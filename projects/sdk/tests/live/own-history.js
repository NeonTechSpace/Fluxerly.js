// Deletion of the designated bot's own message history in one test-owned channel, or with `--guild` in the whole
// sandbox guild, covering success, a lost response and post-dispatch cancellation, each reconciled by unique markers.
// Journal `.env.test.own-history.local` records sandbox and bot identity, a unique marker, the test-owned channels and
// messages, deletion phases and an optional other-author control sample. An existing journal is recovered instead of
// running the checks: only journaled channels are removed, without repeating any history deletion
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Cause, Effect, Exit, Scope } from "effect"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    processValue,
    verifySandboxIdentity,
} from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { settle as value } from "./support/results.js"
import { createDeadlineSandboxApi } from "./support/sandbox-api.js"

// Guild mode requires current authorization to erase the designated bot's entire sandbox guild history
const mode = process.argv[2]
const guildMode = process.argv[3] === "--guild"
assert.ok(mode === "default" || mode === "effect")
assert.ok(process.argv.length === (guildMode ? 4 : 3))

const rawFetch = globalThis.fetch
const journalFile = openJournal("own-history")
const operationDeadline = new AbortController()
const reportsScope = guildMode ? "guild" : "channel"

let lock
let token
let guildId
let botId
let client
let scope
let journal
let verified = false
let stage = "configuration"
let requestDeadline = operationDeadline.signal

const report = createReporter({ mode, scope: reportsScope }, { passed: true })
const save = () => journalFile.save(journal)
const deadlineTimer = setTimeout(() => operationDeadline.abort(), 150_000).unref()
// This is failure containment, not cleanup evidence. The journal remains for a later verified recovery
const watchdog = setTimeout(() => {
    console.error(
        JSON.stringify({
            mode,
            scope: reportsScope,
            stage,
            passed: false,
            reason: "deadline",
            ...(journal ? { journalRetained: true } : {}),
        }),
    )
    process.exit(1)
}, 180_000).unref()

const api = createDeadlineSandboxApi({ fetch: rawFetch, token: () => token, deadline: () => requestDeadline })

function assertJournal() {
    assert.equal(journal?.guildId, guildId)
    assert.equal(journal?.botId, botId)
    assert.match(journal?.marker ?? "", /^fluxerly-own-history-[a-f0-9]{32}$/)
    assert.ok(Array.isArray(journal?.channels) && journal.channels.length <= 2)
    assert.ok(Array.isArray(journal?.messages))
    assert.ok(Array.isArray(journal?.deletions))
    const expectedMarkers = new Set([`${journal.marker}-primary`, `${journal.marker}-control`])
    const seenMarkers = new Set()
    for (const entry of journal.channels) {
        assert.ok(expectedMarkers.has(entry?.marker))
        assert.ok(!seenMarkers.has(entry.marker))
        seenMarkers.add(entry.marker)
        assert.equal(entry.name, entry.marker)
        assert.equal(entry.type, 0)
        if (entry.id !== undefined) assert.match(entry.id, /^\d+$/)
    }
}

async function findOwnedChannel(entry) {
    const listed = await api("GET", `/guilds/${guildId}/channels`)
    assert.ok(Array.isArray(listed.data))
    const matches = listed.data.filter((channel) => channel?.type === entry.type && channel?.name === entry.marker)
    assert.ok(matches.length <= 1)
    return matches[0]
}

async function createOwnedChannel(kind) {
    const entry = {
        marker: `${journal.marker}-${kind}`,
        name: `${journal.marker}-${kind}`,
        type: 0,
        phase: "creating",
    }
    journal.channels.push(entry)
    save()
    let created
    try {
        created = (await api("POST", `/guilds/${guildId}/channels`, { name: entry.name, type: entry.type })).data
    } catch {
        // The creation intent is already durable. Reconcile its unique marker instead of replaying a possibly applied POST
        created = await findOwnedChannel(entry)
        assert.ok(created, "Unresolved test-channel creation")
    }
    assert.match(created?.id ?? "", /^\d+$/)
    assert.equal(created.guild_id, guildId)
    assert.equal(created.type, entry.type)
    assert.equal(created.name, entry.name)
    entry.id = created.id
    entry.phase = "created"
    save()
    return entry
}

async function findOwnedMessage(channelId, marker) {
    const page = await api("GET", `/channels/${channelId}/messages?limit=100`)
    assert.ok(Array.isArray(page.data))
    const matches = page.data.filter((message) => message?.author?.id === botId && message?.content === marker)
    assert.ok(matches.length <= 1)
    return matches[0]
}

