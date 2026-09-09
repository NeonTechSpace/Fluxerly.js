import assert from "node:assert/strict"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { parseEnv } from "node:util"
import { createGuildTestRole, cleanupGuildTestRole } from "./guild-fixture.mjs"

const mode = process.argv[2]
const selectedGuild = process.env.FLUXER_TEST_ROLE_RESET_GUILD_ID
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.role-reset.local", import.meta.url)
const rawFetch = globalThis.fetch
let stage = "configuration"
let lock, token, guildId, botId, journal, client, scope, Effect, Exit, Scope
let verified = false
const report = (check, details = {}) => console.log(JSON.stringify({ mode, check, passed: true, ...details }))
const sorted = (roles) => [...roles].sort((a, b) => a.id.localeCompare(b.id))
const withoutDisplay = (roles) => sorted(roles).map(({ hoist_position, ...role }) => role)

async function api(method, path, body) {
    const response = await rawFetch(`https://api.fluxer.app/v1${path}`, {
        method,
        headers: {
            Authorization: `Bot ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
    })
    const data = response.status === 204 ? (await response.body?.cancel(), null) : await response.json()
    assert.ok(response.ok)
    return { status: response.status, data }
}

async function value(operation) {
    if (mode === "default") {
        const result = await operation
        if (result.isErr()) throw result.error
        return result.value
    }
    const result = await Effect.runPromise(Effect.result(operation))
    if (result._tag === "Failure") throw result.failure
    return result.success
}

const save = () => writeFileSync(journalPath, JSON.stringify(journal))
async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.kind, "role-display-reset")
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    await cleanupGuildTestRole(api, journal)
    unlinkSync(journalPath)
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
    assert.match(selectedGuild ?? "", /^[1-9][0-9]{0,19}$/)
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    guildId = env.FLUXER_TEST_GUILD_ID
    token = env.FLUXER_TEST_BOT_TOKEN
    assert.equal(guildId, selectedGuild)
    assert.ok(token && token === token.trim())
    assert.match(env.FLUXER_TEST_APPLICATION_ID ?? "", /^[1-9][0-9]{0,19}$/)
    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    stage = "sandbox_identity"
    const [application, self, guild] = await Promise.all([
        api("GET", "/oauth2/applications/@me"),
        api("GET", "/users/@me"),
        api("GET", `/guilds/${guildId}`),
    ])
    assert.equal(application.data.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(application.data.bot?.id, self.data.id)
    assert.equal(self.data.bot, true)
    assert.equal(guild.data.id, guildId)
    botId = self.data.id
    verified = true
    report(stage)
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }

    stage = "original_display_preflight"
    const original = (await api("GET", `/guilds/${guildId}/roles`)).data
    assert.ok(Array.isArray(original) && original.length > 0)
    // This bounded check preserves existing assignments by requiring an initially cleared guild
    assert.ok(original.every((role) => role.hoist_position === null))
    report(stage, { originalRoleCount: original.length })
    journal = { kind: "role-display-reset", guildId, botId }
    writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })
    const first = await createGuildTestRole(api, journal, save)
    journal.secondRole = { guildId }
    const second = await createGuildTestRole(api, journal.secondRole, save)

    const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
    if (mode === "effect") {
        ;({ Effect, Exit, Scope } = await import("effect"))
        scope = Scope.makeUnsafe()
        client = await value(sdk.createClient({ token, cache: { roles: true } }).pipe(Scope.provide(scope)))
    } else client = await value(sdk.createClient({ token, cache: { roles: true } }))

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
        assert.equal((await value(client.roles.get({ guildId, id: first }))).hoistPosition, 7)

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
        assert.equal(await value(client.roles.get({ guildId, id: first })), undefined)
        const after = (await api("GET", `/guilds/${guildId}/roles`)).data
        assert.deepEqual(withoutDisplay(after), withoutDisplay(before))
        assert.ok(after.every((role) => role.hoist_position === null))
        assert.ok((await value(client.roles.fetchAll(guildId))).every((role) => role.hoistPosition === null))
        report(stage, { roleCount: after.length, singleDispatch: true, cacheInvalidated: true })
    }
    await cleanup()
    assert.deepEqual(sorted((await api("GET", `/guilds/${guildId}/roles`)).data), sorted(original))
    report("original_roles_restored")
} catch {
    console.error(JSON.stringify({ mode, check: stage, passed: false }))
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    try {
        try {
            if (client) {
                await value(client.shutdown())
                assert.equal(client.state, "Closed")
            }
        } finally {
            if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
        }
        if (client) report("client_closed")
    } catch {
        console.error(JSON.stringify({ mode, check: "client_cleanup", passed: false }))
        process.exitCode = 1
    }
    try {
        await cleanup()
    } catch {
        console.error(JSON.stringify({ mode, check: "role_cleanup", passed: false, journalRetained: true }))
        process.exitCode = 1
    }
    clearTimeout(watchdog)
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
