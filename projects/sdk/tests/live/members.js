// Targeted member nickname change with a lost response, raw reconciliation, cache invalidation and SDK restoration
// for a currently authorized non-bot member.
// Journal `.env.test.members.local` records sandbox, bot and member identity, the marker nickname and the original
// nickname. An existing journal is recovered before a new run: recovery requires the same currently supplied member
// ID, restores the original nickname only from the exact marker and refuses an unexpected concurrent change
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Effect, Exit, Scope } from "effect"
import {
    acquireLock,
    checkSandboxIdentity,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    processValue,
} from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { settle as value } from "./support/results.js"
import { createSandboxApi } from "./support/sandbox-api.js"

// Manual, current-authorization check only. FLUXER_TEST_MEMBER_ID must come from this invocation, never the env file
const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const memberId = processValue("FLUXER_TEST_MEMBER_ID")

const rawFetch = globalThis.fetch
const journalFile = openJournal("members")
let lock
let journal
let client
let scope
let clientFetch
let token
let guildId
let botId
let verified = false
let stage = "configuration"

const report = createReporter({ mode }, { passed: true })

// Cache lookups return the member or undefined directly in the default API and as a never-failing Effect natively
function cachedMember(reference) {
    return mode === "default" ? client.members.get(reference) : Effect.runPromise(client.members.get(reference))
}

const sandboxApi = createSandboxApi({ fetch: rawFetch, token: () => token })
const api = async (method, path, body) => (await sandboxApi(method, path, body)).data

async function fetchTarget() {
    const member = await api("GET", `/guilds/${guildId}/members/${memberId}`)
    assert.equal(member.user?.id, memberId)
    return member
}

function nickname(member) {
    const value = member.nick ?? null
    assert.ok(
        value === null || (typeof value === "string" && [...value].length >= 1 && [...value].length <= 32),
        "Target nickname is not restorable",
    )
    return value
}

async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.equal(journal.memberId, memberId, "Recovery requires current authorization for the journaled member")
    assert.match(journal.changedNickname, /^fn_[a-f0-9]{28}$/)
    assert.ok(
        journal.originalNickname === null ||
            (typeof journal.originalNickname === "string" &&
                [...journal.originalNickname].length >= 1 &&
                [...journal.originalNickname].length <= 32),
    )

    const current = await fetchTarget()
    const currentNickname = current.nick ?? null
    assert.ok(
        currentNickname === journal.originalNickname || currentNickname === journal.changedNickname,
        "Conflicting nickname change; retain restoration journal",
    )
    if (currentNickname === journal.changedNickname) {
        await api("PATCH", `/guilds/${guildId}/members/${memberId}`, { nick: journal.originalNickname })
        assert.equal((await fetchTarget()).nick ?? null, journal.originalNickname)
    }
    journalFile.remove()
    journal = undefined
    report("target_nickname_restored")
}

const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: true }))
    process.exit(1)
}, 90_000).unref()

