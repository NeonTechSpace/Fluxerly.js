import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import { createRequire, registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { withHostedDiscovery } from "../hosted-discovery.mjs"

// Import and creation must resolve the SDK's ws dependency without opening a socket or sending an HTTP request
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
let creationRequests = 0
globalThis.fetch = () => {
    creationRequests += 1
    throw new Error("Creation must not make HTTP requests")
}
const { createClient, createWebhookClient, oauth, ConfigurationError, ClientClosedError } =
    await import("@neontechspace/fluxerly/effect")
assert.ok(guardedWebSocketResolutions > 0, "The SDK must import the guarded ws dependency")

// The SDK and the application share one Effect installation
const fromSdk = createRequire(import.meta.resolve("@neontechspace/fluxerly/effect"))
assert.equal(realpathSync(fromSdk.resolve("effect")), realpathSync(fileURLToPath(import.meta.resolve("effect"))))

// Invalid settings are misuse, so native creation dies with the ConfigurationError class the entry point exports
const misuse = await Effect.runPromiseExit(Effect.scoped(createClient({ token: "" })))
assert.ok(misuse.cause.reasons.find((reason) => reason._tag === "Die")?.defect instanceof ConfigurationError)

await Effect.runPromise(
    Effect.scoped(
        Effect.gen(function* () {
            const webhook = yield* createWebhookClient({ id: "100", token: "fixture_only" })
            yield* webhook.shutdown()
            assert.ok((yield* Effect.flip(webhook.fetchMessage("400"))) instanceof ClientClosedError)
            const oauthClient = yield* oauth.create({ clientId: "100", clientSecret: "fixture-only" })
            yield* oauthClient.shutdown()
        }),
    ),
)

const client = await Effect.runPromise(
    Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({ token: "fixture-only-not-a-credential", cache: { messages: true } })
            assert.equal(client.state, "Disconnected")
            assert.equal(guardedWebSocket.constructions, 0)
            assert.equal(creationRequests, 0)

            const requests = []
            globalThis.fetch = withHostedDiscovery(async (url, init) => {
                requests.push(`${init.method} ${url}`)
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
            assert.equal(fetched.content, "Original")
            const edited = yield* client.messages.edit(fetched, { content: "Updated" })
            assert.equal(edited.content, "Updated")
            assert.equal((yield* client.messages.get(edited))?.content, "Updated")
            yield* client.messages.delete(edited)
            assert.deepEqual(requests, [
                "GET https://api.fluxer.app/v1/channels/20/messages/10",
                "PATCH https://api.fluxer.app/v1/channels/20/messages/10",
                "DELETE https://api.fluxer.app/v1/channels/20/messages/10",
            ])
            return client
        }),
    ),
)
// Closing the creation scope shuts the client down
assert.equal(client.state, "Closed")
console.log("Effect JavaScript packed consumer passed")
