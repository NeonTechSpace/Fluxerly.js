import assert from "node:assert/strict"
import { withHostedDiscovery } from "../hosted-discovery.mjs"
import {
    createWebhookClient,
    builders,
    commands,
    colors,
    text,
    permissionBits,
    assets,
    CountOperationError,
    MemberChunkError,
    ShardConnectionError,
    AuthenticationError,
} from "@neontechspace/fluxerly"

assert.equal(colors.parse("#ff8800")._unsafeUnwrap(), 0xff8800)
assert.equal(colors.toHex(1)._unsafeUnwrap(), "#000001")
assert.deepEqual(colors.toRgb(0xff8800)._unsafeUnwrap(), [255, 136, 0])
assert.deepEqual(text.split("A🦊B", { maxLength: 2 })._unsafeUnwrap(), ["A", "🦊", "B"])
assert.deepEqual(permissionBits.inspect(1n << 63n)._unsafeUnwrap(), { names: [], unknownBits: 1n << 63n })

assert.deepEqual(builders.message().content("packed").embed(builders.embed().title("Title")).build(), {
    content: "packed",
    embeds: [{ title: "Title" }],
})
const commandStore = commands.memoryCooldowns({ maxEntries: 1 })._unsafeUnwrap()
assert.equal(commandStore.claim({ key: "packed", durationMs: 60_000 })._unsafeUnwrap()._tag, "CooldownAcquired")
assert.equal(commandStore.claim({ key: "packed", durationMs: 60_000 })._unsafeUnwrap()._tag, "CooldownActive")
commandStore.clear()
assert.equal(commandStore.size, 0)
const commandRouter = commands.create({ prefix: "!" })._unsafeUnwrap()
const registeredRouter = commandRouter.register({ name: "ping", execute() {} })._unsafeUnwrap()
assert.notEqual(registeredRouter, commandRouter)
assert.ok(Object.isFrozen(registeredRouter))
assert.deepEqual(registeredRouter.help({ prefix: "?", maxLength: 100 })._unsafeUnwrap(), ["?ping"])
assert.equal(registeredRouter.help({ prefix: "!", maxLength: 0 }).error.field, "help")
const webhookClient = createWebhookClient({ id: "100", token: "fixture_only" })
assert.ok(webhookClient.isOk())
assert.equal((await webhookClient.value.send({ content: "x" }, { timeoutMs: 0 })).error._tag, "WebhookOperationError")
assert.equal((await webhookClient.value.fetch({ timeoutMs: 0 })).error._tag, "WebhookOperationError")
assert.equal((await webhookClient.value.edit({ name: "packed" }, { timeoutMs: 0 })).error._tag, "WebhookOperationError")
assert.equal((await webhookClient.value.delete({ timeoutMs: 0 })).error._tag, "WebhookOperationError")
await webhookClient.value.shutdown()
assert.equal((await webhookClient.value.fetchMessage("400")).error._tag, "ClientClosedError")

globalThis.fetch = () => {
    throw new Error("Creation must not make HTTP requests")
}
globalThis.WebSocket = class {
    constructor() {
        throw new Error("Creation must not open a WebSocket")
    }
}

const { createClient, ConfigurationError, MessageOperationError, CollectorError, MessageFlags } =
    await import("@neontechspace/fluxerly")
