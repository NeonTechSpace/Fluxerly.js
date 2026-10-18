/**
 * Optional channel cache: ID-keyed guild-channel and thread observations with client-wide limits and in-flight guards.
 * Invariant: The cache never decides effective permissions. A dispatched mutation invalidates the channel snapshots and
 * pending channel reads it can affect, even when Fluxer rejects it, because a rejected multi-entry reorder does not
 * establish rollback. A mutation confined to one thread affects only that thread, which has no descendants or sibling
 * order. A community-scoped mutation can create, order or move any of the community's channels, and a write to a category
 * can move or re-permission its children, so either affects the whole community. A write to any other channel affects only
 * that channel, plus its threads when the write deletes it or converts its type, and the posts applying a tag it removes,
 * which Fluxer drops from posts on read without a thread update. For the same reasons, a text or announcement channel
 * update takes the cached threads whose type the channel's type cannot hold, and a forum or media channel update takes
 * the cached posts applying a tag the update lacks. Either update also stops the reads in flight from storing the
 * channel's threads, because a read can store the channel's new state before the update arrives. Fluxer gives each
 * new tag a new ID, so a missing ID is a removed tag. A channel's community and whether it is a category never change, so
 * an observation from before the write places it, and a write to a channel the cache cannot place clears every channel,
 * because it can belong to any community.
 * Bulk gateway observations invalidate their guild rather than keeping permissions Fluxer may still be copying, and
 * create or delete events can be visibility changes, not proof of remote creation or deletion. A deleted or hidden channel
 * takes its cached threads, because Fluxer sends no thread deletion for them, and a full channel list never removes
 * threads, which it does not include. Every applied store, removal and whole-cache clear is recorded to the client's change
 * hub, a replacement counting as one store. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { isDeepStrictEqual } from "node:util"
import type { ResourceCacheSettings } from "#sdk/cache"
import type { CacheDiagnostic } from "#sdk/client"
import { ChannelType, isThreadChannel, type GuildChannel, type GuildThreadChannel } from "#sdk/channels"
import type { EventMap, EventName } from "#sdk/events"
import { ExpiryQueue, ExpiryTimer } from "./expiry-queue.js"
import type { LogicalScheduler } from "./logical-scheduler.js"
import type { CacheChangeHub } from "./cache-changes.js"
import { retentionAge } from "./retention-age.js"
import { decodeGuildChannels } from "./channel-decode.js"
import { identifier, record } from "./decode/primitives.js"
import { decodeSnapshotThreads, threadParentTypes } from "./thread-events.js"
import { cacheStats, readStats } from "./cache.js"

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
    /**
     * Marks a mutation that can change the threads of the channel named by channelId without thread events, as its
     * deletion or a type conversion does
     */
    readonly changesThreads?: boolean
    /**
     * Tells which forum tags a mutation of the forum or media channel named by channelId can remove, so the posts
     * applying one lose it without thread events. Deleting one tag removes that tag, and an edit's availableTags removes
     * every tag it does not list by ID
     */
    readonly removesTag?: (tagId: string) => boolean
}

/** The facts about a channel that a write cannot change, which decide what the write can affect */
type ChannelPlace = Pick<GuildChannel, "guildId" | "type">

