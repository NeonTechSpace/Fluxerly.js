import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocket } from "ws"
import { createClient, type ClientOptions } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { Opcode as GatewayOpcode } from "../../src/internal/protocol/gateway.js"
import { startGatewayServer, type ReceivedCommand } from "../support/gateway-server.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { modes, type Mode } from "../support/both-apis.js"
import { wsTarget } from "../support/ws-redirect.js"
import { sdkClock, type SdkClock } from "../support/client-clock.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
const hostedGateway = "wss://gateway.fluxer.app/?v=1&encoding=json"
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    const requested = wsTarget.requested
    wsTarget.url = ""
    wsTarget.sockets = []
    wsTarget.requested = []
    // Every SDK socket targets the discovered hosted gateway before redirection to the loopback fixture
    expect(requested.filter((url) => url !== hostedGateway)).toEqual([])
})

async function fixture(clock: SdkClock) {
    const options = { status: 200, retryAfter: 0, header: "", holdHello: false, holdReady: false, rejectResume: "" }
    const requests: number[] = []
    const rejectsResume = (command: ReceivedCommand) =>
        command.op === GatewayOpcode.resume && options.rejectResume !== ""
    const gateway = await startGatewayServer({
        heartbeatIntervalMs: 600_000,
        hello: () => !options.holdHello,
        autoReady: (command) => !options.holdReady && !rejectsResume(command),
        // Each connection's READY names a distinct session, so a resume shows which session it continues
        ready: (identify) => ({ session_id: `fixture-${identify.connection + 1}` }),
        onCommand: (command, socket) => {
            if (options.holdReady || !rejectsResume(command)) return
            if (options.rejectResume === "invalid") gateway.send({ op: GatewayOpcode.invalidSession, d: false }, socket)
            else socket.close(4007)
        },
    })
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe("https://fluxer.app/.well-known/fluxer")
            expect(init).toMatchObject({ method: "GET", redirect: "manual" })
            requests.push(clock.now())
            if (options.status === 429)
                return Response.json(
                    { retry_after: options.retryAfter },
                    { status: options.status, headers: options.header ? { "Retry-After": options.header } : {} },
                )
            if (options.status !== 200) return new Response(null, { status: options.status })
            return Response.json(hostedDiscoveryDocument)
        }),
    )
    return { options, requests, commands: gateway.commands, sockets: gateway.sockets, send: gateway.send }
}

type Operation = "connect" | "run" | "waitForClose"
async function driver(mode: Mode, connection?: ClientOptions["connection"]) {
    const options = { token: "fixture-only", ...(connection ? { connection } : {}) }
    if (mode === "default") {
        const client = createClient(options)
        const shutdown = async () => {
            expect((await client.shutdown()).isOk()).toBe(true)
        }
        onTestFinished(shutdown)
        return {
            client,
            shutdown,
            closeOwner: shutdown,
            start(operation: Operation) {
                const controller = new AbortController()
                const settled = Promise.resolve(client[operation]({ signal: controller.signal }))
                const done = settled.then((result) => (result.isOk() ? "Success" : result.error._tag))
                return {
                    done,
                    failure: settled.then((result): unknown => (result.isOk() ? undefined : result.error)),
                    cancel: async () => {
                        controller.abort()
                    },
                }
            },
        }
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        client,
        shutdown: () => Effect.runPromise(client.shutdown()),
        closeOwner: () => Effect.runPromise(Scope.close(scope, Exit.void)),
        start(operation: Operation) {
            const fiber = Effect.runFork(client[operation]())
            const exited = Effect.runPromiseExit(Fiber.join(fiber))
            const done = exited.then((exit) => {
                if (Exit.isSuccess(exit)) return "Success"
                expect(Cause.hasDies(exit.cause)).toBe(false)
                if (Cause.hasInterruptsOnly(exit.cause)) return "Interrupted"
                const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                if (failure?._tag !== "Fail") throw new Error("Expected a typed connection failure")
                return failure.error._tag
            })
            const failure = exited.then((exit): unknown => {
                if (Exit.isSuccess(exit)) return undefined
                const reason = exit.cause.reasons.find((item) => item._tag === "Fail")
                return reason?._tag === "Fail" ? reason.error : undefined
            })
            return { done, failure, cancel: () => Effect.runPromise(Fiber.interrupt(fiber)) }
        },
    }
}

async function connected(client: { readonly state: string }) {
    await vi.waitFor(() => expect(client.state).toBe("Connected"), { interval: 5 })
}
function released(clock: SdkClock) {
    expect(clock.pending.size).toBe(0)
    expect(wsTarget.sockets.length).toBeGreaterThan(0)
    for (const socket of wsTarget.sockets) {
        expect(socket.readyState).toBe(WebSocket.CLOSED)
        for (const event of ["open", "message", "error", "close"]) expect(socket.listenerCount(event)).toBe(0)
    }
}

