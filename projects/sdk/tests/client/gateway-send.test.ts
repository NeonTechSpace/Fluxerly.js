import { Clock, Effect, Exit, Fiber, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ClientClosedError, GatewaySendError, type Client } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { nowMs } from "../../src/internal/clock.js"
import { commandPacer, gatewayCommands, maxPendingApplicationCommands } from "../../src/internal/gateway/commands.js"
import { Opcode } from "../../src/internal/protocol/gateway.js"
import { describeBothApis, setup } from "../support/both-apis.js"
import { runWithTestClock } from "../support/clock.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs } from "../support/log-capture.js"
import { expectErr, settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => vi.unstubAllGlobals())

type AnyClient = Client | NativeClient

function send(client: AnyClient, shardId: number, op: number, d: unknown) {
    return (client as Client).gateway.send(shardId, op, d)
}

async function connected(mode: "default" | "native", options: Parameters<typeof setup>[1] = {}) {
    const server = await startGatewayServer()
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const client = (await setup(mode, options)) as AnyClient
    await settle((client as Client).connect())
    return { server, client }
}

describeBothApis("gateway.send", (mode) => {
    test("hands the exact frame to the connection and logs it at Debug", async () => {
        const logs = captureLogs()
        const { server, client } = await connected(mode, { logging: { ...logs.logging, level: "debug" } })
        const data = { guild_ids: ["40"], nonce: "counts-1" }
        const sending = settle(send(client, 0, Opcode.requestGuildCounts, data))
        // The operation copies the data when it starts, so later changes cannot alter the frame
        data.nonce = "changed"
        await sending
        await vi.waitFor(() =>
            expect(server.commandsWithOp(Opcode.requestGuildCounts).map((command) => command.d)).toEqual([
                { guild_ids: ["40"], nonce: "counts-1" },
            ]),
        )
        expect(logs.withCode("gateway.commandSent")).toEqual([
            expect.objectContaining({ level: "debug", shardId: 0, fields: { opcode: Opcode.requestGuildCounts } }),
        ])
    })

    test("rejects session-control and server-only opcodes as reserved without sending", async () => {
        const { server, client } = await connected(mode)
        const before = server.commands.length
        for (const op of [
            Opcode.heartbeat,
            Opcode.identify,
            Opcode.resume,
            Opcode.dispatch,
            Opcode.reconnect,
            Opcode.invalidSession,
            Opcode.hello,
            Opcode.heartbeatAck,
        ]) {
            const error = await expectErr(send(client, 0, op, null))
            expect(error).toBeInstanceOf(GatewaySendError)
            expect(error).toMatchObject({ reason: "reserved", shardId: 0, opcode: op, code: "gateway.send.reserved" })
        }
        expect(server.commands.slice(before).filter((command) => command.op !== Opcode.heartbeat)).toEqual([])
    })

    test.each([
        { name: "a fractional shard ID", shardId: 0.5, op: 15, d: null, path: "shardId" },
        { name: "a negative opcode", shardId: 0, op: -1, d: null, path: "op" },
        { name: "undefined data", shardId: 0, op: 15, d: undefined, path: "d" },
        { name: "data JSON cannot encode", shardId: 0, op: 15, d: { count: 1n }, path: "d" },
        { name: "a frame above 4,096 bytes", shardId: 0, op: 15, d: "x".repeat(4_081), path: "d" },
    ])("rejects $name as input", async ({ shardId, op, d, path }) => {
        const { client } = await connected(mode)
        const error = await expectErr(send(client, shardId, op, d))
        expect(error).toMatchObject({ reason: "input", inputValidation: expect.objectContaining({ path }) })
        expect(Object.isFrozen((error as GatewaySendError).details)).toBe(true)
    })

    test("accepts a frame of exactly 4,096 bytes", async () => {
        const { server, client } = await connected(mode)
        const overhead = Buffer.byteLength(JSON.stringify({ op: 15, d: "" }))
        await settle(send(client, 0, 15, "x".repeat(4_096 - overhead)))
        await vi.waitFor(() => expect(server.commandsWithOp(15)).toHaveLength(1))
    })

    test("rejects shards this client does not own, and shards that are not connected", async () => {
        stubFetchWithHostedDiscovery(async () => Response.json({}))
        const client = (await setup(mode, { sharding: { totalShards: 2, shardIds: [1] } })) as AnyClient
        expect(await expectErr(send(client, 0, 15, null))).toMatchObject({ reason: "notOwned", shardId: 0 })
        expect(await expectErr(send(client, 1, 15, null))).toMatchObject({ reason: "notReady", shardId: 1 })
    })

    test("fails with ClientClosedError after shutdown", async () => {
        const { client } = await connected(mode)
        await settle((client as Client).shutdown())
        expect(await expectErr(send(client, 0, 15, null))).toBeInstanceOf(ClientClosedError)
    })
})

