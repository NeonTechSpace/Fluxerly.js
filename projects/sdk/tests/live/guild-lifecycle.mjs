import assert from "node:assert/strict"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { parseEnv } from "node:util"
import { Effect, Exit, Scope, Stream } from "effect"

const mode = process.argv[2]
const leave = process.argv.includes("--leave")
const loseResponse = process.argv.includes("--lose-response")
assert.ok(mode === "default" || mode === "effect")
assert.ok(!loseResponse || leave)
// A stored target is not current leave authorization; this value must be supplied for this invocation
const targetId = process.env.FLUXER_TEST_LEAVE_GUILD_ID
if (leave) assert.match(targetId ?? "", /^[1-9][0-9]{0,19}$/)
const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
let lock
let client
let scope
let token
let stage = "configuration"
const report = (check, details = {}) => console.log(JSON.stringify({ mode, check, passed: true, ...details }))

async function value(operation) {
    if (Effect.isEffect(operation)) {
        const result = await Effect.runPromise(Effect.result(operation))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
}

async function api(path) {
    const response = await rawFetch(`https://api.fluxer.app/v1${path}`, {
        headers: { Authorization: `Bot ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
    })
    assert.ok(response.ok, `Sandbox HTTP ${response.status}`)
    return response.json()
}

async function rawMemberships() {
    const ids = []
    let cursor
    for (let page = 0; page < 20; page++) {
        const batch = await api(`/users/@me/guilds?limit=200&with_counts=false${cursor ? `&after=${cursor}` : ""}`)
        assert.ok(Array.isArray(batch) && batch.length <= 200)
        if (batch.length === 0) return ids
        for (const guild of batch) {
            assert.match(guild.id, /^[1-9][0-9]*$/)
            assert.ok(cursor === undefined || BigInt(guild.id) > BigInt(cursor))
            ids.push(guild.id)
            cursor = guild.id
        }
    }
    throw new Error("Membership inventory exceeded the live check bound")
}

async function waitForObservation(read) {
    const deadline = performance.now() + 15_000
    while (read() === undefined) {
        assert.equal(client.state, "Connected")
        assert.ok(performance.now() < deadline, "Guild event observation deadline")
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return read()
}

const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", readdMayBeRequired: leave }))
    process.exit(1)
}, 90_000).unref()

try {
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    const env = { ...parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8")), ...process.env }
    token = env.FLUXER_TEST_BOT_TOKEN
    assert.ok(token && token === token.trim())
    assert.match(env.FLUXER_TEST_GUILD_ID ?? "", /^[1-9][0-9]*$/)
    assert.match(env.FLUXER_TEST_APPLICATION_ID ?? "", /^[1-9][0-9]*$/)
    stage = "sandbox_identity"
    const [application, self, sandbox] = await Promise.all([
        api("/applications/@me"),
        api("/users/@me"),
        api(`/guilds/${env.FLUXER_TEST_GUILD_ID}`),
    ])
    assert.equal(application.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(application.bot?.id, self.id)
    assert.equal(self.bot, true)
    assert.equal(sandbox.id, env.FLUXER_TEST_GUILD_ID)
    report(stage)
    const sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
    if (mode === "default") client = sdk.createClient({ token, cache: { guilds: true } })._unsafeUnwrap()
    else {
        scope = Scope.makeUnsafe()
        client = await Effect.runPromise(
            sdk.createClient({ token, cache: { guilds: true } }).pipe(Scope.provide(scope)),
        )
    }
    stage = "membership_pages_and_traversal"
    const expected = await rawMemberships()
    assert.ok(expected.includes(sandbox.id))
    const page = await value(client.guilds.fetchPage({ limit: 200 }))
    assert.ok(Object.isFrozen(page) && page.every(Object.isFrozen))
    assert.deepEqual(
        page.map((guild) => guild.id),
        expected.slice(0, 200),
    )
    assert.equal(await value(client.guilds.get(sandbox.id)), undefined)
    const traversal = client.guilds.iterate({ maxItems: 4000, maxPages: 20 })
    const actual = []
    if (mode === "effect") {
        for (const guild of await Effect.runPromise(Stream.runCollect(traversal))) actual.push(guild.id)
    } else for await (const guild of traversal) actual.push((await value(guild)).id)
    assert.deepEqual(actual, expected)
    report(stage)
    if (leave) {
        stage = "leave_target_identity"
        assert.ok(expected.includes(targetId), "The bot must be re-added before another leave invocation")
        const target = await api(`/guilds/${targetId}`)
        assert.equal(target.id, targetId)
        assert.notEqual(target.owner_id, self.id)
        let available
        let deleted
        const listen = async (event, receive) =>
            mode === "default"
                ? value(client.on(event, receive))
                : value(client.on(event, (item) => Effect.sync(() => receive(item))).pipe(Scope.provide(scope)))
        await listen("guildCreate", (guild) => {
            if (guild.id === targetId) available = guild
        })
        await listen("guildDelete", (guild) => {
            if (guild.id === targetId) deleted = guild
        })
        stage = "leave_target_gateway_availability"
        await value(client.connect())
        assert.equal((await waitForObservation(() => available)).id, targetId)
        assert.equal(deleted, undefined)
        await value(client.guilds.fetch(targetId))
        assert.ok(await value(client.guilds.get(targetId)))
        report(stage, { targetId, readdRequiredAfterward: true })
        let dispatched = 0
        globalThis.fetch = async (url, init) => {
            const parsed = new URL(url)
            if (init?.method === "DELETE" && parsed.pathname === `/v1/users/@me/guilds/${targetId}`) {
                dispatched++
                assert.equal(parsed.searchParams.get("delete_messages"), "false")
                assert.equal(init.body, undefined)
                const response = await rawFetch(url, init)
                if (loseResponse && response.status === 204) {
                    await response.body?.cancel()
                    throw new TypeError("Test-owned response loss")
                }
                return response
            }
            return rawFetch(url, init)
        }
        stage = "leave_and_independent_membership_readback"
        if (loseResponse) {
            await assert.rejects(
                () => value(client.guilds.leave(targetId)),
                (error) =>
                    error?._tag === "GuildOperationError" &&
                    error.operation === "guilds.leave" &&
                    error.outcome === "unknown",
            )
        } else await value(client.guilds.leave(targetId))
        assert.equal(dispatched, 1)
        const departure = await waitForObservation(() => deleted)
        assert.deepEqual(departure, { id: targetId, unavailable: false, unavailableHidden: false })
        assert.ok(Object.isFrozen(departure))
        assert.equal(await value(client.guilds.get(targetId)), undefined)
        const after = await rawMemberships()
        assert.ok(!after.includes(targetId))
        assert.deepEqual(
            after,
            expected.filter((id) => id !== targetId),
        )
        assert.notEqual(client.state, "Closed")
        if (targetId !== sandbox.id) assert.equal((await value(client.guilds.fetch(sandbox.id))).id, sandbox.id)
        report(stage, { targetId, uncertainResponseReconciled: loseResponse, readdRequired: true })
    }
} catch (error) {
    console.error(
        JSON.stringify({
            mode,
            stage,
            passed: false,
            tag: error?._tag ?? error?.name ?? "Error",
            ...(typeof error?.reason === "string" ? { reason: error.reason } : {}),
            ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
            readdMayBeRequired: leave,
        }),
    )
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    let quiescent = true
    const retainEvidence = (finalizer) => {
        quiescent = false
        console.error(
            JSON.stringify({ mode, stage: "sdk_cleanup", passed: false, finalizer, lockRetained: lock !== undefined }),
        )
        process.exitCode = 1
    }
    if (client)
        try {
            await value(client.shutdown())
        } catch {
            retainEvidence("client_shutdown")
        }
    if (scope)
        try {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        } catch {
            retainEvidence("scope_close")
        }
    if (quiescent)
        try {
            if (client) assert.equal(client.state, "Closed")
            report("sdk_closed")
        } catch {
            retainEvidence("client_state")
        }
    if (quiescent && lock !== undefined)
        try {
            closeSync(lock)
            unlinkSync(lockPath)
        } catch {
            retainEvidence("sandbox_lock_cleanup")
        }
    if (quiescent) clearTimeout(watchdog)
}
