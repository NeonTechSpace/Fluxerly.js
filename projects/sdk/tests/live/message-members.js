// A message dispatch refreshes the cached member of its author, without a member request.
// GUILD_CREATE already caches the bot's member at startup, so the check first removes that entry with cache.delete,
// and requires it to be absent right before it posts a message through the raw API. Any later store of the entry
// counts only when it is reported after the post began and the client has delivered that message's event. The cached
// entry must then match a fresh raw read, and the SDK must have made no member request meanwhile.
// A guild snapshot (a guildCreate event or a store of the guild in the guild cache, which this check enables for the
// purpose) or a new shard session between the removal and the accepted store would refill the entry with no message
// intake, so the run then fails as inconclusive (support/member-window.js) and is rerun. The window opens only after
// the startup snapshot's event, which is delivered after it has filled the cache.
// The check holds the exclusive sandbox lock (shared-state). Another check's bot activity, such as a reaction or typing
// in its own channel, carries the same member and could refill the cache, and cache.onChange has no order relative to
// event handlers, so the exclusive lock is what excludes that refill.
// Nickname changes cannot isolate the message instead: gateway.ignoredEvents refuses GUILD_MEMBER_UPDATE while
// cache.members is on, so the member update dispatch would refresh the cache as well.
// Journal `.env.test.message-members.local` records the server ID and the test channel's unique marker and returned
// ID. An existing journal triggers recovery only: The channel is matched by its marker, deleted and its removal
// verified. The check never changes the bot's member
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Exit, Scope } from "effect"
import { cleanupGuildChannelFixtures, createGuildChannelFixture } from "./channel-fixture.mjs"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    verifySandboxIdentity,
} from "./support/harness.js"
import { createWindowGuard } from "./support/member-window.js"
import { createOutcomeReporter } from "./support/reporting.js"
import { settle as value } from "./support/results.js"
import { createRetryingSandboxApi } from "./support/sandbox-api.js"

const mode = process.argv[2]
const rawFetch = globalThis.fetch
const journalFile = openJournal("message-members")
const report = createOutcomeReporter({ mode })
let stage = "configuration"
let lock
let token
let guildId
let botId
let journal
let client
let scope
let verified = false

// Independent setup and readback never share the SDK's observed fetch
const api = createRetryingSandboxApi({ fetch: rawFetch, token: () => token, allowNotFound: true })
const save = () => journalFile.save(journal)

async function cleanup() {
    if (!journal) return
    assert.equal(journal.guildId, guildId)
    await cleanupGuildChannelFixtures(api, journal, save)
    journalFile.remove()
    journal = undefined
    report("test_channel_and_messages_removed")
}

async function waitFor(condition, description) {
    const deadline = performance.now() + 20_000
    while (!condition()) {
        assert.ok(performance.now() < deadline, `Timed out waiting for ${description}`)
        await sleep(20)
    }
}

// The SDK's own REST paths, from the point where the checked sequence starts
const sdkRequests = []
const observeSdkRequests = () => {
    globalThis.fetch = async (...args) => {
        const input = args[0]
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
        sdkRequests.push(url.pathname)
        return rawFetch(...args)
    }
}

async function verifyMessageRefreshesMember(ops, channelId) {
    const key = `${guildId}:${botId}`
    const target = { guildId, userId: botId }
    const changes = []
    const created = []
    const guard = createWindowGuard(guildId)
    await ops.observe(
        (change) => {
            changes.push(change)
            guard.change(change)
        },
        (message) => created.push(message),
        (id) => guard.guildCreate(id),
    )
    await ops.connect()

    stage = "startup_member_cached"
    await waitFor(() => ops.cachedMember(target) !== undefined, "the startup member")
    // The startup snapshot fills the cache before its event is delivered, so it must not land inside the window
    await waitFor(() => guard.started, "the startup guild snapshot event")
    report(stage)

    stage = "forget_cached_member"
    // From here to the accepted store, a reconnect or guild snapshot would refill the entry without any message intake
    guard.open(ops.epochs())
    ops.forget(key)
    await waitFor(
        () =>
            guard.check(ops.epochs()) ??
            changes.some((change) => change.kind === "members" && change.op === "delete" && change.key === key),
        "the member removal report",
    )
    assert.equal(ops.cachedMember(target), undefined)
    report(stage)

    stage = "message_refreshes_member"
    // Nothing may have refilled the entry yet, so a later store can only follow the post
    assert.equal(ops.cachedMember(target), undefined)
    const changesBefore = changes.length
    const requestsBefore = sdkRequests.length
    const sent = await api("POST", `/channels/${channelId}/messages`, {
        content: `member-intake-${randomUUID()}`,
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    })
    assert.equal(sent.status, 200)
    assert.match(sent.data?.id ?? "", /^\d+$/)
    await waitFor(
        () => guard.check(ops.epochs()) ?? created.some((message) => message.id === sent.data.id),
        "the message event",
    )
    const message = created.find((item) => item.id === sent.data.id)
    assert.equal(message.member?.userId, botId, "The message event carried no member")
    // Cache intake precedes delivery and the change report follows in a later microtask, so it may already be there
    await waitFor(
        () =>
            guard.check(ops.epochs()) ??
            changes
                .slice(changesBefore)
                .some((change) => change.kind === "members" && change.op === "set" && change.key === key),
        "the member store report",
    )
    const cached = ops.cachedMember(target)
    guard.check(ops.epochs())
    guard.close()
    assert.ok(cached !== undefined, "The message did not fill the member cache")
    assert.deepEqual(
        sdkRequests.slice(requestsBefore).filter((path) => path.includes("/members")),
        [],
    )

    const raw = (await api("GET", `/guilds/${guildId}/members/${botId}`)).data
    assert.equal(raw?.user?.id, botId)
    assert.equal(cached.guildId, guildId)
    assert.equal(cached.userId, botId)
    assert.deepEqual([...cached.roleIds].sort(), [...raw.roles].sort())
    assert.equal(cached.nickname ?? null, raw.nick ?? null)
    assert.equal(Date.parse(cached.joinedAt), Date.parse(raw.joined_at))
    assert.deepEqual(cached, message.member)
    assert.ok(Object.isFrozen(cached) && Object.isFrozen(cached.roleIds))
    report(stage, true, { requestsDuringCheck: sdkRequests.length - requestsBefore })
}

