import { once } from "node:events"
import { createServer } from "node:http"
import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import { createClient } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { modes, type Mode } from "../support/both-apis.js"
import { outcome, sdkClock } from "../support/client-clock.js"

const transport = vi.hoisted(() => ({
    url: "",
    sockets: [] as import("ws").WebSocket[],
    delivered: 0,
    maxPayload: undefined as number | undefined,
}))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(_url: string, options: import("ws").ClientOptions) {
                super(transport.url, options)
                transport.sockets.push(this)
                transport.maxPayload = options.maxPayload
            }
            override emit(event: string | symbol, ...args: unknown[]): boolean {
                if (event === "message") transport.delivered++
                return super.emit(event, ...args)
            }
        },
    }
})

afterEach(() => {
    vi.unstubAllGlobals()
    transport.sockets = []
    transport.delivered = 0
    transport.maxPayload = undefined
})

// Public receive-policy boundary, deliberately independent of the implementation constant
const limit = 100 * 1024 * 1024

function ready(bytes?: number) {
    const text = JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "receive-fixture" } })
    return bytes === undefined ? text : text + " ".repeat(bytes - Buffer.byteLength(text))
}

// A hand-written gateway rather than startGatewayServer, because it sends raw padded and fragmented READY frames
async function fixture(mode: Mode, initial = ready(), fragmented = false) {
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    const peers: WebSocket[] = []
    let payload = initial
    gateway.on("connection", (socket) => {
        peers.push(socket)
        socket.on("error", () => {})
        socket.send('{"op":10,"d":{"heartbeat_interval":600000}}')
        socket.on("message", (raw) => {
            const command = JSON.parse(raw.toString())
            if (command.op === 1) socket.send('{"op":11}')
            if (command.op !== 2) return
            if (fragmented) {
                const midpoint = Math.floor(payload.length / 2)
                socket.send(payload.slice(0, midpoint), { fin: false })
                socket.send(payload.slice(midpoint), { fin: true })
            } else socket.send(payload)
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Expected owned loopback address")
    transport.url = `ws://127.0.0.1:${address.port}`
    vi.stubGlobal("fetch", async () => Response.json(hostedDiscoveryDocument))
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture-only-not-a-credential", connection: { startupTimeoutMs: 3000 } }
    const client =
        mode === "default"
            ? createClient(options)
            : await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        await outcome(client.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
        for (const socket of [...peers, ...transport.sockets]) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return { client, peers, replaceReady: (value: string) => (payload = value) }
}

function released() {
    for (const socket of transport.sockets) {
        expect(socket.readyState).toBe(WebSocket.CLOSED)
        for (const event of ["message", "error", "close"]) expect(socket.listenerCount(event)).toBe(0)
    }
}

for (const mode of modes) {
    test.each([limit - 1, limit])(`${mode}: accepts a complete READY of %i bytes`, async (bytes) => {
        const { client } = await fixture(mode, ready(bytes))
        expect(await outcome(client.connect())).toEqual({ value: undefined })
        expect(transport.maxPayload).toBe(limit)
        expect(client.state).toBe("Connected")
        expect(await outcome(client.shutdown())).toEqual({ value: undefined })
        released()
    })

    test.each([false, true])(`${mode}: rejects oversized READY before delivery, fragmented=%s`, async (fragmented) => {
        const f = await fixture(mode, ready(limit + 1), fragmented)
        expect(await outcome(f.client.connect())).toMatchObject({
            error: { _tag: "ConnectionError", phase: "gateway", reason: "protocol", status: 1009 },
        })
        expect(transport.delivered).toBe(1) // Only HELLO reached the JSON-processing boundary
        expect(f.peers).toHaveLength(1) // No automatic retry of the rejected payload
        expect(f.client.state).toBe("Disconnected")
        released()
        f.replaceReady(ready())
        expect(await outcome(f.client.connect())).toEqual({ value: undefined })
        expect(f.peers).toHaveLength(2)
    })

    test(`${mode}: accepts an exactly-at-limit fragmented READY`, async () => {
        const { client } = await fixture(mode, ready(limit), true)
        expect(await outcome(client.connect())).toEqual({ value: undefined })
        expect(client.state).toBe("Connected")
    })

    test.each(["oversized", "utf8"] as const)(
        `${mode}: established %s receive failure is terminal and sanitized`,
        async (kind) => {
            const { client, peers } = await fixture(mode)
            expect(await outcome(client.connect())).toEqual({ value: undefined })
            const delivered = transport.delivered
            const closed = outcome(client.waitForClose())
            const payload = kind === "oversized" ? ready(limit + 1) : Buffer.from([0xc3, 0x28])
            peers[0]!.send(payload, { binary: false })
            const result = await closed
            expect(result).toMatchObject({
                error: {
                    _tag: "ConnectionError",
                    phase: "gateway",
                    reason: "protocol",
                    status: kind === "oversized" ? 1009 : 1007,
                },
            })
            expect(transport.delivered).toBe(delivered)
            expect(client.state).toBe("Closed")
            expect(peers).toHaveLength(1)
            released()
        },
    )

    test(`${mode}: established invalid JSON retries with a new session until three in a row end the shard`, async () => {
        vi.spyOn(Math, "random").mockReturnValue(0)
        onTestFinished(() => {
            vi.restoreAllMocks()
        })
        const { client, peers } = await fixture(mode)
        expect(await outcome(client.connect())).toEqual({ value: undefined })
        const closed = outcome(client.waitForClose())
        for (let anomaly = 1; anomaly <= 3; anomaly++) {
            await vi.waitFor(() => expect(client.state).toBe("Connected"))
            peers.at(-1)!.send("{private-payload-sentinel", { binary: false })
            // Each retry starts a new session, so the fixture answers its Identify with READY
            if (anomaly < 3) await vi.waitFor(() => expect(peers).toHaveLength(anomaly + 1))
        }
        const result = await closed
        expect(result).toMatchObject({
            error: { _tag: "ConnectionError", phase: "gateway", reason: "protocol", status: null },
        })
        expect(JSON.stringify(result)).not.toContain("private-payload-sentinel")
        expect(peers).toHaveLength(3)
        expect(client.state).toBe("Closed")
        released()
    })

    test(`${mode}: a connection that stays healthy between invalid JSON anomalies restarts the count`, async () => {
        const clock = sdkClock()
        onTestFinished(() => {
            vi.restoreAllMocks()
        })
        const { client, peers } = await fixture(mode)
        expect(await outcome(client.connect())).toEqual({ value: undefined })
        const closed = outcome(client.waitForClose())
        // Jitter is 0.5, so recovery waits 500 ms, then 1,000 ms, and the sequence restarts after a healthy connection
        const anomaly = async (retryDelayMs: number) => {
            await vi.waitFor(() => expect(client.state).toBe("Connected"))
            const connections = peers.length
            peers.at(-1)!.send("{private-payload-sentinel", { binary: false })
            await clock.waiting(retryDelayMs)
            await clock.advance(retryDelayMs)
            await vi.waitFor(() => expect(peers).toHaveLength(connections + 1))
        }
        await anomaly(500)
        await anomaly(1_000)
        await vi.waitFor(() => expect(client.state).toBe("Connected"))
        await clock.advance(60_000)
        await anomaly(500)
        await anomaly(1_000)
        await vi.waitFor(() => expect(client.state).toBe("Connected"))
        // Quick anomalies after the restart still count, so the third in a row ends the shard
        peers.at(-1)!.send("{private-payload-sentinel", { binary: false })
        expect(await closed).toMatchObject({ error: { _tag: "ConnectionError", reason: "protocol" } })
        expect(peers).toHaveLength(5)
    })
}
