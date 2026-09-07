import assert from "node:assert/strict"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"

const mode = process.argv[2]
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const report = (check, details = {}) => console.log(JSON.stringify({ mode, check, ...details }))
let stage = "configuration"
let lock

async function get(path, token) {
    const response = await fetch(`https://api.fluxer.app/v1${path}`, {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
    })
    if (!response.ok) {
        await response.body?.cancel()
        throw new Error("Identity request failed")
    }
    return response.json()
}

async function observeHeartbeat(client) {
    stage = "heartbeat"
    const deadline = performance.now() + 65_000
    while (client.gatewayLatencyMs === null) {
        assert.equal(client.state, "Connected")
        assert.ok(performance.now() < deadline)
        await sleep(100)
    }
    assert.ok(Number.isFinite(client.gatewayLatencyMs) && client.gatewayLatencyMs >= 0)
    report(stage, { passed: true, latencyMs: client.gatewayLatencyMs })
}

// A watchdog is failure containment, never evidence of successful cleanup
// Keep it unreferenced so a successful check must exit naturally
setTimeout(() => {
    report("process_timeout", { passed: false, cleanExitVerified: false })
    process.exit(1)
}, 120_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    stage = "configuration"
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    const token = env.FLUXER_TEST_BOT_TOKEN
    const applicationId = env.FLUXER_TEST_APPLICATION_ID
    const guildId = env.FLUXER_TEST_GUILD_ID
    assert.ok(token && token === token.trim())
    assert.match(applicationId ?? "", /^\d+$/)
    assert.match(guildId ?? "", /^\d+$/)

    stage = "sandbox_identity"
    const application = await get("/applications/@me", token)
    const user = await get("/users/@me", token)
    assert.equal(application.id, applicationId)
    assert.equal(user.bot, true)
    assert.equal(typeof user.id, "string")
    assert.equal(application.bot?.id, user.id)
    assert.equal((await get(`/guilds/${guildId}`, token)).id, guildId)
    report(stage, { passed: true, clientSecretUsed: false })

    let client
    if (mode === "default") {
        const { createClient } = await import("@neontechspace/fluxerly")
        stage = "creation"
        const created = createClient({ token })
        assert.ok(created.isOk())
        client = created.value
        assert.equal(client.state, "Disconnected")
        try {
            stage = "connect"
            assert.ok((await client.connect()).isOk())
            assert.equal(client.state, "Connected")
            report("ready", { passed: true })
            await observeHeartbeat(client)
        } finally {
            const previous = stage
            stage = "shutdown"
            assert.ok((await client.shutdown()).isOk())
            stage = previous
        }
        stage = "terminal_outcome"
        assert.ok((await client.waitForClose()).isOk())
    } else {
        const { Effect, Exit } = await import("effect")
        const { createClient } = await import("@neontechspace/fluxerly/effect")
        const exit = await Effect.runPromiseExit(
            Effect.scoped(
                Effect.gen(function* () {
                    stage = "creation"
                    client = yield* createClient({ token })
                    assert.equal(client.state, "Disconnected")
                    stage = "connect"
                    yield* client.connect()
                    assert.equal(client.state, "Connected")
                    report("ready", { passed: true })
                    yield* Effect.promise(() => observeHeartbeat(client))
                    stage = "scope_shutdown"
                }),
            ),
        )
        assert.ok(Exit.isSuccess(exit))
        stage = "terminal_outcome"
        assert.ok(Exit.isSuccess(await Effect.runPromiseExit(client.waitForClose())))
    }
    assert.equal(client.state, "Closed")
    assert.equal(client.gatewayLatencyMs, null)
    report("closed", { passed: true, latencyReset: true })
} catch {
    // Do not print assertions, native causes, HTTP bodies or credential-bearing errors
    report(stage, { passed: false })
    process.exitCode = 1
} finally {
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
// No success-path process.exit: The invoking shell must observe natural exit
