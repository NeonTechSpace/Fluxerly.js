import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { Effect, Logger, References } from "effect"
import { createClient, MessageOperationError } from "@neontechspace/fluxerly/effect"

globalThis.fetch = () => {
    throw new Error("Creation must not make HTTP requests")
}
globalThis.WebSocket = class {
    constructor() {
        throw new Error("Creation must not open a WebSocket")
    }
}

const messages = []
const client = await Effect.runPromise(
    Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({ token: "fixture-only-not-a-credential" })
            assert.equal(client.state, "Disconnected")
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
            for (const event of ["messageUpdate", "messageDelete", "messageDeleteBulk"]) {
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

const fromSdk = createRequire(import.meta.resolve("@neontechspace/fluxerly/effect"))
assert.equal(realpathSync(fromSdk.resolve("effect")), realpathSync(fileURLToPath(import.meta.resolve("effect"))))
console.log("Effect JavaScript packed consumer passed")
