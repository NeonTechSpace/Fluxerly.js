import { afterEach, expect, test, vi } from "vitest"
import { ConnectionError, type Client } from "../../src/index.js"
import type { IdentifyCoordinator } from "../../src/sharding.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { Opcode } from "../../src/internal/protocol/gateway.js"
import { describeBothApis, setup, type FixtureClientOptions, type Mode } from "../support/both-apis.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs } from "../support/log-capture.js"
import { expectErr, settle } from "../support/settle.js"
import { sdkClock } from "../support/client-clock.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type AnyClient = Client | NativeClient

interface Request {
    readonly shardId: number
    readonly totalShards: number
    readonly signal: AbortSignal
    readonly resolve: () => void
    readonly reject: (error: unknown) => void
}

/** An identify coordinator whose permits the test grants or refuses one at a time */
function coordinator() {
    const requests: Request[] = []
    const identify: IdentifyCoordinator = {
        permit: (shardId, totalShards, signal) =>
            new Promise<void>((resolve, reject) => requests.push({ shardId, totalShards, signal, resolve, reject })),
    }
    return { requests, identify }
}

async function start(mode: Mode, options: FixtureClientOptions) {
    const server = await startGatewayServer({
        ready: (identify) => (identify.d.shard ? { shard: identify.d.shard } : {}),
    })
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const client = (await setup(mode, options)) as AnyClient
    return { server, client }
}

describeBothApis("sharding.identify", (mode) => {
    test("sends each new-session Identify only after its permit, with no SDK spacing, and Resume without one", async () => {
        const clock = sdkClock()
        const { requests, identify } = coordinator()
        const { server, client } = await start(mode, { sharding: { totalShards: 2, identify } })
        const connecting = settle((client as Client).connect())
        await vi.waitFor(() => expect(requests).toHaveLength(1))
        const first = requests[0]!.shardId
        expect(requests[0]).toMatchObject({ totalShards: 2 })
        expect(server.commandsWithOp(Opcode.identify)).toEqual([])
        // One permit is outstanding at a time
        expect(requests).toHaveLength(1)
        requests[0]!.resolve()
        await vi.waitFor(() => expect(server.commandsWithOp(Opcode.identify)).toHaveLength(1))
        // The coordinator owns pacing, so the second shard asks at once, without the SDK's one-second spacing
        await vi.waitFor(() => expect(requests).toHaveLength(2), { interval: 5 })
        expect(requests[1]).toMatchObject({ shardId: 1 - first, totalShards: 2 })
        expect(server.commandsWithOp(Opcode.identify)).toHaveLength(1)
        requests[1]!.resolve()
        await connecting
        expect(server.commandsWithOp(Opcode.identify).map((command) => command.d.shard)).toEqual([
            [first, 2],
            [1 - first, 2],
        ])
        server.closeCurrent(4000)
        await clock.waiting(500)
        await clock.advance(500)
        await vi.waitFor(() => expect(server.commandsWithOp(Opcode.resume)).toHaveLength(1), { interval: 5 })
        expect(requests).toHaveLength(2)
    })

    test("logs a refused permit in full and retries the attempt", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0)
        const logs = captureLogs()
        const { requests, identify } = coordinator()
        const { server, client } = await start(mode, { logging: logs.logging, sharding: { totalShards: 1, identify } })
        const connecting = settle((client as Client).connect())
        await vi.waitFor(() => expect(requests).toHaveLength(1))
        const refusal = new Error("Lock service unavailable")
        requests[0]!.reject(refusal)
        await vi.waitFor(() => expect(requests).toHaveLength(2))
        expect(logs.withCode("lifecycle.identifyPermitFailed")).toEqual([
            expect.objectContaining({
                level: "error",
                shardId: 0,
                error: expect.objectContaining({ origin: "application", message: "Lock service unavailable" }),
            }),
        ])
        requests[1]!.resolve()
        await connecting
        // A total of one keeps the unsharded Identify format
        expect(server.commandsWithOp(Opcode.identify).map((command) => command.d.shard)).toEqual([undefined])
    })

    test("fails startup with the refusal as the cause once attempts run out", async () => {
        const { requests, identify } = coordinator()
        const { server, client } = await start(mode, {
            connection: { maxStartupAttempts: 1 },
            sharding: { totalShards: 1, identify },
        })
        const connecting = expectErr((client as Client).connect())
        await vi.waitFor(() => expect(requests).toHaveLength(1))
        const refusal = new Error("Refused")
        requests[0]!.reject(refusal)
        const error = await connecting
        expect(error).toBeInstanceOf(ConnectionError)
        expect((error as ConnectionError).cause).toBe(refusal)
        expect(server.commandsWithOp(Opcode.identify)).toEqual([])
    })

    test("aborts the signal of a pending permit when the client shuts down", async () => {
        const { requests, identify } = coordinator()
        const { client } = await start(mode, { sharding: { totalShards: 1, identify } })
        void settle((client as Client).connect()).catch(() => undefined)
        await vi.waitFor(() => expect(requests).toHaveLength(1))
        expect(requests[0]!.signal.aborted).toBe(false)
        await settle((client as Client).shutdown())
        expect(requests[0]!.signal.aborted).toBe(true)
    })
})