async function createOwnedMessage(channel, kind) {
    const entry = { channelId: channel.id, marker: `${journal.marker}-message-${kind}`, phase: "creating" }
    journal.messages.push(entry)
    save()
    let created
    try {
        created = (await api("POST", `/channels/${channel.id}/messages`, { content: entry.marker })).data
    } catch {
        // A response loss is reconciled by the unique marker, never by a second send
        created = await findOwnedMessage(channel.id, entry.marker)
        assert.ok(created, "Unresolved test-message creation")
    }
    assert.match(created?.id ?? "", /^\d+$/)
    assert.equal(created.channel_id, channel.id)
    assert.equal(created.author?.id, botId)
    entry.id = created.id
    entry.phase = "created"
    save()
    return entry
}

async function assertMarkerPresent(entry) {
    const response = await api("GET", `/channels/${entry.channelId}/messages/${entry.id}`)
    assert.equal(response.status, 200)
    assert.equal(response.data?.id, entry.id)
    assert.equal(response.data?.channel_id, entry.channelId)
    assert.equal(response.data?.author?.id, botId)
}

async function assertMarkerAbsent(entry) {
    const response = await api("GET", `/channels/${entry.channelId}/messages/${entry.id}`)
    assert.equal(response.status, 404)
}

async function cache(entry) {
    const reference = { id: entry.id, channelId: entry.channelId }
    const fetched = await value(
        client.messages.fetch(reference, mode === "default" ? { signal: operationDeadline.signal } : undefined),
        mode === "effect" ? operationDeadline.signal : undefined,
    )
    assert.equal(fetched.id, entry.id)
    const retained =
        mode === "default" ? client.messages.get(reference) : await Effect.runPromise(client.messages.get(reference))
    assert.equal(retained?.id, entry.id)
}

async function assertCacheCleared(entries) {
    for (const entry of entries) {
        const reference = { id: entry.id, channelId: entry.channelId }
        const retained =
            mode === "default"
                ? client.messages.get(reference)
                : await Effect.runPromise(client.messages.get(reference))
        assert.equal(retained, undefined)
    }
}

async function captureNonBotControl() {
    const channels = await api("GET", `/guilds/${guildId}/channels`)
    assert.ok(Array.isArray(channels.data))
    for (const channel of channels.data.filter((item) => item?.type === 0).slice(0, 3)) {
        const page = await api("GET", `/channels/${channel.id}/messages?limit=100`)
        assert.ok(Array.isArray(page.data))
        const message = page.data.find((item) => /^\d+$/.test(item?.id ?? "") && item?.author?.id !== botId)
        if (message) {
            journal.nonBotControl = { channelId: channel.id, id: message.id, authorId: message.author.id }
            save()
            return
        }
    }
}

async function assertNonBotControl() {
    if (!journal.nonBotControl) return
    const control = journal.nonBotControl
    const response = await api("GET", `/channels/${control.channelId}/messages/${control.id}`)
    assert.equal(response.status, 200)
    assert.equal(response.data?.id, control.id)
    assert.equal(response.data?.author?.id, control.authorId)
}

async function assertBotMembership() {
    const membership = await api("GET", `/guilds/${guildId}/members/${botId}`)
    assert.equal(membership.status, 200)
    assert.equal(membership.data?.user?.id, botId)
}

function deleteOperation(primary, signal = operationDeadline.signal) {
    return guildMode
        ? client.guilds.deleteOwnMessages(guildId, mode === "default" ? { confirm: true, signal } : { confirm: true })
        : client.messages.deleteOwnMessages(
              primary.id,
              mode === "default" ? { confirm: true, signal } : { confirm: true },
          )
}

