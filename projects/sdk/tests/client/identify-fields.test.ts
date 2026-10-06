import { Effect, Exit, Scope } from "effect"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { ConfigurationError, type Client, type EventName } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { validateConfiguration } from "../../src/internal/configuration.js"
import { EventBus } from "../../src/internal/events.js"
import { eventDispatchTypes, type MappedEvent } from "../../src/internal/gateway/event-dispatches.js"
import { Opcode } from "../../src/internal/protocol/gateway.js"
import { describeBothApis, setup, type FixtureClientOptions } from "../support/both-apis.js"
import { sdkClock } from "../support/client-clock.js"
import { startGatewayServer, type GatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs } from "../support/log-capture.js"
import { settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type AnyClient = Client | NativeClient
const token = "fixture-only-not-a-credential"

async function start(options: FixtureClientOptions, mode: "default" | "native", before?: (client: Client) => void) {
    const server = await startGatewayServer()
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const client = (await setup(mode, { connection: { recovery: { minDelayMs: 100 } }, ...options })) as AnyClient
    before?.(client as Client)
    await settle((client as Client).connect())
    return { server, client }
}

function identifies(server: GatewayServer): Record<string, unknown>[] {
    return server.commandsWithOp(Opcode.identify).map((command) => command.d as Record<string, unknown>)
}

/** End the current session so the next attempt sends a new Identify */
async function newSession(server: GatewayServer, count: number) {
    server.send({ op: Opcode.invalidSession, d: false }, server.sockets.at(-1))
    await vi.waitFor(() => expect(identifies(server)).toHaveLength(count))
}

function subscribe(mode: "default" | "native", client: AnyClient, event: EventName) {
    // A registered handler is enough to register interest for automatic filtering
    if (mode === "default") {
        ;(client as Client).on(event, () => {})
        return
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    Effect.runSync((client as NativeClient).on(event, () => Effect.void).pipe(Scope.provide(scope)))
}

describeBothApis("Identify fields", (mode) => {
    test("sends normalized ignored events, session flags and the initial presence, then publishes the presence", async () => {
        const { server } = await start(
            {
                gateway: {
                    ignoredEvents: ["typing_start", "TYPING_START", "PRESENCE_UPDATE"],
                    flags: { debounceMessageReactions: true },
                    presence: { status: "idle", customStatus: { text: "Busy" } },
                },
            },
            mode,
        )
        const presence = { status: "idle", afk: false, mobile: false, custom_status: { text: "Busy" } }
        expect(identifies(server)).toEqual([
            expect.objectContaining({ ignored_events: ["TYPING_START", "PRESENCE_UPDATE"], flags: 2, presence }),
        ])
        // Fluxer may prefer the saved account status to an Identify presence, so READY is followed by an update
        await vi.waitFor(() =>
            expect(server.commandsWithOp(Opcode.presenceUpdate).map((command) => command.d)).toEqual([presence]),
        )
    })

    test("omits every optional field by default", async () => {
        const { server } = await start({}, mode)
        const [identify] = identifies(server)
        expect(Object.keys(identify!).sort()).toEqual(["properties", "token"])
    })

    test("carries the latest presence.set intent in a later new session", async () => {
        const { server, client } = await start({ gateway: { presence: { status: "idle" } } }, mode)
        await settle((client as Client).presence.set({ status: "dnd" }))
        await newSession(server, 2)
        expect(identifies(server)[1]).toMatchObject({ presence: { status: "dnd" } })
    })

    test("warns when an explicit list suppresses every dispatch of a registered event", async () => {
        const logs = captureLogs()
        await start({ logging: logs.logging, gateway: { ignoredEvents: ["TYPING_START"] } }, mode, (client) =>
            subscribe(mode, client, "typingStart"),
        )
        expect(logs.withCode("gateway.ignoredEventRegistered")).toEqual([
            expect.objectContaining({ level: "warn", fields: { events: "typingStart" } }),
        ])
    })

    test("automatic filtering keeps registered events, SDK needs and cache categories, re-evaluated per session", async () => {
        const { server, client } = await start(
            { gateway: { ignoredEvents: "auto" }, cache: { channels: true } },
            mode,
            (client) => subscribe(mode, client, "messageCreate"),
        )
        const first = identifies(server)[0]!.ignored_events as string[]
        expect(first).toEqual(expect.arrayContaining(["TYPING_START", "PRESENCE_UPDATE", "MESSAGE_UPDATE"]))
        for (const kept of ["MESSAGE_CREATE", "GUILD_CREATE", "GUILD_DELETE", "CHANNEL_UPDATE", "CHANNEL_UPDATE_BULK"])
            expect(first).not.toContain(kept)
        // Reaction pages started by a command after connecting read clicks from these, with no registration at Identify
        for (const click of ["MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE"]) expect(first).not.toContain(click)
        for (const never of ["READY", "RESUMED", "GUILD_MEMBERS_CHUNK", "GUILD_COUNTS_UPDATE"])
            expect(first).not.toContain(never)
        // A registration made after the session started applies from the next new session
        subscribe(mode, client, "typingStart")
        await newSession(server, 2)
        expect(identifies(server)[1]!.ignored_events).not.toContain("TYPING_START")
        subscribe(mode, client, "raw")
        await newSession(server, 3)
        expect(identifies(server)[2]).not.toHaveProperty("ignored_events")
    })

    test("sends the configured token in Identify and Resume and reuses one discovery across recovery", async () => {
        const clock = sdkClock()
        const server = await startGatewayServer({ sessionId: "session-a" })
        const fetch = stubFetchWithHostedDiscovery(async (url) => {
            throw new Error(`Unexpected operation request ${url}`)
        })
        const client = (await setup(mode, { token })) as AnyClient
        await settle((client as Client).connect())

        server.closeCurrent(4000)
        await clock.waiting(500)
        await clock.advance(500)
        await vi.waitFor(() => expect(server.commandsWithOp(Opcode.resume)).toHaveLength(1), { interval: 5 })
        await vi.waitFor(() => expect(client.state).toBe("Connected"), { interval: 5 })

        expect(identifies(server).map((identify) => identify.token)).toEqual([token])
        expect(server.commandsWithOp(Opcode.resume).map((command) => command.d)).toEqual([
            { token, session_id: "session-a", seq: 1 },
        ])
        expect(fetch).toHaveBeenCalledOnce()
    })
})

describe("gateway option validation", () => {
    const rejected = (gateway: unknown, cache?: unknown) => {
        const exit = Effect.runSyncExit(validateConfiguration({ token, gateway, ...(cache ? { cache } : {}) }))
        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined
        expect(error?._tag === "Fail" && error.error).toBeInstanceOf(ConfigurationError)
        return error?._tag === "Fail" ? (error.error as ConfigurationError) : undefined
    }

    test.each([
        { name: "session control", gateway: { ignoredEvents: ["READY"] } },
        { name: "an SDK request reply", gateway: { ignoredEvents: ["guild_members_chunk"] } },
        { name: "more than 256 names", gateway: { ignoredEvents: Array.from({ length: 257 }, (_, i) => `E${i}`) } },
        { name: "a name with other characters", gateway: { ignoredEvents: ["MESSAGE-CREATE"] } },
        {
            name: "a list above 2,560 encoded bytes",
            gateway: { ignoredEvents: Array.from({ length: 50 }, (_, i) => `${"X".repeat(60)}${i}`) },
        },
        { name: "an unknown flag", gateway: { flags: { compress: true } } },
        { name: "a non-boolean flag", gateway: { flags: { debounceMessageReactions: 1 } } },
        { name: "an invalid presence", gateway: { presence: { status: "offline" } } },
        { name: "an unknown setting", gateway: { intents: 0 } },
    ])("rejects $name", ({ gateway }) => {
        expect(rejected(gateway)).toBeDefined()
    })

    test("rejects ignoring a dispatch an enabled cache category needs", () => {
        expect(rejected({ ignoredEvents: ["MESSAGE_DELETE"] }, { messages: true })?.field).toBe("ignoredEvents")
        expect(
            Exit.isSuccess(
                Effect.runSyncExit(validateConfiguration({ token, gateway: { ignoredEvents: ["MESSAGE_DELETE"] } })),
            ),
        ).toBe(true)
    })

    test("maps every public event except raw to the dispatch types that deliver it", async () => {
        // Type-level completeness: adding a public event without a mapping fails the test typecheck
        type Unmapped = Exclude<EventName, "raw" | MappedEvent>
        const complete: [Unmapped] extends [never] ? true : Unmapped = true
        expect(complete).toBe(true)
        // Runtime: every mapped name is an event the bus accepts, so a renamed event cannot hide in the map
        const bus = new EventBus()
        for (const event of Object.keys(eventDispatchTypes))
            expect(Exit.isSuccess(await Effect.runPromiseExit(bus.open(event as EventName))), event).toBe(true)
        bus.stop()
    })
})
