/**
 * Optional message cache: Retained message observations, in-flight request guards and connection-gap invalidation.
 * Invariant: Fluxer is the source of truth. Intake updates stored data from REST responses and gateway events before subscribers
 * see them, retained data and conflict metadata stay bounded, and pre-gap observations are cleared even after session resumption.
 * A gap on a guild with a known shard invalidates only that shard's data, private-conversation data belongs to shard zero, and
 * unknown ownership stays conservative, including channel-only in-flight reads, without an unbounded channel-to-guild index.
 * A deleted thread parent removes the messages of every channel in its guild that the channel cache cannot place, because
 * Fluxer deletes the parent's threads without thread deletion events and messages do not record their thread's parent.
 * Pre-gap requests neither repopulate invalid snapshots nor evict healthy post-gap observations on late completion. A callback
 * that throws or returns an invalid value is reported with kind cache and the message IDs, and neither retention nor reporting
 * failure changes a successful REST result or event delivery. Every applied store, removal and whole-cache clear is recorded
 * to the client's change hub after it is applied, a replacement counting as one store. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { isDeepStrictEqual } from "node:util"
import type { CacheDiagnostic } from "#sdk/client"
import type { Message, MessageCore, MessageReference } from "#sdk/messages"
import type { CacheConfiguration } from "./configuration.js"
import { retentionAge } from "./retention-age.js"
import { ExpiryQueue, ExpiryTimer } from "./expiry-queue.js"
import type { LogicalScheduler } from "./logical-scheduler.js"
import type { CacheChangeHub } from "./cache-changes.js"

type Entry<M extends MessageCore> = { message: M; bytes: number; expires: number | null }
export type CacheRequest = {
    readonly channel: string
    readonly id: string | undefined
    readonly mutation: boolean
    readonly generation: number
    invalid: boolean
}

/**
 * Whether an overlapping response describes the same message state as the retained snapshot.
 * Fluxer omits guild_id from message HTTP responses while gateway events include it, so a guild ID present on only
 * one side is unknown context rather than a conflicting change
 */
function sameObservation<M extends MessageCore>(retained: M, incoming: M) {
    if (isDeepStrictEqual(retained, incoming)) return true
    if ((retained.guildId === undefined) === (incoming.guildId === undefined)) return false
    const { guildId: _retainedGuild, ...retainedState } = retained
    const { guildId: _incomingGuild, ...incomingState } = incoming
    return isDeepStrictEqual(retainedState, incomingState)
}

/** A message's cache change key: Its channel and message IDs */
const changeKey = (message: MessageReference) => `${message.channelId}:${message.id}`

/** One client's retained observations and bounded in-flight guards, never a server-state replica */
export class MessageCache<M extends MessageCore = Message> {
    #entries = new Map<string, Entry<M>>()
    #requests = new Set<CacheRequest>()
    #bytes = 0
    #generation = 0
    #expiry = new ExpiryQueue<Entry<M> & { expires: number }>((entry) => this.#entries.get(entry.message.id) === entry)
    #timer: ExpiryTimer
    #closed = false
    readonly #limits: { readonly maxEntries: number; readonly maxBytes: number } | undefined

