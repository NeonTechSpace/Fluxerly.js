import { setImmediate as turn } from "node:timers/promises"
import { afterEach, expect, test, vi } from "vitest"
import type { Client } from "../../../src/index.js"
import type { Client as NativeClient } from "../../../src/effect.js"
import type { SessionStore } from "../../../src/sharding.js"
import { Opcode } from "../../../src/internal/protocol/gateway.js"
import { createFixtures } from "../../../src/internal/testing/fixtures.js"
import { describeBothApis, setup, type Mode } from "../../support/both-apis.js"
import { startGatewayServer, type GatewayServer } from "../../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { captureLogs } from "../../support/log-capture.js"
import { settle } from "../../support/settle.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type AnyClient = Client | NativeClient
// The hosted discovery fixture's gateway endpoint, which saved snapshots must match
const hostedGateway = "wss://gateway.fluxer.app/?v=1&encoding=json"

/** A session store holding one fresh snapshot for shard zero, or none */
function store(snapshot: boolean): SessionStore {
    return {
        load: async () =>
            snapshot
                ? {
                      sessionId: "saved-session",
                      sequence: 41,
                      resumeUrl: hostedGateway,
                      savedAt: Date.now() - 1_000,
                      totalShards: 1,
                  }
                : undefined,
        save: async () => {},
    }
}

/** A bot in two communities whose REST reads the fake API answers. With failSecond, the second answers HTTP 403 */
function api(failSecond = false) {
    const fixtures = createFixtures()
    const guildIds = [fixtures.nextId(), fixtures.nextId()]
    const requests: string[] = []
    stubFetchWithHostedDiscovery(async (url) => {
        const path = new URL(url).pathname.replace(/^\/v1/u, "")
        requests.push(path)
        const guildId = path.split("/")[2]!
        if (failSecond && guildId === guildIds[1])
            return Response.json({ code: "MISSING_ACCESS", message: "Missing access" }, { status: 403 })
        if (path === "/users/@me/guilds")
            return Response.json(guildIds.map((id) => ({ id, name: "fixture", owner_id: "90", features: [] })))
        if (path === `/guilds/${guildId}`)
            return Response.json(fixtures.guild({ id: guildId, name: `Community ${guildId}` }))
        if (path === `/guilds/${guildId}/roles`)
            return Response.json([fixtures.role({ id: guildId, name: "@everyone", position: 0 })])
        if (path === `/guilds/${guildId}/channels`)
            return Response.json([fixtures.channel({ id: fixtures.nextId(), guild_id: guildId })])
        return Response.json({ code: "UNKNOWN", message: "Unknown" }, { status: 404 })
    })
    return { guildIds, requests }
}

async function start(mode: Mode, options: { readonly snapshot: boolean; readonly refillCaches?: boolean }) {
    const server: GatewayServer = await startGatewayServer({
        autoReady: false,
        onCommand: (command, socket) => {
            if (command.op === Opcode.identify) server.dispatch("READY", { session_id: "live-session" }, socket)
            if (command.op === Opcode.resume)
                server.send({ op: Opcode.dispatch, s: command.d.seq, t: "RESUMED", d: {} }, socket)
        },
    })
    const logs = captureLogs()
    const client = (await setup(mode, {
        logging: logs.logging,
        cache: { guilds: true, roles: true, channels: true },
        sharding: {
            totalShards: 1,
            sessions: store(options.snapshot),
            ...(options.refillCaches === undefined ? {} : { refillCaches: options.refillCaches }),
        },
    })) as AnyClient
    return { server, client, logs }
}

