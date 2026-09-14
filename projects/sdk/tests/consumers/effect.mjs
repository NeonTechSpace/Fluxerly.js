import assert from "node:assert/strict"
import { createRequire, registerHooks } from "node:module"
import { withHostedDiscovery } from "../hosted-discovery.mjs"

const guardedWebSocketUrl = `data:text/javascript,${encodeURIComponent(`
    export let constructions = 0
    export default class WebSocket {
        constructor() {
            constructions += 1
            throw new Error("Creation must not open a WebSocket")
        }
    }
`)}`
let guardedWebSocketResolutions = 0
registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context)
        if (specifier !== "ws") return resolved
        guardedWebSocketResolutions += 1
        return { ...resolved, url: guardedWebSocketUrl }
    },
})
const guardedWebSocket = await import(guardedWebSocketUrl)
const { createWebhookClient, oauth, colors, text, permissionBits, builders, commands } =
    await import("@neontechspace/fluxerly/effect")
assert.ok(guardedWebSocketResolutions > 0, "The SDK must import the guarded ws dependency")

assert.equal(await Effect.runPromise(colors.parse("#ff8800")), 0xff8800)
assert.equal(await Effect.runPromise(colors.toHex(1)), "#000001")
assert.deepEqual(await Effect.runPromise(colors.toRgb(0xff8800)), [255, 136, 0])
assert.deepEqual(await Effect.runPromise(text.split("A🦊B", { maxLength: 2 })), ["A", "🦊", "B"])
assert.deepEqual(await Effect.runPromise(permissionBits.inspect(1n << 63n)), { names: [], unknownBits: 1n << 63n })

assert.deepEqual(builders.message().content("packed").embed(builders.embed().title("Title")).build(), {
    content: "packed",
    embeds: [{ title: "Title" }],
})
await Effect.runPromise(
    Effect.gen(function* () {
        const store = yield* commands.memoryCooldowns({ maxEntries: 1 })
        const claim = store.claim({ key: "packed", durationMs: 60_000 })
        assert.equal(store.size, 0)
        assert.equal((yield* claim)._tag, "CooldownAcquired")
        assert.equal((yield* claim)._tag, "CooldownActive")
        yield* store.clear()
        assert.equal(store.size, 0)
        const router = yield* commands.create({ prefix: "!" })
        const registered = yield* router.register({ name: "ping", execute: () => Effect.void })
        assert.notEqual(registered, router)
        assert.deepEqual(yield* registered.help({ prefix: "?", maxLength: 100 }), ["?ping"])
        const invalidHelp = yield* Effect.result(registered.help({ prefix: "!", maxLength: 0 }))
        assert.equal(invalidHelp._tag, "Failure")
        assert.equal(invalidHelp.failure.field, "help")
        assert.ok(Object.isFrozen(registered))
    }),
)

await Effect.runPromise(
    Effect.scoped(
        Effect.gen(function* () {
            const webhook = yield* createWebhookClient({ id: "100", token: "fixture_only" })
            const invalid = yield* Effect.result(webhook.send({ content: "x" }, { timeoutMs: 0 }))
            assert.equal(invalid.failure._tag, "WebhookOperationError")
            assert.equal((yield* Effect.result(webhook.fetch({ timeoutMs: 0 }))).failure._tag, "WebhookOperationError")
            assert.equal(
                (yield* Effect.result(webhook.edit({ name: "packed" }, { timeoutMs: 0 }))).failure._tag,
                "WebhookOperationError",
            )
            assert.equal((yield* Effect.result(webhook.delete({ timeoutMs: 0 }))).failure._tag, "WebhookOperationError")
            yield* webhook.shutdown()
            const closed = yield* Effect.result(webhook.fetchMessage("400"))
            assert.equal(closed.failure._tag, "ClientClosedError")
        }),
    ),
)
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Context, Effect, Logger, References, Stream } from "effect"
const {
    createClient,
    MessageOperationError,
    CollectorError,
    fromEffectLogger,
    MessageFlags,
    assets,
    CountOperationError,
    MemberChunkError,
    ShardConnectionError,
    AuthenticationError,
} = await import("@neontechspace/fluxerly/effect")
const { createClient: createDefault } = await import("@neontechspace/fluxerly")

