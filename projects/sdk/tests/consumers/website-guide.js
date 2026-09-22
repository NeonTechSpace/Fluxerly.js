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
let stallReply = false
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

function deliver(id, content, bot = false) {
    const message = { id, channel_id: "20", content, author: { id: "30", username: "fixture", bot } }
    for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: "MESSAGE_CREATE", d: message }))
    return message
}

const originalFetch = globalThis.fetch
const originalToken = process.env.FLUXER_BOT_TOKEN
const originalConsoleWarn = console.warn
const originalConsoleError = console.error
const initialExitCode = process.exitCode
const initialSigintListeners = process.listeners("SIGINT")
const initialSigtermListeners = process.listeners("SIGTERM")
const requests = []
const replyWarnings = []
const stopLogs = []
let rejectReply = false
globalThis.fetch = withHostedDiscovery(async (url, options) => {
    assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages")
    assert.equal(options.method, "POST")
    assert.equal(new Headers(options.headers).get("authorization"), "Bot fixture-only")
    const body = JSON.parse(options.body)
    requests.push(body)
    if (stallReply) {
        return await new Promise((resolve, reject) => {
            const abort = () => reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"))
            options.signal.addEventListener("abort", abort, { once: true })
        })
    }
    if (rejectReply) {
        return Response.json({ code: "MISSING_PERMISSIONS", message: "private fixture detail" }, { status: 403 })
    }
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
console.warn = (...values) => replyWarnings.push(values)
console.error = (...values) => stopLogs.push(values)

function assertSignalHandlersRestored() {
    assert.deepEqual(process.listeners("SIGINT"), initialSigintListeners)
    assert.deepEqual(process.listeners("SIGTERM"), initialSigtermListeners)
}

try {
    const running = import(`./${filename}?success`)
    await waitFor(() => identifies === 1 && sockets.size === 1, "The authored bot did not become ready")
    assert.equal(identifies, 1)
    deliver("10", "Hello")
    deliver("12", "!ping extra")
    deliver("13", "Done")
    deliver("15", "!ping", true)
    const ping = deliver("11", "!ping")
    await waitFor(() => requests.length === 1, "The authored bot did not process the fixture ping")
    assert.equal(requests.length, 1, "Unrelated messages must not produce replies")
    const { nonce, ...body } = requests[0]
    assert.match(nonce, /^[a-f\d]{32}$/)
    assert.deepEqual(body, {
        content: "Pong!",
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
        message_reference: { message_id: ping.id, channel_id: ping.channel_id, type: 0 },
    })

    const about = deliver("16", "!about")
    await waitFor(() => requests.length === 2, "The second registered command did not run")
    assert.equal(requests[1].content, "A Fluxer bot built with Fluxerly")
    assert.equal(requests[1].message_reference.message_id, about.id)

    rejectReply = true
    deliver("14", "!ping")
    await waitFor(() => replyWarnings.length === 1, "The authored bot hid a forbidden reply")
    assert.deepEqual(replyWarnings, [["Reply failed", { kind: "MessageError" }]])
    assert.equal(sockets.size, 1, "An expected reply failure must not stop the bot")
    assert.equal(process.emit("SIGINT"), true, "The authored bot did not install its signal handler")
    await running
    await waitFor(() => sockets.size === 0, "Bot shutdown did not close its gateway socket")
    assertSignalHandlersRestored()
    assert.equal(process.exitCode, initialExitCode, "Requested shutdown must be a clean application stop")
    assert.deepEqual(stopLogs, [])

    rejectConnection = true
    await import(`./${filename}?authentication-failure`)
    await waitFor(() => sockets.size === 0, "Rejected connection did not release its gateway socket")
    assertSignalHandlersRestored()
    assert.equal(identifies, 2, "Permanent authentication rejection must not reconnect")
    assert.equal(requests.length, 3, "Failed startup must not send a reply")
    assert.equal(process.exitCode, 1, "The outer application boundary must mark failed startup")
    assert.deepEqual(stopLogs, [["Bot stopped because an operation or cleanup failed"]])

    process.exitCode = initialExitCode
    rejectConnection = false
    rejectReply = false
    stallReply = true
    const overflowed = import(`./${filename}?subscription-overflow`)
    await waitFor(() => identifies === 3 && sockets.size === 1, "The overflow fixture bot did not become ready")
    for (let index = 0; index < 260; index += 1) deliver(String(1000 + index), "!ping")
    await overflowed
    await waitFor(() => sockets.size === 0, "Subscription overflow did not release the gateway socket")
    assertSignalHandlersRestored()
    assert.equal(process.exitCode, 1, "Critical subscription closure must fail the application")
    assert.equal(stopLogs.length, 2, "The outer boundary must report the critical worker failure")
} finally {
    process.exitCode = initialExitCode
    if (originalToken === undefined) delete process.env.FLUXER_BOT_TOKEN
    else process.env.FLUXER_BOT_TOKEN = originalToken
    globalThis.fetch = originalFetch
    console.warn = originalConsoleWarn
    console.error = originalConsoleError
    hooks.deregister()
    for (const socket of sockets) socket.terminate()
    await new Promise((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve())))
    assert.equal(sockets.size, 0, "Test-owned gateway sockets must be released")
    assert.equal(gateway.address(), null, "Test-owned gateway listener must be closed")
}

console.log(
    `Packed website ${filename} passed ping reply, unrelated messages, visible connection failure and gateway cleanup`,
)