// A watchdog is failure containment only. A passing invocation exits naturally after verified cleanup
setTimeout(() => {
    report("process_timeout", false)
    process.exit(1)
}, 120_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.equal(process.argv.length, 3)
    stage = "sandbox_lock"
    lock = acquireLock()
    stage = "configuration"
    const sandbox = loadSandboxEnvironment()
    token = sandbox.token
    guildId = sandbox.guildId

    stage = "sandbox_identity"
    const identity = await verifySandboxIdentity(async (path) => (await api("GET", path)).data, {
        ...sandbox,
        applicationPath: "/oauth2/applications/@me",
    })
    botId = identity.botId
    verified = true
    report(stage, true, { clientSecretUsed: false })

    stage = "recover_prior_test"
    if (journalFile.exists()) {
        journal = journalFile.read()
        stage = "recovery_only"
        await cleanup()
        report(stage)
    } else {
        journal = { guildId }
        journalFile.create(journal)
        stage = "create_test_channel"
        const channel = await createGuildChannelFixture(journal, save, "explicitChild", { type: 0 }, (input) =>
            api("POST", `/guilds/${guildId}/channels`, input).then((response) => {
                assert.equal(response.status, 200)
                return {
                    id: response.data?.id,
                    guildId: response.data?.guild_id,
                    type: response.data?.type,
                    name: response.data?.name,
                }
            }),
        )
        assert.equal(channel.guildId, guildId)
        report(stage)

        // The SDK reads the global fetch when it makes a request, so it is observed from before the client exists
        observeSdkRequests()
        const options = { token, cache: { guilds: true, members: true } }
        const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
        let ops
        if (mode === "default") {
            client = sdk.createClient(options)
            ops = {
                epochs: () => client.diagnostics().shards.map((shard) => shard.sessionEpoch),
                observe: async (onChange, onMessage, onGuildCreate) => {
                    client.cache.onChange(onChange)
                    client.on("guildCreate", (guild) => onGuildCreate(guild.id))
                    client.on("messageCreate", (message) => {
                        if (message.channelId === channel.id) onMessage(message)
                    })
                },
                connect: () => value(client.connect()),
                cachedMember: (target) => client.members.get(target),
                forget: (key) => client.cache.delete("members", key),
            }
        } else {
            scope = Scope.makeUnsafe()
            const provide = (effect) => Effect.runPromise(effect.pipe(Effect.provideService(Scope.Scope, scope)))
            client = await provide(sdk.createClient(options))
            ops = {
                epochs: () => client.diagnostics().shards.map((shard) => shard.sessionEpoch),
                observe: async (onChange, onMessage, onGuildCreate) => {
                    await provide(client.cache.onChange((change) => Effect.sync(() => onChange(change))))
                    await provide(client.on("guildCreate", (guild) => Effect.sync(() => onGuildCreate(guild.id))))
                    await provide(
                        client.on("messageCreate", (message) =>
                            Effect.sync(() => {
                                if (message.channelId === channel.id) onMessage(message)
                            }),
                        ),
                    )
                },
                connect: () => value(client.connect()),
                cachedMember: (target) => Effect.runSync(client.members.get(target)),
                forget: (key) => client.cache.delete("members", key),
            }
        }
        await verifyMessageRefreshesMember(ops, channel.id)
        stage = "client_shutdown"
        await value(client.shutdown())
        report(stage)
    }
} catch (error) {
    report(stage, false, {
        ...(error?.code === "ERR_ASSERTION"
            ? { assertionLine: Number(error.stack?.match(/message-members\.js:(\d+):\d+/)?.[1]) || undefined }
            : {}),
        ...(typeof error?.status === "number" ? { httpStatus: error.status } : {}),
        ...(error?.name === "InconclusiveWindow" ? { reason: error.message } : {}),
        category:
            error?.code === "ERR_ASSERTION"
                ? "assertion"
                : error?.name === "InconclusiveWindow"
                  ? "inconclusive"
                  : "unexpected",
    })
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    // Keep the journal and lock if a failed owned finalizer may have left a writer alive
    await finalizeOwned({
        writers: [
            client && client.state !== "Closed" && ["client_shutdown", () => value(client.shutdown())],
            scope && ["scope_close", () => Effect.runPromise(Scope.close(scope, Exit.void))],
        ],
        cleanup: async () => {
            if (verified && journal) await cleanup()
        },
        lock,
        onFailure: (finalizer) => {
            if (finalizer === "cleanup") report("cleanup", false, { journalRetained: journal !== undefined })
            else if (finalizer === "sandbox_lock") report("lock_cleanup", false, { lockRetained: true })
            else
                report("cleanup", false, {
                    finalizer,
                    journalRetained: journal !== undefined,
                    lockRetained: lock !== undefined,
                })
            process.exitCode = 1
        },
    })
}
