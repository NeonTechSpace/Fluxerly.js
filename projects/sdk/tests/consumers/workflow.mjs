import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"

const kind = process.argv[2]
assert.ok(kind === "default" || kind === "effect", "Select default or effect workflow")

const message = (id, content) => ({
    id,
    channel_id: "20",
    content,
    author: { id: "30", username: "fixture" },
})

function frame(payload, opcode = 1) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body])
    assert.ok(body.length < 65_536, "Fixture frame exceeded its bounded payload")
    const header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
    return Buffer.concat([header, body])
}

function websocketAccept(key) {
    return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
}

function waitFor(predicate, message) {
    return (async () => {
        const deadline = Date.now() + 5_000
        while (!predicate()) {
            if (Date.now() >= deadline) throw Error(message)
            await sleep(5)
        }
    })()
}

async function fixture() {
    let origin = ""
    let sequence = 0
    let completeCancellationRequest
    const cancellationRequest = new Promise((resolve) => {
        completeCancellationRequest = resolve
    })
    const requests = []
    const sockets = new Set()
    const gatewayPaths = []
    const server = createServer(async (request, response) => {
        const target = new URL(request.url ?? "/", origin)
        requests.push(`${request.method} ${target.pathname}${target.search}`)
        if (target.pathname === "/.well-known/fluxer") {
            response.setHeader("content-type", "application/json")
            response.end(
                JSON.stringify({
                    api_code_version: 1,
                    endpoints: {
                        api_public: `${origin}/api`,
                        gateway: origin.replace("http:", "ws:") + "/gateway",
                        media: `${origin}/media`,
                        static_cdn: `${origin}/static`,
                        webapp: `${origin}/web`,
                        invite: `${origin}/invite`,
                    },
                    features: { presigned_attachment_uploads: false },
                }),
            )
            return
        }
        if (target.pathname === "/api/v1/channels/20/messages" && request.method === "GET") {
            const before = target.searchParams.get("before")
            response.setHeader("content-type", "application/json")
            response.end(
                JSON.stringify(before === "20" ? [message("19", "second page")] : [message("20", "first page")]),
            )
            return
        }
        if (target.pathname === "/api/v1/channels/20/messages/30" && request.method === "GET") {
            response.setHeader("content-type", "application/json")
            response.end(JSON.stringify(message("30", "freshness")))
            return
        }
        if (target.pathname === "/api/v1/channels/20/messages/40" && request.method === "GET") {
            completeCancellationRequest()
            request.once("close", () => response.destroy())
            return
        }
        if (target.pathname === "/api/v1/channels/20/messages/50" && request.method === "DELETE") {
            response.destroy()
            return
        }
        response.statusCode = 404
        response.end()
    })
    server.on("upgrade", (request, socket) => {
        assert.equal(request.url, "/gateway?v=1&encoding=json")
        const key = request.headers["sec-websocket-key"]
        assert.equal(typeof key, "string")
        gatewayPaths.push(request.url)
        socket.write(
            [
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
                "",
                "",
            ].join("\r\n"),
        )
        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))
        socket.write(frame(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })))
        let pending = Buffer.alloc(0)
        socket.on("data", (chunk) => {
            pending = Buffer.concat([pending, chunk])
            while (pending.length >= 2) {
                let length = pending[1] & 0x7f
                let headerLength = 2
                if (length === 126) {
                    if (pending.length < 4) return
                    length = pending.readUInt16BE(2)
                    headerLength = 4
                }
                assert.notEqual(length, 127, "Fixture accepts only bounded client frames")
                const size = headerLength + 4 + length
                if (pending.length < size) return
                const opcode = pending[0] & 0x0f
                const mask = pending.subarray(headerLength, headerLength + 4)
                const payload = Buffer.from(pending.subarray(headerLength + 4, size))
                for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
                pending = pending.subarray(size)
                if (opcode === 8) {
                    socket.end(frame(payload, 8))
                    return
                }
                if (opcode !== 1) continue
                const command = JSON.parse(payload.toString())
                if (command.op === 2)
                    socket.write(
                        frame(JSON.stringify({ op: 0, s: ++sequence, t: "READY", d: { session_id: "fixture" } })),
                    )
                if (command.op === 1) socket.write(frame(JSON.stringify({ op: 11 })))
            }
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    assert.ok(address && typeof address !== "string", "Fixture has no TCP port")
    origin = `http://127.0.0.1:${address.port}`
    return {
        origin,
        requests,
        gatewayPaths,
        deliver(content) {
            for (const socket of sockets)
                socket.write(
                    frame(
                        JSON.stringify({
                            op: 0,
                            s: ++sequence,
                            t: "MESSAGE_CREATE",
                            d: message(String(100 + sequence), content),
                        }),
                    ),
                )
        },
        awaitCancellationRequest() {
            return cancellationRequest
        },
        async close() {
            for (const socket of sockets) socket.destroy()
            await new Promise((resolve) => server.close(resolve))
        },
    }
}

async function runWorkflow() {
    const remote = await fixture()
    try {
        if (kind === "default") await defaultWorkflow(remote)
        else await effectWorkflow(remote)
        assert.deepEqual(remote.gatewayPaths, ["/gateway?v=1&encoding=json"])
        assert.equal(remote.requests.filter((request) => request.endsWith("/messages/50")).length, 1)
    } finally {
        await remote.close()
    }
}

async function defaultWorkflow(remote) {
    const { commands, createClient } = await import("@neontechspace/fluxerly")
    const invalid = createClient({ token: "" })
    assert.ok(invalid.isErr())
    assert.equal(invalid.error._tag, "ConfigurationError")
    const client = createClient({
        token: "fixture-only",
        instance: { url: remote.origin, allowInsecure: true },
        cache: { messages: { maxAgeMs: 100 } },
    })._unsafeUnwrap()
    let running
    try {
        const commandsSeen = []
        const eventsSeen = []
        const rejections = []
        let router = commands
            .create({ prefix: "!", onUnmatched: (_context, unmatched) => rejections.push(unmatched._tag) })
            ._unsafeUnwrap()
        assert.ok(router.register({ name: "", execute: () => undefined }).isErr())
        router = router.register({ name: "ping", execute: () => commandsSeen.push("ping") })._unsafeUnwrap()
        router.attach(client)._unsafeUnwrap()
        client.on("messageCreate", (event) => eventsSeen.push(event.content))._unsafeUnwrap()
        running = client.run()
        await waitFor(() => client.state === "Connected", "Default run did not become ready")
        remote.deliver("!ping")
        remote.deliver("!unknown")
        await waitFor(
            () => commandsSeen.length === 1 && eventsSeen.length === 2 && rejections.length === 1,
            "Default event workflow stalled",
        )
        await advancedDefault(client, remote)
        ;(await client.shutdown())._unsafeUnwrap()
        ;(await running)._unsafeUnwrap()
        assert.equal(client.state, "Closed")
    } finally {
        if (client.state !== "Closed") (await client.shutdown())._unsafeUnwrap()
        if (running) await running
    }
}

async function advancedDefault(client, remote) {
    const pages = []
    for await (const result of client.messages.iterateHistory("20", { maxItems: 2, pageSize: 1 })) {
        assert.ok(result.isOk(), result.isErr() ? result.error.message : "")
        pages.push(result.value.id)
    }
    assert.deepEqual(pages, ["20", "19"])
    const cached = await client.messages.fetch({ channelId: "20", id: "30" })
    assert.ok(cached.isOk())
    assert.equal(client.messages.get(cached.value)._unsafeUnwrap()?.content, "freshness")
    await sleep(130)
    assert.equal(client.messages.get(cached.value)._unsafeUnwrap(), undefined)
    const controller = new AbortController()
    const cancelling = client.messages.fetch({ channelId: "20", id: "40" }, { signal: controller.signal })
    await remote.awaitCancellationRequest()
    controller.abort()
    const cancelled = await cancelling
    assert.ok(cancelled.isErr())
    assert.equal(cancelled.error._tag, "CancelledError")
    const unknown = await client.messages.delete({ channelId: "20", id: "50" })
    assert.ok(unknown.isErr())
    assert.equal(unknown.error._tag, "MessageOperationError")
    assert.equal(unknown.error.outcome, "unknown")
}

async function effectWorkflow(remote) {
    const { Cause, Effect, Exit, Fiber, Scope, Stream } = await import("effect")
    const { commands, createClient } = await import("@neontechspace/fluxerly/effect")
    const invalid = await Effect.runPromise(Effect.result(createClient({ token: "" })))
    assert.equal(invalid._tag, "Failure")
    assert.equal(invalid.failure._tag, "ConfigurationError")
    const scope = Scope.makeUnsafe()
    const registration = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createClient({
            token: "fixture-only",
            instance: { url: remote.origin, allowInsecure: true },
            cache: { messages: { maxAgeMs: 100 } },
        }).pipe(Scope.provide(scope)),
    )
    try {
        const commandsSeen = []
        const eventsSeen = []
        const rejections = []
        let router = await Effect.runPromise(
            commands.create({
                prefix: "!",
                onUnmatched: (_context, unmatched) => Effect.sync(() => rejections.push(unmatched._tag)),
            }),
        )
        const invalidRegistration = await Effect.runPromise(
            Effect.result(router.register({ name: "", execute: () => Effect.void })),
        )
        assert.equal(invalidRegistration._tag, "Failure")
        router = await Effect.runPromise(
            router.register({ name: "ping", execute: () => Effect.sync(() => commandsSeen.push("ping")) }),
        )
        await Effect.runPromise(router.attach(client).pipe(Scope.provide(registration)))
        await Effect.runPromise(
            client
                .on("messageCreate", (event) => Effect.sync(() => eventsSeen.push(event.content)))
                .pipe(Scope.provide(registration)),
        )
        const running = Effect.runFork(client.run())
        await waitFor(() => client.state === "Connected", "Effect run did not become ready")
        remote.deliver("!ping")
        remote.deliver("!unknown")
        await waitFor(
            () => commandsSeen.length === 1 && eventsSeen.length === 2 && rejections.length === 1,
            "Effect event workflow stalled",
        )
        await advancedEffect(client, remote, { Cause, Effect, Exit, Fiber, Stream })
        await Effect.runPromise(client.shutdown())
        await Effect.runPromise(Fiber.join(running))
        assert.equal(client.state, "Closed")
    } finally {
        await Effect.runPromise(Scope.close(registration, Exit.void))
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
}

async function advancedEffect(client, remote, runtime) {
    const { Cause, Effect, Exit, Fiber, Stream } = runtime
    const pages = await Effect.runPromise(
        client.messages.iterateHistory("20", { maxItems: 2, pageSize: 1 }).pipe(
            Stream.map((item) => item.id),
            Stream.runCollect,
        ),
    )
    assert.deepEqual([...pages], ["20", "19"])
    const cached = await Effect.runPromise(client.messages.fetch({ channelId: "20", id: "30" }))
    assert.equal(await Effect.runPromise(client.messages.get(cached)), cached)
    await sleep(130)
    assert.equal(await Effect.runPromise(client.messages.get(cached)), undefined)
    const cancelling = Effect.runFork(client.messages.fetch({ channelId: "20", id: "40" }))
    await remote.awaitCancellationRequest()
    await Effect.runPromise(Fiber.interrupt(cancelling))
    const cancelled = await Effect.runPromiseExit(Fiber.join(cancelling))
    assert.ok(Exit.isFailure(cancelled) && Cause.hasInterruptsOnly(cancelled.cause))
    const unknown = await Effect.runPromise(Effect.result(client.messages.delete({ channelId: "20", id: "50" })))
    assert.equal(unknown._tag, "Failure")
    assert.equal(unknown.failure._tag, "MessageOperationError")
    assert.equal(unknown.failure.outcome, "unknown")
}

await runWorkflow()
console.log(`${kind} packed workflow passed`)
