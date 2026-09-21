import { once } from "node:events"
import { createServer } from "node:http"
import { Effect, Exit, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { hostedDiscoveryDocument } from "./hosted-discovery.js"

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
type Mode = "default" | "native"
async function settle<A, E>(operation: ResultAsync<A, E> | Effect.Effect<A, E>) {
    if (Effect.isEffect(operation)) {
        const result = await Effect.runPromise(Effect.result(operation))
        return result._tag === "Failure" ? { error: result.failure } : { value: result.success }
    }
    const result = await operation
    return result.isErr() ? { error: result.error } : { value: result.value }
}

function ready(bytes?: number) {
    const text = JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "receive-fixture" } })
    return bytes === undefined ? text : text + " ".repeat(bytes - Buffer.byteLength(text))
}

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
            ? createClient(options)._unsafeUnwrap()
            : await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        await settle(client.shutdown())
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

for (const mode of ["default", "native"] as const) {
    test.each([limit - 1, limit])(`${mode}: accepts a complete READY of %i bytes`, async (bytes) => {
        const { client } = await fixture(mode, ready(bytes))
        expect(await settle(client.connect())).toEqual({ value: undefined })
        expect(transport.maxPayload).toBe(limit)
        expect(client.state).toBe("Connected")
        expect(await settle(client.shutdown())).toEqual({ value: undefined })
        released()
    })

    test.each([false, true])(`${mode}: rejects oversized READY before delivery, fragmented=%s`, async (fragmented) => {
        const f = await fixture(mode, ready(limit + 1), fragmented)
        expect(await settle(f.client.connect())).toMatchObject({
            error: { _tag: "ConnectionError", phase: "gateway", reason: "protocol", status: 1009 },
        })
        expect(transport.delivered).toBe(1) // Only HELLO reached the JSON-processing boundary
        expect(f.peers).toHaveLength(1) // No automatic retry of the rejected payload
        expect(f.client.state).toBe("Disconnected")
        released()
        f.replaceReady(ready())
        expect(await settle(f.client.connect())).toEqual({ value: undefined })
        expect(f.peers).toHaveLength(2)
    })

    test(`${mode}: accepts an exactly-at-limit fragmented READY`, async () => {
        const { client } = await fixture(mode, ready(limit), true)
        expect(await settle(client.connect())).toEqual({ value: undefined })
        expect(client.state).toBe("Connected")
    })

    test.each(["oversized", "utf8", "json"] as const)(
        `${mode}: established %s receive failure is terminal and sanitized`,
        async (kind) => {
            const { client, peers } = await fixture(mode)
            expect(await settle(client.connect())).toEqual({ value: undefined })
            const delivered = transport.delivered
            const closed = settle(client.waitForClose())
            const payload =
                kind === "oversized"
                    ? ready(limit + 1)
                    : kind === "utf8"
                      ? Buffer.from([0xc3, 0x28])
                      : "{private-payload-sentinel"
            peers[0]!.send(payload, { binary: false })
            const result = await closed
            expect(result).toMatchObject({
                error: {
                    _tag: "ConnectionError",
                    phase: "gateway",
                    reason: "protocol",
                    status: kind === "oversized" ? 1009 : kind === "utf8" ? 1007 : null,
                },
            })
            expect(JSON.stringify(result)).not.toContain("private-payload-sentinel")
            expect(transport.delivered).toBe(delivered + (kind === "json" ? 1 : 0))
            expect(client.state).toBe("Closed")
            expect(peers).toHaveLength(1)
            released()
        },
    )
}
