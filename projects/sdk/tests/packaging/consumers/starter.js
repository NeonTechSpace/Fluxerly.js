import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { formatWithOptions } from "node:util"
import { withHostedDiscovery } from "../hosted-discovery.mjs"
import { Recorder, sdkWebSocketUrl, startLoopback } from "./loopback.js"

// Run an authored starter program against the installed package, with its hosted gateway and REST calls redirected
// to test-owned fixtures
const [kind, filename] = process.argv.slice(2)
assert.ok(
    (kind === "default" && (filename === "bot.js" || filename === "bot.ts")) ||
        (kind === "effect" && filename === "bot-effect.ts"),
    "Select a default bot.js or bot.ts starter, or the effect bot-effect.ts starter",
)

let rejectConnection = false
const identifies = new Recorder()
const gateway = await startLoopback({
    command(command, connection) {
        assert.equal(command.op, 2, "The starter must send only Identify and heartbeats")
        identifies.record(command.d.token)
        if (rejectConnection) connection.socket.close(4004, "Fixture authentication rejection")
        else gateway.dispatch(connection, "READY", { session_id: "fixture" })
    },
})
const redirectedWebSocketUrl = `data:text/javascript,${encodeURIComponent(`
    import assert from "node:assert/strict"
    import WebSocket from ${JSON.stringify(sdkWebSocketUrl)}
    export default class FixtureWebSocket extends WebSocket {
        constructor(url, options) {
            assert.equal(url, "wss://gateway.fluxer.app/?v=1&encoding=json")
            super(${JSON.stringify(`${gateway.gatewayUrl}/?v=1&encoding=json`)}, options)
        }
    }
`)}`
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context)
        return specifier === "ws" ? { ...resolved, url: redirectedWebSocketUrl } : resolved
    },
})

const deliver = (id, content, bot = false) =>
    gateway.broadcast("MESSAGE_CREATE", {
        id,
        channel_id: "20",
        content,
        author: { id: "30", username: "fixture", bot },
    })

const originalFetch = globalThis.fetch
const originalToken = process.env.FLUXER_BOT_TOKEN
const originalConsole = { log: console.log, warn: console.warn, error: console.error }
const initialExitCode = process.exitCode
const initialSigintListeners = process.listeners("SIGINT")
const initialSigtermListeners = process.listeners("SIGTERM")
const requests = new Recorder()
// The starter prints nothing itself. Every line comes from the SDK's records, which go to the console
const lines = []
const lineWaiters = new Set()
// The wait fails well before the package check's process deadline, so the catch below can still print the captured
// output
const nextLine = (pattern, timeoutMs = 5_000) =>
    new Promise((resolve, reject) => {
        const found = lines.find((line) => pattern.test(line))
        if (found !== undefined) return resolve(found)
        const timer = setTimeout(() => {
            lineWaiters.delete(waiter)
            reject(new Error(`No SDK output line matched ${pattern} within ${timeoutMs} ms`))
        }, timeoutMs)
        const waiter = (line) => {
            if (!pattern.test(line)) return
            clearTimeout(timer)
            lineWaiters.delete(waiter)
            resolve(line)
        }
        lineWaiters.add(waiter)
    })
let rejectReply = false
globalThis.fetch = withHostedDiscovery(async (url, options) => {
    requests.record({
        url,
        method: options.method,
        authorization: new Headers(options.headers).get("authorization"),
        body: JSON.parse(options.body),
    })
    if (rejectReply)
        return Response.json({ code: "MISSING_PERMISSIONS", message: "private fixture detail" }, { status: 403 })
    const body = JSON.parse(options.body)
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
for (const method of ["log", "warn", "error"])
    console[method] = (...values) => {
        // Native records pass their annotations, which hold the record code, as an object after the message
        const line = formatWithOptions({ depth: 6, breakLength: Infinity }, ...values)
        lines.push(line)
        for (const waiter of lineWaiters) waiter(line)
    }
const linesMatching = (pattern) => lines.filter((line) => pattern.test(line))

function assertSignalHandlersRestored() {
    assert.deepEqual(process.listeners("SIGINT"), initialSigintListeners)
    assert.deepEqual(process.listeners("SIGTERM"), initialSigtermListeners)
}

try {
    const running = import(`./${filename}?success`)
    await identifies.reach(1)
    deliver("10", "!ping", true)
    deliver("11", "Hello")
    deliver("12", "!ping extra")
    // Messages arrive in order, so a reply to the human ping follows the ignored messages
    const ping = deliver("13", "!ping")
    await requests.reach(1)
    const [
        {
            body: { nonce, ...body },
            ...request
        },
    ] = requests.items
    assert.deepEqual(request, {
        url: "https://api.fluxer.app/v1/channels/20/messages",
        method: "POST",
        authorization: "Bot fixture-only",
    })
    assert.equal(typeof nonce, "string")
    assert.deepEqual(body, {
        content: "Pong!",
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
        message_reference: { message_id: ping.id, channel_id: ping.channel_id, type: 0 },
    })

    // A returned failed reply is logged with its Fluxer code, without Fluxer's message, and the bot keeps running
    rejectReply = true
    deliver("14", "!ping")
    assert.match(await nextLine(/events\.handlerFailed/), /MISSING_PERMISSIONS/)
    assert.deepEqual(linesMatching(/private fixture detail/), [])
    assert.equal(gateway.connections.size, 1, "An expected reply failure must not stop the bot")

    assert.equal(process.emit("SIGINT"), true, "The starter did not install its signal handler")
    await running
    await gateway.closed()
    assertSignalHandlersRestored()
    assert.equal(process.exitCode, initialExitCode, "Requested shutdown must be a clean application stop")
    assert.deepEqual(linesMatching(/botFailed/), [], "Requested shutdown must not be reported as a failure")
    assert.equal(requests.items.length, 2, "Only the human ping and the rejected reply may send requests")

    lines.length = 0
    rejectConnection = true
    await import(`./${filename}?authentication-failure`)
    await gateway.closed()
    assertSignalHandlersRestored()
    assert.equal(identifies.items.length, 2, "Permanent authentication rejection must not reconnect")
    assert.deepEqual(identifies.items, ["fixture-only", "fixture-only"])
    assert.equal(requests.items.length, 2, "Failed startup must not send a reply")
    assert.equal(process.exitCode, 1, "runBot must mark failed startup")
    // The client already logged the rejected token, so runBot does not report the same failure again
    assert.equal(linesMatching(/auth\.rejected/).length, 1, "The rejected token must be reported once")
    assert.deepEqual(linesMatching(/botFailed/), [])
} catch (error) {
    process.stderr.write(`--- captured SDK output ---\n${lines.join("\n")}\n`)
    throw error
} finally {
    process.exitCode = initialExitCode
    if (originalToken === undefined) delete process.env.FLUXER_BOT_TOKEN
    else process.env.FLUXER_BOT_TOKEN = originalToken
    globalThis.fetch = originalFetch
    Object.assign(console, originalConsole)
    hooks.deregister()
    await gateway.close()
}

console.log(
    `Packed ${kind} starter ${filename} passed ping reply, rejected reply, signal stop and credential rejection`,
)
