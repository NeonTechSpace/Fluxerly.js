import { isDeepStrictEqual } from "node:util"
import type { Guild, GuildMember, GuildRole } from "#sdk/guilds"
import type { EventMap, EventName } from "#sdk/events"
import type { ResourceCacheSettings } from "#sdk/cache"
import { decodeGuild } from "./guilds.js"
import { identifier, record } from "./message.js"

export type ResourceKind = "guilds" | "members" | "roles"
export type Resources = { guilds: Guild; members: GuildMember; roles: GuildRole }
type Snapshot = Resources[ResourceKind]
export type ResourceConfiguration = Partial<Record<ResourceKind, Required<ResourceCacheSettings>>>
type Selection = { kind: ResourceKind; guildId: string; id?: string }
export type ResourceRequest = {
    selection: Selection
    mutation?: boolean
    replace?: boolean
    members?: boolean
}
export type ResourceGuard = ResourceRequest & { generation: number; invalid: boolean; success: boolean }
type Entry = { selection: Selection; value: Snapshot; bytes: number; expires: number | null }
const kinds = ["guilds", "members", "roles"] as const
const key = (selection: Selection) => `${selection.guildId}:${selection.id ?? selection.guildId}`
const overlaps = (a: Selection, b: Selection) =>
    a.kind === b.kind && a.guildId === b.guildId && (a.id === undefined || b.id === undefined || a.id === b.id)

/** One client's resource observations; REST owns bounded request admission and this owner retains no historical tombstones */
export class GuildCache {
    #entries = { guilds: new Map<string, Entry>(), members: new Map<string, Entry>(), roles: new Map<string, Entry>() }
    #bytes = { guilds: 0, members: 0, roles: 0 }
    #requests = new Set<ResourceGuard>()
    #generation = 0
    #closed = false
    #timer: ReturnType<typeof setTimeout> | undefined

    constructor(
        private readonly settings: ResourceConfiguration,
        private readonly now: () => number,
    ) {}

    get<K extends ResourceKind>(kind: K, guildId: string, id?: string): Resources[K] | undefined {
        const selection = { kind, guildId, ...(id === undefined ? {} : { id }) }
        const entry = this.#peek(selection)
        if (!entry) return undefined
        const entries = this.#entries[kind]
        entries.delete(key(selection))
        entries.set(key(selection), entry)
        return entry.value as Resources[K]
    }

    #peek(selection: Selection) {
        const entry = this.#entries[selection.kind].get(key(selection))
        if (entry && entry.expires !== null && entry.expires <= this.now()) {
            this.#remove(entry)
            return undefined
        }
        return entry
    }

    #remove(entry: Entry) {
        this.#entries[entry.selection.kind].delete(key(entry.selection))
        this.#bytes[entry.selection.kind] -= entry.bytes
    }

    #selections(request: ResourceRequest): readonly Selection[] {
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
        for (const entry of this.#entries[selection.kind].values())
            if (overlaps(selection, entry.selection)) this.#remove(entry)
    }

    begin(request: ResourceRequest): ResourceGuard {
        const guard = { ...request, generation: this.#generation, invalid: false, success: false }
        for (const other of this.#requests) {
            if (!this.#selections(guard).some((a) => this.#selections(other).some((b) => overlaps(a, b)))) continue
            if (guard.mutation) other.invalid = true
            if (other.mutation) guard.invalid = true
        }
        this.#requests.add(guard)
        return guard
    }

    complete(guard: ResourceGuard, result: unknown) {
        guard.success = true
        if (this.#closed) return
        if (guard.generation !== this.#generation) {
            // A pre-gap write can still affect newer observations, but its response cannot repopulate them
            if (guard.mutation) this.missing(guard)
            return
        }
        // Guild request decoders own the result shape; void writes never fabricate a snapshot
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
        if (this.#closed || (!guard.mutation && guard.generation !== this.#generation)) return
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
        const previous = entries.get(key(selection))
        if (previous) this.#remove(previous)
        if (settings.maxAgeMs === 0) return
        const bytes = Buffer.byteLength(
            JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item)),
        )
        if (bytes > settings.maxBytes) return
        this.#purge()
        while (entries.size >= settings.maxEntries || this.#bytes[kind] > settings.maxBytes - bytes)
            this.#remove(entries.values().next().value!)
        entries.set(key(selection), {
            selection,
            value,
            bytes,
            expires: settings.maxAgeMs === null ? null : this.now() + settings.maxAgeMs,
        })
        this.#bytes[kind] += bytes
    }

    event(event: EventName, value: EventMap[EventName]) {
        if (this.#closed || !event.startsWith("guild")) return
        if ((event === "guildMemberAdd" || event === "guildMemberUpdate") && "roleIds" in value)
            this.#observe("members", value)
        else if (
            (event === "guildMemberRemove" || event === "guildBanAdd" || event === "guildBanRemove") &&
            "guildId" in value &&
            "userId" in value
        )
            this.#evict({ kind: "members", guildId: value.guildId, id: value.userId })
        else if ((event === "guildRoleCreate" || event === "guildRoleUpdate") && "permissions" in value)
            this.#observe("roles", value)
        else if (event === "guildRoleUpdateBulk" && "roles" in value)
            for (const role of value.roles) this.#observe("roles", role)
        else if (event === "guildRoleDelete" && "guildId" in value) {
            this.#evict({ kind: "roles", guildId: value.guildId })
            this.#evict({ kind: "members", guildId: value.guildId })
        }
        this.#schedule()
    }

    guildEvent(event: string, value: unknown) {
        if (this.#closed) return
        // Guild removal/unavailability must clear dependent resources, not just the guild's own entry
        if (!record(value) || !identifier(value.id)) {
            this.gap()
            return
        }
        if (event === "GUILD_DELETE") {
            for (const kind of kinds) this.#evict({ kind, guildId: value.id })
        } else {
            const guild = decodeGuild(value)
            if (guild) this.#observe("guilds", guild)
            else this.#evict({ kind: "guilds", guildId: value.id })
        }
        this.#schedule()
    }

    #purge() {
        const now = this.now()
        for (const kind of kinds)
            for (const entry of this.#entries[kind].values())
                if (entry.expires !== null && entry.expires <= now) this.#remove(entry)
    }

    #schedule() {
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = undefined
        if (this.#closed) return
        let next = Infinity
        for (const kind of kinds)
            for (const entry of this.#entries[kind].values())
                if (entry.expires !== null) next = Math.min(next, entry.expires)
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

    gap() {
        this.#generation++
        for (const request of this.#requests) request.invalid = true
        for (const kind of kinds) {
            this.#entries[kind].clear()
            this.#bytes[kind] = 0
        }
        this.#schedule()
    }

    close() {
        this.#closed = true
        this.gap()
        this.#requests.clear()
    }
}
