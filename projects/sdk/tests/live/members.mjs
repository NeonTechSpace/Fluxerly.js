import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { parseEnv } from "node:util"
import { Effect, Exit, Scope } from "effect"

// Manual, current-authorization check only. FLUXER_TEST_MEMBER_ID must come from this invocation, never the env file
const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const memberId = process.env.FLUXER_TEST_MEMBER_ID
assert.match(memberId ?? "", /^[1-9][0-9]{0,19}$/, "Set the currently authorized FLUXER_TEST_MEMBER_ID")

const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.members.local", import.meta.url)
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

const report = (check) => console.log(JSON.stringify({ mode, check, passed: true }))

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

async function api(method, path, body) {
    let response
    try {
        response = await rawFetch(`https://api.fluxer.app/v1${path}`, {
            method,
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
            headers: {
                Authorization: `Bot ${token}`,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const data = await response.json().catch(() => null)
        assert.ok(response.ok, `Sandbox HTTP ${response.status}`)
        return data
    } finally {
        if (response && !response.bodyUsed) await response.body?.cancel()
    }
}

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
    unlinkSync(journalPath)
    journal = undefined
    report("target_nickname_restored")
}

const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: true }))
    process.exit(1)
}, 90_000).unref()

try {
    // An existing lock, including a stale one, is a failure: do not bypass another run or delete its recovery state
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))

    const env = { ...parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8")), ...process.env }
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    assert.ok(token && token === token.trim())
    assert.match(guildId ?? "", /^[1-9][0-9]{0,19}$/)
    assert.match(env.FLUXER_TEST_APPLICATION_ID ?? "", /^[1-9][0-9]{0,19}$/)

    stage = "sandbox_and_target_identity"
    const [application, self, rawGuild] = await Promise.all([
        api("GET", "/applications/@me"),
        api("GET", "/users/@me"),
        api("GET", `/guilds/${guildId}`),
    ])
    let target = await fetchTarget()
    assert.equal(application.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(application.bot?.id, self.id)
    assert.equal(self.bot, true)
    assert.equal(rawGuild.id, guildId)
    assert.equal(target.user?.id, memberId)
    assert.notEqual(target.user?.bot, true, "Use the currently authorized non-bot target")
    assert.notEqual(memberId, self.id, "Use an explicitly authorized non-bot target for this targeted-member check")
    assert.notEqual(memberId, rawGuild.owner_id, "The guild owner cannot be this nickname test target")
    botId = self.id
    verified = true
    report(stage)

    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
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
    writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })

    const sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
    if (mode === "default") client = sdk.createClient({ token, cache: { members: true } })._unsafeUnwrap()
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
    assert.equal(
        (await value(client.members.get({ guildId, userId: memberId })))?.nickname ?? null,
        journal.originalNickname,
    )

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
    assert.equal(await value(client.members.get({ guildId, userId: memberId })), undefined)

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
    let quiescent = true
    const retainEvidence = (finalizer) => {
        quiescent = false
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
    }
    if (client)
        try {
            const closed = client.shutdown()
            if (Effect.isEffect(closed)) await Effect.runPromise(closed)
            else await closed
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
            await cleanup()
        } catch {
            console.error(
                JSON.stringify({
                    mode,
                    stage: "resource_cleanup",
                    passed: false,
                    journalRetained: journal !== undefined,
                }),
            )
            process.exitCode = 1
        }
    if (quiescent && lock !== undefined) {
        try {
            closeSync(lock)
            unlinkSync(lockPath)
        } catch {
            console.error(JSON.stringify({ mode, stage: "lock_cleanup", passed: false, lockRetained: true }))
            process.exitCode = 1
        }
    }
    if (quiescent) clearTimeout(watchdog)
}