globalThis.fetch = () => {
    throw new Error("Creation must not make HTTP requests")
}

const messages = []
await Effect.runPromise(
    Effect.scoped(
        Effect.gen(function* () {
            const credentials = { clientId: "100", clientSecret: "fixture-only" }
            for (const instance of [{}, { allowInsecure: true }]) {
                const invalid = yield* Effect.result(oauth.create({ ...credentials, instance }))
                assert.equal(invalid._tag, "Failure")
                assert.equal(invalid.failure._tag, "ConfigurationError")
                assert.equal(invalid.failure.field, "instance")
            }
            for (const config of [credentials, { ...credentials, instance: { url: "https://fluxer.example.test" } }]) {
                const client = yield* oauth.create(config)
                yield* client.shutdown()
            }
        }),
    ),
)
await Effect.runPromise(
    Effect.scoped(
        Effect.gen(function* () {
            const sharded = yield* createClient({
                token: "fixture-only",
                sharding: { totalShards: 4, shardIds: [2, 0] },
            })
            assert.deepEqual(sharded.shards, [
                { shardId: 2, state: "Disconnected", gatewayLatencyMs: null, recovery: null },
                { shardId: 0, state: "Disconnected", gatewayLatencyMs: null, recovery: null },
            ])
            assert.ok(Object.isFrozen(sharded.shards) && sharded.shards.every(Object.isFrozen))
            assert.ok(new ShardConnectionError(2, new AuthenticationError()).failure instanceof AuthenticationError)
            yield* sharded.shutdown()
            assert.ok(sharded.shards.every((shard) => shard.state === "Closed"))
        }),
    ),
)
const defaultLogs = []
const defaultApi = createDefault({
    token: "fixture-only-not-a-credential",
    logging: {
        development: true,
        logger: fromEffectLogger(Logger.make((entry) => defaultLogs.push(entry.message))),
    },
})._unsafeUnwrap()
assert.ok((await defaultApi.shutdown()).isOk())
assert.deepEqual(
    defaultLogs.map((message) => message[1].event),
    ["closing", "closed"],
)
const client = await Effect.runPromise(
    Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({ token: "fixture-only-not-a-credential", cache: { messages: true } })
            assert.equal(guardedWebSocket.constructions, 0)
            assert.equal(client.state, "Disconnected")
            const chunks = yield* Effect.flip(client.members.iterateChunks("20", { all: true }).pipe(Stream.runDrain))
            assert.ok(chunks instanceof MemberChunkError)
            assert.equal(chunks.reason, "notConnected")
            const guildCounts = yield* Effect.flip(client.guilds.fetchCounts(["20"]))
            assert.ok(guildCounts instanceof CountOperationError)
            assert.equal(guildCounts.reason, "notConnected")
            assert.equal((yield* Effect.flip(client.channels.fetchMemberCounts("20", ["30"]))).reason, "notConnected")
            assert.equal(
                (yield* Effect.flip(client.members.setRoles({ guildId: "20", userId: "30" }, ["20"]))).operation,
                "members.setRoles",
            )
            assert.equal(
                (yield* Effect.flip(client.messages.deleteAttachment({ id: "10", channelId: "20" }, "bad"))).operation,
                "deleteAttachment",
            )
            assert.equal(
                yield* assets.userBanner({ user: { id: "20" }, profile: { banner: "account" } }),
                "https://fluxerusercontent.com/banners/20/account.webp",
            )
            assert.deepEqual(MessageFlags, { SuppressEmbeds: 4, SuppressNotifications: 4096 })
            assert.ok(Object.isFrozen(MessageFlags))
            assert.equal(
                (yield* client.messages.forward("20", { source: { id: "bad", channelId: "30" } }).pipe(Effect.flip))
                    .reason,
                "input",
            )
            assert.equal((yield* client.users.fetchProfile("bad").pipe(Effect.flip)).operation, "users.fetchProfile")
            assert.equal((yield* client.messages.deleteMany("20", []).pipe(Effect.flip)).operation, "deleteMany")
            assert.equal(
                (yield* client.members.fetchHierarchyCheck({ guildId: "bad", userId: "30" }).pipe(Effect.flip))
                    .operation,
                "members.fetchHierarchyCheck",
            )
            assert.equal(
                (yield* client.messages.previewCleanup("20", { maxScanned: 1, maxSelected: 1 }).pipe(Effect.flip))._tag,
                "MessageCleanupError",
            )
            assert.equal((yield* client.messages.cleanup({}).pipe(Effect.flip))._tag, "MessageCleanupError")
            assert.equal(
                (yield* client.members.timeout({ guildId: "20", userId: "30" }, 0).pipe(Effect.flip)).operation,
                "members.timeout",
            )
            assert.equal(
                (yield* client.guilds.ban({ guildId: "20", userId: "30" }, { durationSeconds: 1 }).pipe(Effect.flip))
                    .operation,
                "guilds.ban",
            )
            assert.ok(Object.isFrozen(client.channels))
            assert.equal(yield* client.channels.get("20"), undefined)
            assert.equal((yield* client.channels.fetch("invalid").pipe(Effect.flip))._tag, "ChannelOperationError")
            const collector = yield* client.messages.collect("20").pipe(Effect.flip)
            assert.ok(collector instanceof CollectorError)
            assert.equal(collector.reason, "notConnected")
            assert.equal(
                (yield* client.messages.collect("20", { maxMessages: 0 }).pipe(Effect.flip))._tag,
                "ConfigurationError",
            )
            yield* Effect.yieldNow
            assert.equal((yield* Effect.currentSpan).name, "Packed consumer")
            assert.equal((yield* References.CurrentLogAnnotations).requestId, "package-check")
            yield* Effect.log("Consumer message")
            const subscription = yield* client.on(
                "messageCreate",
                (message) => client.messages.reply(message, { content: "packed reply" }),
                { concurrency: 2 },
            )
            yield* subscription.unsubscribe()
            yield* subscription.waitForClose()
            const rejected = yield* client.messages.send("20", { content: "" }).pipe(Effect.flip)
            assert.equal(rejected._tag, "MessageError")
            for (const event of [
                "messageUpdate",
                "messageDelete",
                "messageDeleteBulk",
                "guildChannelCreate",
                "guildChannelUpdate",
                "guildChannelDelete",
                "guildChannelUpdateBulk",
            ]) {
                const subscription = yield* client.on(event, () => Effect.void)
                yield* subscription.unsubscribe()
                yield* subscription.waitForClose()
                client.events(event)
            }
            const invalidEdit = yield* client.messages.edit({ channelId: "20", id: "10" }, {}).pipe(Effect.flip)
            assert.ok(invalidEdit instanceof MessageOperationError)
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
            const fetched = yield* client.messages.fetch({ channelId: "20", id: "10" })
            const edited = yield* client.messages.edit(fetched, { content: "Updated" })
            assert.equal(edited.content, "Updated")
            assert.ok(Object.isFrozen(edited.author))
            const diagnostics = client.diagnostics()
            assert.ok(Object.isFrozen(diagnostics))
            assert.equal(diagnostics.caches.messages.configured, true)
            const entries = yield* client.cache.entries("messages", { limit: 1 })
            assert.equal(entries[0]?.content, "Updated")
            client.cache.clear()
            assert.deepEqual(yield* client.cache.entries("messages"), [])
            assert.equal(yield* client.messages.delete(edited), undefined)
            assert.deepEqual(requests, ["GET", "PATCH", "DELETE"])
            globalThis.fetch = withHostedDiscovery(async (url, init) => {
                assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages?limit=2&after=9")
                assert.equal(init.method, "GET")
                return Response.json([
                    { id: "10", channel_id: "20", content: "History", author: { id: "30", username: "fixture" } },
                ])
            })
            const history = yield* client.messages.fetchHistory("20", { limit: 2, after: "9" })
            assert.equal(history[0].content, "History")
            assert.ok(Object.isFrozen(history) && Object.isFrozen(history[0].author))
            const invalidHistory = yield* client.messages
                .fetchHistory("20", { before: "10", after: "9" })
                .pipe(Effect.flip)
            assert.ok(invalidHistory instanceof MessageOperationError)
            assert.equal(invalidHistory.operation, "fetchHistory")
            globalThis.fetch = async (url, init) => {
                assert.equal(url, "https://api.fluxer.app/v1/users/@me/guilds?limit=200&with_counts=true")
                assert.equal(init.method, "GET")
                return Response.json([
                    { id: "20", name: "Packed guild", owner_id: "30", features: [], permissions: "0" },
                ])
            }
            const guildList = yield* client.guilds.fetchPage({ withCounts: true })
            assert.equal(guildList[0]?.permissions, 0n)
            // Constructing a stream must not acquire a subscription or open a connection
            client.events("messageCreate", { maxPendingMessages: 8 })
            return client
        }),
    ).pipe(
        Effect.withSpan("Packed consumer"),
        Effect.annotateLogs("requestId", "package-check"),
        Effect.provide(
            Logger.layer([
                Logger.make((entry) => {
                    messages.push(entry.message)
                }),
            ]),
        ),
    ),
)

