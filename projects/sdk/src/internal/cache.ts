import { isDeepStrictEqual } from "node:util"
import type { CacheDiagnostic } from "#sdk/client"
import type { Message, MessageCore, MessageReference } from "#sdk/messages"
import type { CachePolicyErrorReport } from "#sdk/cache"
import { validAge, type CacheConfiguration } from "./configuration.js"
import { discardInvalidCallbackReturn } from "./invalid-callback-return.js"

type Entry<M extends MessageCore> = { message: M; bytes: number; storedAt: number; age: number | null }
export type CacheRequest = {
    readonly channel: string
    readonly id: string | undefined
    readonly mutation: boolean
    readonly generation: number
    invalid: boolean
}

/** One client's retained observations and bounded in-flight guards, never a server-state replica */
export class MessageCache<M extends MessageCore = Message> {
    #entries = new Map<string, Entry<M>>()
    #requests = new Set<CacheRequest>()
    #bytes = 0
    #generation = 0
    #timer: ReturnType<typeof setTimeout> | undefined
    #closed = false
    readonly #limits: { readonly maxEntries: number; readonly maxBytes: number } | undefined

    constructor(
        private settings: CacheConfiguration<M> | undefined,
        private report: (report: CachePolicyErrorReport) => void,
        private readonly now: () => number,
    ) {
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
        if (entry.age !== null && this.now() - entry.storedAt >= entry.age) {
            this.#remove(target)
            return undefined
        }
        return entry
    }

    #remove(target: MessageReference) {
        const entry = this.#entries.get(target.id)
        if (entry?.message.channelId !== target.channelId) return
        this.#entries.delete(target.id)
        this.#bytes -= entry.bytes
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
                if (entry && !isDeepStrictEqual(entry.message, message)) {
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
        let age: unknown = this.settings.maxAgeMs ?? null
        try {
            if (typeof age === "function") age = age(message)
        } catch {
            this.#remove(message)
            this.report(Object.freeze({ reason: "threw" }))
            this.#schedule()
            return
        }
        if (this.#closed || !this.settings) return
        if (!validAge(age)) {
            discardInvalidCallbackReturn(age)
            this.#remove(message)
            this.report(Object.freeze({ reason: "invalidReturn" }))
            this.#schedule()
            return
        }
        const bytes = age === 0 ? 0 : Buffer.byteLength(JSON.stringify(message))
        this.#remove(message)
        if (age !== 0 && bytes <= this.settings.maxBytes) {
            this.#purge()
            while (this.#entries.size >= this.settings.maxEntries || this.#bytes > this.settings.maxBytes - bytes) {
                const oldest = this.#entries.values().next().value!
                this.#remove(oldest.message)
            }
            this.#entries.set(message.id, { message, bytes, storedAt: this.now(), age })
            this.#bytes += bytes
        }
        this.#schedule()
    }

    delete(target: MessageReference, except?: CacheRequest) {
        if (this.#closed) return
        this.#invalidate(target, except)
        this.#remove(target)
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

    gap(affects?: (guildId: string | null | undefined) => boolean) {
        // Channel-only requests capture this generation before admission and retain it across retries
        if (!affects || affects(undefined)) {
            this.#generation++
            for (const request of this.#requests) request.invalid = true
        }
        if (!affects) {
            this.#entries.clear()
            this.#bytes = 0
        } else {
            for (const entry of this.#entries.values()) if (affects(entry.message.guildId)) this.#remove(entry.message)
        }
        this.#schedule()
    }

    #purge() {
        const now = this.now()
        for (const entry of this.#entries.values())
            if (entry.age !== null && now - entry.storedAt >= entry.age) this.#remove(entry.message)
    }

    #schedule() {
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = undefined
        if (this.#closed) return
        const now = this.now()
        let remaining = Infinity
        for (const entry of this.#entries.values())
            if (entry.age !== null) remaining = Math.min(remaining, entry.age - (now - entry.storedAt))
        if (remaining !== Infinity) {
            this.#timer = setTimeout(
                () => {
                    this.#timer = undefined
                    this.#purge()
                    this.#schedule()
                },
                Math.min(2_147_483_647, Math.max(1, Math.ceil(remaining))),
            )
            this.#timer.unref()
        }
    }

    close() {
        this.#closed = true
        this.gap()
        this.#requests.clear()
        this.settings = undefined
        this.report = () => {}
    }
}
