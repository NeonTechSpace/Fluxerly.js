import { afterEach, expect, test, vi } from "vitest"
import { WebSocket } from "ws"
import type { Client } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import type { SessionSnapshot, SessionStore } from "../../src/sharding.js"
import { Opcode } from "../../src/internal/protocol/gateway.js"
import { describeBothApis, setup, type Mode } from "../support/both-apis.js"
import { startGatewayServer, type GatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs } from "../support/log-capture.js"
import { sdkClock } from "../support/client-clock.js"
import { settle } from "../support/settle.js"
import { wsTarget } from "../support/ws-redirect.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type AnyClient = Client | NativeClient
// The hosted discovery fixture's gateway endpoint, which saved snapshots must match
const hostedGateway = "wss://gateway.fluxer.app/?v=1&encoding=json"

async function start(mode: Mode, sessions: SessionStore, totalShards = 1) {
    // Resume continues from the saved sequence, so RESUMED carries it rather than the fixture's own counter
    const server: GatewayServer = await startGatewayServer({
        autoReady: false,
        onCommand: (command, socket) => {
            // Several shards need distinct sessions, so each session ID names its shard, and READY echoes the shard
            if (command.op === Opcode.identify)
                server.dispatch(
                    "READY",
                    totalShards === 1
                        ? { session_id: "live-session" }
                        : { session_id: `live-session-${command.d.shard[0]}`, shard: command.d.shard },
                    socket,
                )
            if (command.op === Opcode.resume)
                server.send({ op: Opcode.dispatch, s: command.d.seq, t: "RESUMED", d: {} }, socket)
        },
    })
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const logs = captureLogs()
    const client = (await setup(mode, {
        logging: logs.logging,
        // A coordinator that grants every permit at once starts several shards without SDK Identify spacing
        sharding: { totalShards, sessions, ...(totalShards > 1 && { identify: { permit: async () => {} } }) },
    })) as AnyClient
    return { server, client, logs }
}

function store(snapshot?: unknown) {
    const saved: [number, SessionSnapshot, boolean][] = []
    const sessions: SessionStore = {
        load: vi.fn(async () => snapshot as SessionSnapshot | undefined),
        save: vi.fn(async (shardId: number, value: SessionSnapshot) => {
            // Record whether the shard's socket had closed when the snapshot was handed over
            saved.push([shardId, value, wsTarget.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)])
        }),
    }
    return { saved, sessions }
}

