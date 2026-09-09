import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, openSync, closeSync, writeSync, existsSync, unlinkSync } from "node:fs"
import { parseEnv } from "node:util"
import { Effect, Scope, Exit } from "effect"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
assert.ok(process.argv.slice(3).every((arg) => arg === "--mutate"))
const mutate = process.argv.includes("--mutate")
const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.vanity.local", import.meta.url)
let lock, client, scope, token, guildId, botId, journal
let verified = false,
    stage = "configuration"
const hash = (code) => createHash("sha256").update(code).digest("hex")
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
    assert.ok(response.ok || response.status === 404, `Sandbox HTTP ${response.status}`)
    return { status: response.status, data }
}
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
    unlinkSync(journalPath)
    journal = undefined
    report("initially_empty_custom_invite_slot_restored")
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
    assert.equal(app.data.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(app.data.bot?.id, self.data.id)
    assert.equal(self.data.bot, true)
    botId = self.data.id
    const guild = (await api("GET", `/guilds/${guildId}`)).data
    assert.equal(guild.id, guildId)
    assert.ok(Array.isArray(guild.features))
    verified = true
    report(stage)
    if (existsSync(journalPath)) {
        assert.ok(mutate && env.FLUXER_TEST_VANITY_MUTATIONS === "1", "Manual recovery requires mutation authorization")
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
        assert.equal(env.FLUXER_TEST_VANITY_MUTATIONS, "1", "Set explicit mutation authorization")
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
                assert.equal(Effect.isEffect(local) ? await Effect.runPromise(local) : local._unsafeUnwrap(), undefined)
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