const sharded = createClient({ token: "fixture-only", sharding: { totalShards: 4, shardIds: [2, 0] } })._unsafeUnwrap()
assert.deepEqual(sharded.shards, [
    { shardId: 2, state: "Disconnected", gatewayLatencyMs: null, recovery: null },
    { shardId: 0, state: "Disconnected", gatewayLatencyMs: null, recovery: null },
])
assert.ok(Object.isFrozen(sharded.shards) && sharded.shards.every(Object.isFrozen))
assert.ok(new ShardConnectionError(2, new AuthenticationError()).failure instanceof AuthenticationError)
assert.ok((await sharded.shutdown()).isOk())
assert.ok(sharded.shards.every((shard) => shard.state === "Closed"))
const cacheReports = []
let completeCacheReport
const cacheReported = new Promise((resolve) => {
    completeCacheReport = resolve
})
const result = createClient({
    token: "fixture-only-not-a-credential",
    cache: {
        messages: {
            maxEntries: 2,
            maxBytes: 1_024 * 1_024,
            maxAgeMs: (message) => (message.id === "11" ? undefined : null),
            onError: async (report) => {
                await Promise.resolve()
                cacheReports.push(report)
                completeCacheReport()
            },
        },
    },
})
assert.equal(result.isOk(), true)
assert.equal(result.value.state, "Disconnected")
for await (const batch of result.value.members.iterateChunks("20", { all: true })) {
    assert.ok(batch.isErr() && batch.error instanceof MemberChunkError)
    assert.equal(batch.error.reason, "notConnected")
}
const guildCounts = await result.value.guilds.fetchCounts(["20"])
assert.ok(guildCounts.isErr() && guildCounts.error instanceof CountOperationError)
assert.equal(guildCounts.error.reason, "notConnected")
assert.equal((await result.value.channels.fetchMemberCounts("20", ["30"])).error.reason, "notConnected")
assert.equal(
    (await result.value.members.setRoles({ guildId: "20", userId: "30" }, ["20"])).error.operation,
    "members.setRoles",
)
assert.equal(
    (await result.value.messages.deleteAttachment({ id: "10", channelId: "20" }, "bad")).error.operation,
    "deleteAttachment",
)
assert.equal(
    assets.userBanner({ user: { id: "20" }, profile: { banner: "account" } }).value,
    "https://fluxerusercontent.com/banners/20/account.webp",
)
assert.deepEqual(MessageFlags, { SuppressEmbeds: 4, SuppressNotifications: 4096 })
assert.ok(Object.isFrozen(MessageFlags))
assert.equal(
    (await result.value.messages.forward("20", { source: { id: "bad", channelId: "30" } })).error.reason,
    "input",
)
assert.equal((await result.value.users.fetchProfile("bad")).error.operation, "users.fetchProfile")
assert.equal((await result.value.messages.deleteMany("20", [])).error.operation, "deleteMany")
assert.equal(
    (await result.value.members.fetchHierarchyCheck({ guildId: "bad", userId: "30" })).error.operation,
    "members.fetchHierarchyCheck",
)
assert.equal(
    (await result.value.messages.previewCleanup("20", { maxScanned: 1, maxSelected: 1 })).error._tag,
    "MessageCleanupError",
)
assert.equal((await result.value.messages.cleanup({})).error._tag, "MessageCleanupError")
assert.equal(
    (await result.value.members.timeout({ guildId: "20", userId: "30" }, 0)).error.operation,
    "members.timeout",
)
assert.equal(
    (await result.value.guilds.ban({ guildId: "20", userId: "30" }, { durationSeconds: 1 })).error.operation,
    "guilds.ban",
)
assert.ok(Object.isFrozen(result.value.channels))
assert.equal(result.value.channels.get("20").value, undefined)
assert.equal((await result.value.channels.fetch("invalid")).error._tag, "ChannelOperationError")
const collector = result.value.messages.collect("20")
assert.ok(collector.isErr() && collector.error instanceof CollectorError)
assert.equal(collector.error.reason, "notConnected")
assert.equal(result.value.messages.collect("20", { maxMessages: 0 }).error._tag, "ConfigurationError")
assert.equal(Reflect.set(result.value, "state", "Connected"), false)
const emptyCache = result.value.messages.get({ id: "10", channelId: "20" })
assert.ok(emptyCache.isOk())
assert.equal(emptyCache.value, undefined)