try {
    // An existing lock, including a stale one, is a failure: do not bypass another run or delete its recovery state
    lock = acquireLock()

    const sandbox = loadSandboxEnvironment({ processOverrides: true })
    token = sandbox.token
    guildId = sandbox.guildId

    stage = "sandbox_and_target_identity"
    const [application, self, rawGuild] = await Promise.all([
        api("GET", "/applications/@me"),
        api("GET", "/users/@me"),
        api("GET", `/guilds/${guildId}`),
    ])
    let target = await fetchTarget()
    checkSandboxIdentity({ application, user: self, guild: rawGuild }, sandbox)
    assert.equal(target.user?.id, memberId)
    assert.notEqual(target.user?.bot, true, "Use the currently authorized non-bot target")
    assert.notEqual(memberId, self.id, "Use an explicitly authorized non-bot target for this targeted-member check")
    assert.notEqual(memberId, rawGuild.owner_id, "The guild owner cannot be this nickname test target")
    botId = self.id
    verified = true
    report(stage)

    if (journalFile.exists()) {
        journal = journalFile.read()
        await cleanup()
        target = await fetchTarget()
    }

    journal = {
        guildId,
        botId,
        memberId,
        originalNickname: nickname(target),
        changedNickname: `fn_${randomUUID().replaceAll("-", "").slice(0, 28)}`,
    }
    journalFile.create(journal)

    const sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
    if (mode === "default") client = sdk.createClient({ token, cache: { members: true } })
    else {
        scope = Scope.makeUnsafe()
        client = await Effect.runPromise(
            sdk.createClient({ token, cache: { members: true } }).pipe(Scope.provide(scope)),
        )
    }

    stage = "target_nickname_preflight"
    assert.equal(nickname(await fetchTarget()), journal.originalNickname, "Concurrent nickname change before mutation")
    report(stage)

    await value(client.members.fetch({ guildId, userId: memberId }))
    assert.equal((await cachedMember({ guildId, userId: memberId }))?.nickname ?? null, journal.originalNickname)

    stage = "target_nickname_set_lost_response"
    let markerDispatches = 0
    clientFetch = globalThis.fetch
    globalThis.fetch = async (request, options) => {
        const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url)
        const body = options?.body === undefined ? undefined : JSON.parse(String(options.body))
        if (
            options?.method === "PATCH" &&
            url.pathname === `/v1/guilds/${guildId}/members/${memberId}` &&
            body?.nick === journal.changedNickname
        ) {
            assert.equal(markerDispatches, 0, "The lost-response nickname write must not retry")
            markerDispatches += 1
            const response = await clientFetch(request, options)
            await response.body?.cancel()
            throw new TypeError("Intentionally lost nickname response")
        }
        return clientFetch(request, options)
    }
    try {
        await value(client.members.setNickname({ guildId, userId: memberId }, journal.changedNickname))
        assert.fail("The marker response must be lost")
    } catch (error) {
        assert.equal(error?._tag, "GuildOperationError")
        assert.equal(error?.reason, "network")
        assert.equal(error?.outcome, "unknown")
        assert.equal(error?.status, null)
    } finally {
        globalThis.fetch = clientFetch
        clientFetch = undefined
    }
    assert.equal(markerDispatches, 1)
    assert.equal(await cachedMember({ guildId, userId: memberId }), undefined)

    stage = "target_nickname_raw_reconciliation"
    assert.equal(nickname(await fetchTarget()), journal.changedNickname)
    report(stage)

    stage = "sdk_nickname_restore_and_independent_readback"
    const restored = await value(client.members.setNickname({ guildId, userId: memberId }, journal.originalNickname))
    assert.equal(restored.userId, memberId)
    assert.equal(restored.nickname ?? null, journal.originalNickname)
    assert.equal((await fetchTarget()).nick ?? null, journal.originalNickname)
    report(stage)
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
    if (clientFetch) globalThis.fetch = clientFetch
    const shutdown = async () => {
        const closed = client.shutdown()
        if (Effect.isEffect(closed)) await Effect.runPromise(closed)
        else await closed
    }
    // Keep the journal, lock and deadline if a failed owned finalizer may have left a writer alive
    await finalizeOwned({
        writers: [
            client && ["client_shutdown", shutdown],
            scope && ["scope_close", () => Effect.runPromise(Scope.close(scope, Exit.void))],
        ],
        cleanup,
        lock,
        watchdog,
        onFailure: (finalizer) => {
            if (finalizer === "cleanup")
                console.error(
                    JSON.stringify({
                        mode,
                        stage: "resource_cleanup",
                        passed: false,
                        journalRetained: journal !== undefined,
                    }),
                )
            else if (finalizer === "sandbox_lock")
                console.error(JSON.stringify({ mode, stage: "lock_cleanup", passed: false, lockRetained: true }))
            else
                console.error(
                    JSON.stringify({
                        mode,
                        stage: "client_cleanup",
                        passed: false,
                        finalizer,
                        journalRetained: journal !== undefined,
                        lockRetained: lock !== undefined,
                    }),
                )
            process.exitCode = 1
        },
    })
}
