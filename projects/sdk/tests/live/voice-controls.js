// Manual selected-participant move, disconnect, mute and deafen controls with snapshots, events and REST readback.
// Journal `.env.test.voice-controls.local` records the sandbox, bot and participant identity, the participant's
// baseline and current state, the temporary voice channel marker and returned ID, and any pending operation.
// An existing journal triggers recovery only: a pending operation is resolved from fresh gateway and REST
// observations, the participant must rejoin the baseline channel with unchanged flags, the baseline is restored and
// verified, and the test channel is removed. Unexpected or conflicting state keeps the journal
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Exit, Scope } from "effect"
import {
    acquireLock,
    checkSandboxIdentity,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    processValue,
    snowflake as idPattern,
} from "./support/harness.js"
import { pendingResolution, rejoinedBaseline, sameState } from "./support/voice-state.js"
import { createReporter } from "./support/reporting.js"
import { createSandboxApi } from "./support/sandbox-api.js"
import { settle as value } from "./support/results.js"

const mode = process.argv[2]

// Manual current-authorization check. The participant ID is accepted only from this process, never .env.test.local
assert.ok(mode === "default" || mode === "effect")
assert.ok(process.argv[3] === undefined || ["--flags-only", "--no-move"].includes(process.argv[3]))
assert.equal(process.argv[4], undefined)
const flagsOnly = process.argv[3] === "--flags-only"
const skipMoves = process.argv[3] === "--no-move"
const voiceUserId = processValue("FLUXER_TEST_VOICE_USER_ID")

const rawFetch = globalThis.fetch
const journalFile = openJournal("voice-controls")
const report = createReporter({ mode }, { passed: true })
let lock, journal, client, scope, sdk, token, guildId, botId
let verified = false
let stage = "configuration"
let stops = []
let voiceEvents = []
let snapshots = []

const sandboxApi = createSandboxApi({ fetch: rawFetch, token: () => token })
async function api(method, path) {
    const { data } = await sandboxApi(method, path)
    return data && typeof data === "object" && "data" in data ? data.data : data
}

async function rawMember() {
    const member = await api("GET", `/guilds/${guildId}/members/${voiceUserId}`)
    assert.equal(member?.user?.id, voiceUserId)
    assert.equal(typeof member.mute, "boolean", "Participant mute state is not restorable")
    assert.equal(typeof member.deaf, "boolean", "Participant deafen state is not restorable")
    return member
}

const flags = (member) => ({ muted: member.mute, deafened: member.deaf })
const save = () => journalFile.save(journal)

async function stopClient() {
    const failures = []
    const failedStops = []
    for (const stop of stops.reverse())
        try {
            await stop()
        } catch {
            failures.push("subscription_stop")
            failedStops.push(stop)
        }
    stops = failedStops.reverse()
    if (client) {
        try {
            const closed = client.shutdown()
            if (Effect.isEffect(closed)) await Effect.runPromise(closed)
            else await closed
            client = undefined
        } catch {
            failures.push("client_shutdown")
        }
    }
    if (scope)
        try {
            await Effect.runPromise(Scope.close(scope, Exit.void))
            scope = undefined
        } catch {
            failures.push("scope_close")
        }
    if (failures.length) throw new Error("Owned voice client finalization failed")
}

async function startClient() {
    voiceEvents = []
    snapshots = []
    if (mode === "default") client = sdk.createClient({ token, cache: { members: true } })
    else {
        scope = Scope.makeUnsafe()
        client = await Effect.runPromise(
            sdk.createClient({ token, cache: { members: true } }).pipe(Scope.provide(scope)),
        )
    }
    const subscribe = async (event, receive) => {
        const subscription =
            mode === "default"
                ? client.on(event, receive)
                : await Effect.runPromise(
                      client.on(event, (item) => Effect.sync(() => receive(item))).pipe(Scope.provide(scope)),
                  )
        return async () => {
            if (mode === "default") {
                subscription.close()
                await value(subscription.waitForClose())
            } else {
                await Effect.runPromise(subscription.close())
                await Effect.runPromise(subscription.waitForClose().pipe(Scope.provide(scope)))
            }
        }
    }
    stops.push(
        await subscribe("voiceStateUpdate", (item) => {
            if (item.guildId === guildId && item.userId === voiceUserId && voiceEvents.length < 128)
                voiceEvents.push(item)
        }),
    )
    stops.push(
        await subscribe("voiceStateSnapshot", (item) => {
            if (item.guildId === guildId && snapshots.length < 4) snapshots.push(item)
        }),
    )
    await value(client.connect())
    const deadline = performance.now() + 15_000
    while (!snapshots.length) {
        assert.ok(performance.now() < deadline, "Timed out waiting for the fresh initial voice snapshot")
        assert.equal(client.state, "Connected", "Gateway closed before the fresh initial voice snapshot")
        await sleep(20)
    }
}

