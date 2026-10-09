/**
 * Optional guild cache: Guild, member, role and expression observations with limits for each resource across the client.
 * Invariant: REST registers conflict guards before admission waits and keeps them through retries and cleanup, and gateway intake
 * updates or invalidates the cache before delivery, including memberships after role deletion. Connection gaps stop old requests
 * from repopulating snapshots while late writes still invalidate newer observations. Fluxer stays authoritative for membership,
 * permissions and hierarchy, so an earlier observation never suppresses a targeted role request. Every applied store, removal and
 * whole-kind clear is recorded to the client's change hub, a replacement counting as one store. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { isDeepStrictEqual } from "node:util"
import type { CacheDiagnostic } from "#sdk/client"
import type { Guild, GuildMember, GuildRole } from "#sdk/guilds"
import type { GuildEmoji, GuildSticker } from "#sdk/expressions"
import type { EventMap, EventName } from "#sdk/events"
import type { ResourceCacheSettings } from "#sdk/cache"
import { decodeGuild, decodeGuildSnapshot, decodeRoles } from "./guilds.js"
import { expressionItems } from "./expressions.js"
import { ExpiryQueue, ExpiryTimer } from "./expiry-queue.js"
import type { LogicalScheduler } from "./logical-scheduler.js"
import type { CacheChangeHub } from "./cache-changes.js"
import { retentionAge } from "./retention-age.js"
import { identifier, record } from "./decode/primitives.js"
import { cacheStats, readStats } from "./cache.js"

export type ResourceKind = "guilds" | "members" | "roles" | "emojis" | "stickers"
export type Resources = {
    guilds: Guild
    members: GuildMember
    roles: GuildRole
    emojis: GuildEmoji
    stickers: GuildSticker
}
type Snapshot = Resources[ResourceKind]
export type ResourceConfiguration = Partial<Record<ResourceKind, Required<ResourceCacheSettings>>>
type Selection = { kind: ResourceKind; guildId: string; id?: string }
export type ResourceRequest = {
    selection: Selection
    mutation?: boolean
    replace?: boolean
    members?: boolean
    batch?: boolean
    wholeGuild?: boolean
}
export type ResourceGuard = ResourceRequest & {
    generation: number
    invalid: boolean
    /** A scoped gateway gap made this read stale, so it must not evict a newer post-gap observation */
    gapped: boolean
    success: boolean
}
type Entry = { selection: Selection; value: Snapshot; bytes: number; expires: number | null }
const kinds = ["guilds", "members", "roles", "emojis", "stickers"] as const
const key = (selection: Selection) => `${selection.guildId}:${selection.id ?? selection.guildId}`
/** Public cache change key: The guild ID for guilds, otherwise guildId:id */
const changeKey = (selection: Selection) =>
    selection.kind === "guilds" ? selection.guildId : `${selection.guildId}:${selection.id ?? selection.guildId}`
const overlaps = (a: Selection, b: Selection) =>
    a.kind === b.kind && a.guildId === b.guildId && (a.id === undefined || b.id === undefined || a.id === b.id)

