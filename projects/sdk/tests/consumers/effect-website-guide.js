import assert from "node:assert/strict"
import { once } from "node:events"
import { createRequire, registerHooks } from "node:module"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { withHostedDiscovery } from "../hosted-discovery.mjs"

const filename = process.argv[2]
assert.equal(filename, "effect-website-guide.ts", "Select the authored Effect starter")

const sdkRequire = createRequire(import.meta.resolve("@neontechspace/fluxerly/effect"))
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
            assert.equal(command.op, 1, "The authored Effect starter must send only Identify and heartbeats")
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

function deliver(id, content, bot = false) {
    const message = { id, channel_id: "20", content, author: { id: "30", username: "fixture", bot } }
    for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: "MESSAGE_CREATE", d: message }))
    return message
}

const originalFetch = globalThis.fetch
const originalToken = process.env.FLUXER_BOT_TOKEN
const originalConsoleError = console.error
const initialSigintListeners = process.listeners("SIGINT")
const initialSigtermListeners = process.listeners("SIGTERM")
const initialExitCode = process.exitCode
const requests = []
const stopLogs = []
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
process.env.FLUXER_BOT_TOKEN = "fixture-only"
console.error = (...values) => stopLogs.push(values)

function assertSignalHandlersRestored() {
    assert.deepEqual(process.listeners("SIGINT"), initialSigintListeners)
    assert.deepEqual(process.listeners("SIGTERM"), initialSigtermListeners)
}

try {
    const running = import(`./${filename}?success`)
    await waitFor(() => identifies === 1 && sockets.size === 1, "The authored Effect starter did not become ready")
    deliver("10", "!ping", true)
    deliver("11", "Hello")
    // `on` starts one callback at a time in receive order by default, so this
    // reply establishes that both ignored events completed before the human ping
    const humanPing = deliver("12", "!ping")
    await waitFor(
        () => requests.length === 1,
        "The authored Effect starter did not reply after processing the ignored messages and human ping",
    )
    assert.equal(process.emit("SIGINT"), true, "The authored Effect starter did not install its signal handler")
    await running
    await waitFor(() => sockets.size === 0, "Interrupting the authored Effect starter did not close its gateway socket")
    assertSignalHandlersRestored()
    assert.equal(
        process.exitCode,
        initialExitCode,
        "Interrupting the authored Effect starter must not set an exit code",
    )
    assert.deepEqual(stopLogs, [], "Interrupting the authored Effect starter must not log an error")
    assert.equal(requests.length, 1, "Bot and unrelated messages must not produce replies")
    const { nonce, ...body } = requests[0]
    assert.match(nonce, /^[a-f\d]{32}$/)
    assert.deepEqual(body, {
        content: "Pong!",
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
        message_reference: { message_id: humanPing.id, channel_id: humanPing.channel_id, type: 0 },
    })

    rejectConnection = true
    const rejected = import(`./${filename}?authentication-failure`)
    await waitFor(() => identifies === 2, "The permanent authentication rejection did not reach the authored starter")
    await rejected
    await waitFor(() => sockets.size === 0, "Rejected authored startup did not close its gateway socket")
    assertSignalHandlersRestored()
    assert.equal(identifies, 2, "Permanent authentication rejection must not reconnect")
    assert.equal(requests.length, 1, "Rejected startup must not send a reply")
    assert.equal(
        process.exitCode,
        1,
        "The authored safe catch must mark a permanent authentication rejection as failed",
    )
    assert.deepEqual(stopLogs, [["Bot stopped because an operation or cleanup failed"]])
} finally {
    process.exitCode = initialExitCode
    if (originalToken === undefined) delete process.env.FLUXER_BOT_TOKEN
    else process.env.FLUXER_BOT_TOKEN = originalToken
    globalThis.fetch = originalFetch
    console.error = originalConsoleError
    hooks.deregister()
    for (const socket of sockets) socket.terminate()
    await new Promise((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve())))
    assert.equal(sockets.size, 0, "Test-owned gateway sockets must be released")
    assert.equal(gateway.address(), null, "Test-owned gateway listener must be closed")
}

console.log("Packed authored Effect starter passed ping reply, interruption, auth rejection and cleanup")