test.each(modes)("%s startup timeout includes earlier attempts and retry waits", async (mode) => {
    const clock = sdkClock()
    const server = await fixture(clock)
    server.options.status = 503
    const api = await driver(mode, { startupTimeoutMs: 2000 })
    const startup = api.start("connect")
    await clock.waiting(500)
    await clock.advance(500)
    await clock.waiting(1000)
    server.options.status = 200
    server.options.holdReady = true
    await clock.advance(1000)
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 2)).toBe(true), { interval: 5 })
    await clock.advance(499)
    expect(api.client.state).toBe("Connecting")
    await clock.advance(1)
    expect(await startup.done).toBe("ConnectionTimeoutError")
    expect(api.client.state).toBe("Disconnected")
    expect(server.requests).toEqual([0, 500, 1500])
    released(clock)
    await clock.advance(60_000)
    expect(server.requests).toHaveLength(3)
})

test.each(modes)("%s cancels a startup retry wait without closing the reusable client", async (mode) => {
    const clock = sdkClock()
    const server = await fixture(clock)
    server.options.status = 503
    const api = await driver(mode)
    const startup = api.start("connect")
    await clock.waiting(500)
    await startup.cancel()
    expect(await startup.done).toBe(mode === "default" ? "CancelledError" : "Interrupted")
    expect(api.client.state).toBe("Disconnected")
    expect(clock.pending.size).toBe(0)
    await clock.advance(60_000)
    expect(server.requests).toHaveLength(1)
    server.options.status = 200
    expect(await api.start("connect").done).toBe("Success")
    await api.shutdown()
    released(clock)
})

test.each(modes)("%s does not count gateway cleanup as continuously connected time", async (mode) => {
    const clock = sdkClock()
    const server = await fixture(clock)
    const api = await driver(mode)
    expect(await api.start("connect").done).toBe("Success")
    server.sockets[0]!.close(4000)
    await clock.waiting(500)
    await clock.advance(500)
    await connected(api.client)
    await clock.advance(59_999)
    // Withhold the close handshake at the transport boundary until the SDK's force-close budget
    vi.spyOn(wsTarget.sockets.at(-1)!, "close").mockImplementation(() => {})
    server.send({ op: GatewayOpcode.reconnect }, server.sockets.at(-1))
    await clock.waiting(5000)
    expect(api.client.state).toBe("Recovering")
    await clock.advance(5000)
    await clock.waiting(1000)
    await clock.advance(1000)
    await connected(api.client)
    expect(server.sockets).toHaveLength(3)
    await api.shutdown()
    released(clock)
})

test.each(modes)("%s stops recovery after permanent authentication rejection and retains the failure", async (mode) => {
    const clock = sdkClock()
    const server = await fixture(clock)
    const api = await driver(mode)
    const run = api.start("run")
    await connected(api.client)
    server.options.holdReady = true
    server.sockets[0]!.close(4000)
    await clock.waiting(500)
    await clock.advance(500)
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 6)).toBe(true), { interval: 5 })
    server.sockets.at(-1)!.close(4004)
    expect(await run.done).toBe("AuthenticationError")
    expect(await api.start("waitForClose").done).toBe("AuthenticationError")
    expect(api.client.state).toBe("Closed")
    released(clock)
    await clock.advance(120_000)
    expect(server.sockets).toHaveLength(2)
})

for (const sample of [0, 0.5, 0.999])
    test.each(modes)(`%s startup jitter sample ${sample} respects waits and the attempt limit`, async (mode) => {
        const clock = sdkClock()
        vi.mocked(Math.random).mockReturnValue(sample)
        const server = await fixture(clock)
        server.options.status = 503
        const api = await driver(mode)
        const startup = api.start("connect")
        for (const [delay, count] of [
            [1000 * sample, 1],
            [2000 * sample, 2],
        ] as const) {
            if (delay === 0) continue
            await clock.waiting(delay)
            await clock.advance(delay - 1)
            expect(server.requests).toHaveLength(count)
            await clock.advance(1)
        }
        expect(await startup.done).toBe("ConnectionError")
        expect(server.requests).toEqual([0, 1000 * sample, 3000 * sample])
        expect(api.client.state).toBe("Disconnected")
        expect(clock.pending.size).toBe(0)
        await clock.advance(60_000)
        expect(server.requests).toHaveLength(3)
    })

