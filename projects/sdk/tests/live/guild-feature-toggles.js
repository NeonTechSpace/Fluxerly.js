// Guild feature toggles: emoji and sticker clone opt-ins and owner-crown visibility through SDK edits, independent
// feature readback and a lost edit response.
// Journal `.env.test.guild-features.local` records sandbox and bot identity, a marker, the original feature set, the
// expected set and any pending write. An existing journal triggers recovery only: The original toggles are
// restored only when the current set matches the original, expected or pending set, refusing unexpected feature
// changes. Disabling cloning cannot revoke copies made during the temporary opt-in
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Effect, Exit, Scope } from "effect"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    verifySandboxIdentity,
} from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { createSandboxApi } from "./support/sandbox-api.js"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const rawFetch = globalThis.fetch
const journalFile = openJournal("guild-features")
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
const report = createReporter({ mode }, { passed: true })
const ordered = (features) => [...features].sort()
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b))
const validFeatures = (features) =>
    Array.isArray(features) &&
    features.every((feature) => typeof feature === "string") &&
    new Set(features).size === features.length
const save = () => journalFile.save(journal)
async function value(operation) {
    if (Effect.isEffect(operation)) return Effect.runPromise(operation)
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
}
// Cache lookups return the entry or undefined directly in the default API and as an Effect in the native API
const cached = (lookup) => (Effect.isEffect(lookup) ? Effect.runPromise(lookup) : lookup)
const sandboxApi = createSandboxApi({ fetch: rawFetch, token: () => token })
const api = async (method, path, body) => (await sandboxApi(method, path, body)).data
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
    journalFile.remove()
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
            assert.equal(await cached(client.guilds.get(guildId)), undefined)
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
    lock = acquireLock()
    const sandbox = loadSandboxEnvironment()
    token = sandbox.token
    guildId = sandbox.guildId
    stage = "sandbox_identity"
    const identity = await verifySandboxIdentity((path) => api("GET", path), sandbox)
    botId = identity.botId
    assert.ok(validFeatures(identity.guild.features))
    verified = true
    report(stage)
    if (journalFile.exists()) {
        journal = journalFile.read()
        stage = "recovery_only"
        await cleanup()
        report(stage)
    } else {
        const options = { token, cache: { guilds: true } }
        if (mode === "default") client = sdk.createClient(options)
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
    // Keep the journal, lock and deadline if a failed owned finalizer may have left a writer alive
    await finalizeOwned({
        writers: [
            client && ["client_shutdown", () => value(client.shutdown())],
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
                        stage: "feature_cleanup",
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
