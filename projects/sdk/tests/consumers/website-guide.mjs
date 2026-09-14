import assert from "node:assert/strict"
import { once } from "node:events"
import { createRequire, registerHooks } from "node:module"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { withHostedDiscovery } from "../hosted-discovery.mjs"

const filename = process.argv[2]
assert.ok(filename === "bot.js" || filename === "bot.ts", "Select the authored JavaScript or TypeScript bot")

// Use the installed SDK's transport dependency only at the external gateway fixture boundary
const sdkRequire = createRequire(import.meta.resolve("@neontechspace/fluxerly"))
const websocketUrl = pathToFileURL(sdkRequire.resolve("ws")).href
const { WebSocketServer } = sdkRequire("ws")
const gateway = new WebSocketServer({ port: 0, host: "127.0.0.1" })
await once(gateway, "listening")
const address = gateway.address()
assert.ok(address && typeof address !== "string")
const fixtureUrl = `ws://127.0.0.1:${address.port}/?v=1&encoding=json`
const redirectedWebSocketUrl = `data:text/javascript,${encodeURIComponent(`
    import assert from "node:assert/strict"
    import WebSocket from ${JSON.stringify(websocketUrl)}
    export default class FixtureWebSocket extends WebSocket {
        constructor(url, options) {
            assert.equal(url, "wss://gateway.fluxer.app/?v=1&encoding=json")
            super(${JSON.stringify(fixtureUrl)}, options)
        }
    }
`)}`
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context)
        return specifier === "ws" ? { ...resolved, url: redirectedWebSocketUrl } : resolved
    },
})

let rejectConnection = false
let sequence = 0
let identifies = 0
const sockets = new Set()
gateway.on("connection", (socket, request) => {
    assert.equal(request.url, "/?v=1&encoding=json")
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.on("message", (payload) => {
        const command = JSON.parse(payload.toString())
        if (command.op === 2) {
            identifies += 1
            assert.equal(command.d.token, "fixture-only")
            if (rejectConnection) socket.close(4004, "Fixture authentication rejection")
            else socket.send(JSON.stringify({ op: 0, s: ++sequence, t: "READY", d: { session_id: "fixture" } }))
        } else {
            assert.equal(command.op, 1, "The tiny bot must send only Identify and heartbeats")
            socket.send(JSON.stringify({ op: 11 }))
        }
    })
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
})

async function waitFor(predicate, message) {
    const deadline = Date.now() + 5_000
    while (!predicate()) {
        if (Date.now() >= deadline) throw Error(message)
        await sleep(5)
    }
}

function deliver(id, content) {
    const message = { id, channel_id: "20", content, author: { id: "30", username: "fixture" } }
    for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: "MESSAGE_CREATE", d: message }))
    return message
}

const originalFetch = globalThis.fetch
const requests = []
globalThis.fetch = withHostedDiscovery(async (url, options) => {
    assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages")
    assert.equal(options.method, "POST")
    assert.equal(new Headers(options.headers).get("authorization"), "Bot fixture-only")
    const body = JSON.parse(options.body)
    requests.push(body)
    return Response.json({
        id: "40",
        channel_id: "20",
        content: body.content,
        author: { id: "90", username: "fixture-bot", bot: true },
        nonce: body.nonce,
        message_reference: body.message_reference,
    })
})

let client
try {
    ;({ client } = await import(`./${filename}?success`))
    assert.equal(client.state, "Connected", "The authored connect call must make the bot ready")
    assert.equal(identifies, 1)
    const seen = []
    assert.ok(client.on("messageCreate", (message) => seen.push(message.content)).isOk())
    deliver("10", "Hello")
    deliver("12", "!ping extra")
    deliver("13", "Done")
    const ping = deliver("11", "!ping")
    await waitFor(() => requests.length === 1 && seen.length === 4, "The authored bot did not process fixture messages")
    assert.deepEqual(seen, ["Hello", "!ping extra", "Done", "!ping"])
    assert.ok((await client.shutdown()).isOk())
    assert.equal(client.state, "Closed")
    await waitFor(() => sockets.size === 0, "Bot shutdown did not close its gateway socket")
    assert.equal(requests.length, 1, "Unrelated messages must not produce replies")
    const { nonce, ...body } = requests[0]
    assert.match(nonce, /^[a-f\d]{32}$/)
    assert.deepEqual(body, {
        content: "Pong!",
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
        message_reference: { message_id: ping.id, channel_id: ping.channel_id, type: 0 },
    })

    rejectConnection = true
    await assert.rejects(import(`./${filename}?authentication-failure`), (error) => {
        assert.equal(error._tag, "AuthenticationError", "The authored connect check must surface its failure")
        return true
    })
    await waitFor(() => sockets.size === 0, "Rejected connection did not release its gateway socket")
    assert.equal(identifies, 2, "Permanent authentication rejection must not reconnect")
    assert.equal(requests.length, 1, "Failed startup must not send a reply")
} finally {
    if (client && client.state !== "Closed") assert.ok((await client.shutdown()).isOk())
    globalThis.fetch = originalFetch
    hooks.deregister()
    for (const socket of sockets) socket.terminate()
    await new Promise((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve())))
    assert.equal(sockets.size, 0, "Test-owned gateway sockets must be released")
    assert.equal(gateway.address(), null, "Test-owned gateway listener must be closed")
}

console.log(
    `Packed website ${filename} passed ping reply, unrelated messages, visible connection failure and gateway cleanup`,
)
