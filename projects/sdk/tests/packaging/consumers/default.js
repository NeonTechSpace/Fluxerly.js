import assert from "node:assert/strict"
import { registerHooks } from "node:module"
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
    await import("@neontechspace/fluxerly")
assert.ok(guardedWebSocketResolutions > 0, "The SDK must import the guarded ws dependency")

// Errors thrown by the packed internals are the classes the entry point exports
assert.throws(() => createClient({ token: undefined }), ConfigurationError)

const webhook = createWebhookClient({ id: "100", token: "fixture_only" })
assert.ok((await webhook.shutdown()).isOk())
assert.ok((await webhook.fetchMessage("400"))._unsafeUnwrapErr() instanceof ClientClosedError)
const oauthClient = oauth.create({ clientId: "100", clientSecret: "fixture-only" })
assert.ok((await oauthClient.shutdown()).isOk())

const client = createClient({ token: "fixture-only-not-a-credential", cache: { messages: true } })
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
const fetched = (await client.messages.fetch({ channelId: "20", id: "10" }))._unsafeUnwrap()
assert.equal(fetched.content, "Original")
const edited = (await client.messages.edit(fetched, { content: "Updated" }))._unsafeUnwrap()
assert.equal(edited.content, "Updated")
assert.equal(client.messages.get(edited)?.content, "Updated")
assert.ok((await client.messages.delete(edited)).isOk())
assert.deepEqual(requests, [
    "GET https://api.fluxer.app/v1/channels/20/messages/10",
    "PATCH https://api.fluxer.app/v1/channels/20/messages/10",
    "DELETE https://api.fluxer.app/v1/channels/20/messages/10",
])

assert.ok((await client.shutdown()).isOk())
assert.equal(client.state, "Closed")
assert.ok((await client.connect())._unsafeUnwrapErr() instanceof ClientClosedError)

for (const path of ["dist/internal/client.js", "src/internal/configuration.ts"]) {
    await assert.rejects(import(`@neontechspace/fluxerly/${path}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
}
console.log("Default JavaScript packed consumer passed")
