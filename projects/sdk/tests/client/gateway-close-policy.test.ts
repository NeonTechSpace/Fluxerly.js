import { afterEach, expect, test, vi } from "vitest"
import type { Client, SessionSnapshot, SessionStore } from "../../src/index.js"
import { Opcode, resumePreservingCloseCode } from "../../src/internal/protocol/gateway.js"
import { modes, setup } from "../support/both-apis.js"
import { sdkClock } from "../support/client-clock.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

for (const mode of modes) {
    test(`${mode} heartbeat timeout preserves the session and replays withheld dispatches on Resume`, async () => {
        const clock = sdkClock()
        const server = await startGatewayServer({
            heartbeatIntervalMs: 1000,
            heartbeatAck: false,
            enforceClientClosePolicy: true,
        })
        stubFetchWithHostedDiscovery(async () => Response.json({}))
        const client = (await setup(mode)) as Client
        await settle(client.connect())
        const replay = settle(client.waitFor("typingStart"))
        server.withholdDispatch("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 })
        await clock.waiting(1000)
        await clock.advance(1000)
        await vi.waitFor(() => expect(server.commandsWithOp(Opcode.heartbeat)).toHaveLength(1), { interval: 5 })
        await clock.waiting(1000)
        await clock.advance(1000)
        await clock.waiting(500)
        expect(server.clientCloses).toEqual([{ connection: 0, code: resumePreservingCloseCode }])
        await clock.advance(500)
        expect(await replay).toMatchObject({ channelId: "20", userId: "30" })
        await vi.waitFor(() => expect(client.state).toBe("Connected"), { interval: 5 })
        expect(server.commandsWithOp(Opcode.resume)).toHaveLength(1)
        expect(server.commandsWithOp(Opcode.identify)).toHaveLength(1)
        await settle(client.shutdown())
        expect(server.clientCloses).toEqual([
            { connection: 0, code: resumePreservingCloseCode },
            { connection: 1, code: 1000 },
        ])
    })

    test(`${mode} a gateway reconnect request preserves the session for Resume`, async () => {
        const clock = sdkClock()
        const server = await startGatewayServer({ enforceClientClosePolicy: true })
        stubFetchWithHostedDiscovery(async () => Response.json({}))
        const client = (await setup(mode)) as Client
        await settle(client.connect())
        server.send({ op: Opcode.reconnect })
        await clock.waiting(500)
        expect(server.clientCloses).toEqual([{ connection: 0, code: resumePreservingCloseCode }])
        await clock.advance(500)
        await vi.waitFor(() => expect(client.state).toBe("Connected"), { interval: 5 })
        expect(server.commandsWithOp(Opcode.resume)).toHaveLength(1)
        expect(server.commandsWithOp(Opcode.identify)).toHaveLength(1)
        await settle(client.shutdown())
    })

    test(`${mode} shutdown with a SessionStore lets a new client Resume within retention`, async () => {
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
        const server = await startGatewayServer({ enforceClientClosePolicy: true })
        stubFetchWithHostedDiscovery(async () => Response.json({}))
        let snapshot: SessionSnapshot | undefined
        const sessions: SessionStore = {
            load: async () => snapshot,
            save: async (_shardId, saved) => {
                snapshot = saved
            },
        }
        const first = (await setup(mode, { sharding: { totalShards: 1, sessions } })) as Client
        await settle(first.connect())
        await settle(first.shutdown())
        expect(snapshot).toBeDefined()
        expect(server.clientCloses).toEqual([{ connection: 0, code: resumePreservingCloseCode }])
        const second = (await setup(mode, { sharding: { totalShards: 1, sessions } })) as Client
        const resumed = settle(second.waitFor("raw", { filter: (event) => event.t === "RESUMED" }))
        await settle(second.connect())
        expect((await resumed).t).toBe("RESUMED")
        expect(server.commandsWithOp(Opcode.resume)).toHaveLength(1)
        expect(server.commandsWithOp(Opcode.identify)).toHaveLength(1)
        await settle(second.shutdown())
    })
}
