import assert from "node:assert/strict"
import { createWebhookClient } from "@neontechspace/fluxerly/effect"

await Effect.runPromise(
    Effect.scoped(
        Effect.gen(function* () {
            const webhook = yield* createWebhookClient({ id: "100", token: "fixture_only" })
            const invalid = yield* Effect.result(webhook.send({ content: "x" }, { timeoutMs: 0 }))
            assert.equal(invalid.failure._tag, "WebhookOperationError")
            yield* webhook.shutdown()
            const closed = yield* Effect.result(webhook.fetchMessage("400"))
            assert.equal(closed.failure._tag, "ClientClosedError")
        }),
    ),
)
import { realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { Context, Effect, Logger, References } from "effect"
import { createClient, MessageOperationError, CollectorError, fromEffectLogger } from "@neontechspace/fluxerly/effect"
import { createClient as createDefault } from "@neontechspace/fluxerly"

globalThis.fetch = () => {
    throw new Error("Creation must not make HTTP requests")
}
globalThis.WebSocket = class {
    constructor() {
        throw new Error("Creation must not open a WebSocket")
    }
}

const messages = []
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
            const client = yield* createClient({ token: "fixture-only-not-a-credential" })
            assert.equal(client.state, "Disconnected")
            assert.equal((yield* client.messages.deleteMany("20", []).pipe(Effect.flip)).operation, "deleteMany")
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
            globalThis.fetch = async (url, init) => {
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
            }
            const fetched = yield* client.messages.fetch({ channelId: "20", id: "10" })
            const edited = yield* client.messages.edit(fetched, { content: "Updated" })
            assert.equal(edited.content, "Updated")
            assert.ok(Object.isFrozen(edited.author))
            assert.equal(yield* client.messages.delete(edited), undefined)
            assert.deepEqual(requests, ["GET", "PATCH", "DELETE"])
            globalThis.fetch = async (url, init) => {
                assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages?limit=2&after=9")
                assert.equal(init.method, "GET")
                return Response.json([
                    { id: "10", channel_id: "20", content: "History", author: { id: "30", username: "fixture" } },
                ])
            }
            const history = yield* client.messages.fetchHistory("20", { limit: 2, after: "9" })
            assert.equal(history[0].content, "History")
            assert.ok(Object.isFrozen(history) && Object.isFrozen(history[0].author))
            const invalidHistory = yield* client.messages
                .fetchHistory("20", { before: "10", after: "9" })
                .pipe(Effect.flip)
            assert.ok(invalidHistory instanceof MessageOperationError)
            assert.equal(invalidHistory.operation, "fetchHistory")
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
globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages/10")
    assert.equal(init.method, "GET")
    return Response.json({
        id: "10",
        channel_id: "20",
        content: "Native cached snapshot",
        author: { id: "30", username: "fixture" },
    })
}
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