for (const budget of [30_000, 60_000])
    test.each(modes)(`%s respects a 31-second server wait with a ${budget} ms startup budget`, async (mode) => {
        const clock = sdkClock()
        const server = await fixture(clock)
        Object.assign(server.options, { status: 429, retryAfter: 31, header: "0.125" })
        const api = await driver(mode, { startupTimeoutMs: budget })
        const startup = api.start("connect")
        if (budget === 30_000) {
            // The server wait is returned as it was received, rather than retried early or reported as a timeout
            expect(await startup.done).toBe("RateLimitError")
            expect(await startup.failure).toMatchObject({ _tag: "RateLimitError", retryAfterMs: 31_000 })
            expect(api.client.state).toBe("Disconnected")
            expect(clock.pending.size).toBe(0)
            await clock.advance(60_000)
            expect(server.requests).toEqual([0])
        } else {
            await clock.waiting(31_000)
            await clock.advance(30_999)
            expect(server.requests).toEqual([0])
            server.options.status = 200
            await clock.advance(1)
            expect(await startup.done).toBe("Success")
            expect(server.requests).toEqual([0, 31_000])
            await api.shutdown()
            released(clock)
        }
    })

test.each(modes)("%s owner closure during backoff stops recovery and completes lifetime observers", async (mode) => {
    const clock = sdkClock()
    const server = await fixture(clock)
    const api = await driver(mode)
    expect(await api.start("connect").done).toBe("Success")
    const lifetime = api.start("waitForClose")
    server.sockets[0]!.close(4000)
    await clock.waiting(500)
    await api.closeOwner()
    expect(await lifetime.done).toBe("Success")
    expect(api.client.state).toBe("Closed")
    released(clock)
    await clock.advance(120_000)
    expect(server.sockets).toHaveLength(1)
})

test.each(modes)("%s startup honors fractional server waits without shortening the header", async (mode) => {
    const clock = sdkClock()
    const server = await fixture(clock)
    Object.assign(server.options, { status: 429, retryAfter: 0.125, header: "0.75" })
    const api = await driver(mode, { startupTimeoutMs: 2000 })
    const startup = api.start("connect")
    await clock.waiting(750)
    await clock.advance(749)
    expect(server.requests).toEqual([0])
    server.options.status = 200
    await clock.advance(1)
    expect(await startup.done).toBe("Success")
    expect(server.requests).toEqual([0, 750])
    await api.shutdown()
    released(clock)
})

test.each(modes)("%s recovery increases its jitter ceiling without a startup attempt cap", async (mode) => {
    const clock = sdkClock()
    const server = await fixture(clock)
    const api = await driver(mode, { maxStartupAttempts: 1 })
    expect(await api.start("connect").done).toBe("Success")
    for (const delay of [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]) {
        const count = server.sockets.length
        server.sockets.at(-1)!.close(4000)
        await clock.waiting(delay)
        expect(api.client.state).toBe("Recovering")
        expect(api.client.gatewayLatencyMs).toBe(null)
        await clock.advance(delay - 1)
        expect(server.sockets).toHaveLength(count)
        await clock.advance(1)
        await connected(api.client)
        expect(server.sockets).toHaveLength(count + 1)
    }
    expect(server.requests).toHaveLength(1)
    expect(server.commands.filter((command) => command.op === 6)).toHaveLength(8)
    await api.shutdown()
    released(clock)
})

for (const duration of [59_999, 60_000])
    test.each(modes)(`%s resets backoff only after ${duration} ms continuously connected`, async (mode) => {
        const clock = sdkClock()
        const server = await fixture(clock)
        const api = await driver(mode)
        expect(await api.start("connect").done).toBe("Success")
        server.sockets[0]!.close(4000)
        await clock.waiting(500)
        await clock.advance(500)
        await connected(api.client)
        await clock.advance(duration)
        server.sockets.at(-1)!.close(4000)
        const delay = duration === 60_000 ? 500 : 1000
        await clock.waiting(delay)
        await clock.advance(delay - 1)
        expect(server.sockets).toHaveLength(2)
        await clock.advance(1)
        await connected(api.client)
        expect(server.sockets).toHaveLength(3)
        await api.shutdown()
        released(clock)
    })

