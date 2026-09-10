import type { ResourceCacheSettings } from "#sdk/cache"
import type { DirectMessageChannel, User } from "#sdk/users"

export type UserResources = { users: User; directMessages: DirectMessageChannel }
type Kind = keyof UserResources
type Entry = { value: User | DirectMessageChannel; bytes: number; expires: number }

/** Optional client-owned public snapshots; conservative generations prevent overlapping reads resurrecting stale data */
export class UserCache {
    #entries = { users: new Map<string, Entry>(), directMessages: new Map<string, Entry>() }
    #generation = { users: 0, directMessages: 0 }
    #closed = false
    #timer: ReturnType<typeof setTimeout> | undefined
    constructor(
        private readonly settings: Partial<Record<Kind, Required<ResourceCacheSettings>>>,
        private readonly now: () => number,
    ) {}
    begin(kind: Kind, mutation: boolean) {
        if (mutation) this.#entries[kind].clear()
        this.#schedule()
        return ++this.#generation[kind]
    }
    complete(kind: Kind, generation: number, values: readonly (User | DirectMessageChannel)[], replace = false) {
        if (this.#closed || generation !== this.#generation[kind]) return
        const settings = this.settings[kind]
        if (!settings) return
        if (replace) this.#entries[kind].clear()
        for (const value of values) {
            this.#entries[kind].delete(value.id)
            const bytes = Buffer.byteLength(JSON.stringify(value))
            if (bytes > settings.maxBytes || settings.maxAgeMs === 0) continue
            this.#entries[kind].set(value.id, {
                value,
                bytes,
                expires: settings.maxAgeMs === null ? Infinity : this.now() + settings.maxAgeMs,
            })
            let total = [...this.#entries[kind].values()].reduce((sum, entry) => sum + entry.bytes, 0)
            while (total > settings.maxBytes || this.#entries[kind].size > settings.maxEntries) {
                const id = this.#entries[kind].keys().next().value!
                total -= this.#entries[kind].get(id)!.bytes
                this.#entries[kind].delete(id)
            }
        }
        this.#schedule()
    }
    get<K extends Kind>(kind: K, id: string): UserResources[K] | undefined {
        this.#expire()
        return this.#entries[kind].get(id)?.value as UserResources[K] | undefined
    }
    invalidate(kind: Kind) {
        this.#generation[kind]++
        this.#entries[kind].clear()
        this.#schedule()
    }
    failed(kind: Kind, generation: number) {
        if (generation === this.#generation[kind]) this.invalidate(kind)
    }
    gap(affects?: (guildId: string | null | undefined) => boolean) {
        if (!affects || affects(undefined)) this.invalidate("users")
        if (!affects || affects(null)) this.invalidate("directMessages")
    }
    close() {
        this.#closed = true
        this.gap()
    }
    #expire() {
        for (const kind of ["users", "directMessages"] as const)
            for (const [id, entry] of this.#entries[kind])
                if (entry.expires <= this.now()) this.#entries[kind].delete(id)
    }
    #schedule() {
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = undefined
        this.#expire()
        if (this.#closed) return
        let earliest = Infinity
        for (const kind of ["users", "directMessages"] as const)
            for (const entry of this.#entries[kind].values()) earliest = Math.min(earliest, entry.expires)
        if (Number.isFinite(earliest))
            this.#timer = setTimeout(
                () => this.#schedule(),
                Math.min(2_147_483_647, Math.max(1, earliest - this.now())),
            )
        this.#timer?.unref()
    }
}