describe("outbound command pacing", () => {
    const window = 1_000
    function pacerFixture(clock: Clock.Clock, budget = 2) {
        const sent: [number, unknown][] = []
        let open = true
        const pacer = commandPacer({
            send: (op, d) => {
                if (!open) return false
                sent.push([op, d])
                return true
            },
            now: () => nowMs(clock),
            logger: undefined,
            shardId: 0,
            budget,
            windowMs: window,
        })
        return { sent, pacer, disconnect: () => (open = false) }
    }

    test("keeps paced commands inside the rolling budget in submission order while control is never delayed", () =>
        runWithTestClock(
            Effect.gen(function* () {
                const clock = yield* Clock.Clock
                const { sent, pacer } = pacerFixture(clock)
                const commands = gatewayCommands(
                    (op, d) => {
                        sent.push([op, d])
                        return true
                    },
                    pacer.send,
                    {
                        token: Redacted.make("fixture-only-not-a-credential"),
                        session: { id: "session", sequence: 5 },
                        resuming: true,
                        shard: undefined,
                    },
                )
                yield* Effect.forkChild(pacer.run)
                commands.guildCounts(["1"], "a")
                yield* TestClock.adjust(400)
                commands.guildCounts(["2"], "b")
                commands.guildCounts(["3"], "c")
                const submitted = yield* Effect.forkChild(pacer.submit(20, { value: 1 }))
                commands.authenticate()
                yield* Effect.yieldNow
                expect(sent.map(([op]) => op)).toEqual([15, 15, Opcode.resume])
                // The first window slot frees 1,000 ms after the first send, the second 400 ms later
                yield* TestClock.adjust(599)
                expect(sent).toHaveLength(3)
                yield* TestClock.adjust(1)
                expect(sent.map(([, d]) => d)).toEqual([
                    { guild_ids: ["1"], nonce: "a" },
                    { guild_ids: ["2"], nonce: "b" },
                    expect.objectContaining({ session_id: "session", seq: 5 }),
                    { guild_ids: ["3"], nonce: "c" },
                ])
                yield* TestClock.adjust(400)
                expect(sent.at(-1)).toEqual([20, { value: 1 }])
                expect(Exit.isSuccess(yield* Fiber.await(submitted))).toBe(true)
            }),
        ))

    test("withdraws an interrupted submission and fails waiting ones when the connection closes", () =>
        runWithTestClock(
            Effect.gen(function* () {
                const clock = yield* Clock.Clock
                const { sent, pacer } = pacerFixture(clock, 1)
                yield* Effect.forkChild(pacer.run)
                pacer.send(3, "first")
                const withdrawn = yield* Effect.forkChild(pacer.submit(20, "withdrawn"))
                const waiting = yield* Effect.forkChild(pacer.submit(20, "waiting"))
                yield* Effect.yieldNow
                yield* Fiber.interrupt(withdrawn)
                yield* TestClock.adjust(window)
                expect(sent).toEqual([
                    [3, "first"],
                    [20, "waiting"],
                ])
                expect(Exit.isSuccess(yield* Fiber.await(waiting))).toBe(true)
                const stranded = yield* Effect.forkChild(pacer.submit(20, "stranded"))
                yield* Effect.yieldNow
                pacer.close()
                expect(yield* Effect.flip(Fiber.join(stranded))).toBe("closed")
                expect(yield* Effect.flip(pacer.submit(20, "late"))).toBe("closed")
            }),
        ))

    test("fails a submission as busy when the shard already holds the most waiting commands", () =>
        runWithTestClock(
            Effect.gen(function* () {
                const clock = yield* Clock.Clock
                const { pacer } = pacerFixture(clock, 1)
                pacer.send(3, "fills the budget")
                for (let index = 0; index < maxPendingApplicationCommands; index++)
                    yield* Effect.forkChild(pacer.submit(20, index))
                yield* Effect.yieldNow
                expect(yield* Effect.flip(pacer.submit(20, "one more"))).toBe("busy")
                pacer.close()
            }),
        ))

    test("paces at the documented 500 commands per window, leaving 100 of Fluxer's 600 for control", () =>
        runWithTestClock(
            Effect.gen(function* () {
                const clock = yield* Clock.Clock
                const sent: unknown[] = []
                // The production defaults: No budget or window override
                const pacer = commandPacer({
                    send: (_op, d) => {
                        sent.push(d)
                        return true
                    },
                    now: () => nowMs(clock),
                    logger: undefined,
                    shardId: 0,
                })
                yield* Effect.forkChild(pacer.run)
                for (let index = 0; index <= 500; index++) pacer.send(15, index)
                yield* Effect.yieldNow
                expect(sent).toHaveLength(500)
                yield* TestClock.adjust(59_999)
                expect(sent).toHaveLength(500)
                yield* TestClock.adjust(1)
                expect(sent).toHaveLength(501)
                expect(sent.at(-1)).toBe(500)
                pacer.close()
            }),
        ))
})