    constructor(
        private settings: CacheConfiguration<M> | undefined,
        private report: (error: unknown, message: MessageCore) => void,
        private readonly now: () => number,
        logical?: LogicalScheduler,
        readonly changes?: CacheChangeHub,
    ) {
        this.#timer = new ExpiryTimer(
            "message cache",
            now,
            () => {
                this.#purge()
                this.#schedule()
            },
            logical,
        )
        this.#limits = settings && Object.freeze({ maxEntries: settings.maxEntries, maxBytes: settings.maxBytes })
    }

    get generation() {
        return this.#generation
    }

    diagnostics(): CacheDiagnostic {
        this.#purge()
        this.#schedule()
        return {
            configured: this.#limits !== undefined,
            retainedEntries: this.#entries.size,
            accountedBytes: this.#bytes,
            maxEntries: this.#limits?.maxEntries ?? null,
            maxBytes: this.#limits?.maxBytes ?? null,
        }
    }

    entries(limit: number): readonly M[] {
        this.#purge()
        this.#schedule()
        const entries: M[] = []
        for (const entry of this.#entries.values()) {
            entries.push(entry.message)
            if (entries.length === limit) break
        }
        return Object.freeze(entries)
    }

    /** Release only this client's retained snapshots and block reads that began before this point from refilling them */
    clear() {
        if (this.#closed) return
        this.gap()
    }

    get(target: MessageReference): M | undefined {
        const entry = this.#peek(target)
        if (!entry) return undefined
        this.#entries.delete(target.id)
        this.#entries.set(target.id, entry)
        return entry.message
    }

    #peek(target: MessageReference) {
        const entry = this.#entries.get(target.id)
        if (!entry || entry.message.channelId !== target.channelId) return undefined
        if (entry.expires !== null && entry.expires <= this.now()) {
            this.#remove(target)
            return undefined
        }
        return entry
    }

    /** Remove one retained message, reporting the deletion unless the caller replaces it. Returns whether one was removed */
    #remove(target: MessageReference, notify = true): boolean {
        const entry = this.#entries.get(target.id)
        if (entry?.message.channelId !== target.channelId) return false
        this.#entries.delete(target.id)
        this.#bytes -= entry.bytes
        if (notify && this.changes?.active) this.changes.record("messages", "delete", changeKey(entry.message))
        return true
    }

    #invalidate(target: MessageReference, except?: CacheRequest) {
        for (const request of this.#requests)
            if (
                request !== except &&
                request.channel === target.channelId &&
                (request.id === undefined || request.id === target.id)
            )
                request.invalid = true
    }

    begin(channel: string, id: string | undefined, mutation: boolean, generation: number): CacheRequest {
        const request = { channel, id, mutation, generation, invalid: generation !== this.#generation }
        for (const other of this.#requests) {
            if (other.channel !== channel || (id !== undefined && other.id !== undefined && id !== other.id)) continue
            if (mutation) other.invalid = true
            if (other.mutation) request.invalid = true
        }
        this.#requests.add(request)
        return request
    }

    end(request: CacheRequest) {
        this.#requests.delete(request)
    }

    complete(request: CacheRequest, messages: readonly M[]) {
        if (this.#closed || request.generation !== this.#generation) return
        // Admit a history page oldest first so its newest members survive tight capacity limits
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index]!
            if (request.invalid) {
                const entry = this.#peek(message)
                if (entry && !sameObservation(entry.message, message)) {
                    this.#remove(message)
                    this.#invalidate(message, request)
                }
            } else this.observe(message, request)
        }
        this.#schedule()
    }

    observe(message: M, request?: CacheRequest) {
        if (this.#closed || !this.settings) return
        this.#invalidate(message, request)
        const resolved = retentionAge(this.settings.maxAgeMs ?? null, message, "message cache", "message")
        if ("error" in resolved) {
            this.#remove(message)
            this.report(resolved.error, message)
            this.#schedule()
            return
        }
        if (this.#closed || !this.settings) return
        const age = resolved.age
        const bytes = age === 0 ? 0 : Buffer.byteLength(JSON.stringify(message))
        // A replacement reports one set, while an older copy that the new one cannot replace reports a delete
        const replaced = this.#remove(message, false)
        if (age !== 0 && bytes <= this.settings.maxBytes) {
            this.#purge()
            while (this.#entries.size >= this.settings.maxEntries || this.#bytes > this.settings.maxBytes - bytes) {
                const oldest = this.#entries.values().next().value!
                this.#remove(oldest.message)
            }
            const entry: Entry<M> = { message, bytes, expires: age === null ? null : this.now() + age }
            this.#entries.set(message.id, entry)
            this.#bytes += bytes
            if (entry.expires !== null) this.#expiry.push(entry as Entry<M> & { expires: number })
            if (this.changes?.active) this.changes.record("messages", "set", changeKey(message))
        } else if (replaced && this.changes?.active) this.changes.record("messages", "delete", changeKey(message))
        this.#schedule()
    }

    delete(target: MessageReference, except?: CacheRequest) {
        if (this.#closed) return
        this.#invalidate(target, except)
        this.#remove(target)
        this.#schedule()
    }

    /** Remove one message by ID when its channel is unknown, and block reads already in flight from restoring it */
    deleteId(id: string) {
        if (this.#closed) return
        this.#generation++
        for (const request of this.#requests) if (request.id === undefined || request.id === id) request.invalid = true
        const entry = this.#entries.get(id)
        if (entry) this.#remove(entry.message)
        this.#schedule()
    }

    deleteMany(channelId: string, ids: readonly string[]) {
        if (this.#closed) return
        // Also block queued reads that have not registered their request guard yet
        this.#generation++
        for (const id of ids) this.delete({ channelId, id })
    }

    deleteAuthor(userId: string) {
        if (this.#closed) return
        this.#generation++
        for (const entry of this.#entries.values()) if (entry.message.author.id === userId) this.delete(entry.message)
    }

    deleteChannel(channelId: string) {
        if (this.#closed) return
        // Queued REST calls have captured this generation but may not have registered a per-request guard yet
        // Preserve other channel snapshots while conservatively blocking admission of pre-deletion responses
        this.#generation++
        for (const request of this.#requests) if (request.channel === channelId) request.invalid = true
        for (const entry of this.#entries.values())
            if (entry.message.channelId === channelId) this.#remove(entry.message)
        this.#schedule()
    }

    /**
     * Remove the messages a deleted thread parent can have taken with its threads: Those in this guild, or without guild
     * context, whose channel held does not place. Reads of such channels already in flight cannot restore them
     */
    deleteUnplaced(guildId: string, held: (channelId: string) => boolean) {
        if (this.#closed) return
        // Queued REST calls have captured this generation but may not have registered a per-request guard yet
        this.#generation++
        for (const request of this.#requests) if (!held(request.channel)) request.invalid = true
        for (const entry of this.#entries.values()) {
            const message = entry.message
            if ((message.guildId === undefined || message.guildId === guildId) && !held(message.channelId))
                this.#remove(message)
        }
        this.#schedule()
    }

    gap(affects?: (guildId: string | null | undefined) => boolean) {
        // Channel-only requests capture this generation before admission and retain it across retries
        if (!affects || affects(undefined)) {
            this.#generation++
            for (const request of this.#requests) request.invalid = true
        }
        if (!affects) {
            const held = this.#entries.size > 0
            this.#entries.clear()
            this.#bytes = 0
            this.#expiry.clear()
            if (held && this.changes?.active) this.changes.record("messages", "clear", null)
        } else {
            for (const entry of this.#entries.values()) if (affects(entry.message.guildId)) this.#remove(entry.message)
        }
        this.#schedule()
    }

    #purge() {
        this.#expiry.purge(this.now(), (entry) => this.#remove(entry.message))
    }

    #schedule() {
        if (this.#closed) {
            this.#timer.cancel()
            this.#expiry.clear()
            return
        }
        this.#expiry.compact(this.#entries.size)
        this.#timer.set(this.#expiry.next())
    }

    close() {
        this.#closed = true
        this.gap()
        this.#requests.clear()
        this.settings = undefined
        this.report = () => {}
    }
}