for (const rejection of ["invalid", "sequence"])
    test.each(modes)(`%s uses a fresh session after ${rejection} resume rejection`, async (mode) => {
        const clock = sdkClock()
        const server = await fixture(clock)
        const api = await driver(mode)
        expect(await api.start("connect").done).toBe("Success")
        server.send({ op: GatewayOpcode.dispatch, s: 42, t: "IGNORED_EVENT", d: {} }, server.sockets[0])
        server.options.rejectResume = rejection
        server.sockets[0]!.close(4000)
        await clock.waiting(500)
        await clock.advance(500)
        await clock.waiting(1000)
        expect(server.commands.filter((command) => command.op === 6)[0]?.d).toMatchObject({
            seq: 42,
            session_id: "fixture-1",
        })
        await clock.advance(1000)
        await connected(api.client)
        expect(
            server.commands.filter((command) => command.op === 2 || command.op === 6).map((command) => command.op),
        ).toEqual([2, 6, 2])
        server.options.rejectResume = ""
        server.sockets.at(-1)!.close(4000)
        await clock.waiting(2000)
        await clock.advance(2000)
        await connected(api.client)
        // The fresh session continues from its own READY, the fixture's second sequence number, rather than 42
        expect(server.commands.filter((command) => command.op === 6).at(-1)?.d).toMatchObject({
            seq: 2,
            session_id: "fixture-3",
        })
        await api.shutdown()
        released(clock)
    })

test.each(modes)("%s bounds each recovery handshake to thirty seconds", async (mode) => {
    const clock = sdkClock()
    const server = await fixture(clock)
    const api = await driver(mode, { startupTimeoutMs: 1000, maxStartupAttempts: 1 })
    expect(await api.start("connect").done).toBe("Success")
    server.options.holdHello = true
    server.sockets[0]!.close(4000)
    await clock.waiting(500)
    await clock.advance(500)
    await vi.waitFor(() => expect(server.sockets).toHaveLength(2), { interval: 5 })
    await clock.waiting(30_000)
    // Server acceptance can precede the client's upgrade callback under concurrent test load
    await vi.waitFor(() => expect(wsTarget.sockets[1]!.readyState).toBe(WebSocket.OPEN), { interval: 5 })
    await clock.advance(29_999)
    expect(wsTarget.sockets[1]!.readyState).toBe(WebSocket.OPEN)
    await clock.advance(1)
    await clock.waiting(1000)
    expect(wsTarget.sockets[1]!.readyState).toBe(WebSocket.CLOSED)
    server.options.holdHello = false
    await clock.advance(1000)
    await connected(api.client)
    expect(server.sockets).toHaveLength(3)
    await api.shutdown()
    released(clock)
})

for (const phase of ["backoff", "handshake"])
    test.each(modes)(`%s managed cancellation during recovery ${phase} releases its lifetime`, async (mode) => {
        const clock = sdkClock()
        const server = await fixture(clock)
        const api = await driver(mode)
        const run = api.start("run")
        await connected(api.client)
        server.options.holdReady = true
        server.sockets[0]!.close(4000)
        await clock.waiting(500)
        if (phase === "handshake") {
            await clock.advance(500)
            await vi.waitFor(() => expect(server.commands.some((command) => command.op === 6)).toBe(true), {
                interval: 5,
            })
        }
        await run.cancel()
        expect(await run.done).toBe(mode === "default" ? "CancelledError" : "Interrupted")
        expect(api.client.state).toBe("Closed")
        expect(await api.start("waitForClose").done).toBe("Success")
        released(clock)
        await clock.advance(120_000)
        expect(server.sockets).toHaveLength(phase === "backoff" ? 1 : 2)
    })

test.each(modes)(
    "%s cancelled observers and rejected operations do not own recovery; concurrent shutdown does",
    async (mode) => {
        const clock = sdkClock()
        const server = await fixture(clock)
        const api = await driver(mode)
        const startup = api.start("connect")
        expect(await startup.done).toBe("Success")
        server.sockets[0]!.close(4000)
        await clock.waiting(500)
        const cancelled = api.start("waitForClose")
        const retained = api.start("waitForClose")
        const rejected = api.start("run")
        expect(await rejected.done).toBe("ClientBusyError")
        expect(await api.start("connect").done).toBe("ClientBusyError")
        await rejected.cancel()
        await startup.cancel()
        await cancelled.cancel()
        expect(await cancelled.done).toBe(mode === "default" ? "CancelledError" : "Interrupted")
        expect(api.client.state).toBe("Recovering")
        await clock.advance(500)
        await connected(api.client)
        server.options.holdReady = true
        server.sockets.at(-1)!.close(4000)
        await clock.waiting(1000)
        await clock.advance(1000)
        await vi.waitFor(() => expect(server.commands.filter((command) => command.op === 6)).toHaveLength(2), {
            interval: 5,
        })
        await Promise.all([api.shutdown(), api.shutdown()])
        expect(await retained.done).toBe("Success")
        expect(await api.start("waitForClose").done).toBe("Success")
        expect(await api.start("connect").done).toBe("ClientClosedError")
        released(clock)
        await clock.advance(120_000)
        expect(server.sockets).toHaveLength(3)
    },
)