async function deleteOwnMessages(primary, kind) {
    const cancellation = new AbortController()
    const signal = AbortSignal.any([operationDeadline.signal, cancellation.signal])
    const deletion = { kind, phase: "dispatching" }
    journal.deletions.push(deletion)
    save()
    const requests = []
    let attempts = 0
    const expectedPath = guildMode
        ? `/v1/users/@me/guilds/${guildId}/messages/bulk-delete-mine`
        : `/v1/channels/${primary.id}/messages/bulk-delete-mine`
    globalThis.fetch = async (url, init) => {
        if (init?.method !== "POST" || new URL(String(url)).pathname !== expectedPath) return rawFetch(url, init)
        attempts++
        const response = await rawFetch(url, init)
        requests.push({
            method: init?.method,
            path: expectedPath,
            body: init?.body,
            status: response.status,
        })
        if (kind !== "success" && response.status === 202) {
            await response.body?.cancel()
            if (kind === "cancelled") {
                cancellation.abort()
                throw new DOMException("Test-owned post-dispatch cancellation", "AbortError")
            }
            throw new Error("Test-owned delete response loss")
        }
        return response
    }
    try {
        if (kind === "cancelled") {
            const outcome =
                mode === "default"
                    ? await deleteOperation(primary, signal)
                    : await Effect.runPromiseExit(deleteOperation(primary), { signal })
            if (mode === "default") assert.ok(outcome.isErr() && outcome.error._tag === "CancelledError")
            else assert.ok(Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause))
            deletion.phase = "cancelled"
        } else if (kind === "lost_response") {
            await assert.rejects(
                () => value(deleteOperation(primary), mode === "effect" ? operationDeadline.signal : undefined),
                (error) =>
                    error?._tag === (guildMode ? "GuildOperationError" : "MessageOperationError") &&
                    error?.outcome === "unknown",
            )
            deletion.phase = "unknown"
        } else {
            await value(deleteOperation(primary), mode === "effect" ? operationDeadline.signal : undefined)
            deletion.phase = "succeeded"
        }
    } finally {
        globalThis.fetch = rawFetch
        save()
    }
    assert.ok(requests.length >= 1)
    assert.equal(attempts, requests.length)
    for (const request of requests) {
        assert.equal(request.method, "POST")
        assert.equal(request.path, expectedPath)
        assert.ok(request.body === undefined || request.body === "")
    }
    assert.equal(requests.at(-1)?.status, 202)
    // A confirmed rate-limit rejection may precede the one accepted dispatch. Once that dispatch loses its response,
    // no second POST is possible because the wrapper throws before returning the successful response to the SDK
    assert.ok(requests.slice(0, -1).every((request) => request.status === 429))
}

async function cleanup() {
    if (!verified || !journal) return
    const priorRequestDeadline = requestDeadline
    requestDeadline = AbortSignal.timeout(30_000)
    try {
        assertJournal()
        for (const entry of journal.channels) {
            const located = await findOwnedChannel(entry)
            if (!located) {
                assert.match(entry.id ?? "", /^\d+$/, "Unresolved channel creation retains its journal")
                assert.equal((await api("GET", `/channels/${entry.id}`)).status, 404)
                continue
            }
            assert.match(located.id ?? "", /^\d+$/)
            assert.equal(located.guild_id, guildId)
            assert.equal(located.name, entry.name)
            if (entry.id !== undefined) assert.equal(located.id, entry.id)
            else {
                entry.id = located.id
                entry.phase = "reconciled"
                save()
            }
            const current = await api("GET", `/channels/${located.id}`)
            assert.equal(current.status, 200)
            assert.equal(current.data?.id, located.id)
            assert.equal(current.data?.guild_id, guildId)
            assert.equal(current.data?.name, entry.name)
            entry.cleanupPhase = "dispatching"
            save()
            assert.equal((await api("DELETE", `/channels/${located.id}`)).status, 204)
            assert.equal((await api("GET", `/channels/${located.id}`)).status, 404)
            entry.cleanupPhase = "verified"
            save()
        }
        const remaining = await api("GET", `/guilds/${guildId}/channels`)
        assert.ok(Array.isArray(remaining.data))
        assert.ok(journal.channels.every((entry) => !remaining.data.some((channel) => channel?.name === entry.name)))
        journalFile.remove()
        journal = undefined
        report("test_owned_channels_removed")
    } finally {
        requestDeadline = priorRequestDeadline
    }
}