export type ChannelCacheGuard = ChannelCacheRequest & {
    /** The target channel's place, observed when a mutation that names one began */
    readonly target?: ChannelPlace
    readonly generation: number
    invalid: boolean
    /** A scoped gateway gap made this read stale, so it must not evict a newer post-gap observation */
    gapped: boolean
    /** The channels whose threads this read must not store, because a change to their threads may postdate its answer */
    stoppedParents?: Set<string>
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

/** Channel types whose posts Fluxer shows with only the tags the channel still offers */
const forumTypes: ReadonlySet<unknown> = new Set([ChannelType.Forum, ChannelType.Media])

/**
 * The thread types each convertible channel type can hold. Fluxer converts only between text and announcement channels,
 * retyping their public threads to match without thread events for archived ones, and blocks a conversion to an
 * announcement channel while private threads remain
 */
const textThreadTypes = new Map<unknown, ReadonlySet<unknown>>([
    [ChannelType.Text, new Set([ChannelType.PublicThread, ChannelType.PrivateThread])],
    [ChannelType.Announcement, new Set([ChannelType.AnnouncementThread])],
])

/** The tag IDs a channel offers, or undefined when it is not a forum or media channel or its tags are not known */
const tagIds = (channel: GuildChannel | undefined) =>
    channel !== undefined && forumTypes.has(channel.type) && "availableTags" in channel && channel.availableTags
        ? new Set(channel.availableTags.map((tag) => tag.id))
        : undefined

/** One client's bounded guild-channel observations and in-flight guards, never a guild inventory or permission authority */
export class ChannelCache {
    #entries = new Map<string, Entry>()
    #requests = new Set<ChannelCacheGuard>()
    #bytes = 0
    #generation = 0
    #closed = false
    readonly #stats = cacheStats()
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
        if (!entry) {
            this.#stats.misses++
            return undefined
        }
        this.#stats.hits++
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
            ...readStats(this.#stats),
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
        // A raw read neither expires the entry nor makes it less likely to be removed
        const known =
            request.mutation && !request.thread && request.channelId !== undefined
                ? this.#entries.get(request.channelId)?.value
                : undefined
        const guard: ChannelCacheGuard = {
            ...request,
            ...(known === undefined ? {} : { target: { guildId: known.guildId, type: known.type } }),
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
            if (guard.invalid || (isThreadChannel(value) && guard.stoppedParents?.has(value.parentId))) {
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
        // A dispatched write can partially apply a category subtree or ordering before a later rejection, so it affects
        // the same channels as a successful one. This deliberately changes only this channel cache and its guards
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
            else if (event === "guildChannelDelete") this.#removeChannel(channel.id, channel, true)
            else {
                if (event === "guildChannelUpdate") this.#updated(channel)
                this.#observe(channel)
            }
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
            this.#stats.evictions.expiry++
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
     * Apply a dispatched mutation, never to other resource caches. One confined to a thread evicts only that thread, and
     * creating a new thread evicts nothing. A community-scoped one evicts the community's channels. One that names a
     * channel evicts that channel, with its threads when the write can change them, or the community of a category. A
     * channel the cache has not observed can belong to any community, so a write to it clears every channel snapshot
     */
    #mutated(guard: ChannelCacheGuard) {
        if (guard.thread) {
            if (guard.channelId !== undefined) this.#evict(selection(guard), guard)
        } else if (guard.channelId === undefined) {
            if (guard.guildId === undefined) return this.gap()
            this.#evict({ guildId: guard.guildId }, guard)
        } else {
            const held = this.#entries.get(guard.channelId)?.value
            const place: ChannelPlace | undefined = guard.target ?? held
            if (place === undefined) return this.gap()
            if (place.type === categoryType) this.#evict({ guildId: place.guildId }, guard)
            else {
                this.#removeChannel(guard.channelId, place, guard.changesThreads === true, guard)
                if (guard.removesTag !== undefined && !guard.changesThreads && forumTypes.has(place.type)) {
                    const forum = { id: guard.channelId, guildId: place.guildId }
                    const removed = guard.removesTag
                    // No read can store the forum while the write runs, so a newer observation of it comes from an
                    // event or snapshot. Showing every removed tag absent, it shows no removal that reads in flight
                    // could predate, and the event stopped any such read itself
                    const earlier = tagIds(held)
                    if (earlier === undefined || [...earlier].some(removed)) this.#stopThreadReads(forum.id, guard)
                    this.#dropThreads(forum, (post) => "appliedTagIds" in post && post.appliedTagIds?.some(removed))
                }
            }
        }
        this.#schedule()
    }

    /**
     * Apply what a channel update changes about its threads without thread events. A text or announcement channel update
     * takes the cached threads whose type its new type cannot hold, because Fluxer retypes a converted channel's threads
     * and sends no thread update for archived ones. A forum or media channel update takes the cached posts applying a tag
     * the update lacks, because Fluxer removes a tag through this update alone and drops it from posts on read. The
     * earlier observation cannot tell whether reads in flight predate such a change, because it can be absent or a read
     * can already have stored the channel's new state, so every such update stops the reads in flight from storing its
     * threads
     */
    #updated(after: GuildChannel) {
        const fits = textThreadTypes.get(after.type)
        if (fits !== undefined) {
            this.#stopThreadReads(after.id)
            this.#dropThreads(after, (thread) => !fits.has(thread.type))
        } else if (forumTypes.has(after.type)) {
            const current = tagIds(after)
            this.#stopThreadReads(after.id)
            // An update without the tag list cannot show that any tag survived
            this.#dropThreads(
                after,
                (post) =>
                    "appliedTagIds" in post &&
                    post.appliedTagIds?.some((tagId) => current === undefined || !current.has(tagId)),
            )
        }
    }

    /**
     * Stop the reads in flight from storing a thread of one channel, while they still store every other channel. An
     * ID-only read cannot tell before it answers whether it names one of those threads, but a thread never changes its
     * parent channel, so its answer can. A read of the channel itself or of the whole community is stopped as well by
     * the caller's observation or removal of the channel, which overlaps it
     */
    #stopThreadReads(parentId: string, except?: ChannelCacheGuard) {
        for (const guard of this.#requests) if (guard !== except) (guard.stoppedParents ??= new Set()).add(parentId)
    }

    /** Remove the cached threads of one channel that only accepts */
    #dropThreads(parent: Pick<GuildChannel, "id" | "guildId">, only: (thread: GuildThreadChannel) => unknown) {
        for (const entry of this.#entries.values()) {
            const thread = entry.value
            if (
                isThreadChannel(thread) &&
                thread.parentId === parent.id &&
                thread.guildId === parent.guildId &&
                only(thread)
            )
                this.#remove(entry)
        }
    }

    /**
     * Remove one non-category channel, and when threads is true also the cached threads it can hold. A deleted or hidden
     * parent takes its threads, and Fluxer sends no THREAD_DELETE for them. The guild-wide request also stops ID-only
     * reads in flight, which can name one of those threads
     */
    #removeChannel(channelId: string, place: ChannelPlace, threads: boolean, except?: ChannelCacheGuard) {
        this.#evict({ channelId, guildId: place.guildId }, except)
        if (threads && threadParentTypes.has(place.type))
            this.#evict(
                { guildId: place.guildId },
                except,
                (candidate) => isThreadChannel(candidate) && candidate.parentId === channelId,
            )
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
        while (this.#entries.size >= this.settings.maxEntries || this.#bytes > this.settings.maxBytes - bytes) {
            this.#remove(this.#entries.values().next().value!)
            this.#stats.evictions.capacity++
        }
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
        this.#expiry.purge(this.now(), (entry) => {
            if (this.#remove(entry)) this.#stats.evictions.expiry++
        })
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