function freshSnapshotState(member) {
    const snapshot = snapshots.at(-1)
    assert.ok(snapshot?.guildId === guildId, "The fresh gateway connection did not supply the sandbox voice snapshot")
    const connections = snapshot.voiceStates.filter((item) => item.userId === voiceUserId && item.channelId !== null)
    assert.ok(connections.length <= 1, "Refuse a participant with multiple current voice connections")
    if (connections.length === 1) {
        assert.equal(connections[0].isMuted, member.mute, "Snapshot and REST mute observations disagree")
        assert.equal(connections[0].isDeafened, member.deaf, "Snapshot and REST deafen observations disagree")
    }
    return connections.length === 0
        ? { channelId: null, connectionId: undefined, ...flags(member) }
        : { channelId: connections[0].channelId, connectionId: connections[0].connectionId, ...flags(member) }
}

async function freshCurrentState() {
    await stopClient()
    await startClient()
    return freshSnapshotState(await rawMember())
}

function assertCurrent(expected) {
    assert.ok(sameState(journal.current, expected), "Journal state does not match the intended operation state")
    const observed = voiceEvents.at(-1)
    if (observed)
        assert.ok(
            sameState(
                { channelId: observed.channelId, muted: observed.isMuted, deafened: observed.isDeafened },
                expected,
            ),
            "Concurrent participant voice-state change; retain recovery journal",
        )
}

async function waitForEvent(expected, startAt, description) {
    const deadline = performance.now() + 15_000
    while (performance.now() < deadline) {
        const event = voiceEvents
            .slice(startAt)
            .find((item) =>
                sameState({ channelId: item.channelId, muted: item.isMuted, deafened: item.isDeafened }, expected),
            )
        if (event) return { ...expected, connectionId: event.connectionId }
        assert.equal(client.state, "Connected", "Gateway closed during voice-control verification")
        await sleep(20)
    }
    assert.fail(`Timed out waiting for ${description}`)
}

async function verifyState(expected) {
    const raw = await rawMember()
    assert.deepEqual(flags(raw), { muted: expected.muted, deafened: expected.deafened })
    const fetched = await value(client.members.fetch({ guildId, userId: voiceUserId }))
    assert.equal(fetched.isMuted, expected.muted)
    assert.equal(fetched.isDeafened, expected.deafened)
}

async function mutate(name, intended, operation) {
    assertCurrent(journal.current)
    await verifyState(journal.current)
    journal.pending = { name, before: journal.current, intended }
    save()
    const startAt = voiceEvents.length
    try {
        await value(operation())
        const observed = await waitForEvent(intended, startAt, `${name} voice-state event`)
        await verifyState(intended)
        journal.current = observed
        journal.pending = undefined
        save()
        return observed
    } catch (error) {
        await reconcilePending()
        throw error
    }
}

async function reconcilePending() {
    assert.ok(journal?.pending, "No uncertain operation is available for reconciliation")
    const current = await freshCurrentState()
    const resolution = pendingResolution(current, journal.pending)
    assert.notEqual(
        resolution,
        "conflict",
        "Uncertain voice operation has a conflicting current state; retain recovery journal",
    )
    journal.current = current
    journal.pending = undefined
    journal.phase = "recovering"
    save()
    report("uncertain_voice_operation_reconciled", { currentMatches: resolution })
}

async function reconcileTestChannel() {
    if (!journal?.channel) return undefined
    assert.match(journal.channel.name ?? "", /^fluxerly-sdk-voice-[a-f0-9]{32}$/)
    if (journal.channel.id !== undefined) return journal.channel
    const matches = (await value(client.channels.fetchAll(guildId))).filter(
        (channel) => channel.type === sdk.ChannelType.Voice && channel.name === journal.channel.name,
    )
    assert.ok(matches.length <= 1, "Multiple channels match the test voice marker; retain recovery journal")
    assert.equal(matches.length, 1, "Unresolved channel creation; retain the marker journal for reconciliation")
    journal.channel.id = matches[0].id
    save()
    return journal.channel
}

async function removeTestChannel() {
    const channel = await reconcileTestChannel()
    if (!channel) return
    assert.match(channel.id, idPattern)
    let found
    try {
        found = await value(client.channels.fetch(channel.id))
    } catch (error) {
        if (error?._tag !== "ChannelOperationError" || error.reason !== "notFound") throw error
        journal.channel = undefined
        save()
        report("test_voice_channel_removal_verified")
        return
    }
    assert.equal(found.guildId, guildId)
    assert.equal(found.type, sdk.ChannelType.Voice)
    assert.equal(found.name, channel.name, "Test voice channel changed; retain recovery journal")
    await value(client.channels.delete(channel.id))
    try {
        await value(client.channels.fetch(channel.id))
        assert.fail("Deleted test voice channel remains readable")
    } catch (error) {
        assert.equal(error?._tag, "ChannelOperationError")
        assert.equal(error?.reason, "notFound")
    }
    journal.channel = undefined
    save()
    report("test_voice_channel_removed")
}

