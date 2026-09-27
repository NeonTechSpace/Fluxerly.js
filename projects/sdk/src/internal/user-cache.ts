/**
 * Optional user and private-conversation cache with collection and per-resource stale-completion fences.
 * Invariant: It keeps public snapshots only, bounded per resource, and a stale completion never repopulates invalidated data.
 * Every applied store, removal and whole-kind clear is recorded to the client's change hub, a replacement counting as one store.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { ResourceCacheSettings } from "#sdk/cache"
import type { CacheDiagnostic } from "#sdk/client"
import type { DirectMessageChannel, User } from "#sdk/users"
import { ExpiryQueue, ExpiryTimer } from "./expiry-queue.js"
import type { LogicalScheduler } from "./logical-scheduler.js"
import type { CacheChangeHub } from "./cache-changes.js"

export type UserResources = { users: User; directMessages: DirectMessageChannel }
type Kind = keyof UserResources
type Entry = { kind: Kind; value: User | DirectMessageChannel; bytes: number; expires: number | null }
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
    // Keep only the latest active guard per ID, with a conservative collection fence if callers exceed the bound
    #targets = {
        users: new Map<string, UserCacheGuard>(),
        directMessages: new Map<string, UserCacheGuard>(),
    }
    #closed = false
    #expiry = new ExpiryQueue<Entry & { expires: number }>(
        (entry) => this.#entries[entry.kind].get(entry.value.id) === entry,
    )
    #timer: ExpiryTimer

    constructor(
        private readonly settings: Partial<Record<Kind, Required<ResourceCacheSettings>>>,
        private readonly now: () => number,
        logical?: LogicalScheduler,
        readonly changes?: CacheChangeHub,
    ) {
        this.#timer = new ExpiryTimer(
            "user cache",
            now,
            () => {
                this.#purge()
                this.#schedule()
            },
            logical,
        )
    }

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
            // A stale write can still have changed Fluxer state, so evict only the resource it could affect
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

    /** Remove one retained snapshot, reporting the deletion unless the caller replaces it. Returns whether one was removed */
    #remove(kind: Kind, id: string, notify = true): boolean {
        const entry = this.#entries[kind].get(id)
        if (!entry) return false
        this.#entries[kind].delete(id)
        this.#bytes[kind] -= entry.bytes
        if (notify && this.changes?.active) this.changes.record(kind, "delete", id)
        return true
    }

    #clearKind(kind: Kind) {
        const held = this.#entries[kind].size > 0
        this.#entries[kind].clear()
        this.#bytes[kind] = 0
        if (held && this.changes?.active) this.changes.record(kind, "clear", null)
    }

    #observe(kind: Kind, value: User | DirectMessageChannel, settings: Required<ResourceCacheSettings>) {
        // A replacement reports one set, while an older copy that the new one cannot replace reports a delete
        const replaced = this.#remove(kind, value.id, false)
        const bytes = Buffer.byteLength(JSON.stringify(value))
        if (bytes > settings.maxBytes) {
            if (replaced && this.changes?.active) this.changes.record(kind, "delete", value.id)
            return
        }
        const entries = this.#entries[kind]
        while (entries.size >= settings.maxEntries || this.#bytes[kind] > settings.maxBytes - bytes)
            this.#remove(kind, entries.keys().next().value!)
        const entry: Entry = {
            kind,
            value,
            bytes,
            expires: settings.maxAgeMs === null ? null : this.now() + settings.maxAgeMs,
        }
        entries.set(value.id, entry)
        this.#bytes[kind] += bytes
        if (entry.expires !== null) this.#expiry.push(entry as Entry & { expires: number })
        if (this.changes?.active) this.changes.record(kind, "set", value.id)
    }

    #purge() {
        this.#expiry.purge(this.now(), (entry) => this.#remove(entry.kind, entry.value.id))
    }

    #schedule() {
        if (this.#closed) {
            this.#timer.cancel()
            this.#expiry.clear()
            return
        }
        this.#expiry.compact(this.#entries.users.size + this.#entries.directMessages.size)
        this.#timer.set(this.#expiry.next())
    }
}
