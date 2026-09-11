import assert from "node:assert/strict"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"

const mode = process.argv[2]
const voice = process.argv[3] === "--voice"
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const report = (check, details = {}) => console.log(JSON.stringify({ mode, voice, check, ...details }))
let lock
let stage = "configuration"
let restoreVoiceCapture
const rawGuildCreate = { value: undefined }

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

const projectVoiceState = (guildId, state) => ({
    guildId,
    channelId: state.channel_id,
    userId: state.user_id,
    connectionId: state.connection_id,
    ...(typeof state.session_id === "string" ? { sessionId: state.session_id } : {}),
    isMuted: state.mute,
    isDeafened: state.deaf,
    isSelfMuted: state.self_mute,
    isSelfDeafened: state.self_deaf,
    isMobile: state.is_mobile,
    isSuppressed: state.suppress,
})

async function waitForVoiceSnapshot(client, guildId, snapshot) {
    const deadline = performance.now() + 15_000
    while (rawGuildCreate.value === undefined) {
        assert.equal(client.state, "Connected")
        assert.ok(performance.now() < deadline, "Timed out waiting for the raw sandbox GUILD_CREATE")
        await sleep(20)
    }
    const supplied = Object.hasOwn(rawGuildCreate.value, "voice_states")
    while (supplied && snapshot.value === undefined) {
        assert.equal(client.state, "Connected")
        assert.ok(performance.now() < deadline, "Timed out waiting for the projected voice-state snapshot")
        await sleep(20)
    }
    if (!supplied) {
        assert.equal(snapshot.value, undefined)
        return false
    }
    assert.ok(Array.isArray(rawGuildCreate.value.voice_states))
    assert.deepEqual(snapshot.value, {
        guildId,
        voiceStates: rawGuildCreate.value.voice_states.map((state) => projectVoiceState(guildId, state)),
    })
    assert.ok(Object.isFrozen(snapshot.value) && Object.isFrozen(snapshot.value.voiceStates))
    return true
}

function verifyMemberFlags(member, rawMember) {
    assert.equal(typeof rawMember.mute, "boolean")
    assert.equal(typeof rawMember.deaf, "boolean")
    assert.equal(member.isMuted, rawMember.mute)
    assert.equal(member.isDeafened, rawMember.deaf)
}

setTimeout(() => {
    report("process_timeout", { passed: false, cleanExitVerified: false })
    process.exit(1)
}, 60_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.ok(process.argv[3] === undefined || voice)
    assert.equal(process.argv[4], undefined)
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

    if (voice) {
        const { default: WebSocket } = await import("ws")
        const originalEmit = WebSocket.prototype.emit
        WebSocket.prototype.emit = function (event, ...args) {
            if (event === "message") {
                try {
                    const payload = JSON.parse(args[0].toString())
                    if (payload?.t === "GUILD_CREATE" && payload.d?.id === guildId) rawGuildCreate.value = payload.d
                } catch {
                    // The SDK remains the owner of protocol validation
                }
            }
            return Reflect.apply(originalEmit, this, [event, ...args])
        }
        restoreVoiceCapture = () => {
            WebSocket.prototype.emit = originalEmit
        }
    }

    if (mode === "default") {
        const { createClient } = await import("@neontechspace/fluxerly")
        const client = createClient({ token })._unsafeUnwrap()
        const created = { value: undefined }
        const unavailable = { value: undefined }
        const voiceSnapshot = { value: undefined }
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
            if (voice)
                client
                    .on("voiceStateSnapshot", (value) => {
                        if (value.guildId === guildId) voiceSnapshot.value = value
                    })
                    ._unsafeUnwrap()
            stage = "connect"
            ;(await client.connect())._unsafeUnwrap()
            stage = "guild_create_after_ready"
            await waitForGuildCreate(client, guildId, created, unavailable)
            assert.equal(created.value.name, guild.name)
            assert.equal(created.value.ownerId, guild.owner_id)
            report(stage, { passed: true })
            if (voice) {
                stage = "voice_baseline"
                const snapshotSupplied = await waitForVoiceSnapshot(client, guildId, voiceSnapshot)
                const rawMember = await get(`/guilds/${guildId}/members/${bot.id}`, token)
                const member = (await client.members.fetch({ guildId, userId: bot.id }))._unsafeUnwrap()
                verifyMemberFlags(member, rawMember)
                report(stage, { passed: true, snapshotSupplied, memberFlags: true, mutations: false })
            }
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
        const voiceSnapshot = { value: undefined }
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
                    if (voice)
                        yield* client.on("voiceStateSnapshot", (value) =>
                            Effect.sync(() => {
                                if (value.guildId === guildId) voiceSnapshot.value = value
                            }),
                        )
                    stage = "connect"
                    yield* client.connect()
                    stage = "guild_create_after_ready"
                    yield* Effect.promise(() => waitForGuildCreate(client, guildId, created, unavailable))
                    assert.equal(created.value.name, guild.name)
                    assert.equal(created.value.ownerId, guild.owner_id)
                    report(stage, { passed: true })
                    if (voice) {
                        stage = "voice_baseline"
                        const snapshotSupplied = yield* Effect.promise(() =>
                            waitForVoiceSnapshot(client, guildId, voiceSnapshot),
                        )
                        const rawMember = yield* Effect.promise(() =>
                            get(`/guilds/${guildId}/members/${bot.id}`, token),
                        )
                        const member = yield* client.members.fetch({ guildId, userId: bot.id })
                        verifyMemberFlags(member, rawMember)
                        report(stage, { passed: true, snapshotSupplied, memberFlags: true, mutations: false })
                    }
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
    restoreVoiceCapture?.()
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