async function requireRejoin() {
    report("participant_action_required", { action: "join_the_original_voice_channel_to_finish_recovery" })
    const deadline = performance.now() + 90_000
    let current = await freshCurrentState()
    while (performance.now() < deadline) {
        const event = voiceEvents.at(-1)
        if (event)
            current = {
                channelId: event.channelId,
                connectionId: event.connectionId,
                muted: event.isMuted,
                deafened: event.isDeafened,
            }
        if (rejoinedBaseline(current, journal.baseline)) {
            journal.current = current
            journal.phase = "restoring"
            save()
            await verifyState(journal.baseline)
            return
        }
        assert.equal(client.state, "Connected", "Gateway closed while waiting for participant rejoin")
        await sleep(100)
    }
    assert.fail(
        "Participant did not rejoin the original voice channel; SDK cannot make a disconnected participant join",
    )
}

async function restore() {
    if (!verified || !journal) return
    assert.equal(journal.kind, "voice-controls")
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.equal(journal.userId, voiceUserId, "Recovery requires current authorization for the journaled participant")
    if (journal.pending) await reconcilePending()
    else {
        const current = await freshCurrentState()
        if (journal.phase === "awaiting_rejoin") {
            if (rejoinedBaseline(current, journal.baseline)) journal.phase = "restoring"
            journal.current = current
            if (current.channelId !== journal.baseline.channelId) await requireRejoin()
        } else
            assert.ok(
                sameState(current, journal.current),
                "Concurrent participant voice-state change; retain recovery journal",
            )
        save()
    }
    if (journal.current.channelId === null) await requireRejoin()
    if (journal.current.channelId !== journal.baseline.channelId) {
        const restored = await mutate(
            "recovery_move",
            { ...journal.current, channelId: journal.baseline.channelId },
            () =>
                client.members.move(
                    { guildId, userId: voiceUserId, connectionId: journal.current.connectionId },
                    journal.baseline.channelId,
                ),
        )
        journal.current = restored
        journal.phase = "restoring"
        save()
    }
    if (journal.current.muted !== journal.baseline.muted)
        await mutate("restore_mute", { ...journal.current, muted: journal.baseline.muted }, () =>
            client.members.setMute({ guildId, userId: voiceUserId }, { muted: journal.baseline.muted }),
        )
    if (journal.current.deafened !== journal.baseline.deafened)
        await mutate("restore_deafen", { ...journal.current, deafened: journal.baseline.deafened }, () =>
            client.members.setDeaf({ guildId, userId: voiceUserId }, { deafened: journal.baseline.deafened }),
        )
    await verifyState(journal.baseline)
    await removeTestChannel()
    journalFile.remove()
    journal = undefined
    report("participant_state_restored")
}

const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: true }))
    process.exit(1)
}, 330_000).unref()

