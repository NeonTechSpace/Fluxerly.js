// Role display-position reset on a sandbox server with initially cleared positions: a successful reset and a
// lost-response reset each dispatch once, invalidate cached roles and leave every other role field unchanged.
// Journal `.env.test.role-reset.local` records the sandbox and bot identity and two test roles. An existing
// journal triggers recovery only, with verified test-role deletion
import { typedResult } from "./support/results.js"
import assert from "node:assert/strict"
import { createGuildTestRole, cleanupGuildTestRole } from "./guild-fixture.mjs"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    processValue,
    verifySandboxIdentity,
} from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { createSandboxApi } from "./support/sandbox-api.js"

const mode = process.argv[2]
const journalFile = openJournal("role-reset")
const rawFetch = globalThis.fetch
let stage = "configuration"
let lock, token, guildId, botId, journal, client, scope, Effect, Exit, Scope
let verified = false
const report = createReporter({ mode }, { passed: true })
const sorted = (roles) => [...roles].sort((a, b) => a.id.localeCompare(b.id))
const withoutDisplay = (roles) => sorted(roles).map(({ hoist_position: _hoistPosition, ...role }) => role)

const api = createSandboxApi({ fetch: rawFetch, token: () => token, timeoutMs: 10_000 })

async function value(operation) {
    if (mode === "default") {
        const result = await operation
        if (result.isErr()) throw result.error
        return result.value
    }
    const result = await Effect.runPromise(typedResult(Effect, operation))
    if (result._tag === "Failure") throw result.failure
    return result.success
}

// Cache lookups return the entry or undefined directly in the default API and as an Effect in the native API
const cached = (lookup) => (mode === "default" ? lookup : Effect.runPromise(lookup))

const save = () => journalFile.save(journal)
async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.kind, "role-display-reset")
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    await cleanupGuildTestRole(api, journal, save)
    journalFile.remove()
    journal = undefined
    report("test_roles_removed")
}

const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, check: stage, passed: false, reason: "deadline", cleanupVerified: false }))
    process.exit(1)
}, 120_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.equal(process.argv.length, 3)
    // The selected server must be confirmed by the current process, never by the stored configuration alone
    const selectedGuild = processValue("FLUXER_TEST_ROLE_RESET_GUILD_ID")
    const sandbox = loadSandboxEnvironment()
    guildId = sandbox.guildId
    token = sandbox.token
    assert.equal(guildId, selectedGuild)
    stage = "sandbox_lock"
    lock = acquireLock()
    stage = "sandbox_identity"
    const identity = await verifySandboxIdentity(async (path) => (await api("GET", path)).data, {
        applicationId: sandbox.applicationId,
        guildId,
        applicationPath: "/oauth2/applications/@me",
        concurrent: true,
    })
    botId = identity.botId
    verified = true
    report(stage)
    if (journalFile.exists()) {
        journal = journalFile.read()
        stage = "recovery_only"
        await cleanup()
        report(stage)
    } else {
        stage = "original_display_preflight"
        const original = (await api("GET", `/guilds/${guildId}/roles`)).data
        assert.ok(Array.isArray(original) && original.length > 0)
        // This bounded check preserves existing assignments by requiring an initially cleared guild
        assert.ok(original.every((role) => role.hoist_position === null))
        report(stage, { originalRoleCount: original.length })
        journal = { kind: "role-display-reset", guildId, botId }
        journalFile.create(journal)
        const first = await createGuildTestRole(api, journal, save)
        journal.secondRole = { guildId }
        const second = await createGuildTestRole(api, journal.secondRole, save)

        const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
        if (mode === "effect") {
            ;({ Effect, Exit, Scope } = await import("effect"))
            scope = Scope.makeUnsafe()
            client = await value(sdk.createClient({ token, cache: { roles: true } }).pipe(Scope.provide(scope)))
        } else client = sdk.createClient({ token, cache: { roles: true } })

        const positions = [
            { id: first, hoistPosition: 7 },
            { id: second, hoistPosition: -3 },
        ]
        for (const loseResponse of [false, true]) {
            stage = "seed_distinct_display_positions"
            await value(client.roles.setHoistPositions(guildId, positions))
            const before = (await api("GET", `/guilds/${guildId}/roles`)).data
            for (const position of positions)
                assert.equal(before.find((role) => role.id === position.id)?.hoist_position, position.hoistPosition)
            assert.deepEqual(sorted(before.filter((role) => role.id !== first && role.id !== second)), sorted(original))
            await value(client.roles.fetchAll(guildId))
            assert.equal((await cached(client.roles.get({ guildId, id: first }))).hoistPosition, 7)

            stage = loseResponse ? "reset_lost_response" : "reset_success"
            let dispatches = 0
            globalThis.fetch = async (request, options) => {
                const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url)
                if (options?.method !== "DELETE" || url.pathname !== `/v1/guilds/${guildId}/roles/hoist-positions`)
                    return rawFetch(request, options)
                dispatches++
                assert.equal(dispatches, 1)
                assert.equal(options.body, undefined)
                const response = await rawFetch(request, options)
                assert.equal(response.status, 204)
                if (!loseResponse) return response
                await response.body?.cancel()
                throw new TypeError("Intentionally lost reset response")
            }
            try {
                if (loseResponse) {
                    await assert.rejects(value(client.roles.resetHoistPositions(guildId)), (error) => {
                        assert.equal(error._tag, "GuildOperationError")
                        assert.equal(error.reason, "network")
                        assert.equal(error.outcome, "unknown")
                        return true
                    })
                } else assert.equal(await value(client.roles.resetHoistPositions(guildId)), undefined)
            } finally {
                globalThis.fetch = rawFetch
            }
            assert.equal(dispatches, 1)
            assert.equal(await cached(client.roles.get({ guildId, id: first })), undefined)
            const after = (await api("GET", `/guilds/${guildId}/roles`)).data
            assert.deepEqual(withoutDisplay(after), withoutDisplay(before))
            assert.ok(after.every((role) => role.hoist_position === null))
            assert.ok((await value(client.roles.fetchAll(guildId))).every((role) => role.hoistPosition === null))
            report(stage, { roleCount: after.length, singleDispatch: true, cacheInvalidated: true })
        }
        await cleanup()
        assert.deepEqual(sorted((await api("GET", `/guilds/${guildId}/roles`)).data), sorted(original))
        report("original_roles_restored")
    }
} catch {
    console.error(JSON.stringify({ mode, check: stage, passed: false }))
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    // Keep the journal, lock and deadline if the client or its scope may still be writing
    await finalizeOwned({
        writers: [
            client && ["client_cleanup", () => value(client.shutdown())],
            scope && ["scope_cleanup", () => Effect.runPromise(Scope.close(scope, Exit.void))],
        ],
        checks: [client && ["client_cleanup", () => assert.equal(client.state, "Closed")]],
        cleanup: async () => {
            if (client) report("client_closed")
            await cleanup()
        },
        lock,
        watchdog,
        onFailure: (finalizer) => {
            if (finalizer === "cleanup")
                console.error(JSON.stringify({ mode, check: "role_cleanup", passed: false, journalRetained: true }))
            else if (finalizer === "sandbox_lock")
                console.error(
                    JSON.stringify({ mode, check: "sandbox_lock_cleanup", passed: false, lockRetained: true }),
                )
            else console.error(JSON.stringify({ mode, check: finalizer, passed: false }))
            process.exitCode = 1
        },
    })
}
