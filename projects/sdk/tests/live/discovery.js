// Discovery categories, status and directory search with independent readback and transient read recovery. The
// manual mutation mode submits, edits and withdraws a real discovery application for an eligible disposable server.
// Journal `.env.test.discovery.local` records sandbox and bot identity, a synthetic marker description, the
// application timestamp and whether a provider write is unresolved. An existing journal triggers recovery only
// with mutation authorization: Unrelated descriptions or replacement applications are refused, the test
// application is withdrawn, and removal of the record and the discoverable feature is verified. An unresolved write
// keeps the journal for operator reconciliation
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Effect, Scope, Exit } from "effect"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    processAuthorized,
    verifySandboxIdentity,
} from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { settle as value } from "./support/results.js"
import { createSandboxApi } from "./support/sandbox-api.js"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
assert.ok(process.argv.slice(3).every((arg) => arg === "--mutate"))
const mutate = process.argv.includes("--mutate")
const rawFetch = globalThis.fetch
const journalFile = openJournal("discovery")
let lock, client, scope, token, guildId, botId, journal
let verified = false,
    stage = "configuration"
const report = createReporter({ mode }, { passed: true })
const save = () => journalFile.save(journal)
const sandboxApi = createSandboxApi({ fetch: rawFetch, token: () => token })
const api = async (method, path) => (await sandboxApi(method, path)).data
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
    journalFile.remove()
    journal = undefined
    report("test_application_removed_and_guild_feature_checked")
}
const watchdog = setTimeout(() => {
    console.error(
        JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: journalFile.exists() }),
    )
    process.exit(1)
}, 120_000).unref()
try {
    lock = acquireLock()
    const sandbox = loadSandboxEnvironment({ processOverrides: true })
    const { env } = sandbox
    token = sandbox.token
    guildId = sandbox.guildId
    stage = "sandbox_identity"
    const identity = await verifySandboxIdentity((path) => api("GET", path), sandbox)
    botId = identity.botId
    const { guild } = identity
    verified = true
    report(stage)
    if (journalFile.exists()) {
        assert.ok(
            mutate && processAuthorized("FLUXER_TEST_DISCOVERY_MUTATIONS"),
            "Explicit mutation authorization required for recovery",
        )
        journal = journalFile.read()
        stage = "recovery_only"
        await cleanup()
        report(stage)
    } else {
        const sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
        if (mode === "default") client = sdk.createClient({ token, cache: { guilds: true } })
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
            assert.ok(
                processAuthorized("FLUXER_TEST_DISCOVERY_MUTATIONS"),
                "Explicit public-submission authorization required",
            )
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
            assert.equal(Effect.isEffect(local) ? await Effect.runPromise(local) : local, undefined)
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