async function run() {
    lock = acquireLock()
    const sandbox = loadSandboxEnvironment({ processOverrides: true })
    token = sandbox.token
    guildId = sandbox.guildId
    stage = "sandbox_identity_and_participant"
    const [application, self, guild, participant] = await Promise.all([
        api("GET", "/applications/@me"),
        api("GET", "/users/@me"),
        api("GET", `/guilds/${guildId}`),
        rawMember(),
    ])
    botId = checkSandboxIdentity({ application, user: self, guild }, sandbox)
    assert.equal(participant.user?.id, voiceUserId)
    assert.notEqual(participant.user?.bot, true, "Use the currently authorized non-bot participant")
    assert.notEqual(voiceUserId, botId, "The bot cannot be the voice-control participant")
    verified = true
    report(stage, { clientSecretUsed: false })
    sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
    await startClient()
    stage = "bot_permission_and_hierarchy_preflight"
    const permissions = await value(client.permissions.fetch({ guildId, userId: botId }))
    const required =
        sdk.Permissions.ManageChannels |
        sdk.Permissions.Connect |
        sdk.Permissions.MoveMembers |
        sdk.Permissions.MuteMembers |
        sdk.Permissions.DeafenMembers
    const canManageParticipant = await value(client.members.fetchCanManage({ guildId, userId: voiceUserId }))
    report("voice_control_preflight", {
        passed: (permissions & required) === required && canManageParticipant,
        hasRequiredPermissions: (permissions & required) === required,
        canManageParticipant,
        participantIsGuildOwner: guild.owner_id === voiceUserId,
    })
    assert.equal(
        permissions & required,
        required,
        "The designated sandbox bot lacks a required voice-control permission",
    )
    assert.equal(
        canManageParticipant,
        true,
        "The bot cannot manage this participant under Fluxer's current hierarchy rule",
    )
    report(stage)
    if (journalFile.exists()) {
        journal = journalFile.read()
        stage = "recover_prior_voice_test"
        await restore()
        return
    }
    const baseline = freshSnapshotState(await rawMember())
    assert.notEqual(baseline.channelId, null, "The participant must already be connected to one visible voice channel")
    journal = {
        kind: "voice-controls",
        guildId,
        botId,
        userId: voiceUserId,
        baseline,
        current: baseline,
        phase: "preparing",
    }
    journalFile.create(journal)
    journal.phase = "mutating"
    save()
    const setFlags = (name, changed) =>
        mutate(name, { ...journal.current, ...changed }, () =>
            "muted" in changed
                ? client.members.setMute({ guildId, userId: voiceUserId }, { muted: changed.muted })
                : client.members.setDeaf({ guildId, userId: voiceUserId }, { deafened: changed.deafened }),
        )
    stage = "server_mute"
    if (journal.current.muted) await setFlags("initial_unmute", { muted: false })
    await setFlags("mute", { muted: true })
    report(stage)
    stage = "server_unmute"
    await setFlags("unmute", { muted: false })
    if (baseline.muted) await setFlags("restore_initial_mute", { muted: true })
    report(stage)
    stage = "server_deafen"
    if (journal.current.deafened) await setFlags("initial_undeafen", { deafened: false })
    await setFlags("deafen", { deafened: true })
    report(stage)
    stage = "server_undeafen"
    await setFlags("undeafen", { deafened: false })
    if (baseline.deafened) await setFlags("restore_initial_deafen", { deafened: true })
    report(stage)
    if (flagsOnly) return
    if (!skipMoves) {
        journal.channel = { name: `fluxerly-sdk-voice-${randomUUID().replaceAll("-", "")}` }
        save()
        stage = "create_test_voice_channel"
        const temporary = await value(
            client.channels.create(guildId, { type: sdk.ChannelType.Voice, name: journal.channel.name }),
        )
        journal.channel.id = temporary.id
        save()
        assert.equal(temporary.guildId, guildId)
        assert.equal(temporary.type, sdk.ChannelType.Voice)
        assert.equal(temporary.name, journal.channel.name)
        report(stage)
        stage = "move_to_test_voice_channel"
        await mutate("move_to_test", { ...journal.current, channelId: temporary.id }, () =>
            client.members.move(
                { guildId, userId: voiceUserId, connectionId: journal.current.connectionId },
                temporary.id,
            ),
        )
        report(stage)
        stage = "restore_original_voice_channel"
        await mutate("restore_channel", { ...journal.current, channelId: baseline.channelId }, () =>
            client.members.move(
                { guildId, userId: voiceUserId, connectionId: journal.current.connectionId },
                baseline.channelId,
            ),
        )
        report(stage)
    }
    stage = "disconnect"
    journal.phase = "awaiting_rejoin"
    save()
    await mutate("disconnect", { ...journal.current, channelId: null, connectionId: undefined }, () =>
        client.members.disconnect({ guildId, userId: voiceUserId, connectionId: journal.current.connectionId }),
    )
    report(stage)
    await requireRejoin()
}

try {
    await run()
} catch (error) {
    console.error(
        JSON.stringify({
            mode,
            stage,
            passed: false,
            tag: error?._tag ?? error?.name ?? "Error",
            ...(typeof error?.reason === "string" ? { reason: error.reason } : {}),
            ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
        }),
    )
    process.exitCode = 1
} finally {
    // Recovery runs only after the original client is proven closed, and the client it starts is always closed.
    // Keep the journal, lock and deadline if a failed owned finalizer or recovery leaves work uncertain
    let initialClientClosed = false
    await finalizeOwned({
        writers: [
            [
                "initial_client_shutdown",
                async () => {
                    await stopClient()
                    initialClientClosed = true
                },
            ],
            [
                "voice_recovery",
                async () => {
                    if (initialClientClosed) await restore()
                },
            ],
            ["restoration_client_shutdown", stopClient],
        ],
        lock,
        watchdog,
        onFailure: (finalizer) => {
            const lockRetained = lock?.held ?? false
            if (finalizer === "sandbox_lock")
                console.error(JSON.stringify({ mode, stage: "lock_cleanup", passed: false, lockRetained }))
            else
                console.error(
                    JSON.stringify({
                        mode,
                        stage: finalizer === "voice_recovery" ? "voice_recovery" : "client_cleanup",
                        passed: false,
                        ...(finalizer === "voice_recovery" ? {} : { finalizer }),
                        journalRetained: journal !== undefined,
                        lockRetained,
                    }),
                )
            process.exitCode = 1
        },
    })
}
