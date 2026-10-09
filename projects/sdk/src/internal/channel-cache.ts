/**
 * Optional channel cache: ID-keyed guild-channel and thread observations with client-wide limits and in-flight guards.
 * Invariant: The cache never decides effective permissions. Dispatched mutations invalidate channel snapshots and pending channel
 * reads because category and ordering changes can affect descendants, and a rejected multi-entry reorder does not establish
 * rollback. A mutation confined to one thread invalidates only that thread, which has no descendants or sibling order.
 * Bulk gateway observations invalidate their guild rather than keeping permissions Fluxer may still be copying, and
 * create or delete events can be visibility changes, not proof of remote creation or deletion. A deleted or hidden channel
 * takes its cached threads, because Fluxer sends no thread deletion for them, and a full channel list never removes
 * threads, which it does not include. Every applied store, removal and whole-cache clear is recorded to the client's change
 * hub, a replacement counting as one store. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { isDeepStrictEqual } from "node:util"
import type { ResourceCacheSettings } from "#sdk/cache"
import type { CacheDiagnostic } from "#sdk/client"
import { isThreadChannel, type GuildChannel, type GuildThreadChannel } from "#sdk/channels"
import type { EventMap, EventName } from "#sdk/events"
import { ExpiryQueue, ExpiryTimer } from "./expiry-queue.js"
import type { LogicalScheduler } from "./logical-scheduler.js"
import type { CacheChangeHub } from "./cache-changes.js"
import { retentionAge } from "./retention-age.js"
import { decodeGuildChannels } from "./channel-decode.js"
import { identifier, record } from "./decode/primitives.js"
import { decodeSnapshotThreads, threadParentTypes } from "./thread-events.js"

export type ChannelCacheRequest = {
    readonly channelId?: string
    readonly guildId?: string
    readonly mutation?: boolean
    /** A complete, authoritative guild list that may reconcile absent channel snapshots */
    readonly replace?: boolean
    /**
     * Marks a mutation confined to the thread named by channelId, or to a new thread when channelId is absent. A thread
     * has no descendants or sibling order, so the change affects no other channel snapshot
     */
    readonly thread?: boolean
}

export type ChannelCacheGuard = ChannelCacheRequest & {
    readonly generation: number
    invalid: boolean
    /** A scoped gateway gap made this read stale, so it must not evict a newer post-gap observation */
    gapped: boolean
    success: boolean
}

type Entry = { value: GuildChannel; bytes: number; expires: number | null }

const categoryType = 4

const selection = (request: ChannelCacheRequest) => ({
    ...(request.channelId === undefined ? {} : { channelId: request.channelId }),
    ...(request.guildId === undefined ? {} : { guildId: request.guildId }),
})

const overlaps = (left: ChannelCacheRequest, right: ChannelCacheRequest) => {
    if (left.channelId !== undefined && right.channelId !== undefined) return left.channelId === right.channelId
    if (left.guildId !== undefined && right.guildId !== undefined) return left.guildId === right.guildId
    // An ID-only route cannot prove that it belongs to a different guild
    return true
}

const matches = (request: ChannelCacheRequest, channel: GuildChannel) =>
    (request.channelId === undefined || request.channelId === channel.id) &&
    (request.guildId === undefined || request.guildId === channel.guildId)

const notThread = (channel: GuildChannel) => !isThreadChannel(channel)

/** One client's bounded guild-channel observations and in-flight guards, never a guild inventory or permission authority */
export class ChannelCache {
    #entries = new Map<string, Entry>()
    #requests = new Set<ChannelCacheGuard>()
    #bytes = 0
    #generation = 0
    #closed = false
    #expiry = new ExpiryQueue<Entry & { expires: number }>((entry) => this.#entries.get(entry.value.id) === entry)
    #timer: ExpiryTimer

