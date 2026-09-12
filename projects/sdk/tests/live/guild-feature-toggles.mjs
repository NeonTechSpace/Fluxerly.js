import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { parseEnv } from "node:util"
import { Effect, Exit, Scope } from "effect"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.guild-features.local", import.meta.url)
const sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
const toggles = new Set(Object.values(sdk.GuildFeatureToggles))
const emoji = sdk.GuildFeatureToggles.CloneEmojiEnabled
const sticker = sdk.GuildFeatureToggles.CloneStickerEnabled
const crown = sdk.GuildFeatureToggles.HideOwnerCrown
assert.equal(emoji, "CLONE_EMOJI_ENABLED")
assert.equal(sticker, "CLONE_STICKER_ENABLED")
let lock, journal, client, scope, token, guildId, botId
let verified = false
let stage = "configuration"
const report = (check) => console.log(JSON.stringify({ mode, check, passed: true }))
const ordered = (features) => [...features].sort()
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b))
const validFeatures = (features) =>
    Array.isArray(features) &&
    features.every((feature) => typeof feature === "string") &&
    new Set(features).size === features.length
const save = () => writeFileSync(journalPath, JSON.stringify(journal))
async function value(operation) {
    if (Effect.isEffect(operation)) return Effect.runPromise(operation)
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
    assert.ok(response.ok, `Sandbox HTTP ${response.status}`)
    return response.json()
}
async function observedFeatures() {
    const guild = await api("GET", `/guilds/${guildId}`)
    assert.equal(guild.id, guildId)
    assert.ok(validFeatures(guild.features))
    return ordered(guild.features)
}
function validateJournal() {
    assert.equal(journal.version, 1)
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.match(journal.marker, /^fg_[a-f0-9]{16}$/)
    assert.ok(validFeatures(journal.original))
    assert.ok(validFeatures(journal.expected))
    const unchanged = (features) => features.filter((feature) => ![emoji, sticker, crown].includes(feature))
    assert.ok(same(unchanged(journal.original), unchanged(journal.expected)))
    if (journal.pending !== undefined) {
        assert.ok(validFeatures(journal.pending))
        assert.ok(same(unchanged(journal.original), unchanged(journal.pending)))
    }
}
async function cleanup() {
    if (!verified || !journal) return
    validateJournal()
    const current = await observedFeatures()
    assert.ok(
        same(current, journal.original) ||
            same(current, journal.expected) ||
            (journal.pending !== undefined && same(current, journal.pending)),
        "Conflicting guild features; retain restoration journal",
    )
    if (!same(current, journal.original)) {
        // Reads detect conflicts but Fluxer has no conditional PATCH; restoration is not atomic
        await api("PATCH", `/guilds/${guildId}`, {
            features: journal.original.filter((feature) => toggles.has(feature)),
        })
    }
    assert.ok(same(await observedFeatures(), journal.original), "Original guild features were not restored")
    unlinkSync(journalPath)
    journal = undefined
    report("original_guild_features_restored")
}
async function edit(selected, check, loseResponse = false) {
    stage = check
    assert.ok(same(await observedFeatures(), journal.expected), "Concurrent feature change before mutation")
    const desired = [
        ...journal.original.filter((feature) => toggles.has(feature) && ![emoji, sticker, crown].includes(feature)),
        ...selected,
    ]
    const expected = ordered([...journal.original.filter((feature) => !toggles.has(feature)), ...desired])
    journal.pending = expected
    save()
    let attempts = 0
    if (loseResponse) {
        globalThis.fetch = async (url, init) => {
            const response = await rawFetch(url, init)
            if (String(url) === `https://api.fluxer.app/v1/guilds/${guildId}` && init?.method === "PATCH") {
                attempts++
                await response.arrayBuffer()
                assert.equal(response.status, 200)
                throw new Error("Discarded test-owned guild feature response")
            }
            return response
        }
    }
    try {
        const operation = value(
            client.guilds.edit(guildId, { featureToggles: desired }, { auditReason: journal.marker }),
        )
        if (loseResponse) {
            await assert.rejects(operation, (error) => error.reason === "network" && error.outcome === "unknown")
            assert.equal(attempts, 1)
            assert.equal(await value(client.guilds.get(guildId)), undefined)
        } else {
            const result = await operation
            assert.ok(same(result.features, expected))
        }
    } finally {
        globalThis.fetch = rawFetch
    }
    assert.ok(same(await observedFeatures(), expected), "Independent feature readback differs")
    assert.ok(same((await value(client.guilds.fetch(guildId))).features, expected))
    journal.expected = expected
    delete journal.pending
    save()
    report(check)
}

const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: Boolean(journal) }))
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
    const application = await api("GET", "/applications/@me")
    const self = await api("GET", "/users/@me")
    assert.equal(application.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(application.bot?.id, self.id)
    assert.equal(self.bot, true)
    botId = self.id
    await observedFeatures()
    verified = true
    report(stage)
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }
    const options = { token, cache: { guilds: true } }
    if (mode === "default") client = sdk.createClient(options)._unsafeUnwrap()
    else {
        scope = Scope.makeUnsafe()
        client = await Effect.runPromise(sdk.createClient(options).pipe(Scope.provide(scope)))
    }
    const original = await observedFeatures()
    journal = {
        version: 1,
        guildId,
        botId,
        marker: `fg_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        original,
        expected: original,
    }
    save()
    const originalCrown = original.includes(crown) ? [crown] : []
    const changedCrown = original.includes(crown) ? [] : [crown]
    await edit([...originalCrown], "cloning_disabled_baseline")
    await edit([emoji, sticker, ...originalCrown], "cloning_opt_ins_enabled")
    await edit([emoji, sticker, ...changedCrown], "cloning_preserved_during_other_toggle_change")
    await edit([sticker, ...changedCrown], "emoji_opt_in_disabled")
    await edit([...changedCrown], "sticker_opt_in_disabled_lost_response", true)
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
            await value(client.shutdown())
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
                    stage: "feature_cleanup",
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
