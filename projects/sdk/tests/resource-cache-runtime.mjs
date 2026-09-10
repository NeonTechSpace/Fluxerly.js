import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Exit, Scope } from "effect"
import { createClient } from "@neontechspace/fluxerly"
import { createClient as createNative } from "@neontechspace/fluxerly/effect"

assert.equal(typeof globalThis.gc, "function")
const originalFetch = globalThis.fetch
const guildId = "1234567890123456789"
const userId = (index) => (2234567890123456000n + BigInt(index)).toString()
const roleIds = Array.from({ length: 250 }, (_, index) => (3234567890123456000n + BigInt(index)).toString())
let large = false
let requests = 0
globalThis.fetch = async (input) => {
    requests++
    const path = new URL(input).pathname
    if (path.endsWith("/members"))
        return Response.json(
            Array.from({ length: 1000 }, (_, index) => ({
                user: { id: userId(index), username: "member" },
                roles: large ? roleIds : roleIds.slice(0, 3),
                joined_at: "2026-09-08T00:00:00.000Z",
            })),
        )
    if (path.endsWith("/roles"))
        return Response.json([
            {
                id: roleIds[0],
                name: "Readers",
                color: 0,
                position: 1,
                permissions: "18446744073709551615",
                hoist: false,
                mentionable: false,
            },
        ])
    return Response.json({ id: guildId, name: "Community", owner_id: userId(0), features: [] })
}

const unwrap = (result) => {
    assert.ok(result.isOk())
    return result.value
}
async function client(mode, settings) {
    const scope = Scope.makeUnsafe()
    const cache = { guilds: settings, members: settings, roles: settings }
    const c =
        mode === "default"
            ? unwrap(createClient({ token: "fixture-only", cache }))
            : await Effect.runPromise(createNative({ token: "fixture-only", cache }).pipe(Scope.provide(scope)))
    const run = (value) => (mode === "default" ? Promise.resolve(value).then(unwrap) : Effect.runPromise(value))
    return {
        fill: () => run(c.members.fetchPage(guildId, { limit: 1000 })),
        guild: () => run(c.guilds.fetch(guildId)),
        roles: () => run(c.roles.fetchAll(guildId)),
        get: (index) => run(c.members.get({ guildId, userId: userId(index) })),
        diagnostics: () => c.diagnostics(),
        clear: () => c.cache.clear(),
        close: async () => {
            await run(c.shutdown())
            await Effect.runPromise(Scope.close(scope, Exit.void))
        },
    }
}
async function collect(weak) {
    for (let round = 0; round < 30; round++) {
        await sleep(20)
        globalThis.gc()
        if (weak.every((ref) => ref.deref() === undefined)) return
    }
    assert.fail("Resource snapshots remained strongly retained")
}
async function weakSnapshots(api) {
    const guild = await api.guild()
    const members = await api.fill()
    const roles = await api.roles()
    return [new WeakRef(guild), new WeakRef(members[999]), new WeakRef(roles[0])]
}
try {
    for (const mode of ["default", "native"]) {
        for (const manyRoles of [false, true]) {
            large = manyRoles
            const api = await client(mode, true)
            try {
                const rows = await api.fill()
                const bytes = Buffer.byteLength(JSON.stringify(rows[0]))
                let retained = 0
                const before = requests
                const started = performance.now()
                for (let i = 0; i < 1000; i++) if (await api.get(i)) retained++
                const lookupMs = performance.now() - started
                assert.equal(requests, before)
                assert.equal(retained, Math.min(1000, Math.floor(4_194_304 / bytes)))
                console.log(
                    JSON.stringify({ mode, check: "resource_cache_workload", manyRoles, bytes, retained, lookupMs }),
                )
            } finally {
                await api.close()
            }
        }
        large = false
        const expiring = await client(mode, { maxAgeMs: 30 })
        try {
            const weak = await weakSnapshots(expiring)
            await sleep(80)
            // No cache lookup or shutdown may be used to trigger expiry before this GC assertion
            await collect(weak)
        } finally {
            await expiring.close()
        }
        const cleared = await client(mode, true)
        try {
            const weak = await weakSnapshots(cleared)
            cleared.clear()
            const diagnostics = cleared.diagnostics()
            for (const kind of ["guilds", "members", "roles"])
                assert.deepEqual(diagnostics.caches[kind], {
                    configured: true,
                    retainedEntries: 0,
                    accountedBytes: 0,
                    maxEntries: 1000,
                    maxBytes: 4194304,
                })
            await collect(weak)
        } finally {
            await cleared.close()
        }
        console.log(JSON.stringify({ mode, check: "resource_cache_clear_release", passed: true }))
        const closing = await client(mode, true)
        const weak = await weakSnapshots(closing)
        await closing.close()
        await collect(weak)
        console.log(JSON.stringify({ mode, check: "resource_cache_active_expiry_and_shutdown", passed: true }))
    }
} finally {
    globalThis.fetch = originalFetch
}
