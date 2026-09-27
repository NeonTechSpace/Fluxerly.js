// Custom invite code reads with independent readback and transient read recovery, and a rejected write on a server
// without the feature. The manual mutation mode sets, replaces with a lost response and removes custom codes in an
// initially empty slot.
// Journal `.env.test.vanity.local` records sandbox and bot identity, the empty initial code, SHA-256 hashes of the two
// test codes, never the codes, and whether a provider write is unresolved. An existing journal is recovered before a
// new run only with mutation authorization: only a matching test-owned code is removed and concurrent replacements
// are refused. An uncertain partial write keeps the journal, even if the custom-code slot is empty
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
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
import { createSandboxApi, successOrNotFound } from "./support/sandbox-api.js"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
assert.ok(process.argv.slice(3).every((arg) => arg === "--mutate"))
const mutate = process.argv.includes("--mutate")
const rawFetch = globalThis.fetch
const journalFile = openJournal("vanity")
let lock, client, scope, token, guildId, botId, journal
let verified = false,
    stage = "configuration"
const hash = (code) => createHash("sha256").update(code).digest("hex")
const report = createReporter({ mode }, { passed: true })
const save = () => journalFile.save(journal)
const api = createSandboxApi({ fetch: rawFetch, token: () => token, accept: successOrNotFound })
async function state() {
    const guild = (await api("GET", `/guilds/${guildId}`)).data
    assert.equal(guild.id, guildId)
    const vanity = (await api("GET", `/guilds/${guildId}/vanity-url`)).data
    assert.equal(vanity.code, guild.vanity_url_code)
    return vanity
}
// Only an initially empty custom-invite slot may be used. No existing code is stored or restored
async function cleanup() {
    if (!journal || !verified) return
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.equal(journal.initialCode, null)
    assert.ok(Array.isArray(journal.hashes) && journal.hashes.length === 2)
    assert.ok(journal.hashes.every((item) => /^[a-f0-9]{64}$/.test(item)))
    const current = await state()
    if (current.code !== null) {
        assert.ok(journal.hashes.includes(hash(current.code)), "Concurrent custom-code change; journal retained")
        await api("PATCH", `/guilds/${guildId}/vanity-url`, { code: null })
    }
    assert.equal((await state()).code, null)
    // An interrupted provider write can leave an invite detached from the guild's code pointer
    // Retain the journal on an unresolved request rather than claiming rollback from an empty slot
    assert.equal(journal.pending, false, "Unresolved provider mutation; operator reconciliation required")
    journalFile.remove()
    journal = undefined
    report("initially_empty_custom_invite_slot_restored")
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
    const identity = await verifySandboxIdentity(async (path) => (await api("GET", path)).data, sandbox)
    botId = identity.botId
    const { guild } = identity
    assert.ok(Array.isArray(guild.features))
    verified = true
    report(stage)
    if (journalFile.exists()) {
        assert.ok(
            mutate && processAuthorized("FLUXER_TEST_VANITY_MUTATIONS"),
            "Manual recovery requires mutation authorization",
        )
        journal = journalFile.read()
        await cleanup()
    }
    const sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
    if (mode === "default") client = sdk.createClient({ token, cache: { guilds: true } })
    else {
        scope = Scope.makeUnsafe()
        client = await Effect.runPromise(
            sdk.createClient({ token, cache: { guilds: true } }).pipe(Scope.provide(scope)),
        )
    }
    stage = "remote_read_and_independent_readback"
    const before = await state()
    const observed = await value(client.guilds.fetchVanityUrl(guildId))
    assert.equal(observed.code, before.code)
    assert.equal(observed.uses, before.uses)
    assert.equal(observed.url, before.code === null ? null : `https://fluxer.gg/${encodeURIComponent(before.code)}`)
    assert.ok(Object.isFrozen(observed))
    report(stage)
    stage = "transient_read_recovery"
    let attempts = 0
    globalThis.fetch = async (url, options) => {
        if (String(url).endsWith(`/guilds/${guildId}/vanity-url`) && options?.method === "GET" && ++attempts === 1)
            return new Response(null, { status: 503 })
        return rawFetch(url, options)
    }
    assert.equal((await value(client.guilds.fetchVanityUrl(guildId))).code, before.code)
    assert.equal(attempts, 2)
    globalThis.fetch = rawFetch
    report(stage)
    if (!mutate) {
        if (!guild.features.includes("VANITY_URL")) {
            stage = "disabled_server_write_rejected"
            // This reserved spelling is also rejected if the feature is enabled concurrently
            let failure
            try {
                await value(client.guilds.editVanityUrl(guildId, "fluxer-vanity-test"))
            } catch (error) {
                failure = error
            }
            assert.equal(failure?._tag, "GuildOperationError")
            assert.equal(failure?.status, 400)
            assert.equal((await state()).code, before.code)
            report(stage)
        }
        console.log(
            JSON.stringify({
                mode,
                check: "successful_vanity_mutations",
                skipped: true,
                reason: "manual_mutation_mode_required",
            }),
        )
    } else {
        stage = "manual_mutation_preflight"
        assert.ok(processAuthorized("FLUXER_TEST_VANITY_MUTATIONS"), "Set explicit mutation authorization")
        assert.ok(guild.features.includes("VANITY_URL"), "Server needs VANITY_URL")
        assert.equal(before.code, null, "Existing custom codes must never be replaced by this test")
        const codes = [env.FLUXER_TEST_VANITY_CODE, env.FLUXER_TEST_VANITY_SECOND_CODE]
        assert.ok(
            codes.every(
                (code) =>
                    typeof code === "string" &&
                    code.length >= 2 &&
                    code.length <= 32 &&
                    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code) &&
                    !code.includes("fluxer"),
            ),
        )
        assert.notEqual(codes[0], codes[1])
        for (const code of codes) assert.equal((await api("GET", `/invites/${encodeURIComponent(code)}`)).status, 404)
        journal = { guildId, botId, initialCode: null, hashes: codes.map(hash), pending: false }
        save()
        for (const [index, code] of codes.entries()) {
            stage = index === 0 ? "set_custom_code" : "replace_code_with_lost_response"
            assert.equal((await state()).code, index === 0 ? null : codes[0])
            journal.pending = true
            save()
            attempts = 0
            let confirmed = false
            globalThis.fetch = async (url, options) => {
                const response = await rawFetch(url, options)
                if (String(url).endsWith(`/guilds/${guildId}/vanity-url`) && options?.method === "PATCH") {
                    attempts++
                    if (response.ok) {
                        const body = await response.clone().json()
                        confirmed = body.code === code
                        if (confirmed) {
                            journal.pending = false
                            save()
                        }
                        if (index === 1) {
                            await response.arrayBuffer()
                            throw Error("Test-owned discarded response")
                        }
                    }
                }
                return response
            }
            if (index === 0) {
                const result = await value(client.guilds.editVanityUrl(guildId, code))
                assert.equal(result.code, code)
                assert.equal(result.url, `https://fluxer.gg/${code}`)
            } else {
                await value(client.guilds.fetch(guildId))
                let failure
                try {
                    await value(client.guilds.editVanityUrl(guildId, code))
                } catch (error) {
                    failure = error
                }
                assert.equal(failure?.reason, "network")
                assert.equal(failure?.outcome, "unknown")
                const local = client.guilds.get(guildId)
                assert.equal(Effect.isEffect(local) ? await Effect.runPromise(local) : local, undefined)
            }
            globalThis.fetch = rawFetch
            assert.equal(attempts, 1)
            assert.ok(confirmed)
            assert.equal((await state()).code, code)
            assert.equal((await value(client.guilds.fetchVanityUrl(guildId))).code, code)
            const invite = await value(client.invites.fetch(code))
            assert.equal(invite.guild?.id, guildId)
            assert.equal(invite.code, code)
            if (index === 1) assert.equal((await api("GET", `/invites/${encodeURIComponent(codes[0])}`)).status, 404)
            report(stage)
        }
        stage = "remove_custom_code"
        assert.equal((await value(client.guilds.editVanityUrl(guildId, null))).code, null)
        assert.equal((await state()).code, null)
        for (const code of codes) assert.equal((await api("GET", `/invites/${encodeURIComponent(code)}`)).status, 404)
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
