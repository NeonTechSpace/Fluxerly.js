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

async function start(mode: Mode, sessions: SessionStore) {
    // Resume continues from the saved sequence, so RESUMED carries it rather than the fixture's own counter
    const server: GatewayServer = await startGatewayServer({
        autoReady: false,
        onCommand: (command, socket) => {
            if (command.op === Opcode.identify) server.dispatch("READY", { session_id: "live-session" }, socket)
            if (command.op === Opcode.resume)
                server.send({ op: Opcode.dispatch, s: command.d.seq, t: "RESUMED", d: {} }, socket)
        },
    })
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const logs = captureLogs()
    const client = (await setup(mode, {
        logging: logs.logging,
        sharding: { totalShards: 1, sessions },
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

    test("resumes a snapshot saved within the 60-second window", async () => {
        const savedAt = Date.now() - 59_000
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
        { name: "older than 60 seconds", snapshot: (now: number) => ({ savedAt: now - 60_000 }) },
        { name: "for another gateway endpoint", snapshot: () => ({ resumeUrl: "wss://elsewhere.example/?v=1" }) },
        { name: "for another shard plan", snapshot: () => ({ totalShards: 2 }) },
        { name: "malformed", snapshot: () => ({ sequence: -1 }) },
    ])("ignores a snapshot $name and starts a new session", async ({ snapshot }) => {
        const now = Date.now()
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
