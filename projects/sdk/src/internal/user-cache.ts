import type { ResourceCacheSettings } from "#sdk/cache"
import type { CacheDiagnostic } from "#sdk/client"
import type { DirectMessageChannel, User } from "#sdk/users"
import type { LogicalScheduler, LogicalTimer } from "./logical-scheduler.js"

export type UserResources = { users: User; directMessages: DirectMessageChannel }
type Kind = keyof UserResources
type Entry = { value: User | DirectMessageChannel; bytes: number; expires: number | null }
const targetGuardCapacity = 256

export type UserCacheGuard = {
    readonly kind: Kind
    readonly id?: string
    readonly mutation: boolean
    readonly replace: boolean
    readonly collectionEpoch: object
    readonly targetEpoch: object
}

/** Optional client-owned public snapshots with collection and per-resource stale-completion fences */
export class UserCache {
    #entries = { users: new Map<string, Entry>(), directMessages: new Map<string, Entry>() }
    #bytes = { users: 0, directMessages: 0 }
    #collectionEpoch = { users: {}, directMessages: {} }
    #targetEpoch = { users: {}, directMessages: {} }
    // Keep only the latest active guard per ID, with a conservative collection fence if callers exceed the bound.
    #targets = {
        users: new Map<string, UserCacheGuard>(),
        directMessages: new Map<string, UserCacheGuard>(),
    }
    #closed = false
    #timer: ReturnType<typeof setTimeout> | LogicalTimer | undefined

    constructor(
        private readonly settings: Partial<Record<Kind, Required<ResourceCacheSettings>>>,
        private readonly now: () => number,
        private readonly logical?: LogicalScheduler,
    ) {}

    begin(kind: Kind, options: { id?: string; mutation?: boolean; replace?: boolean } = {}): UserCacheGuard {
        const mutation = options.mutation === true
        const replace = options.replace === true
        const collection = options.id === undefined || replace
        if (collection) this.#advanceCollection(kind)
        else {
            this.#targetEpoch[kind] = {}
            const targets = this.#targets[kind]
            if (!targets.has(options.id!) && targets.size >= targetGuardCapacity) this.#advanceCollection(kind)
        }
        const guard: UserCacheGuard = {
            kind,
            ...(options.id === undefined ? {} : { id: options.id }),
            mutation,
            replace,
            collectionEpoch: this.#collectionEpoch[kind],
            targetEpoch: this.#targetEpoch[kind],
        }
        if (!collection && !this.#closed) this.#targets[kind].set(options.id!, guard)
        if (mutation) {
            if (options.id === undefined) this.#clearKind(kind)
            else this.#remove(kind, options.id)
            this.#schedule()
        }
        return guard
    }

    complete(guard: UserCacheGuard, values: readonly (User | DirectMessageChannel)[]) {
        if (this.#closed) {
            this.#finish(guard)
            return
        }
        if (!this.#current(guard)) {
            // A stale write can still have changed Fluxer state, so evict only the resource it could affect.
            if (guard.mutation) this.invalidate(guard.kind, guard.id)
            this.#finish(guard)
            return
        }
        const settings = this.settings[guard.kind]
        if (guard.mutation) {
            if (guard.id === undefined) this.#clearKind(guard.kind)
            else this.#remove(guard.kind, guard.id)
        } else if (guard.replace) this.#clearKind(guard.kind)
        if (settings && settings.maxAgeMs !== 0 && settings.maxEntries !== 0) {
            this.#purge()
            for (const value of values) this.#observe(guard.kind, value, settings)
        }
        this.#finish(guard)
        this.#schedule()
    }

    get<K extends Kind>(kind: K, id: string): UserResources[K] | undefined {
        const entry = this.#peek(kind, id)
        if (!entry) return undefined
        this.#entries[kind].delete(id)
        this.#entries[kind].set(id, entry)
        return entry.value as UserResources[K]
    }

    diagnostics(kind: Kind): CacheDiagnostic {
        this.#purge()
        this.#schedule()
        const settings = this.settings[kind]
        return {
            configured: settings !== undefined,
            retainedEntries: this.#entries[kind].size,
            accountedBytes: this.#bytes[kind],
            maxEntries: settings?.maxEntries ?? null,
            maxBytes: settings?.maxBytes ?? null,
        }
    }

    entries<K extends Kind>(kind: K, limit: number): readonly UserResources[K][] {
        this.#purge()
        this.#schedule()
        const entries: UserResources[K][] = []
        for (const entry of this.#entries[kind].values()) {
            entries.push(entry.value as UserResources[K])
            if (entries.length === limit) break
        }
        return Object.freeze(entries)
    }

    /** Release retained account/conversation observations and make reads begun earlier ineligible to restore them */
    clear() {
        if (this.#closed) return
        this.gap()
    }

    invalidate(kind: Kind, id?: string) {
        if (this.#closed) return
        if (id === undefined) {
            this.#advanceCollection(kind)
            this.#clearKind(kind)
        } else {
            this.#targetEpoch[kind] = {}
            this.#targets[kind].delete(id)
            this.#remove(kind, id)
        }
        this.#schedule()
    }

    failed(guard: UserCacheGuard) {
        if (this.#closed) {
            this.#finish(guard)
            return
        }
        if (guard.mutation || this.#current(guard)) this.invalidate(guard.kind, guard.id)
        this.#finish(guard)
    }

    gap(affects?: (guildId: string | null | undefined) => boolean) {
        if (!affects || affects(undefined)) {
            this.#advanceCollection("users")
            this.#clearKind("users")
        }
        if (!affects || affects(null)) {
            this.#advanceCollection("directMessages")
            this.#clearKind("directMessages")
        }
        this.#schedule()
    }

    close() {
        if (this.#closed) return
        this.#closed = true
        this.#advanceCollection("users")
        this.#advanceCollection("directMessages")
        this.#clearKind("users")
        this.#clearKind("directMessages")
        this.#schedule()
    }

    #advanceCollection(kind: Kind) {
        this.#collectionEpoch[kind] = {}
        this.#targets[kind].clear()
    }

    #current(guard: UserCacheGuard) {
        if (guard.collectionEpoch !== this.#collectionEpoch[guard.kind]) return false
        return guard.id === undefined || guard.replace
            ? guard.targetEpoch === this.#targetEpoch[guard.kind]
            : this.#targets[guard.kind].get(guard.id) === guard
    }

    #finish(guard: UserCacheGuard) {
        if (guard.id !== undefined && !guard.replace && this.#targets[guard.kind].get(guard.id) === guard)
            this.#targets[guard.kind].delete(guard.id)
    }

    #peek(kind: Kind, id: string) {
        const entry = this.#entries[kind].get(id)
        if (entry && entry.expires !== null && entry.expires <= this.now()) {
            this.#remove(kind, id)
            return undefined
        }
        return entry
    }

    #remove(kind: Kind, id: string) {
        const entry = this.#entries[kind].get(id)
        if (!entry) return
        this.#entries[kind].delete(id)
        this.#bytes[kind] -= entry.bytes
    }

    #clearKind(kind: Kind) {
        this.#entries[kind].clear()
        this.#bytes[kind] = 0
    }

    #observe(kind: Kind, value: User | DirectMessageChannel, settings: Required<ResourceCacheSettings>) {
        this.#remove(kind, value.id)
        const bytes = Buffer.byteLength(JSON.stringify(value))
        if (bytes > settings.maxBytes) return
        const entries = this.#entries[kind]
        while (entries.size >= settings.maxEntries || this.#bytes[kind] > settings.maxBytes - bytes)
            this.#remove(kind, entries.keys().next().value!)
        entries.set(value.id, {
            value,
            bytes,
            expires: settings.maxAgeMs === null ? null : this.now() + settings.maxAgeMs,
        })
        this.#bytes[kind] += bytes
    }

    #purge() {
        const now = this.now()
        for (const kind of ["users", "directMessages"] as const)
            for (const [id, entry] of this.#entries[kind])
                if (entry.expires !== null && entry.expires <= now) this.#remove(kind, id)
    }

    #schedule() {
        if (this.#timer !== undefined)
            if (this.logical) this.logical.clear(this.#timer as LogicalTimer)
            else clearTimeout(this.#timer as ReturnType<typeof setTimeout>)
        this.#timer = undefined
        if (this.#closed) return
        let earliest = Infinity
        for (const kind of ["users", "directMessages"] as const)
            for (const entry of this.#entries[kind].values())
                if (entry.expires !== null) earliest = Math.min(earliest, entry.expires)
        if (earliest !== Infinity) {
            const callback = () => {
                this.#purge()
                this.#schedule()
            }
            const delay = Math.min(2_147_483_647, Math.max(1, Math.ceil(earliest - this.now())))
            if (this.logical) this.#timer = this.logical.set(callback, delay, "user cache")
            else {
                const timer = setTimeout(callback, delay)
                timer.unref()
                this.#timer = timer
            }
        }
    }
}