    constructor(
        private readonly settings: Required<ResourceCacheSettings>,
        private readonly now: () => number,
        logical?: LogicalScheduler,
        readonly changes?: CacheChangeHub,
        private readonly report: (error: unknown) => void = () => undefined,
    ) {
        this.#timer = new ExpiryTimer(
            "channel cache",
            now,
            () => {
                this.#purge()
                this.#schedule()
            },
            logical,
        )
    }

    get(channelId: string): GuildChannel | undefined {
        const entry = this.#peek(channelId)
        if (!entry) return undefined
        this.#entries.delete(channelId)
        this.#entries.set(channelId, entry)
        return entry.value
    }

    /** Whether an unexpired observation of this channel is retained, without making it less likely to be removed */
    holds(channelId: string): boolean {
        return this.#peek(channelId) !== undefined
    }

    diagnostics(): CacheDiagnostic {
        this.#purge()
        this.#schedule()
        return {
            configured: true,
            retainedEntries: this.#entries.size,
            accountedBytes: this.#bytes,
            maxEntries: this.settings.maxEntries,
            maxBytes: this.settings.maxBytes,
        }
    }

    entries(limit: number): readonly GuildChannel[] {
        this.#purge()
        this.#schedule()
        const entries: GuildChannel[] = []
        for (const entry of this.#entries.values()) {
            entries.push(entry.value)
            if (entries.length === limit) break
        }
        return Object.freeze(entries)
    }

    /** Release all retained channels and invalidate requests that could otherwise reintroduce an earlier observation */
    clear() {
        if (this.#closed) return
        this.gap()
    }

    /** Remove one channel and invalidate overlapping requests, including ID-only routes that could belong to it */
    delete(channelId: string) {
        if (this.#closed) return
        this.#evict({ channelId })
        this.#schedule()
    }

    begin(request: ChannelCacheRequest): ChannelCacheGuard {
        const guard: ChannelCacheGuard = {
            ...request,
            generation: this.#generation,
            invalid: false,
            gapped: false,
            success: false,
        }
        for (const other of this.#requests) {
            if (!overlaps(guard, other)) continue
            if (guard.mutation) other.invalid = true
            if (other.mutation) guard.invalid = true
        }
        this.#requests.add(guard)
        return guard
    }

    complete(guard: ChannelCacheGuard, result: unknown) {
        guard.success = true
        if (this.#closed) return
        if (guard.mutation) {
            this.#mutated(guard)
            return
        }
        if (guard.generation !== this.#generation || guard.gapped) return
        // Request decoders own the result shape and freezing. Void responses never fabricate a snapshot
        const values: readonly GuildChannel[] =
            result === undefined
                ? []
                : Array.isArray(result)
                  ? (result as readonly GuildChannel[])
                  : [result as GuildChannel]
        // Only a conflict-free full guild list can prove absence. CHANNEL_UPDATE_BULK is never passed as replace. Fluxer
        // never lists threads with a guild's channels, so the list proves nothing about them
        if (guard.replace && !guard.invalid) this.#evict(selection(guard), guard, notThread)
        for (const value of values) {
            if (guard.invalid) {
                const entry = this.#peek(value.id)
                if (entry && !isDeepStrictEqual(entry.value, value))
                    this.#evict({ channelId: value.id, guildId: value.guildId }, guard)
            } else this.#observe(value, guard)
        }
        this.#schedule()
    }

    missing(guard: ChannelCacheGuard) {
        if (this.#closed || (!guard.mutation && (guard.generation !== this.#generation || guard.gapped))) return
        this.#evict(selection(guard), guard)
        this.#schedule()
    }

    end(guard: ChannelCacheGuard, dispatched: boolean) {
        // A dispatched write can partially apply a category subtree or ordering before a later rejection. Do not let an
        // ID-only route retain unrelated stale channels. This deliberately clears only this channel cache and its guards
        if (!guard.success && guard.mutation && dispatched && !this.#closed) this.#mutated(guard)
        this.#requests.delete(guard)
    }

    event(event: EventName, value: EventMap[EventName]) {
        if (this.#closed) return
        if (event === "guildChannelUpdateBulk") {
            // Gateway bulk lists are visibility-trimmed and reordered before permission copying, never a full snapshot
            this.#evict({ guildId: (value as EventMap["guildChannelUpdateBulk"]).guildId })
        } else if (event === "guildChannelCreate" || event === "guildChannelUpdate" || event === "guildChannelDelete") {
            const channel = value as GuildChannel
            // A category can change its children's parentage and order. Its own observation is insufficient to retain
            // the rest of the guild, so evict every affected channel rather than caching a partial reconciliation
            if (channel.type === categoryType && event !== "guildChannelCreate")
                this.#evict({ guildId: channel.guildId })
            else if (event === "guildChannelDelete") {
                this.#evict({ channelId: channel.id, guildId: channel.guildId })
                // A deleted or hidden parent takes its threads, and Fluxer sends no THREAD_DELETE for them. The guild-wide
                // request also stops ID-only reads in flight, which can name one of those threads
                if (threadParentTypes.has(channel.type))
                    this.#evict(
                        { guildId: channel.guildId },
                        undefined,
                        (candidate) => isThreadChannel(candidate) && candidate.parentId === channel.id,
                    )
            } else this.#observe(channel)
        } else if (event === "threadCreate") {
            // isNewlyCreated describes the event, not the thread
            const { isNewlyCreated: _isNewlyCreated, ...thread } = value as EventMap["threadCreate"]
            this.#observe(Object.freeze(thread) as GuildThreadChannel)
        } else if (event === "threadUpdate") this.#observe(value as EventMap["threadUpdate"])
        else if (event === "threadDelete") {
            const deletion = value as EventMap["threadDelete"]
            this.#evict({ channelId: deletion.id, guildId: deletion.guildId })
        } else if (event === "threadListSync") {
            const sync = value as EventMap["threadListSync"]
            const parents = sync.parentIds === undefined ? undefined : new Set(sync.parentIds)
            this.#evict(
                { guildId: sync.guildId },
                undefined,
                (candidate) => isThreadChannel(candidate) && (parents === undefined || parents.has(candidate.parentId)),
            )
            for (const thread of sync.threads) this.#observe(thread)
        }
        this.#schedule()
    }

    /** Evict one thread, such as one whose cached membership of the bot is no longer current. An unknown guild matches any */
    evictThread(threadId: string, guildId: string | undefined) {
        if (this.#closed) return
        this.#evict(guildId === undefined ? { channelId: threadId } : { channelId: threadId, guildId })
        this.#schedule()
    }

    /**
     * Evict the cached threads of the affected guilds once a shard resumed. Fluxer does not replay THREAD_LIST_SYNC,
     * so a thread observed before the Resume completed may no longer be visible. Reads in flight for those guilds, and
     * ID-only reads, which can name a thread, cannot store an answer that may predate the Resume
     */
    dropThreads(affects: (guildId: string | null | undefined) => boolean) {
        if (this.#closed) return
        for (const guard of this.#requests)
            if (guard.guildId === undefined || affects(guard.guildId)) guard.invalid = true
        for (const entry of this.#entries.values())
            if (isThreadChannel(entry.value) && affects(entry.value.guildId)) this.#remove(entry)
        this.#schedule()
    }

    /**
     * Apply a raw guild lifecycle body. GUILD_CREATE replaces the guild's channels and threads, decoding its threads one
     * at a time, and the field paths of the threads it left out as malformed are returned for the caller to log
     */
    guildEvent(event: string, value: unknown): readonly string[] {
        if (this.#closed) return []
        if (!record(value) || !identifier(value.id)) {
            this.gap()
            return []
        }
        let skipped: readonly string[] = []
        // Removal or lost guild visibility invalidates observations but does not establish physical deletion
        if (event === "GUILD_DELETE") this.#evict({ guildId: value.id })
        else if (event === "GUILD_CREATE") {
            // The snapshot lists every channel and active thread the bot can view, so it replaces this guild's channels
            // and threads. An unavailable guild or a malformed channel list leaves no channels
            this.#evict({ guildId: value.id })
            for (const channel of decodeGuildChannels(value.channels, value.id) ?? []) this.#observe(channel)
            const snapshot = decodeSnapshotThreads(value, value.id)
            for (const thread of snapshot.threads) this.#observe(thread)
            skipped = snapshot.skipped
        }
        this.#schedule()
        return skipped
    }

    gap(affects?: (guildId: string | null | undefined) => boolean) {
        if (!affects) {
            this.#generation++
            for (const guard of this.#requests) guard.invalid = true
            const held = this.#entries.size > 0
            this.#entries.clear()
            this.#bytes = 0
            this.#expiry.clear()
            if (held && this.changes?.active) this.changes.record("channels", "clear", null)
        } else {
            this.pause(affects)
            for (const entry of this.#entries.values()) if (affects(entry.value.guildId)) this.#remove(entry)
        }
        this.#schedule()
    }

    /**
     * Keep in-flight reads for the affected guilds from storing their responses after the gateway connection was lost,
     * while retained channels stay. A successful Resume replays every missed dispatch, which keeps them current
     */
    pause(affects: (guildId: string | null | undefined) => boolean) {
        for (const guard of this.#requests)
            if (affects(guard.guildId)) {
                guard.invalid = true
                guard.gapped = true
            }
    }

    close() {
        this.#closed = true
        this.gap()
        this.#requests.clear()
    }

    #peek(channelId: string) {
        const entry = this.#entries.get(channelId)
        if (entry && entry.expires !== null && entry.expires <= this.now()) {
            this.#remove(entry)
            return undefined
        }
        return entry
    }

    /** Remove one retained channel, reporting the deletion unless the caller replaces it. Returns whether it was removed */
    #remove(entry: Entry, notify = true): boolean {
        if (this.#entries.get(entry.value.id) !== entry) return false
        this.#entries.delete(entry.value.id)
        this.#bytes -= entry.bytes
        if (notify && this.changes?.active) this.changes.record("channels", "delete", entry.value.id)
        return true
    }

    #invalidate(request: ChannelCacheRequest, except?: ChannelCacheGuard) {
        for (const guard of this.#requests) if (guard !== except && overlaps(request, guard)) guard.invalid = true
    }

    /**
     * Apply a dispatched mutation. One confined to a thread evicts only that thread, and creating a new thread evicts
     * nothing. Any other can reorder or move category descendants, even when its route names one ID, so it clears every
     * channel snapshot and invalidates every channel guard, never other resource caches
     */
    #mutated(guard: ChannelCacheGuard) {
        if (!guard.thread) return this.gap()
        if (guard.channelId !== undefined) this.#evict(selection(guard), guard)
        this.#schedule()
    }

    /** Remove the retained channels the request selects, narrowed to those that only accepts when it is given */
    #evict(request: ChannelCacheRequest, except?: ChannelCacheGuard, only?: (channel: GuildChannel) => boolean) {
        this.#invalidate(request, except)
        const selected = (channel: GuildChannel) => matches(request, channel) && (only === undefined || only(channel))
        if (request.channelId !== undefined) {
            const entry = this.#entries.get(request.channelId)
            if (entry && selected(entry.value)) this.#remove(entry)
            return
        }
        for (const entry of this.#entries.values()) if (selected(entry.value)) this.#remove(entry)
    }

    #observe(channel: GuildChannel, except?: ChannelCacheGuard) {
        if (this.#closed) return
        this.#invalidate({ channelId: channel.id, guildId: channel.guildId }, except)
        const resolved = retentionAge(this.settings.maxAgeMs, channel, "channels cache", "snapshot")
        if (this.#closed) return
        const previous = this.#entries.get(channel.id)
        if ("error" in resolved) {
            if (previous) this.#remove(previous)
            this.report(resolved.error)
            return
        }
        const age = resolved.age
        // A replacement reports one set, while an older copy that the new one cannot replace reports a delete
        const replaced = previous !== undefined && this.#remove(previous, false)
        const bytes =
            age === 0
                ? 0
                : Buffer.byteLength(
                      JSON.stringify(channel, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
                  )
        if (age === 0 || bytes > this.settings.maxBytes) {
            if (replaced && this.changes?.active) this.changes.record("channels", "delete", channel.id)
            return
        }
        this.#purge()
        while (this.#entries.size >= this.settings.maxEntries || this.#bytes > this.settings.maxBytes - bytes)
            this.#remove(this.#entries.values().next().value!)
        const entry: Entry = {
            value: channel,
            bytes,
            expires: age === null ? null : this.now() + age,
        }
        this.#entries.set(channel.id, entry)
        this.#bytes += bytes
        if (entry.expires !== null) this.#expiry.push(entry as Entry & { expires: number })
        if (this.changes?.active) this.changes.record("channels", "set", channel.id)
    }

    #purge() {
        this.#expiry.purge(this.now(), (entry) => this.#remove(entry))
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
}
