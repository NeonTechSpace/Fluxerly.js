import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync, openSync, closeSync, writeSync, existsSync, unlinkSync } from "node:fs"
import { parseEnv } from "node:util"
import { Effect, Scope, Exit, Stream } from "effect"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.administration.local", import.meta.url)
let lock, journal, client, scope, token, guildId, botId
let verified = false,
    stage = "configuration"
const report = (check) => console.log(JSON.stringify({ mode, check, passed: true }))
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
    assert.ok(response.ok, `Sandbox HTTP ${response.status}`)
    return { status: response.status, data }
}
async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.match(journal.marker, /^fa_[a-f0-9]{16}$/)
    assert.equal(typeof journal.originalName, "string")
    assert.ok(journal.originalName.length > 0 && [...journal.originalName].length <= 100)
    const current = (await api("GET", `/guilds/${guildId}`)).data
    assert.equal(current.id, guildId)
    assert.ok(
        [journal.originalName, journal.marker, `${journal.marker}_lost`].includes(current.name),
        "Conflicting server rename; retain restoration journal",
    )
    if (current.name !== journal.originalName) await api("PATCH", `/guilds/${guildId}`, { name: journal.originalName })
    assert.equal((await api("GET", `/guilds/${guildId}`)).data.name, journal.originalName)
    unlinkSync(journalPath)
    journal = undefined
    report("original_server_name_restored")
}
async function gather(query) {
    const result = []
    if (mode === "effect") {
        for await (const item of Stream.toAsyncIterable(client.auditLogs.iterate(guildId, query))) result.push(item)
    } else {
        for await (const item of client.auditLogs.iterate(guildId, query)) {
            if (item.isErr()) throw item.error
            result.push(item.value)
        }
    }
    return result
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
    const sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
    const options = { token, cache: { guilds: true } }
    if (mode === "default") client = sdk.createClient(options)._unsafeUnwrap()
    else {
        scope = Scope.makeUnsafe()
        client = await Effect.runPromise(sdk.createClient(options).pipe(Scope.provide(scope)))
    }
    const original = await value(client.guilds.fetch(guildId))
    journal = {
        guildId,
        botId,
        marker: `fa_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        originalName: original.name,
    }
    save()
    stage = "server_rename_and_independent_readback"
    const renamed = await value(client.guilds.edit(guildId, { name: journal.marker }, { auditReason: journal.marker }))
    assert.equal(renamed.name, journal.marker)
    assert.equal((await api("GET", `/guilds/${guildId}`)).data.name, journal.marker)
    assert.equal((await value(client.guilds.fetch(guildId))).name, journal.marker)
    report(stage)
    stage = "lost_server_edit_response_reconciliation"
    let attempts = 0
    globalThis.fetch = async (url, init) => {
        const response = await rawFetch(url, init)
        if (String(url).endsWith(`/guilds/${guildId}`) && init?.method === "PATCH") {
            attempts++
            await response.arrayBuffer()
            assert.equal(response.status, 200)
            throw new Error("Discarded test-owned settings response")
        }
        return response
    }
    try {
        await assert.rejects(
            value(client.guilds.edit(guildId, { name: `${journal.marker}_lost` }, { auditReason: journal.marker })),
            (error) => error.reason === "network" && error.outcome === "unknown",
        )
    } finally {
        globalThis.fetch = rawFetch
    }
    assert.equal(attempts, 1)
    const cached = client.guilds.get(guildId)
    assert.equal(Effect.isEffect(cached) ? await Effect.runPromise(cached) : cached._unsafeUnwrap(), undefined)
    assert.equal((await api("GET", `/guilds/${guildId}`)).data.name, `${journal.marker}_lost`)
    assert.equal((await value(client.guilds.fetch(guildId))).name, `${journal.marker}_lost`)
    report(stage)
    stage = "filtered_audit_pages_and_cursor_readback"
    let page
    for (let attempt = 0; attempt < 8; attempt++) {
        page = await value(client.auditLogs.fetchPage(guildId, { userId: botId, actionType: 1, limit: 10 }))
        if (page.entries.filter((entry) => entry.reason === journal.marker).length >= 2) break
        await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const owned = page.entries.filter((entry) => entry.reason === journal.marker)
    assert.ok(owned.length >= 2)
    assert.ok(owned.every((entry) => entry.targetId === guildId && entry.userId === botId))
    assert.ok(
        owned.some((entry) =>
            entry.changes?.some((change) => change.key === "name" && change.newValue === `${journal.marker}_lost`),
        ),
    )
    const raw = (await api("GET", `/guilds/${guildId}/audit-logs?user_id=${botId}&action_type=1&limit=3`)).data
    const iterated = await gather({ userId: botId, actionType: 1, maxItems: 3, pageSize: 1 })
    assert.deepEqual(
        iterated.map((entry) => entry.id),
        raw.audit_log_entries.map((entry) => entry.id),
    )
    assert.equal(new Set(iterated.map((entry) => entry.id)).size, iterated.length)
    const after = await value(
        client.auditLogs.fetchPage(guildId, { userId: botId, actionType: 1, after: iterated[1].id, limit: 3 }),
    )
    assert.ok(after.entries.some((entry) => entry.id === iterated[0].id))
    report(stage)
    stage = "transient_audit_read_recovery"
    let readAttempts = 0
    globalThis.fetch = async (url, init) => {
        if (String(url).includes("/audit-logs") && readAttempts++ === 0) return new Response(null, { status: 503 })
        return rawFetch(url, init)
    }
    try {
        await value(client.auditLogs.fetchPage(guildId, { userId: botId, actionType: 1, limit: 1 }))
    } finally {
        globalThis.fetch = rawFetch
    }
    assert.equal(readAttempts, 2)
    report(stage)
    stage = "sdk_name_restore_and_readback"
    await value(client.guilds.edit(guildId, { name: journal.originalName }, { auditReason: journal.marker }))
    assert.equal((await api("GET", `/guilds/${guildId}`)).data.name, journal.originalName)
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
