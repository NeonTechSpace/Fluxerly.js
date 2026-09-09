import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync, openSync, closeSync, writeSync, existsSync, unlinkSync } from "node:fs"
import { parseEnv } from "node:util"
import { Effect, Scope, Exit } from "effect"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.invites.local", import.meta.url)
let lock, journal, client, scope, token, guildId, botId
let verified = false,
    stage = "configuration"
const report = (check) => console.log(JSON.stringify({ mode, check, passed: true }))
// The journal contains destination identity only, never invite codes
const save = () => writeFileSync(journalPath, JSON.stringify(journal))
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
    const response = await rawFetch(`https://api.fluxer.app/v1${path}`, {
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
    assert.ok(response.ok || response.status === 404, `Sandbox HTTP ${response.status}`)
    return { status: response.status, data }
}
async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.match(journal.marker, /^fi_[a-f0-9]{16}$/)
    const channels = (await api("GET", `/guilds/${guildId}/channels`)).data
    assert.ok(Array.isArray(channels))
    const matches = channels.filter((item) => item.id === journal.channelId || item.name === journal.marker)
    assert.ok(matches.length <= 1)
    assert.ok(matches.length || journal.channelId || !journal.channelPending, "Unresolved channel creation")
    for (const channel of matches) {
        assert.equal(channel.name, journal.marker)
        assert.equal(channel.guild_id, guildId)
        assert.equal(channel.type, 0)
        journal.channelId = channel.id
        save()
        const invites = (await api("GET", `/channels/${channel.id}/invites`)).data
        assert.ok(Array.isArray(invites))
        assert.ok(invites.length <= 3)
        for (const invite of invites) {
            assert.equal(invite.channel.id, channel.id)
            assert.equal(invite.guild.id, guildId)
            assert.equal(invite.inviter?.id, botId)
            const path = `/invites/${encodeURIComponent(invite.code)}`
            await api("DELETE", path)
            assert.equal((await api("GET", path)).status, 404)
        }
        assert.deepEqual((await api("GET", `/channels/${channel.id}/invites`)).data, [])
        await api("DELETE", `/channels/${channel.id}`)
    }
    if (journal.channelId) {
        assert.equal((await api("GET", `/channels/${journal.channelId}`)).status, 404)
        const invites = (await api("GET", `/guilds/${guildId}/invites`)).data
        assert.ok(Array.isArray(invites))
        assert.ok(!invites.some((item) => item.channel.id === journal.channelId))
    }
    unlinkSync(journalPath)
    journal = undefined
    report("test_invites_revoked_and_channel_removed")
}
const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: true }))
    process.exit(1)
}, 180_000).unref()
try {
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    assert.ok(token)
    assert.match(guildId ?? "", /^[1-9][0-9]*$/)
    stage = "sandbox_identity"
    const app = await api("GET", "/applications/@me"),
        self = await api("GET", "/users/@me")
    assert.equal(app.data.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(app.data.bot?.id, self.data.id)
    assert.equal(self.data.bot, true)
    assert.equal((await api("GET", `/guilds/${guildId}`)).data.id, guildId)
    botId = self.data.id
    verified = true
    report(stage)
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }
    journal = { guildId, botId, marker: `fi_${randomUUID().replaceAll("-", "").slice(0, 16)}`, channelPending: false }
    save()
    const sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
    if (mode === "default") client = sdk.createClient({ token })._unsafeUnwrap()
    else {
        scope = Scope.makeUnsafe()
        client = await Effect.runPromise(sdk.createClient({ token }).pipe(Scope.provide(scope)))
    }
    stage = "owned_channel"
    journal.channelPending = true
    save()
    const channel = await value(client.channels.create(guildId, { type: 0, name: journal.marker }))
    journal.channelId = channel.id
    save()
    const created = []
    const deleted = []
    const knownCodes = new Set()
    let observationOverflow
    const retain = (events, event, limit, name) => {
        if (events.length === limit) {
            observationOverflow ??= name
            return
        }
        events.push(event)
    }
    const observeCreate = (invite) => {
        if (
            invite.guild?.id !== journal.guildId ||
            invite.channel.id !== journal.channelId ||
            invite.inviterId !== journal.botId
        )
            return
        retain(
            created,
            {
                code: invite.code,
                channelId: invite.channel.id,
                guildId: invite.guild.id,
                url: invite.url,
            },
            3,
            "Invite create observation overflow",
        )
    }
    const observeDelete = (invite) => {
        if (
            invite.guildId !== journal.guildId ||
            invite.channelId !== journal.channelId ||
            !knownCodes.has(invite.code)
        )
            return
        retain(
            deleted,
            { code: invite.code, guildId: invite.guildId, channelId: invite.channelId },
            1,
            "Invite delete observation overflow",
        )
    }
    for (const [event, observe] of [
        ["inviteCreate", observeCreate],
        ["inviteDelete", observeDelete],
    ]) {
        if (mode === "default") client.on(event, observe)._unsafeUnwrap()
        else
            await Effect.runPromise(
                client
                    .on(event, (invite) => Effect.sync(() => observe(invite)))
                    .pipe(Effect.provideService(Scope.Scope, scope)),
            )
    }
    await value(client.connect())
    const waitForInvite = async (events, code) => {
        const until = Date.now() + 10_000
        while (!events.some((event) => event.code === code) && !observationOverflow && Date.now() < until)
            await new Promise((resolve) => setTimeout(resolve, 25))
        assert.equal(observationOverflow, undefined, observationOverflow)
        return events.find((event) => event.code === code)
    }
    stage = "separate_one_day_defaults_and_readback"
    const first = await value(client.invites.create(channel.id, undefined, { auditReason: "SDK invite check" }))
    knownCodes.add(first.code)
    const second = await value(client.invites.create(channel.id))
    knownCodes.add(second.code)
    assert.notEqual(first.code, second.code)
    for (const expected of [first, second]) {
        const observed = await waitForInvite(created, expected.code)
        assert.equal(observed?.channelId, channel.id)
        assert.equal(observed?.guildId, guildId)
        assert.equal(observed?.url, expected.url)
    }
    for (const invite of [first, second]) {
        assert.equal(invite.maxAgeSeconds, 86400)
        const link = new URL(invite.url)
        assert.equal(link.origin, "https://fluxer.gg")
        assert.equal(decodeURIComponent(link.pathname.slice(1)), invite.code)
        assert.equal(invite.maxUses, 0)
        assert.equal(invite.temporary, false)
        assert.equal(invite.inviterId, botId)
        assert.equal(Date.parse(invite.expiresAt) - Date.parse(invite.createdAt), 86400000)
        const remote = (await api("GET", `/invites/${encodeURIComponent(invite.code)}`)).data
        assert.equal(remote.channel.id, channel.id)
        assert.equal(remote.guild.id, guildId)
        assert.equal((await value(client.invites.fetch(invite.code))).code, invite.code)
    }
    assert.equal((await value(client.invites.fetchChannel(channel.id))).length, 2)
    assert.equal(
        (await value(client.invites.fetchGuild(guildId))).filter((item) => item.channel.id === channel.id).length,
        2,
    )
    report(stage)
    stage = "lost_create_response_reconciliation"
    let attempts = 0
    globalThis.fetch = async (url, init) => {
        const response = await rawFetch(url, init)
        if (String(url).endsWith(`/channels/${channel.id}/invites`) && init?.method === "POST") {
            attempts++
            await response.arrayBuffer()
            assert.equal(response.status, 200)
            throw new Error("Discarded test-owned invite response")
        }
        return response
    }
    try {
        await assert.rejects(
            value(client.invites.create(channel.id)),
            (error) => error.reason === "network" && error.outcome === "unknown",
        )
    } finally {
        globalThis.fetch = rawFetch
    }
    assert.equal(attempts, 1)
    const reconciled = (await api("GET", `/channels/${channel.id}/invites`)).data
    assert.equal(reconciled.length, 3)
    assert.ok(reconciled.every((item) => item.inviter?.id === botId && item.max_age === 86400))
    report(stage)
    stage = "revocation_and_missing_code"
    await value(client.invites.delete(first.code))
    const revoked = await waitForInvite(deleted, first.code)
    assert.deepEqual(revoked, { code: first.code, guildId, channelId: channel.id })
    assert.equal((await api("GET", `/invites/${encodeURIComponent(first.code)}`)).status, 404)
    await assert.rejects(value(client.invites.fetch(first.code)), (error) => error.status === 404)
    await assert.rejects(value(client.invites.delete(first.code)), (error) => error.status === 404)
    assert.equal((await value(client.invites.fetchChannel(channel.id))).length, 2)
    assert.equal(observationOverflow, undefined, observationOverflow)
    report(stage)
} catch (error) {
    console.error(
        JSON.stringify({
            mode,
            stage,
            passed: false,
            tag: error?._tag ?? error?.name ?? "Error",
            reason: error?.reason ?? null,
            status: error?.status ?? null,
        }),
    )
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    try {
        if (client) {
            const closed = client.shutdown()
            if (Effect.isEffect(closed)) await Effect.runPromise(closed)
            else await closed
        }
        if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
    } catch {
        console.error(JSON.stringify({ mode, stage: "client_cleanup", passed: false }))
        process.exitCode = 1
    }
    try {
        await cleanup()
    } catch {
        console.error(JSON.stringify({ mode, stage: "resource_cleanup", passed: false, journalRetained: true }))
        process.exitCode = 1
    }
    clearTimeout(watchdog)
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