describeBothApis("cache refill after a restored session", (mode) => {
    test("refills the community, role and channel caches of a shard that resumed a saved session", async () => {
        const { guildIds, requests } = api()
        const { client, logs } = await start(mode, { snapshot: true })
        await settle((client as Client).connect())
        await vi.waitFor(() => expect(logs.withCode("lifecycle.cacheRefill")).toHaveLength(1))
        expect(logs.withCode("lifecycle.cacheRefill")[0]).toMatchObject({
            level: "info",
            fields: { guilds: 2, refilled: 2, failed: 0, shards: 1 },
        })
        for (const guildId of guildIds) {
            expect(requests).toEqual(
                expect.arrayContaining([
                    `/guilds/${guildId}`,
                    `/guilds/${guildId}/roles`,
                    `/guilds/${guildId}/channels`,
                ]),
            )
            expect(await settle((client as Client).guilds.get(guildId))).toMatchObject({ name: `Community ${guildId}` })
            expect(await settle((client as Client).roles.get({ guildId, id: guildId }))).toMatchObject({
                name: "@everyone",
            })
        }
        expect(client.diagnostics().caches.channels.retainedEntries).toBe(2)
    })

    test("reports the communities it could not refill at Warn and keeps the others", async () => {
        const { guildIds } = api(true)
        const { client, logs } = await start(mode, { snapshot: true })
        await settle((client as Client).connect())
        await vi.waitFor(() => expect(logs.withCode("lifecycle.cacheRefill")).toHaveLength(1))
        expect(logs.withCode("lifecycle.cacheRefill")[0]).toMatchObject({
            level: "warn",
            fields: { guilds: 2, refilled: 1, failed: 1 },
            error: expect.objectContaining({ details: expect.objectContaining({ status: 403 }) }),
        })
        expect(await settle((client as Client).guilds.get(guildIds[0]!))).toBeDefined()
        expect(await settle((client as Client).guilds.get(guildIds[1]!))).toBeUndefined()
    })

    test("stops with a Warn when the community list repeats a full page, instead of paging forever", async () => {
        const fixtures = createFixtures()
        // A full page of 200 communities, returned again whatever cursor the SDK sends
        const page = Array.from({ length: 200 }, () => ({
            id: fixtures.nextId(),
            name: "fixture",
            owner_id: "90",
            features: [],
        }))
        const listRequests: string[] = []
        const requests: string[] = []
        stubFetchWithHostedDiscovery(async (url) => {
            const path = new URL(url).pathname.replace(/^\/v1/u, "")
            requests.push(path)
            if (path !== "/users/@me/guilds")
                return Response.json({ code: "UNKNOWN", message: "Unknown" }, { status: 404 })
            listRequests.push(url)
            // Bounds an SDK that keeps paging, so the test fails on the request count rather than hanging
            if (listRequests.length > 2)
                return Response.json({ code: "MISSING_ACCESS", message: "Missing access" }, { status: 403 })
            return Response.json(page)
        })
        const { client, logs } = await start(mode, { snapshot: true })
        await settle((client as Client).connect())
        await vi.waitFor(() => expect(logs.withCode("lifecycle.cacheRefill")).toHaveLength(1))
        const [record] = logs.withCode("lifecycle.cacheRefill")
        expect(record).toMatchObject({ level: "warn", fields: { guilds: 200, refilled: 0, failed: 0 } })
        expect(record?.error).toBeUndefined()
        expect(listRequests).toHaveLength(2)
        expect(requests.filter((path) => path !== "/users/@me/guilds")).toEqual([])
    })

    test.each([
        { name: "a new session", snapshot: false, refillCaches: undefined },
        { name: "refillCaches set to false", snapshot: true, refillCaches: false },
    ])("sends no refill request after $name", async ({ snapshot, refillCaches }) => {
        const { requests } = api()
        const { client, logs } = await start(mode, {
            snapshot,
            ...(refillCaches === undefined ? {} : { refillCaches }),
        })
        await settle((client as Client).connect())
        expect(client.state).toBe("Connected")
        // A refill sends its first request within a few event loop turns of connecting, as the first test shows
        for (let index = 0; index < 20; index++) await turn()
        await settle((client as Client).shutdown())
        expect(requests).toEqual([])
        expect(logs.withCode("lifecycle.cacheRefill")).toEqual([])
    })
})