describeBothApis("sharding.sessions", (mode) => {
    test("saves each resumable session at shutdown after its socket closed", async () => {
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
        const { saved, sessions } = store()
        const { server, client } = await start(mode, sessions)
        await settle((client as Client).connect())
        expect(sessions.load).toHaveBeenCalledWith(0)
        const typed = settle((client as Client).waitFor("typingStart"))
        server.dispatch("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 })
        await typed
        await settle((client as Client).shutdown())
        expect(saved).toEqual([
            [
                0,
                {
                    sessionId: "live-session",
                    sequence: 2,
                    resumeUrl: hostedGateway,
                    savedAt: 1_700_000_000_000,
                    totalShards: 1,
                },
                true,
            ],
        ])
        expect(Object.isFrozen(saved[0]![1])).toBe(true)
    })

    test("saves only the shard that is Connected when shutdown begins, not one that is Recovering", async () => {
        // The clock is held, so the dropped shard stays in its recovery wait instead of resuming
        sdkClock()
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
        const { saved, sessions } = store()
        const { server, client } = await start(mode, sessions, 2)
        await settle((client as Client).connect())
        const identifies = server.commandsWithOp(Opcode.identify)
        expect(identifies.map((command) => command.d.shard[0]).sort()).toEqual([0, 1])
        // Shard 0 drops with a reconnectable close while shard 1 stays live. Saving "the first shard" or "every shard
        // with a session" would then differ from saving only the live one
        server.sockets[identifies.find((command) => command.d.shard[0] === 0)!.connection]!.close(4000)
        await vi.waitFor(() =>
            expect((client as Client).shards.map(({ shardId, state }) => [shardId, state])).toEqual([
                [0, "Recovering"],
                [1, "Connected"],
            ]),
        )
        await settle((client as Client).shutdown())
        // The Recovering shard's session may already have expired, and the live one is saved after its socket closed
        expect(sessions.save).toHaveBeenCalledTimes(1)
        expect(saved).toEqual([
            [
                1,
                expect.objectContaining({ sessionId: "live-session-1", resumeUrl: hostedGateway, totalShards: 2 }),
                true,
            ],
        ])
    })

    test("starts a new session when the store's load never settles, once the load deadline passes", async () => {
        const clock = sdkClock()
        const sessions: SessionStore = {
            load: vi.fn(() => new Promise<SessionSnapshot | undefined>(() => {})),
            save: vi.fn(async () => {}),
        }
        const { server, client, logs } = await start(mode, sessions)
        const connecting = settle((client as Client).connect())
        // Observe a startup rejection even when an assertion fails first and cleanup interrupts it
        void connecting.catch(() => {})
        await vi.waitFor(() => expect(sessions.load).toHaveBeenCalledWith(0))
        // The store has not answered and the SDK is waiting on its load deadline, so the shard holds its handshake
        await clock.waiting(5_000)
        expect(server.commands.filter((command) => command.op !== Opcode.heartbeat)).toEqual([])
        expect(logs.withCode("lifecycle.sessionLoadFailed")).toEqual([])
        await clock.advance(5_000)
        await vi.waitFor(() => expect(server.commandsWithOp(Opcode.identify)).toHaveLength(1))
        await connecting
        expect(server.commandsWithOp(Opcode.resume)).toEqual([])
        expect(logs.withCode("lifecycle.sessionLoadFailed")).toEqual([
            expect.objectContaining({ level: "error", error: expect.objectContaining({ origin: "application" }) }),
        ])
    })

    test("completes shutdown when the store's save never settles, once the save deadline passes", async () => {
        const clock = sdkClock()
        const sessions: SessionStore = {
            load: async () => undefined,
            save: vi.fn(() => new Promise<void>(() => {})),
        }
        const { client, logs } = await start(mode, sessions)
        await settle((client as Client).connect())
        let closed = false
        const closing = settle((client as Client).shutdown()).then(() => {
            closed = true
        })
        await vi.waitFor(() => expect(sessions.save).toHaveBeenCalledTimes(1))
        // Shutdown waits for the save, and only the save deadline ends that wait
        await clock.waiting(5_000)
        expect(closed).toBe(false)
        expect(logs.withCode("lifecycle.sessionSaveFailed")).toEqual([])
        await clock.advance(5_000)
        await closing
        expect((client as Client).state).toBe("Closed")
        expect(sessions.save).toHaveBeenCalledTimes(1)
        expect(logs.withCode("lifecycle.sessionSaveFailed")).toEqual([
            expect.objectContaining({ level: "error", error: expect.objectContaining({ origin: "application" }) }),
        ])
    })

    test("resumes a snapshot saved within the 60-second window", async () => {
        const now = 1_700_000_000_000
        vi.spyOn(Date, "now").mockReturnValue(now)
        const savedAt = now - 59_999
        const { sessions } = store({
            sessionId: "saved-session",
            sequence: 41,
            resumeUrl: hostedGateway,
            savedAt,
            totalShards: 1,
        })
        const { server, client, logs } = await start(mode, sessions)
        await settle((client as Client).connect())
        expect(
            server.commands.filter((command) => command.op !== Opcode.heartbeat).map((command) => command.op),
        ).toEqual([Opcode.resume])
        expect(server.commandsWithOp(Opcode.resume)[0]!.d).toMatchObject({ session_id: "saved-session", seq: 41 })
        expect(logs.withCode("lifecycle.sessionRestored")).toHaveLength(1)
    })

    test.each([
        { name: "at the 60-second expiry boundary", snapshot: (now: number) => ({ savedAt: now - 60_000 }) },
        { name: "for another gateway endpoint", snapshot: () => ({ resumeUrl: "wss://elsewhere.example/?v=1" }) },
        { name: "for another shard plan", snapshot: () => ({ totalShards: 2 }) },
        { name: "malformed", snapshot: () => ({ sequence: -1 }) },
    ])("ignores a snapshot $name and starts a new session", async ({ snapshot }) => {
        const now = 1_700_000_000_000
        vi.spyOn(Date, "now").mockReturnValue(now)
        const { sessions } = store({
            sessionId: "saved-session",
            sequence: 41,
            resumeUrl: hostedGateway,
            savedAt: now,
            totalShards: 1,
            ...snapshot(now),
        })
        const { server, client, logs } = await start(mode, sessions)
        await settle((client as Client).connect())
        expect(server.commandsWithOp(Opcode.resume)).toEqual([])
        expect(server.commandsWithOp(Opcode.identify)).toHaveLength(1)
        expect(logs.withCode("lifecycle.sessionSnapshotIgnored")).toEqual([expect.objectContaining({ level: "warn" })])
    })

    test("logs store failures in full without failing startup or shutdown", async () => {
        const failure = new Error("Store offline")
        const sessions: SessionStore = {
            load: () => Promise.reject(failure),
            save: () => Promise.reject(failure),
        }
        const { server, client, logs } = await start(mode, sessions)
        await settle((client as Client).connect())
        expect(server.commandsWithOp(Opcode.identify)).toHaveLength(1)
        await settle((client as Client).shutdown())
        for (const code of ["lifecycle.sessionLoadFailed", "lifecycle.sessionSaveFailed"])
            expect(logs.withCode(code)).toEqual([
                expect.objectContaining({
                    level: "error",
                    error: expect.objectContaining({ origin: "application", message: "Store offline" }),
                }),
            ])
    })
})