try {
    stage = "sandbox_lock"
    lock = acquireLock()

    const sandbox = loadSandboxEnvironment()
    token = sandbox.token
    guildId = sandbox.guildId
    if (guildMode)
        assert.equal(
            processValue("FLUXER_TEST_DELETE_MINE_GUILD_ID"),
            guildId,
            "Guild mode requires a matching process-only deletion confirmation",
        )

    stage = "sandbox_identity"
    const identity = await verifySandboxIdentity(async (path) => (await api("GET", path)).data, sandbox)
    botId = identity.botId
    await assertBotMembership()
    verified = true
    report(stage)

    stage = "recover_prior_test_channels"
    if (journalFile.exists()) {
        journal = journalFile.read()
        await cleanup()
        report("recovery_only_no_history_deletion")
    } else {
        journal = {
            guildId,
            botId,
            marker: `fluxerly-own-history-${randomUUID().replaceAll("-", "")}`,
            channels: [],
            messages: [],
            deletions: [],
        }
        journalFile.create(journal)
        if (guildMode) await captureNonBotControl()

        stage = "create_test_owned_channels"
        const primary = await createOwnedChannel("primary")
        const control = await createOwnedChannel("control")
        report(stage)

        stage = "create_test_owned_messages"
        const primaryMarker = await createOwnedMessage(primary, "primary")
        const controlMarker = await createOwnedMessage(control, "control")
        await assertMarkerPresent(primaryMarker)
        await assertMarkerPresent(controlMarker)
        report(stage)

        const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
        const clientOptions = { token, cache: { messages: { maxEntries: 8, maxBytes: 131_072 } } }
        if (mode === "default") client = sdk.createClient(clientOptions)
        else {
            scope = Scope.makeUnsafe()
            client = await Effect.runPromise(sdk.createClient(clientOptions).pipe(Scope.provide(scope)))
        }

        stage = "cache_selected_markers"
        await cache(primaryMarker)
        await cache(controlMarker)
        report(stage)

        stage = "whole_history_success"
        await deleteOwnMessages(primary, "success")
        await assertMarkerAbsent(primaryMarker)
        if (guildMode) await assertMarkerAbsent(controlMarker)
        else await assertMarkerPresent(controlMarker)
        await assertCacheCleared([primaryMarker, controlMarker])
        await assertBotMembership()
        if (guildMode) await assertNonBotControl()
        report(
            guildMode
                ? "selected_markers_removed_and_membership_preserved"
                : "selected_marker_removed_control_and_membership_preserved",
            guildMode ? { nonBotSampleObserved: Boolean(journal.nonBotControl) } : {},
        )

        stage = "create_lost_response_marker"
        const lossMarker = await createOwnedMessage(primary, "lost-response")
        await cache(lossMarker)
        report(stage)

        stage = "whole_history_lost_response_reconciliation"
        await deleteOwnMessages(primary, "lost_response")
        await assertMarkerAbsent(lossMarker)
        await assertCacheCleared([lossMarker])
        await assertBotMembership()
        if (guildMode) await assertNonBotControl()
        report("one_unknown_outcome_without_retry_reconciled_by_marker")

        stage = "whole_history_post_dispatch_cancellation"
        const cancellationMarker = await createOwnedMessage(primary, "cancelled")
        await cache(cancellationMarker)
        await deleteOwnMessages(primary, "cancelled")
        await assertMarkerAbsent(cancellationMarker)
        await assertCacheCleared([cancellationMarker])
        await assertBotMembership()
        if (guildMode) await assertNonBotControl()
        report("post_dispatch_cancellation_without_retry_reconciled_by_marker")
        console.log(
            JSON.stringify({
                mode,
                scope: reportsScope,
                check: "other_author_sample_preservation",
                ...(journal.nonBotControl
                    ? { passed: true }
                    : { skipped: true, reason: "No other-author control in the selected check" }),
            }),
        )
    }
} catch (error) {
    // Do not emit configured IDs, marker contents, request bodies, raw failures or credentials
    console.error(
        JSON.stringify({
            mode,
            scope: reportsScope,
            stage,
            passed: false,
            tag: error?._tag ?? error?.name ?? "Error",
            ...(typeof error?.reason === "string" ? { reason: error.reason } : {}),
            ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
            ...(journal ? { journalRetained: true } : {}),
        }),
    )
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    const failedStages = {
        client_shutdown: "client_cleanup",
        scope_close: "scope_cleanup",
        cleanup: "resource_cleanup",
        sandbox_lock: "lock_cleanup",
    }
    // Keep the journal, lock and deadlines if a failed owned finalizer may have left a writer alive
    const quiescent = await finalizeOwned({
        writers: [
            client && ["client_shutdown", () => value(client.shutdown())],
            scope && ["scope_close", () => Effect.runPromise(Scope.close(scope, Exit.void))],
        ],
        cleanup,
        lock,
        watchdog,
        onFailure: (finalizer) => {
            console.error(
                JSON.stringify({
                    mode,
                    scope: reportsScope,
                    stage: failedStages[finalizer],
                    passed: false,
                    ...(finalizer === "cleanup" ? { journalRetained: true } : {}),
                }),
            )
            process.exitCode = 1
        },
    })
    if (quiescent) clearTimeout(deadlineTimer)
}