/** One client's resource observations. REST owns bounded request admission and this owner retains no historical tombstones */
export class GuildCache {
    #entries = {
        guilds: new Map<string, Entry>(),
        members: new Map<string, Entry>(),
        roles: new Map<string, Entry>(),
        emojis: new Map<string, Entry>(),
        stickers: new Map<string, Entry>(),
    }
    #bytes = { guilds: 0, members: 0, roles: 0, emojis: 0, stickers: 0 }
    readonly #stats = {
        guilds: cacheStats(),
        members: cacheStats(),
        roles: cacheStats(),
        emojis: cacheStats(),
        stickers: cacheStats(),
    }
    #requests = new Set<ResourceGuard>()
    #generation = 0
    #closed = false
    #expiry = new ExpiryQueue<Entry & { expires: number }>(
        (entry) => this.#entries[entry.selection.kind].get(key(entry.selection)) === entry,
    )
    #timer: ExpiryTimer

    constructor(
        private readonly settings: ResourceConfiguration,
        private readonly now: () => number,
        logical?: LogicalScheduler,
        readonly changes?: CacheChangeHub,
        private readonly report: (error: unknown) => void = () => undefined,
    ) {
        this.#timer = new ExpiryTimer(
            "guild cache",
            now,
            () => {
                this.#purge()
                this.#schedule()
            },
            logical,
        )
    }

    get<K extends ResourceKind>(kind: K, guildId: string, id?: string): Resources[K] | undefined {
        const selection = { kind, guildId, ...(id === undefined ? {} : { id }) }
        const entry = this.#peek(selection)
        // A disabled kind holds nothing, so its lookups are not counted
        if (this.settings[kind]) this.#stats[kind][entry ? "hits" : "misses"]++
        if (!entry) return undefined
        const entries = this.#entries[kind]
        entries.delete(key(selection))
        entries.set(key(selection), entry)
        return entry.value as Resources[K]
    }

    diagnostics(kind: ResourceKind): CacheDiagnostic {
        this.#purge()
        this.#schedule()
        const settings = this.settings[kind]
        return {
            configured: settings !== undefined,
            retainedEntries: this.#entries[kind].size,
            accountedBytes: this.#bytes[kind],
            maxEntries: settings?.maxEntries ?? null,
            maxBytes: settings?.maxBytes ?? null,
            ...readStats(this.#stats[kind]),
        }
    }

    entries<K extends ResourceKind>(kind: K, limit: number): readonly Resources[K][] {
        this.#purge()
        this.#schedule()
        const entries: Resources[K][] = []
        for (const entry of this.#entries[kind].values()) {
            entries.push(entry.value as Resources[K])
            if (entries.length === limit) break
        }
        return Object.freeze(entries)
    }

    /** Release all retained resource observations and prevent earlier reads from restoring them */
    clear() {
        if (this.#closed) return
        this.gap()
    }

    /** Release one kind's observations and prevent earlier reads of that kind from restoring them */
    clearKind(kind: ResourceKind) {
        if (this.#closed) return
        for (const request of this.#requests)
            if (this.#selections(request).some((selection) => selection.kind === kind)) request.invalid = true
        const held = this.#entries[kind].size > 0
        this.#entries[kind].clear()
        this.#bytes[kind] = 0
        if (held && this.changes?.active) this.changes.record(kind, "clear", null)
        this.#schedule()
    }

    /** Remove one observation and prevent overlapping earlier reads from restoring it */
    delete(kind: ResourceKind, guildId: string, id: string) {
        if (this.#closed) return
        this.#evict({ kind, guildId, id })
        this.#schedule()
    }

    #peek(selection: Selection) {
        const entry = this.#entries[selection.kind].get(key(selection))
        if (entry && entry.expires !== null && entry.expires <= this.now()) {
            this.#remove(entry)
            this.#stats[selection.kind].evictions.expiry++
            return undefined
        }
        return entry
    }

    /** Remove one retained snapshot, reporting the deletion unless the caller replaces it. Returns whether it was removed */
    #remove(entry: Entry, notify = true): boolean {
        const entries = this.#entries[entry.selection.kind]
        if (entries.get(key(entry.selection)) !== entry) return false
        entries.delete(key(entry.selection))
        this.#bytes[entry.selection.kind] -= entry.bytes
        if (notify) this.#changed("delete", entry.selection)
        return true
    }

    #changed(op: "set" | "delete", selection: Selection) {
        if (this.changes?.active) this.changes.record(selection.kind, op, changeKey(selection))
    }

    #selections(request: ResourceRequest): readonly Selection[] {
        if (request.wholeGuild) return kinds.map((kind) => ({ kind, guildId: request.selection.guildId }))
        return request.members
            ? [request.selection, { kind: "members", guildId: request.selection.guildId }]
            : [request.selection]
    }

    #invalidate(selection: Selection, except?: ResourceGuard) {
        for (const request of this.#requests)
            if (request !== except && this.#selections(request).some((other) => overlaps(selection, other)))
                request.invalid = true
    }

    #evict(selection: Selection, except?: ResourceGuard) {
        this.#invalidate(selection, except)
        if (selection.id !== undefined) {
            const entry = this.#entries[selection.kind].get(key(selection))
            if (entry) this.#remove(entry)
            return
        }
        for (const entry of this.#entries[selection.kind].values())
            if (overlaps(selection, entry.selection)) this.#remove(entry)
    }

    begin(request: ResourceRequest): ResourceGuard {
        const guard = { ...request, generation: this.#generation, invalid: false, gapped: false, success: false }
        for (const other of this.#requests) {
            if (!this.#selections(guard).some((a) => this.#selections(other).some((b) => overlaps(a, b)))) continue
            if (guard.mutation) other.invalid = true
            if (other.mutation) guard.invalid = true
        }
        this.#requests.add(guard)
        return guard
    }

    complete(guard: ResourceGuard, result: unknown) {
        if (guard.batch && record(result)) result = result.success
        guard.success = true
        if (this.#closed) return
        if (guard.generation !== this.#generation || (!guard.mutation && guard.gapped)) {
            // A pre-gap write can still affect newer observations, but its response cannot repopulate them
            if (guard.mutation) this.missing(guard)
            return
        }
        // Guild request decoders own the result shape, and void writes never fabricate a snapshot
        const values: readonly Snapshot[] =
            result === undefined ? [] : Array.isArray(result) ? result : [result as Snapshot]
        if (guard.mutation || (guard.replace && !guard.invalid))
            for (const selection of this.#selections(guard)) this.#evict(selection, guard)
        for (const value of values) {
            const selection = this.#selection(guard.selection.kind, value)
            if (guard.invalid) {
                const entry = this.#peek(selection)
                if (entry && !isDeepStrictEqual(entry.value, value)) this.#evict(selection, guard)
            } else this.#observe(guard.selection.kind, value, guard)
        }
        this.#schedule()
    }

    missing(guard: ResourceGuard) {
        if (this.#closed || (!guard.mutation && (guard.generation !== this.#generation || guard.gapped))) return
        for (const selection of this.#selections(guard)) this.#evict(selection, guard)
        this.#schedule()
    }

    end(guard: ResourceGuard, uncertain: boolean) {
        if (!guard.success && guard.mutation && uncertain) this.missing(guard)
        this.#requests.delete(guard)
    }

    #selection(kind: ResourceKind, value: Snapshot): Selection {
        return {
            kind,
            guildId: "guildId" in value ? value.guildId : value.id,
            id: "userId" in value ? value.userId : value.id,
        }
    }

    #observe(kind: ResourceKind, value: Snapshot, except?: ResourceGuard) {
        if (this.#closed) return
        const selection = this.#selection(kind, value)
        this.#invalidate(selection, except)
        const settings = this.settings[kind]
        if (!settings) return
        const entries = this.#entries[kind]
        const resolved = retentionAge(settings.maxAgeMs, value, `${kind} cache`, "snapshot")
        if (this.#closed) return
        const previous = entries.get(key(selection))
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
                      JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item)),
                  )
        if (age === 0 || bytes > settings.maxBytes) {
            if (replaced) this.#changed("delete", selection)
            return
        }
        this.#purge()
        while (entries.size >= settings.maxEntries || this.#bytes[kind] > settings.maxBytes - bytes) {
            this.#remove(entries.values().next().value!)
            this.#stats[kind].evictions.capacity++
        }
        const entry: Entry = {
            selection,
            value,
            bytes,
            expires: age === null ? null : this.now() + age,
        }
        entries.set(key(selection), entry)
        this.#bytes[kind] += bytes
        if (entry.expires !== null) this.#expiry.push(entry as Entry & { expires: number })
        this.#changed("set", selection)
    }

    event(event: EventName, value: EventMap[EventName]) {
        if (this.#closed || !event.startsWith("guild")) return
        if ((event === "guildMemberAdd" || event === "guildMemberUpdate") && "roleIds" in value)
            this.#observe("members", value)
        else if (event === "guildMemberRemove" || event === "guildBanAdd" || event === "guildBanRemove") {
            const member = value as EventMap["guildMemberRemove"]
            this.#evict({ kind: "members", guildId: member.guildId, id: member.userId })
        } else if ((event === "guildRoleCreate" || event === "guildRoleUpdate") && "permissions" in value)
            this.#observe("roles", value)
        else if (event === "guildRoleUpdateBulk" && "roles" in value)
            for (const role of value.roles) this.#observe("roles", role)
        else if (event === "guildRoleDelete") {
            const { guildId } = value as EventMap["guildRoleDelete"]
            this.#evict({ kind: "roles", guildId })
            this.#evict({ kind: "members", guildId })
        }
        this.#schedule()
    }

    guildEvent(event: string, value: unknown) {
        if (this.#closed) return
        if (event === "GUILD_EMOJIS_UPDATE" || event === "GUILD_STICKERS_UPDATE") {
            if (!record(value) || !identifier(value.guild_id)) this.gap()
            else this.#evict({ kind: event === "GUILD_EMOJIS_UPDATE" ? "emojis" : "stickers", guildId: value.guild_id })
            this.#schedule()
            return
        }
        // Guild removal/unavailability must clear dependent resources, not just the guild's own entry
        if (!record(value) || !identifier(value.id)) {
            this.gap()
            return
        }
        if (event === "GUILD_DELETE") {
            for (const kind of kinds) this.#evict({ kind, guildId: value.id })
        } else {
            const guild = event === "GUILD_CREATE" ? decodeGuildSnapshot(value) : decodeGuild(value)
            if (guild) this.#observe("guilds", guild)
            else this.#evict({ kind: "guilds", guildId: value.id })
            if (guild && event === "GUILD_CREATE") this.#seed(value.id, value)
        }
        this.#schedule()
    }

    /**
     * Replace a guild's roles, emojis and stickers with the complete collections of its GUILD_CREATE snapshot.
     * Members are not seeded, because the snapshot lists only a few of them
     */
    #seed(guildId: string, snapshot: Readonly<Record<string, unknown>>) {
        const collections = {
            roles: () => decodeRoles(snapshot.roles, guildId),
            emojis: () => expressionItems("emojis", snapshot.emojis, guildId),
            stickers: () => expressionItems("stickers", snapshot.stickers, guildId),
        }
        for (const kind of ["roles", "emojis", "stickers"] as const) {
            this.#evict({ kind, guildId })
            // A malformed collection leaves the category empty for this guild rather than partly seeded
            if (this.settings[kind]) for (const item of collections[kind]() ?? []) this.#observe(kind, item)
        }
    }

    #purge() {
        this.#expiry.purge(this.now(), (entry) => {
            if (this.#remove(entry)) this.#stats[entry.selection.kind].evictions.expiry++
        })
    }

    #schedule() {
        if (this.#closed) {
            this.#timer.cancel()
            this.#expiry.clear()
            return
        }
        this.#expiry.compact(kinds.reduce((total, kind) => total + this.#entries[kind].size, 0))
        this.#timer.set(this.#expiry.next())
    }

    gap(affects?: (guildId: string | null | undefined) => boolean) {
        if (!affects) {
            this.#generation++
            for (const request of this.#requests) request.invalid = true
            for (const kind of kinds) {
                const held = this.#entries[kind].size > 0
                this.#entries[kind].clear()
                this.#bytes[kind] = 0
                if (held && this.changes?.active) this.changes.record(kind, "clear", null)
            }
            this.#expiry.clear()
        } else {
            this.pause(affects)
            for (const kind of kinds)
                for (const entry of this.#entries[kind].values())
                    if (affects(entry.selection.guildId)) this.#remove(entry)
        }
        this.#schedule()
    }

    /**
     * Keep in-flight reads for the affected guilds from storing their responses after the gateway connection was lost,
     * while retained entries stay. A successful Resume replays every missed dispatch, which keeps those entries current
     */
    pause(affects: (guildId: string | null | undefined) => boolean) {
        for (const request of this.#requests)
            if (affects(request.selection.guildId)) {
                request.invalid = true
                request.gapped = true
            }
    }

    close() {
        this.#closed = true
        this.gap()
        this.#requests.clear()
    }
}
