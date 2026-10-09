import { afterEach, expect, test, vi } from "vitest"
import { AuthenticationError, ConnectionError, type Client } from "../../../src/index.js"
import type { Client as NativeClient } from "../../../src/effect.js"
import { Opcode } from "../../../src/internal/protocol/gateway.js"
import { describeBothApis, setup, type Mode } from "../../support/both-apis.js"
import { sdkClock } from "../../support/client-clock.js"
import type { GatewayServerOptions } from "../../support/gateway-server.js"
import { startInstance } from "../../support/instance.js"
import { captureLogs } from "../../support/log-capture.js"
import { sendJson, type RecordedRequest } from "../../support/rest-server.js"
import { expectErr, settle } from "../../support/settle.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type AnyClient = Client | NativeClient

/** A bot that belongs to the given number of guilds, listed in ascending ID pages as Fluxer returns them */
function guildPages(count: number) {
    return (request: RecordedRequest, response: import("node:http").ServerResponse) => {
        const limit = Number(request.query.get("limit"))
        const after = Number(request.query.get("after") ?? 0)
        const ids = Array.from({ length: Math.max(0, Math.min(limit, count - after)) }, (_, index) => after + index + 1)
        sendJson(
            response,
            ids.map((id) => ({ id: String(id), name: "fixture", owner_id: "90", features: [] })),
        )
    }
}

async function start(
    mode: Mode,
    guilds: (request: RecordedRequest, response: import("node:http").ServerResponse) => void,
    gateway: Omit<GatewayServerOptions, "server" | "redirect"> = {},
) {
    const fixture = await startInstance({
        routes: { "GET /v1/users/@me/guilds": guilds },
        gateway: { ready: (identify) => (identify.d.shard ? { shard: identify.d.shard } : {}), ...gateway },
    })
    const logs = captureLogs()
    const client = (await setup(mode, {
        instance: { url: fixture.instance, allowInsecure: true },
        logging: logs.logging,
        sharding: "auto",
        connection: { startupTimeoutMs: 10_000 },
    })) as AnyClient
    return { ...fixture, client, logs }
}

describeBothApis("automatic sharding", (mode) => {
    test("sizes the plan from the guild count at 2,000 guilds per shard and owns every shard", async () => {
        const clock = sdkClock()
        const { rest, gateway, client, logs } = await start(mode, guildPages(2_001))
        expect(client.shards).toEqual([])
        const connecting = settle((client as Client).connect())
        // The SDK starts the second shard's session one second after the first
        await clock.waiting(1_000)
        await clock.advance(1_000)
        await connecting
        expect(client.shards.map((shard) => [shard.shardId, shard.state])).toEqual([
            [0, "Connected"],
            [1, "Connected"],
        ])
        expect(
            gateway
                .commandsWithOp(Opcode.identify)
                .map((command) => command.d.shard as number[])
                .sort(),
        ).toEqual([
            [0, 2],
            [1, 2],
        ])
        // Every page request walks forward from the previous page's last ID, and GET /gateway/bot is never read
        const pages = rest.requestsTo("GET /v1/users/@me/guilds")
        expect(pages.map((request) => request.query.get("after"))).toEqual([
            null,
            ...Array.from({ length: 10 }, (_, index) => String((index + 1) * 200)),
        ])
        expect(rest.requests.some((request) => request.path.endsWith("/gateway/bot"))).toBe(false)
        expect(logs.withCode("lifecycle.automaticSharding")).toEqual([
            expect.objectContaining({ fields: { guilds: 2_001, totalShards: 2, guildsPerShard: 2_000 } }),
        ])
    })

    test("uses one unsharded connection for a bot with few guilds", async () => {
        const { gateway, client } = await start(mode, guildPages(3))
        await settle((client as Client).connect())
        expect(client.shards.map((shard) => shard.shardId)).toEqual([0])
        expect(gateway.commandsWithOp(Opcode.identify)[0]!.d).not.toHaveProperty("shard")
    })

    test("gives the shards their full startup deadline after a slow guild count", async () => {
        const clock = sdkClock()
        const { gateway, client } = await start(
            mode,
            // The count uses 9 of its 10 seconds
            (request, response) => void clock.advance(9_000).then(() => guildPages(3)(request, response)),
            { autoReady: false },
        )
        const connecting = settle((client as Client).connect())
        await vi.waitFor(() => expect(gateway.commandsWithOp(Opcode.identify)).toHaveLength(1), { interval: 5 })
        // 11 seconds after connect began, the shard is still within its own 10 seconds
        await clock.advance(2_000)
        gateway.send({ op: Opcode.dispatch, s: 1, t: "READY", d: { session_id: "fixture-session" } })
        await connecting
        expect(client.state).toBe("Connected")
    })

    test("fails startup without a gateway connection when the guild count cannot be read", async () => {
        const { gateway, client } = await start(mode, (_request, response) =>
            sendJson(response, { code: "UNAUTHORIZED", message: "Unauthorized" }, 401),
        )
        expect(await expectErr((client as Client).connect())).toBeInstanceOf(AuthenticationError)
        expect(client.state).toBe("Disconnected")
        expect(client.shards).toEqual([])
        expect(gateway.sockets).toEqual([])
    })

    test("fails startup at once when the community list repeats a full page, instead of timing out", async () => {
        // A full page of 200 communities, returned again whatever cursor the SDK sends
        const page = Array.from({ length: 200 }, (_, index) => ({
            id: String(index + 1),
            name: "fixture",
            owner_id: "90",
            features: [],
        }))
        let listRequests = 0
        const { gateway, client } = await start(mode, (_request, response) => {
            listRequests += 1
            // Bounds an SDK that keeps paging, so the test fails on the request count rather than waiting for the deadline
            if (listRequests > 2) return sendJson(response, { code: "MISSING_ACCESS", message: "Missing access" }, 403)
            sendJson(response, page)
        })
        const failure = await expectErr((client as Client).connect())
        expect(failure).toBeInstanceOf(ConnectionError)
        expect(failure).toMatchObject({ phase: "discovery", reason: "protocol", status: null })
        expect(listRequests).toBe(2)
        expect(client.state).toBe("Disconnected")
        expect(gateway.sockets).toEqual([])
    })
})
