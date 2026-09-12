import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync, openSync, closeSync, writeSync, existsSync, unlinkSync } from "node:fs"
import { parseEnv } from "node:util"
import { Effect, Scope, Exit } from "effect"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
assert.ok(process.argv.slice(3).every((arg) => arg === "--mutate"))
const mutate = process.argv.includes("--mutate")
const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.discovery.local", import.meta.url)
let lock, client, scope, token, guildId, botId, journal
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
async function api(method, path) {
    const response = await rawFetch(`https://api.fluxer.app/v1${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bot ${token}` },
    })
    const data = await response.json().catch(() => null)
    assert.ok(response.ok, `Sandbox HTTP ${response.status}`)
    return data
}
const status = () => api("GET", `/guilds/${guildId}/discovery`)
async function cleanup() {
    if (!journal || !verified) return
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.match(journal.marker, /^SDK discovery test [a-f0-9]{16}$/)
    assert.equal(journal.initialApplication, null)
    const current = (await status()).application
    if (current !== null) {
        assert.equal(current.guild_id, guildId)
        assert.ok(
            [journal.marker, `${journal.marker} edited`].includes(current.description),
            "Concurrent application change; journal retained",
        )
        if (journal.appliedAt !== undefined) assert.equal(current.applied_at, journal.appliedAt)
        await api("DELETE", `/guilds/${guildId}/discovery`)
    }
    assert.equal((await status()).application, null)
    const guild = await api("GET", `/guilds/${guildId}`)
    assert.equal(guild.id, guildId)
    assert.ok(!guild.features.includes("DISCOVERABLE"), "Provider feature cleanup unresolved")
    assert.equal(journal.pending, false, "Unresolved provider write; operator reconciliation required")
    unlinkSync(journalPath)
    journal = undefined
    report("test_application_removed_and_guild_feature_checked")
}
const watchdog = setTimeout(() => {
    console.error(
        JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: existsSync(journalPath) }),
    )
    process.exit(1)
}, 120_000).unref()
try {
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    const env = { ...parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8")), ...process.env }
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    assert.ok(token)
    assert.match(guildId ?? "", /^[1-9][0-9]*$/)
    stage = "sandbox_identity"
    const app = await api("GET", "/applications/@me"),
        self = await api("GET", "/users/@me")
    assert.equal(app.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(app.bot?.id, self.id)
    assert.equal(self.bot, true)
    botId = self.id
    const guild = await api("GET", `/guilds/${guildId}`)
    assert.equal(guild.id, guildId)
    verified = true
    report(stage)
    if (existsSync(journalPath)) {
        assert.ok(
            mutate && env.FLUXER_TEST_DISCOVERY_MUTATIONS === "1",
            "Explicit mutation authorization required for recovery",
        )
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }
    const sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
    if (mode === "default") client = sdk.createClient({ token, cache: { guilds: true } })._unsafeUnwrap()
    else {
        scope = Scope.makeUnsafe()
        client = await Effect.runPromise(
            sdk.createClient({ token, cache: { guilds: true } }).pipe(Scope.provide(scope)),
        )
    }
    stage = "categories_and_status_independent_readback"
    const categories = await value(client.discovery.fetchCategories())
    assert.deepEqual(
        categories,
        (await api("GET", "/discovery/categories")).map(({ id, name }) => ({ id, name })),
    )
    const before = await status(),
        observed = await value(client.discovery.fetchStatus(guildId))
    let attempts = 0
    assert.equal(observed.eligible, before.eligible)
    assert.equal(observed.minMemberCount, before.min_member_count)
    assert.equal(observed.application?.guildId ?? null, before.application?.guild_id ?? null)
    assert.equal(observed.application?.status ?? null, before.application?.status ?? null)
    assert.ok(Object.isFrozen(observed) && Object.isFrozen(categories))
    report(stage)
    stage = "directory_search_and_transient_read_recovery"
    const directory = await value(client.discovery.search({ limit: 1, offset: 0 }))
    const directoryReadback = await api("GET", "/discovery/guilds?limit=1&offset=0")
    assert.equal(directory.total, directoryReadback.total)
    assert.deepEqual(
        directory.guilds.map((guild) => guild.id),
        directoryReadback.guilds.map((guild) => guild.id),
    )
    assert.ok(Object.isFrozen(directory) && Object.isFrozen(directory.guilds))
    attempts = 0
    globalThis.fetch = async (url, options) => {
        if (String(url).includes("/discovery/guilds?") && options?.method === "GET" && ++attempts === 1)
            return new Response(null, { status: 503 })
        return rawFetch(url, options)
    }
    await value(client.discovery.search({ limit: 1 }))
    assert.equal(attempts, 2)
    globalThis.fetch = rawFetch
    report(stage)
    stage = "transient_status_read_recovery"
    attempts = 0
    globalThis.fetch = async (url, options) => {
        if (String(url).endsWith(`/guilds/${guildId}/discovery`) && options?.method === "GET" && ++attempts === 1)
            return new Response(null, { status: 503 })
        return rawFetch(url, options)
    }
    await value(client.discovery.fetchStatus(guildId))
    assert.equal(attempts, 2)
    globalThis.fetch = rawFetch
    report(stage)
    if (!mutate) {
        assert.deepEqual(await status(), before)
        console.log(
            JSON.stringify({
                mode,
                check: "discovery_mutations",
                skipped: true,
                reason: "requires_authorized_eligible_disposable_server_and_real_submission",
            }),
        )
    } else {
        stage = "manual_public_submission_preflight"
        assert.equal(env.FLUXER_TEST_DISCOVERY_MUTATIONS, "1", "Explicit public-submission authorization required")
        const current = await status()
        assert.equal(current.application, null, "Existing applications and listings must not be altered")
        assert.equal(current.eligible, true, "Server must be eligible and discovery enabled")
        assert.ok(!guild.features.includes("DISCOVERABLE"))
        const categoryId = Number(env.FLUXER_TEST_DISCOVERY_CATEGORY_ID ?? 8)
        assert.ok(categories.some((category) => category.id === categoryId))
        journal = {
            guildId,
            botId,
            initialApplication: null,
            marker: `SDK discovery test ${randomUUID().replaceAll("-", "").slice(0, 16)}`,
            pending: true,
        }
        save()
        stage = "submit_with_lost_response_and_reconcile"
        attempts = 0
        globalThis.fetch = async (url, options) => {
            const response = await rawFetch(url, options)
            if (String(url).endsWith(`/guilds/${guildId}/discovery`) && options?.method === "POST") {
                attempts++
                if (response.ok) {
                    const created = await response.clone().json()
                    assert.equal(created.guild_id, guildId)
                    assert.equal(created.description, journal.marker)
                    journal.appliedAt = created.applied_at
                    journal.pending = false
                    save()
                    await response.arrayBuffer()
                    throw Error("Test-owned discarded response")
                }
            }
            return response
        }
        await value(client.guilds.fetch(guildId))
        let failure
        try {
            await value(
                client.discovery.apply(guildId, {
                    description: journal.marker,
                    categoryId,
                    primaryLanguage: "en-US",
                    tags: ["sdk test"],
                }),
            )
        } catch (error) {
            failure = error
        }
        globalThis.fetch = rawFetch
        assert.equal(failure?.reason, "network")
        assert.equal(failure?.outcome, "unknown")
        assert.equal(attempts, 1)
        const local = client.guilds.get(guildId)
        assert.equal(Effect.isEffect(local) ? await Effect.runPromise(local) : local._unsafeUnwrap(), undefined)
        const created = (await value(client.discovery.fetchStatus(guildId))).application
        assert.equal(created?.description, journal.marker)
        assert.equal(created?.appliedAt, journal.appliedAt)
        assert.equal((await status()).application.applied_at, journal.appliedAt)
        report(stage)
        stage = "edit_test_application_and_readback"
        assert.equal((await status()).application.description, journal.marker)
        journal.pending = true
        save()
        const edited = await value(
            client.discovery.edit(guildId, { description: `${journal.marker} edited`, tags: [] }),
        )
        assert.equal(edited.description, `${journal.marker} edited`)
        assert.deepEqual(edited.tags, [])
        journal.pending = false
        save()
        assert.equal((await status()).application.description, edited.description)
        report(stage)
        stage = "withdraw_test_application_and_readback"
        await value(client.discovery.withdraw(guildId))
        assert.equal((await status()).application, null)
        report(stage)
    }
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