const invalid = createClient({ token: "" })
assert.equal(invalid.isErr(), true)
assert.ok(invalid.error instanceof ConfigurationError)
assert.equal(invalid.error._tag, "ConfigurationError")
const registered = result.value.on(
    "messageCreate",
    async (message, signal) => {
        const sent = await result.value.messages.reply(message, { content: "packed reply" }, { signal })
        assert.ok(sent.isOk())
    },
    { concurrency: 2 },
)
assert.ok(registered.isOk())
registered.value.unsubscribe()
assert.ok((await registered.value.waitForClose()).isOk())
const events = result.value.events("messageCreate")
assert.ok(events.isOk())
events.value.unsubscribe()
assert.equal((await events.value.next()).value, null)
const invalidSend = await result.value.messages.send("20", { content: "" })
assert.equal(invalidSend.error._tag, "MessageError")
for (const event of [
    "messageUpdate",
    "messageDelete",
    "messageDeleteBulk",
    "guildChannelCreate",
    "guildChannelUpdate",
    "guildChannelDelete",
    "guildChannelUpdateBulk",
]) {
    const subscribed = result.value.on(event, () => {})
    assert.ok(subscribed.isOk())
    subscribed.value.unsubscribe()
    assert.ok((await subscribed.value.waitForClose()).isOk())
    const pull = result.value.events(event)
    assert.ok(pull.isOk())
    pull.value.unsubscribe()
    assert.equal((await pull.value.next()).value, null)
}
const invalidEdit = await result.value.messages.edit({ channelId: "20", id: "10" }, {})
assert.ok(invalidEdit.error instanceof MessageOperationError)
assert.equal(invalidEdit.error.outcome, "notDispatched")
const requests = []
globalThis.fetch = withHostedDiscovery(async (url, init) => {
    assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages/10")
    requests.push(init.method)
    return init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({
              id: "10",
              channel_id: "20",
              content: init.body ? JSON.parse(init.body).content : "Original",
              author: { id: "30", username: "fixture" },
          })
})
const fetched = await result.value.messages.fetch({ channelId: "20", id: "10" })
assert.ok(fetched.isOk())
const edited = await result.value.messages.edit(fetched.value, { content: "Updated" })
assert.equal(edited.value.content, "Updated")
assert.ok(Object.isFrozen(edited.value.author))
const cached = result.value.messages.get(edited.value)
assert.ok(cached.isOk())
assert.equal(cached.value?.content, "Updated")
assert.ok(Object.isFrozen(cached.value))
assert.equal(Reflect.set(cached.value, "content", "overwritten"), false)
const diagnostics = result.value.diagnostics()
assert.ok(Object.isFrozen(diagnostics))
assert.equal(diagnostics.caches.messages.configured, true)
const entries = result.value.cache.entries("messages", { limit: 1 })
assert.ok(entries.isOk())
assert.equal(entries.value[0]?.content, "Updated")
result.value.cache.clear()
assert.deepEqual(result.value.cache.entries("messages")._unsafeUnwrap(), [])
const deleted = await result.value.messages.delete(edited.value)
assert.ok(deleted.isOk())
assert.equal(deleted.value, undefined)
assert.deepEqual(requests, ["GET", "PATCH", "DELETE"])
globalThis.fetch = withHostedDiscovery(async (url, init) => {
    assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages?limit=2&before=11")
    assert.equal(init.method, "GET")
    return Response.json([
        { id: "10", channel_id: "20", content: "History", author: { id: "30", username: "fixture" } },
    ])
})
const history = await result.value.messages.fetchHistory("20", { limit: 2, before: "11" })
assert.ok(history.isOk())
assert.equal(history.value[0].content, "History")
assert.ok(Object.isFrozen(history.value) && Object.isFrozen(history.value[0].author))
const invalidHistory = await result.value.messages.fetchHistory("20", { limit: 101 })
assert.ok(invalidHistory.error instanceof MessageOperationError)
assert.equal(invalidHistory.error.operation, "fetchHistory")
globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.fluxer.app/v1/users/@me/guilds?limit=200&with_counts=true")
    assert.equal(init.method, "GET")
    return Response.json([{ id: "20", name: "Packed guild", owner_id: "30", features: [], permissions: "0" }])
}
const guildList = await result.value.guilds.fetchPage({ withCounts: true })
assert.ok(guildList.isOk())
assert.equal(guildList.value[0]?.permissions, 0n)
globalThis.fetch = withHostedDiscovery(async (url, init) => {
    assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages/11")
    assert.equal(init.method, "GET")
    return Response.json({
        id: "11",
        channel_id: "20",
        content: "Policy failure retains no snapshot",
        author: { id: "30", username: "fixture" },
    })
})
const policyFailure = await result.value.messages.fetch({ id: "11", channelId: "20" })
assert.ok(policyFailure.isOk())
await cacheReported
assert.deepEqual(cacheReports, [{ reason: "invalidReturn" }])
const uncached = result.value.messages.get(policyFailure.value)
assert.ok(uncached.isOk())
assert.equal(uncached.value, undefined)
assert.equal((await result.value.shutdown()).isOk(), true)
assert.equal(result.value.state, "Closed")
assert.equal((await result.value.waitForClose()).isOk(), true)
assert.equal((await result.value.connect()).error._tag, "ClientClosedError")

for (const path of ["dist/internal/client.js", "src/internal/configuration.ts"]) {
    await assert.rejects(import(`@neontechspace/fluxerly/${path}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
}
console.log("Default JavaScript packed consumer passed")