assert.equal(client.state, "Closed")
assert.deepEqual(messages, [["Consumer message"]])
assert.equal(
    Effect.runSync(
        createClient({ token: "" }).pipe(
            Effect.catchTag("ConfigurationError", (error) => Effect.succeed(error.field)),
            Effect.scoped,
        ),
    ),
    "token",
)

const CacheReporter = Context.Service("packed-cache-reporter")
const creationReports = []
const executionReports = []
let completeNativeReport
const nativeReported = new Promise((resolve) => {
    completeNativeReport = resolve
})
let policyCalls = 0
globalThis.fetch = withHostedDiscovery(async (url, init) => {
    assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages/10")
    assert.equal(init.method, "GET")
    return Response.json({
        id: "10",
        channel_id: "20",
        content: "Native cached snapshot",
        author: { id: "30", username: "fixture" },
    })
})
await Effect.runPromise(
    Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({
                token: "fixture-only-not-a-credential",
                cache: {
                    messages: {
                        maxEntries: 1,
                        maxBytes: 1_024 * 1_024,
                        maxAgeMs: () => {
                            policyCalls++
                            return undefined
                        },
                        onError: (report) =>
                            Effect.gen(function* () {
                                const reporter = yield* CacheReporter
                                reporter.reports.push(report)
                                completeNativeReport()
                            }),
                    },
                },
            }).pipe(Effect.provideService(CacheReporter, { reports: creationReports }))
            assert.equal(policyCalls, 0)
            const lookup = client.messages.get({ id: "10", channelId: "20" })
            assert.equal(policyCalls, 0)
            assert.equal(yield* lookup, undefined)
            assert.equal(policyCalls, 0)
            const fetched = yield* client.messages
                .fetch({ id: "10", channelId: "20" })
                .pipe(Effect.provideService(CacheReporter, { reports: executionReports }))
            assert.equal(fetched.content, "Native cached snapshot")
            assert.equal(policyCalls, 1)
            yield* Effect.promise(() => nativeReported)
            assert.deepEqual(creationReports, [{ reason: "invalidReturn" }])
            assert.deepEqual(executionReports, [])
            assert.equal(yield* client.messages.get(fetched), undefined)
        }),
    ),
)

const fromSdk = createRequire(import.meta.resolve("@neontechspace/fluxerly/effect"))
assert.equal(realpathSync(fromSdk.resolve("effect")), realpathSync(fileURLToPath(import.meta.resolve("effect"))))
console.log("Effect JavaScript packed consumer passed")
