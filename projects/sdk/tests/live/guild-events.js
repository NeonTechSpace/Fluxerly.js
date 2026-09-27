// Bot-session guild create delivery after READY for the existing sandbox guild. The `--voice` mode also compares
// the projected voice-state snapshot and member voice flags with raw reads.
// Creates no journal and no remote resources, and changes no server content
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { acquireLock, loadSandboxEnvironment, verifySandboxIdentity } from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { readSandbox } from "./support/sandbox-api.js"

const mode = process.argv[2]
const voice = process.argv[3] === "--voice"
const report = createReporter({ mode, voice })
let lock
let stage = "configuration"
let restoreGatewayCapture
const rawGuildCreate = { value: undefined }

// Counts only: which member data the provider includes in GUILD_CREATE, without IDs or profile values
function guildCreateMembers(botId) {
    const raw = rawGuildCreate.value ?? {}
    const members = Array.isArray(raw.members) ? raw.members : undefined
    return {
        membersField: members === undefined ? (Object.hasOwn(raw, "members") ? "invalid" : "absent") : "array",
        membersSupplied: members?.length ?? null,
        botIncluded: members?.some((member) => member?.user?.id === botId) ?? null,
        memberCount: typeof raw.member_count === "number" ? raw.member_count : null,
        presencesSupplied: Array.isArray(raw.presences) ? raw.presences.length : null,
    }
}
let listedUnavailableAtReady = false

const get = (path, token) => readSandbox(path, token, { timeout: 10_000 })

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
    assert.equal(listedUnavailableAtReady, true, "Sandbox was not an unavailable guild placeholder in READY")
    assert.equal(rawGuildCreate.value?.unavailable, false, "Gateway did not supply the availability marker")
    assert.equal(created.value.isNewJoin, false, "Startup hydration was classified as a join")
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
    lock = acquireLock()

    const { token, applicationId, guildId } = loadSandboxEnvironment()

    stage = "sandbox_identity"
    const { user: bot, guild } = await verifySandboxIdentity((path) => get(path, token), {
        applicationId,
        guildId,
        concurrent: true,
    })
    report(stage, { passed: true, clientSecretUsed: false })

    {
        const { default: WebSocket } = await import("ws")
        const originalEmit = WebSocket.prototype.emit
        WebSocket.prototype.emit = function (event, ...args) {
            if (event === "message") {
                try {
                    const payload = JSON.parse(args[0].toString())
                    if (payload?.t === "READY")
                        listedUnavailableAtReady =
                            payload.d?.guilds?.some((value) => value.id === guildId && value.unavailable === true) ===
                            true
                    if (payload?.t === "GUILD_CREATE" && payload.d?.id === guildId) rawGuildCreate.value = payload.d
                } catch {
                    // The SDK remains the owner of protocol validation
                }
            }
            return Reflect.apply(originalEmit, this, [event, ...args])
        }
        restoreGatewayCapture = () => {
            WebSocket.prototype.emit = originalEmit
        }
    }

    if (mode === "default") {
        const { createClient } = await import("@neontechspace/fluxerly")
        const client = createClient({ token })
        const created = { value: undefined }
        const unavailable = { value: undefined }
        const voiceSnapshot = { value: undefined }
        try {
            stage = "subscribe_before_ready"
            client.on("guildCreate", (value) => {
                if (value.id === guildId) created.value = value
            })
            client.on("guildDelete", (value) => {
                if (value.id === guildId && value.unavailable) unavailable.value = value
            })
            if (voice)
                client.on("voiceStateSnapshot", (value) => {
                    if (value.guildId === guildId) voiceSnapshot.value = value
                })
            stage = "connect"
            ;(await client.connect())._unsafeUnwrap()
            stage = "guild_create_after_ready"
            await waitForGuildCreate(client, guildId, created, unavailable)
            assert.equal(created.value.name, guild.name)
            assert.equal(created.value.ownerId, guild.owner_id)
            report(stage, { passed: true, isNewJoin: created.value.isNewJoin, members: guildCreateMembers(bot.id) })
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
                    report(stage, {
                        passed: true,
                        isNewJoin: created.value.isNewJoin,
                        members: guildCreateMembers(bot.id),
                    })
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
    restoreGatewayCapture?.()
    if (lock !== undefined && !lock.release()) {
        report("sandbox_lock_cleanup", { passed: false, lockRetained: true })
        process.exitCode = 1
    }
}
