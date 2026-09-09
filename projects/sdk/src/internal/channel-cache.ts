import { isDeepStrictEqual } from "node:util"
import type { ResourceCacheSettings } from "#sdk/cache"
import type { GuildChannel } from "#sdk/channels"
import type { EventMap, EventName } from "#sdk/events"
import { identifier, record } from "./message.js"

export type ChannelCacheRequest = {
    readonly channelId?: string
    readonly guildId?: string
    readonly mutation?: boolean
    /** A complete, authoritative guild list that may reconcile absent channel snapshots. */
    readonly replace?: boolean
}

export type ChannelCacheGuard = ChannelCacheRequest & {
    readonly generation: number
    invalid: boolean
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
    // An ID-only route cannot prove that it belongs to a different guild.
    return true
}

const matches = (request: ChannelCacheRequest, channel: GuildChannel) =>
    (request.channelId === undefined || request.channelId === channel.id) &&
    (request.guildId === undefined || request.guildId === channel.guildId)

/** One client's bounded guild-channel observations and in-flight guards, never a guild inventory or permission authority. */
export class ChannelCache {
    #entries = new Map<string, Entry>()
    #requests = new Set<ChannelCacheGuard>()
    #bytes = 0
    #generation = 0
    #closed = false
    #timer: ReturnType<typeof setTimeout> | undefined

    constructor(
        private readonly settings: Required<ResourceCacheSettings>,
        private readonly now: () => number,
    ) {}

    get(channelId: string): GuildChannel | undefined {
        const entry = this.#peek(channelId)
        if (!entry) return undefined
        this.#entries.delete(channelId)
        this.#entries.set(channelId, entry)
        return entry.value
    }

    begin(request: ChannelCacheRequest): ChannelCacheGuard {
        const guard: ChannelCacheGuard = {
            ...request,
            generation: this.#generation,
            invalid: false,
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
        // A dispatched channel mutation can reorder or move category descendants, even when its route names one ID.
        // Keep this cost local to channels: clear their snapshots and invalidate their guards, never other resource caches.
        if (guard.mutation) {
            this.gap()
            return
        }
        if (guard.generation !== this.#generation) return
        // Request decoders own the result shape and freezing; void responses never fabricate a snapshot.
        const values: readonly GuildChannel[] =
            result === undefined
                ? []
                : Array.isArray(result)
                  ? (result as readonly GuildChannel[])
                  : [result as GuildChannel]
        // Only a conflict-free full guild list can prove absence. CHANNEL_UPDATE_BULK is never passed as replace.
        if (guard.replace && !guard.invalid) this.#evict(selection(guard), guard)
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
        if (this.#closed || (!guard.mutation && guard.generation !== this.#generation)) return
        this.#evict(selection(guard), guard)
        this.#schedule()
    }

    end(guard: ChannelCacheGuard, dispatched: boolean) {
        // A dispatched write can partially apply a category subtree or ordering before a later rejection. Do not let an
        // ID-only route retain unrelated stale channels; this deliberately clears only this channel cache and its guards.
        if (!guard.success && guard.mutation && dispatched && !this.#closed) this.gap()
        this.#requests.delete(guard)
    }

    event(event: EventName, value: EventMap[EventName]) {
        if (this.#closed) return
        if (event === "guildChannelUpdateBulk") {
            // Gateway bulk lists are visibility-trimmed and reordered before permission copying, never a full snapshot.
            this.#evict({ guildId: (value as EventMap["guildChannelUpdateBulk"]).guildId })
        } else if (event === "guildChannelCreate" || event === "guildChannelUpdate" || event === "guildChannelDelete") {
            const channel = value as GuildChannel
            // A category can change its children's parentage and order. Its own observation is insufficient to retain
            // the rest of the guild, so evict every affected channel rather than caching a partial reconciliation.
            if (channel.type === categoryType && event !== "guildChannelCreate")
                this.#evict({ guildId: channel.guildId })
            else if (event === "guildChannelDelete") this.#evict({ channelId: channel.id, guildId: channel.guildId })
            else this.#observe(channel)
        }
        this.#schedule()
    }

    guildEvent(event: string, value: unknown) {
        if (this.#closed) return
        if (!record(value) || !identifier(value.id)) {
            this.gap()
            return
        }
        // Removal or lost guild visibility invalidates observations but does not establish physical deletion.
        if (event === "GUILD_DELETE") this.#evict({ guildId: value.id })
        this.#schedule()
    }

    gap() {
        this.#generation++
        for (const guard of this.#requests) guard.invalid = true
        this.#entries.clear()
        this.#bytes = 0
        this.#schedule()
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

    #remove(entry: Entry) {
        if (this.#entries.get(entry.value.id) !== entry) return
        this.#entries.delete(entry.value.id)
        this.#bytes -= entry.bytes
    }

    #invalidate(request: ChannelCacheRequest, except?: ChannelCacheGuard) {
        for (const guard of this.#requests) if (guard !== except && overlaps(request, guard)) guard.invalid = true
    }

    #evict(request: ChannelCacheRequest, except?: ChannelCacheGuard) {
        this.#invalidate(request, except)
        for (const entry of this.#entries.values()) if (matches(request, entry.value)) this.#remove(entry)
    }

    #observe(channel: GuildChannel, except?: ChannelCacheGuard) {
        if (this.#closed) return
        this.#invalidate({ channelId: channel.id, guildId: channel.guildId }, except)
        const previous = this.#entries.get(channel.id)
        if (previous) this.#remove(previous)
        if (this.settings.maxAgeMs === 0) return
        const bytes = Buffer.byteLength(
            JSON.stringify(channel, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
        )
        if (bytes > this.settings.maxBytes) return
        this.#purge()
        while (this.#entries.size >= this.settings.maxEntries || this.#bytes > this.settings.maxBytes - bytes)
            this.#remove(this.#entries.values().next().value!)
        this.#entries.set(channel.id, {
            value: channel,
            bytes,
            expires: this.settings.maxAgeMs === null ? null : this.now() + this.settings.maxAgeMs,
        })
        this.#bytes += bytes
    }

    #purge() {
        const now = this.now()
        for (const entry of this.#entries.values())
            if (entry.expires !== null && entry.expires <= now) this.#remove(entry)
    }

    #schedule() {
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = undefined
        if (this.#closed) return
        let next = Infinity
        for (const entry of this.#entries.values()) if (entry.expires !== null) next = Math.min(next, entry.expires)
        if (next !== Infinity) {
            this.#timer = setTimeout(
                () => {
                    this.#purge()
                    this.#schedule()
                },
                Math.min(2_147_483_647, Math.max(1, Math.ceil(next - this.now()))),
            )
            this.#timer.unref()
        }
    }
}
