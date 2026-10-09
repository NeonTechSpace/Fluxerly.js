import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { ConnectionError, ShardConnectionError, type Client, type ShardingOptions } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient, type TestClientOptions } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { Opcode } from "../../../src/internal/protocol/gateway.js"
import { describeBothApis, setup, type Mode } from "../../support/both-apis.js"
import { sdkClock } from "../../support/client-clock.js"
import { startGatewayServer } from "../../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { captureLogs } from "../../support/log-capture.js"
import { settle } from "../../support/settle.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

/** A community ID that Fluxer routes to shard 0 under one shard and to shard 1 under two */
const movingGuildId = String(1n << 22n)

/**
 * One in-memory test client in either API style, with a guild list whose length the test can change between counts.
 * Guild IDs count up from 1, so every listed community routes to shard 0
 */
async function open(mode: Mode, options: TestClientOptions) {
    let guilds = 1
    const setGuilds = (count: number) => {
        guilds = count
    }
    const respond = (request: { readonly query: Readonly<Record<string, string>> }) => {
        const after = Number(request.query.after ?? 0)
        const limit = Number(request.query.limit)
        const ids = Array.from(
            { length: Math.max(0, Math.min(limit, guilds - after)) },
            (_, index) => after + index + 1,
        )
        return { body: ids.map((id) => ({ id: String(id), name: "fixture", owner_id: "90", features: [] })) }
    }
    if (mode === "default") {
        const test = createDefaultTestClient(options)
        onTestFinished(() => test.shutdown())
        test.rest.respond("GET /users/@me/guilds", respond)
        return {
            test,
            client: test.client,
            setGuilds,
            ready: () => test.ready(),
            emit: (type: string, payload: unknown) => test.emit(type, payload),
            disconnect: async (shardId: number, code: number) => test.disconnect({ shardId, code }),
            closed: async () => {
                const closed = await test.client.waitForClose()
                return closed.isErr() ? closed.error : undefined
            },
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient(options as never).pipe(Scope.provide(scope)))
    test.rest.respond("GET /users/@me/guilds", respond)
    return {
        test,
        client: test.client,
        setGuilds,
        ready: () => Effect.runPromise(test.ready()),
        emit: (type: string, payload: unknown) => Effect.runSync(test.emit(type, payload)),
        disconnect: (shardId: number, code: number) => Effect.runPromise(test.disconnect({ shardId, code })),
        closed: () => Effect.runPromise(Effect.flip(test.client.waitForClose())).catch(() => undefined),
    }
}

type Driver = Awaited<ReturnType<typeof open>>

/** Wait until the client runs every shard of a totalShards plan, all connected */
async function connectedWith(driver: Driver, totalShards: number) {
    await vi.waitFor(
        () => {
            expect(driver.client.state).toBe("Connected")
            expect(driver.client.shards.map((shard) => [shard.shardId, shard.state])).toEqual(
                Array.from({ length: totalShards }, (_, shardId) => [shardId, "Connected"]),
            )
        },
        { interval: 5 },
    )
}

const logsWithCode = (driver: Driver, code: string) => driver.test.logs().filter((record) => record.code === code)

// An identify coordinator replaces the SDK's one-second spacing between shards, which keeps these tests fast
const coordinated: ShardingOptions = { totalShards: "auto", identify: { permit: async () => {} } }

describeBothApis("automatic resharding", (mode) => {
    test("moves every shard to the plan for the new guild count after a 4011 closure and keeps running", async () => {
        const driver = await open(mode, { sharding: "auto", cache: { guilds: true } })
        await driver.ready()
        expect(driver.client.shards.map((shard) => shard.shardId)).toEqual([0])
        driver.emit("GUILD_CREATE", driver.test.fixtures.guildCreate({ guild: { id: movingGuildId } }))
        expect(driver.client.diagnostics().caches.guilds.retainedEntries).toBe(1)
        expect(driver.client.shardIdForGuild(movingGuildId)).toBe(0)

        driver.setGuilds(2_001)
        await driver.disconnect(0, 4011)
        await connectedWith(driver, 2)

        expect(logsWithCode(driver, "lifecycle.resharded")).toEqual([
            expect.objectContaining({
                level: "warn",
                shardId: 0,
                fields: { guilds: 2_001, previousTotalShards: 1, totalShards: 2 },
            }),
        ])
        expect(logsWithCode(driver, "lifecycle.connectionEnded")).toEqual([])
        const identifies = driver.test.commands().filter((command) => command.op === 2)
        expect(identifies.slice(1).map((command) => (command.d as { shard?: unknown }).shard)).toEqual([
            [0, 2],
            [1, 2],
        ])
        // Guild-scoped entries from the old sessions are released, and routing follows the new total
        expect(driver.client.diagnostics().caches.guilds.retainedEntries).toBe(0)
        expect(driver.client.shardIdForGuild(movingGuildId)).toBe(1)
        driver.emit("GUILD_CREATE", driver.test.fixtures.guildCreate({ guild: { id: movingGuildId } }))
        expect(driver.client.diagnostics().caches.guilds.retainedEntries).toBe(1)
    })

    test("adds one shard when the new count still fits the old total, without offering saved sessions again", async () => {
        const load = vi.fn(async () => undefined)
        const driver = await open(mode, {
            sharding: { ...coordinated, sessions: { load, save: async () => {} } },
        })
        await driver.ready()
        await driver.disconnect(0, 4011)
        await connectedWith(driver, 2)
        expect(logsWithCode(driver, "lifecycle.resharded")[0]).toMatchObject({
            fields: { guilds: 1, previousTotalShards: 1, totalShards: 2 },
        })
        // A saved snapshot belongs to the plan it was saved under, so only the first plan loads one
        expect(load.mock.calls).toEqual([[0]])
    })

    test("ends the client like an explicit plan after three moves within an hour", async () => {
        const driver = await open(mode, { sharding: coordinated })
        await driver.ready()
        for (const totalShards of [2, 3, 4]) {
            await driver.disconnect(totalShards - 2, 4011)
            await connectedWith(driver, totalShards)
        }
        const closed = driver.closed()
        await driver.disconnect(3, 4011)
        const failure = await closed
        expect(failure).toBeInstanceOf(ShardConnectionError)
        expect((failure as ShardConnectionError).failure).toMatchObject({ status: 4011 })
        expect(logsWithCode(driver, "lifecycle.resharded")).toHaveLength(3)
        expect(logsWithCode(driver, "lifecycle.connectionEnded")).toEqual([
            expect.objectContaining({
                shardId: 3,
                message: expect.stringContaining("it already moved to a larger plan 3 times within an hour"),
            }),
        ])
    })

    test("shardIdForGuild answers only for local shards and rejects an invalid ID", async () => {
        const driver = await open(mode, { sharding: { totalShards: 4, shardIds: [1] } })
        expect(driver.client.shardIdForGuild(String(5n << 22n))).toBe(1)
        expect(driver.client.shardIdForGuild(String(6n << 22n))).toBeUndefined()
        expect(() => driver.client.shardIdForGuild("not-an-id")).toThrow(
            expect.objectContaining({ _tag: "ConfigurationError", field: "guildId" }),
        )
        const automatic = await open(mode, { sharding: "auto" })
        // The plan is unknown until the first connect counts the communities
        expect(automatic.client.shardIdForGuild("1")).toBeUndefined()
    })

    test("moves a client without sharding settings to automatic sharding when Fluxer refuses its session with 4011", async () => {
        const clock = sdkClock()
        // Fluxer checks a bot's community count when a session starts, so this gateway refuses the unsharded Identify
        const server = await startGatewayServer({
            autoReady: (command) => command.d.shard !== undefined,
            ready: (identify) => ({ shard: identify.d.shard }),
            onCommand: (command, socket) => {
                if (command.op === Opcode.identify && command.d.shard === undefined) socket.close(4011)
            },
        })
        const requests: string[] = []
        // An empty community list fits the old total, so the move adds one shard
        stubFetchWithHostedDiscovery(async (url) => {
            requests.push(new URL(url).pathname)
            return Response.json([])
        })
        const logs = captureLogs()
        const client = await setup(mode, { logging: logs.logging })
        const connecting = settle((client as Client).connect())
        // The SDK starts the new plan's shard sessions one second apart. A failed connect ends the wait at once
        await Promise.race([clock.waiting(1_000), connecting])
        await clock.advance(1_000)
        await connecting

        expect(client.shards.map((shard) => [shard.shardId, shard.state])).toEqual([
            [0, "Connected"],
            [1, "Connected"],
        ])
        // The new plan's handshakes may finish in either order
        const [refused, ...sharded] = server.commandsWithOp(Opcode.identify).map((command) => command.d.shard)
        expect(refused).toBeUndefined()
        expect(sharded.toSorted()).toEqual([
            [0, 2],
            [1, 2],
        ])
        expect(requests).toEqual(["/v1/users/@me/guilds"])
        expect(logs.withCode("lifecycle.resharded")).toEqual([
            expect.objectContaining({
                level: "warn",
                shardId: 0,
                fields: { guilds: 0, previousTotalShards: 1, totalShards: 2 },
            }),
        ])
        expect(logs.withCode("lifecycle.connectionEnded")).toEqual([])
    })

    test("keeps failing clearly with an explicit total", async () => {
        const driver = await open(mode, { sharding: { totalShards: 1 } })
        await driver.ready()
        const closed = driver.closed()
        await driver.disconnect(0, 4011)
        const failure = await closed
        expect(failure).toBeInstanceOf(ConnectionError)
        expect(failure).toMatchObject({ status: 4011 })
        expect(driver.test.requests()).toEqual([])
        expect(logsWithCode(driver, "lifecycle.resharded")).toEqual([])
        expect(logsWithCode(driver, "lifecycle.connectionEnded")).toHaveLength(1)
    })
})
