import assert from "node:assert/strict"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"

const mode = process.argv[2]
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const report = (check, details = {}) => console.log(JSON.stringify({ mode, check, ...details }))
let lock
let stage = "configuration"

async function get(path, token) {
    const response = await fetch(`https://api.fluxer.app/v1${path}`, {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
    })
    if (!response.ok) {
        await response.body?.cancel()
        throw new Error("Sandbox identity request failed")
    }
    return response.json()
}

async function waitForGuildCreate(client, guildId, created, unavailable) {
    const deadline = performance.now() + 15_000
    while (created.value === undefined && unavailable.value === undefined) {
        assert.equal(client.state, "Connected")
        assert.ok(performance.now() < deadline, "Timed out waiting for the sandbox guild create event")
        await sleep(20)
    }
    assert.equal(unavailable.value, undefined, "Sandbox guild is unavailable rather than creating after READY")
    assert.equal(created.value?.id, guildId)
    assert.ok(Object.isFrozen(created.value) && Object.isFrozen(created.value.features))
}

setTimeout(() => {
    report("process_timeout", { passed: false, cleanExitVerified: false })
    process.exit(1)
}, 60_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.equal(process.argv[3], undefined)
    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))

    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    const token = env.FLUXER_TEST_BOT_TOKEN
    const applicationId = env.FLUXER_TEST_APPLICATION_ID
    const guildId = env.FLUXER_TEST_GUILD_ID
    assert.ok(token && token === token.trim())
    assert.match(applicationId ?? "", /^\d+$/)
    assert.match(guildId ?? "", /^\d+$/)

    stage = "sandbox_identity"
    const [application, bot, guild] = await Promise.all([
        get("/applications/@me", token),
        get("/users/@me", token),
        get(`/guilds/${guildId}`, token),
    ])
    assert.equal(application.id, applicationId)
    assert.equal(application.bot?.id, bot.id)
    assert.equal(bot.bot, true)
    assert.equal(guild.id, guildId)
    report(stage, { passed: true, clientSecretUsed: false })

    if (mode === "default") {
        const { createClient } = await import("@neontechspace/fluxerly")
        const client = createClient({ token })._unsafeUnwrap()
        const created = { value: undefined }
        const unavailable = { value: undefined }
        try {
            stage = "subscribe_before_ready"
            client
                .on("guildCreate", (value) => {
                    if (value.id === guildId) created.value = value
                })
                ._unsafeUnwrap()
            client
                .on("guildDelete", (value) => {
                    if (value.id === guildId && value.unavailable) unavailable.value = value
                })
                ._unsafeUnwrap()
            stage = "connect"
            ;(await client.connect())._unsafeUnwrap()
            stage = "guild_create_after_ready"
            await waitForGuildCreate(client, guildId, created, unavailable)
            assert.equal(created.value.name, guild.name)
            assert.equal(created.value.ownerId, guild.owner_id)
            report(stage, { passed: true })
        } finally {
            const previous = stage
            try {
                stage = "shutdown"
                ;(await client.shutdown())._unsafeUnwrap()
            } finally {
                stage = previous
            }
        }
        assert.equal(client.state, "Closed")
        report("closed", { passed: true })
    } else {
        const { Effect, Exit } = await import("effect")
        const { createClient } = await import("@neontechspace/fluxerly/effect")
        const created = { value: undefined }
        const unavailable = { value: undefined }
        let client
        const exit = await Effect.runPromiseExit(
            Effect.scoped(
                Effect.gen(function* () {
                    client = yield* createClient({ token })
                    stage = "subscribe_before_ready"
                    yield* client.on("guildCreate", (value) =>
                        Effect.sync(() => {
                            if (value.id === guildId) created.value = value
                        }),
                    )
                    yield* client.on("guildDelete", (value) =>
                        Effect.sync(() => {
                            if (value.id === guildId && value.unavailable) unavailable.value = value
                        }),
                    )
                    stage = "connect"
                    yield* client.connect()
                    stage = "guild_create_after_ready"
                    yield* Effect.promise(() => waitForGuildCreate(client, guildId, created, unavailable))
                    assert.equal(created.value.name, guild.name)
                    assert.equal(created.value.ownerId, guild.owner_id)
                    report(stage, { passed: true })
                    stage = "scope_shutdown"
                }),
            ),
        )
        assert.ok(Exit.isSuccess(exit))
        assert.equal(client?.state, "Closed")
        report("closed", { passed: true })
    }
} catch {
    report(stage, { passed: false })
    process.exitCode = 1
} finally {
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
