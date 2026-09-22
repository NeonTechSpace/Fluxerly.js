import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const token = "gateway-conformance-fixture-only"

export function assertGatewayCommand(actual, expected) {
    assert.equal(actual?.op, expected.op, `Expected gateway command opcode ${expected.op}`)
    assert.equal(actual?.d?.token, expected.token, `Expected gateway command credential ${expected.token}`)
    if (expected.op === 6) {
        assert.equal(actual.d.session_id, expected.sessionId, `Expected resume session ${expected.sessionId}`)
        assert.equal(actual.d.seq, expected.sequence, `Expected resume sequence ${expected.sequence}`)
    }
}

export function assertGatewayFrame(actual, expected) {
    assert.equal(actual?.op, expected.op, `Expected gateway frame opcode ${expected.op}`)
    if ("type" in expected) assert.equal(actual?.t, expected.type, `Expected gateway dispatch ${expected.type}`)
    if ("sequence" in expected)
        assert.equal(actual?.s, expected.sequence, `Expected gateway frame sequence ${expected.sequence}`)
}

function sendFrame(socket, frame, expected) {
    assertGatewayFrame(frame, expected)
    socket.send(JSON.stringify(frame))
}

async function waitFor(predicate, message, fixture) {
    const deadline = Date.now() + 8_000
    while (!predicate()) {
        if (fixture.failure) throw fixture.failure
        if (Date.now() >= deadline) throw new Error(message)
        await sleep(5)
    }
}

async function createFixture(WebSocketServer) {
    const fixture = {
        commands: [],
        connections: [],
        failure: undefined,
        phase: "identify",
        discoveryRequests: 0,
    }
    let origin = ""
    const server = createServer((request, response) => {
        try {
            assert.equal(request.method, "GET")
            assert.equal(request.url, "/.well-known/fluxer")
            fixture.discoveryRequests += 1
            response.writeHead(200, { "content-type": "application/json" })
            response.end(
                JSON.stringify({
                    api_code_version: 1,
                    endpoints: {
                        api_public: origin,
                        gateway: origin.replace(/^http/, "ws"),
                        media: origin,
                        static_cdn: origin,
                        webapp: origin,
                        invite: origin,
                    },
                    features: { presigned_attachment_uploads: true },
                }),
            )
        } catch (error) {
            fixture.failure = error
            response.writeHead(500).end()
        }
    })
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket, request) => {
        try {
            assert.equal(request.url, "/?v=1&encoding=json")
            fixture.connections.push(socket)
            socket.on("message", (payload) => {
                try {
                    const command = JSON.parse(payload.toString())
                    if (command.op === 1) {
                        socket.send(JSON.stringify({ op: 11 }))
                        return
                    }
                    fixture.commands.push(command)
                    if (fixture.phase === "identify") {
                        assertGatewayCommand(command, { op: 2, token })
                        fixture.phase = "ready"
                        sendFrame(
                            socket,
                            { op: 0, s: 1, t: "READY", d: { session_id: "session-a" } },
                            { op: 0, type: "READY", sequence: 1 },
                        )
                    } else if (fixture.phase === "resume") {
                        assertGatewayCommand(command, { op: 6, token, sessionId: "session-a", sequence: 2 })
                        fixture.phase = "resumed"
                        sendFrame(socket, { op: 0, s: 3, t: "RESUMED", d: {} }, { op: 0, type: "RESUMED", sequence: 3 })
                    } else if (fixture.phase === "reject-resume") {
                        assertGatewayCommand(command, { op: 6, token, sessionId: "session-a", sequence: 3 })
                        fixture.phase = "reset"
                        sendFrame(socket, { op: 9, d: false }, { op: 9 })
                    } else if (fixture.phase === "reset") {
                        assertGatewayCommand(command, { op: 2, token })
                        fixture.phase = "reidentified"
                        sendFrame(
                            socket,
                            { op: 0, s: 1, t: "READY", d: { session_id: "session-b" } },
                            { op: 0, type: "READY", sequence: 1 },
                        )
                    } else {
                        throw new Error(`Unexpected gateway command in ${fixture.phase}: ${JSON.stringify(command)}`)
                    }
                } catch (error) {
                    fixture.failure = error
                    socket.close(4002, "fixture assertion failed")
                }
            })
            sendFrame(socket, { op: 10, d: { heartbeat_interval: 60_000 } }, { op: 10 })
        } catch (error) {
            fixture.failure = error
            socket.close(4002, "fixture assertion failed")
        }
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    origin = `http://127.0.0.1:${address.port}`
    return Object.assign(fixture, {
        origin,
        gateway,
        server,
        async close() {
            for (const socket of gateway.clients) socket.terminate()
            await new Promise((resolve) => gateway.close(() => resolve()))
            server.closeAllConnections()
            await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
            assert.equal(gateway.clients.size, 0, "Test-owned gateway sockets must be released")
            assert.equal(server.listening, false, "Test-owned loopback listener must be closed")
        },
    })
}

async function rethrowAfterCleanup(error, cleanup) {
    try {
        await cleanup()
    } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Gateway conformance setup and cleanup both failed")
    }
    throw error
}

