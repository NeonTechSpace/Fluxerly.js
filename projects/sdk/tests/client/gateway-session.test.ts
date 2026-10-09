import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Client, ClientOptions } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { Opcode } from "../../src/internal/protocol/gateway.js"
import { describeBothApis, setup, type Mode } from "../support/both-apis.js"
import { outcome, sdkClock } from "../support/client-clock.js"
import { startGatewayServer, type GatewayServerOptions } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs, counters } from "../support/log-capture.js"
import { settle } from "../support/settle.js"
import { wsTarget } from "../support/ws-redirect.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type AnyClient = Client | NativeClient

const typing = (timestamp: number) => ({ channel_id: "20", user_id: "30", timestamp })

/** Start a client against a scripted gateway and record what its raw and typing handlers receive */
async function start(mode: Mode, gateway: GatewayServerOptions = {}, connection?: ClientOptions["connection"]) {
    const server = await startGatewayServer(gateway)
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const logs = captureLogs()
    const client = (await setup(mode, { logging: logs.logging, ...(connection ? { connection } : {}) })) as AnyClient
    // Raw dispatches as "TYPE sequence", and typing events by timestamp
    const raw: string[] = []
    const typed: number[] = []
    if (mode === "default") {
        const created = client as Client
        created.on("raw", (event) => void raw.push(`${event.t} ${event.s}`))
        created.on("typingStart", (event) => void typed.push(event.timestamp))
    } else {
        const created = client as NativeClient
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        await Effect.runPromise(
            created
                .on("raw", (event) => Effect.sync(() => void raw.push(`${event.t} ${event.s}`)))
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(
            created
                .on("typingStart", (event) => Effect.sync(() => void typed.push(event.timestamp)))
                .pipe(Scope.provide(scope)),
        )
    }
    return { server, client, logs, raw, typed }
}

/** Hand frames to the newest SDK socket in one synchronous turn, as ws does for frames read from one chunk */
function deliver(...frames: unknown[]) {
    const socket = wsTarget.sockets.at(-1)!
    for (const frame of frames) socket.emit("message", Buffer.from(JSON.stringify(frame)), false)
}

describeBothApis("gateway session", (mode) => {
    test("rejects a dispatch whose sequence goes backwards before delivery and starts a new session", async () => {
        const clock = sdkClock()
        const { server, client, logs, raw, typed } = await start(mode)
        await settle(client.connect())
        deliver({ op: Opcode.dispatch, s: 10, t: "TYPING_START", d: typing(1) })
        await vi.waitFor(() => expect(typed).toEqual([1]))
        deliver({ op: Opcode.dispatch, s: 9, t: "TYPING_START", d: typing(2) })
        expect(counters(client).protocolFailures).toBe(1)
        await clock.waiting(500)
        expect(client.state).toBe("Recovering")
        expect(logs.withCode("lifecycle.connectionLost")).toEqual([
            expect.objectContaining({ fields: expect.objectContaining({ reason: "protocol", next: "identify" }) }),
        ])
        await clock.advance(500)
        await vi.waitFor(() => expect(client.state).toBe("Connected"))
        // The stale session is not resumed, so the gateway cannot replay from the sequence that went backwards
        expect(server.commandsWithOp(Opcode.resume)).toEqual([])
        expect(server.commandsWithOp(Opcode.identify)).toHaveLength(2)
        server.dispatch("TYPING_START", typing(3))
        // Handlers receive events in order, so the complete lists show the stale dispatch never reached them
        await vi.waitFor(() => expect(typed).toEqual([1, 3]))
        await vi.waitFor(() => expect(raw).toEqual(["READY 1", "TYPING_START 10", "READY 2", "TYPING_START 3"]))
    })

    test("fails startup without delivery when the gateway answers Identify with RESUMED", async () => {
        let answerWithReady = false
        const { server, client, raw } = await start(
            mode,
            {
                autoReady: () => answerWithReady,
                onCommand: (command, socket) => {
                    if (command.op === Opcode.identify && !answerWithReady)
                        socket.send(JSON.stringify({ op: Opcode.dispatch, s: 1, t: "RESUMED", d: {} }))
                },
            },
            { maxStartupAttempts: 1 },
        )
        expect(await outcome(client.connect())).toMatchObject({
            error: { _tag: "ConnectionError", reason: "protocol", details: { dispatch: "RESUMED" } },
        })
        expect(client.state).toBe("Disconnected")
        expect(server.sockets).toHaveLength(1)
        // A later session's events arrive alone, so the rejected RESUMED never reached handlers
        answerWithReady = true
        await settle(client.connect())
        server.dispatch("TYPING_START", typing(2))
        await vi.waitFor(() => expect(raw).toEqual(["READY 1", "TYPING_START 2"]))
    })

    test("fails startup without delivery when a dispatch arrives before READY", async () => {
        let answerWithReady = false
        const { server, client, raw, typed } = await start(
            mode,
            { autoReady: () => answerWithReady },
            { maxStartupAttempts: 1 },
        )
        const connecting = outcome(client.connect())
        await vi.waitFor(() => expect(server.commandsWithOp(Opcode.identify)).toHaveLength(1))
        // READY follows in the same turn, so a rejected handshake must not complete afterwards
        deliver(
            { op: Opcode.dispatch, s: 1, t: "TYPING_START", d: typing(1) },
            { op: Opcode.dispatch, s: 2, t: "READY", d: { session_id: "fixture-session" } },
        )
        expect(await connecting).toMatchObject({
            error: { _tag: "ConnectionError", reason: "protocol", details: { dispatch: "TYPING_START" } },
        })
        expect(client.state).toBe("Disconnected")
        expect(server.sockets).toHaveLength(1)
        // A later session's events arrive alone, so neither frame of the rejected handshake reached handlers
        answerWithReady = true
        await settle(client.connect())
        server.dispatch("TYPING_START", typing(2))
        await vi.waitFor(() => expect(typed).toEqual([2]))
        await vi.waitFor(() => expect(raw).toEqual(["READY 1", "TYPING_START 2"]))
    })

    test("rejects a duplicate RESUMED without delivery and starts a new session", async () => {
        const clock = sdkClock()
        const { server, client, logs, raw } = await start(mode)
        await settle(client.connect())
        server.closeCurrent(4000)
        await clock.waiting(500)
        await clock.advance(500)
        await vi.waitFor(() => expect(client.state).toBe("Connected"))
        expect(server.commandsWithOp(Opcode.resume)).toHaveLength(1)
        server.deliverNow("RESUMED", {})
        expect(counters(client).protocolFailures).toBe(1)
        await clock.waiting(1_000)
        expect(client.state).toBe("Recovering")
        expect(logs.withCode("lifecycle.connectionLost").at(-1)).toMatchObject({
            fields: { reason: "protocol", next: "identify" },
        })
        await clock.advance(1_000)
        await vi.waitFor(() => expect(client.state).toBe("Connected"))
        expect(server.commandsWithOp(Opcode.resume)).toHaveLength(1)
        expect(server.commandsWithOp(Opcode.identify)).toHaveLength(2)
        await vi.waitFor(() => expect(raw).toEqual(["READY 1", "RESUMED 2", "READY 4"]))
    })

    test("keeps heartbeating across acknowledged cycles without starting recovery", async () => {
        const clock = sdkClock()
        const { server, client, logs } = await start(mode, { heartbeatIntervalMs: 1_000, heartbeatAck: false })
        await settle(client.connect())
        // Each acknowledgement takes a different logical round trip, so the latency shows that it was processed
        let roundTrip = 0
        for (let cycle = 1; cycle <= 4; cycle++) {
            await clock.waiting(1_000)
            await clock.advance(1_000 - roundTrip)
            expect(client.state).toBe("Connected")
            await vi.waitFor(() => expect(server.commandsWithOp(Opcode.heartbeat)).toHaveLength(cycle))
            roundTrip = cycle * 10
            await clock.advance(roundTrip)
            server.send({ op: Opcode.heartbeatAck })
            await vi.waitFor(() => expect(client.gatewayLatencyMs).toBe(roundTrip))
        }
        // The next interval sends another heartbeat rather than ending the session
        await clock.advance(1_000 - roundTrip)
        await vi.waitFor(() => expect(server.commandsWithOp(Opcode.heartbeat)).toHaveLength(5))
        expect(client.state).toBe("Connected")
        expect(server.sockets).toHaveLength(1)
        expect(logs.withCode("lifecycle.connectionLost")).toEqual([])
    })
})