export async function createGatewayConformanceDriver(mode, sdk, origin, observed) {
    const options = { token, instance: { url: origin, allowInsecure: true } }
    if (mode === "default") {
        const client = sdk.createClient(options)._unsafeUnwrap()
        try {
            const subscription = client.on("messageCreate", (message) => observed.push(message))._unsafeUnwrap()
            return {
                client,
                async proveCancellation() {
                    const controller = new AbortController()
                    const pending = client.waitFor("typingStart", { signal: controller.signal, timeoutMs: 5_000 })
                    controller.abort()
                    assert.equal((await pending)._unsafeUnwrapErr()._tag, "CancelledError")
                },
                async connect() {
                    ;(await client.connect())._unsafeUnwrap()
                },
                async stopSubscription() {
                    subscription.unsubscribe()
                    ;(await subscription.waitForClose())._unsafeUnwrap()
                },
                async waitForTerminal() {
                    const result = await client.waitForClose()
                    assert.ok(result.isErr())
                    return result.error._tag
                },
                async close() {
                    ;(await client.shutdown())._unsafeUnwrap()
                },
            }
        } catch (error) {
            await rethrowAfterCleanup(error, async () => {
                ;(await client.shutdown())._unsafeUnwrap()
            })
        }
    }

    const runtime = await import("effect")
    const scope = runtime.Scope.makeUnsafe()
    let client
    try {
        client = await runtime.Effect.runPromise(sdk.createClient(options).pipe(runtime.Scope.provide(scope)))
        const subscription = await runtime.Effect.runPromise(
            client
                .on("messageCreate", (message) => runtime.Effect.sync(() => observed.push(message)))
                .pipe(runtime.Scope.provide(scope)),
        )
        return {
            client,
            async proveCancellation() {
                const fiber = runtime.Effect.runFork(client.waitFor("typingStart", { timeoutMs: 5_000 }))
                const done = runtime.Effect.runPromiseExit(runtime.Fiber.join(fiber))
                await runtime.Effect.runPromise(runtime.Fiber.interrupt(fiber))
                const exit = await done
                assert.ok(runtime.Exit.isFailure(exit))
                assert.ok(runtime.Cause.hasInterruptsOnly(exit.cause))
            },
            async connect() {
                await runtime.Effect.runPromise(client.connect())
            },
            async stopSubscription() {
                await runtime.Effect.runPromise(subscription.unsubscribe())
                await runtime.Effect.runPromise(subscription.waitForClose())
            },
            async waitForTerminal() {
                const exit = await runtime.Effect.runPromiseExit(client.waitForClose())
                assert.ok(runtime.Exit.isFailure(exit))
                const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                assert.equal(failure?._tag, "Fail")
                return failure.error._tag
            },
            async close() {
                try {
                    await runtime.Effect.runPromise(client.shutdown())
                } finally {
                    await runtime.Effect.runPromise(runtime.Scope.close(scope, runtime.Exit.void))
                }
            },
        }
    } catch (error) {
        await rethrowAfterCleanup(error, async () => {
            try {
                if (client) await runtime.Effect.runPromise(client.shutdown())
            } finally {
                await runtime.Effect.runPromise(runtime.Scope.close(scope, runtime.Exit.void))
            }
        })
    }
}

export async function runGatewayConformance(mode, moduleObject) {
    assert.ok(mode === "default" || mode === "effect")
    const entrypoint = mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect"
    const sdk = moduleObject ?? (await import(entrypoint))
    const sdkRequire = createRequire(fileURLToPath(import.meta.resolve(entrypoint)))
    const { WebSocketServer } = sdkRequire("ws")
    const fixture = await createFixture(WebSocketServer)
    const observed = []
    const originalRandom = Math.random
    Math.random = () => 0.5
    let driver
    try {
        driver = await createGatewayConformanceDriver(mode, sdk, fixture.origin, observed)
        await driver.proveCancellation()
        await driver.connect()
        await waitFor(
            () => fixture.phase === "ready" && driver.client.state === "Connected",
            "Initial READY failed",
            fixture,
        )

        const first = fixture.connections[0]
        assert.ok(first)
        sendFrame(
            first,
            {
                op: 0,
                s: 2,
                t: "MESSAGE_CREATE",
                d: {
                    id: "100",
                    channel_id: "200",
                    content: "gateway-conformance",
                    author: { id: "300", username: "fixture", bot: false },
                },
            },
            { op: 0, type: "MESSAGE_CREATE", sequence: 2 },
        )
        await waitFor(() => observed.length === 1, "MESSAGE_CREATE was not delivered", fixture)
        assert.equal(observed[0].id, "100")
        await driver.stopSubscription()

        fixture.phase = "resume"
        first.terminate()
        await waitFor(
            () => fixture.phase === "resumed" && driver.client.state === "Connected",
            "RESUMED failed",
            fixture,
        )

        fixture.phase = "reject-resume"
        fixture.connections.at(-1).terminate()
        await waitFor(
            () => fixture.phase === "reidentified" && driver.client.state === "Connected",
            "Invalid-session reset did not reidentify",
            fixture,
        )

        const terminal = driver.waitForTerminal()
        fixture.connections.at(-1).close(4004, "fixture terminal authentication rejection")
        assert.equal(await terminal, "AuthenticationError")
        assert.equal(driver.client.state, "Closed")
        assert.equal(fixture.discoveryRequests, 1)
        assert.deepEqual(
            fixture.commands.map((command) => command.op),
            [2, 6, 6, 2],
        )
        if (fixture.failure) throw fixture.failure
        return Object.freeze({ mode, commands: fixture.commands.length, delivered: observed.length })
    } finally {
        Math.random = originalRandom
        try {
            if (driver) await driver.close()
        } finally {
            await fixture.close()
        }
    }
}
