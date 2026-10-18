import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Client, GuildRole } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import type { EventContext } from "../../src/events.js"
import { Opcode } from "../../src/internal/protocol/gateway.js"
import { createFixtures } from "../../src/testing.js"
import { describeBothApis, setup, type Mode } from "../support/both-apis.js"
import { sdkClock, type SdkClock } from "../support/client-clock.js"
import { startGatewayServer, type GatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type AnyClient = Client | NativeClient
const fixtures = createFixtures()
const guildId = fixtures.ids.guild

const epochs = (client: AnyClient) => client.shards.map((shard) => shard.sessionEpoch)
const ids = (roles: readonly GuildRole[] | undefined) => roles?.map((role) => role.id)

/** Wake the shard's recovery wait, whose length the shard reports, once the SDK sleeps for it */
async function recover(client: AnyClient, clock: SdkClock) {
    const delay = await vi.waitFor(
        () => {
            const retryDelayMs = client.shards[0]?.recovery?.retryDelayMs
            expect(retryDelayMs).toEqual(expect.any(Number))
            return retryDelayMs!
        },
        { interval: 5 },
    )
    await vi.waitFor(() => expect([...clock.pending].some((item) => item.delay === delay)).toBe(true), {
        interval: 5,
    })
    await clock.advance(delay)
}

/** Send the community snapshot and wait until the client has applied it */
async function guildCreate(server: GatewayServer, roles: () => Promise<readonly GuildRole[] | undefined>) {
    server.dispatch("GUILD_CREATE", fixtures.guildCreate())
    await vi.waitFor(async () => expect(ids(await roles())).toEqual([guildId]), { interval: 5 })
}

/** Register a guildCreate handler in either API style that runs the given step with each event's community and context */
async function onGuildCreate(
    mode: Mode,
    client: AnyClient,
    step: (guildId: string, context: EventContext) => Promise<void>,
) {
    if (mode === "default") {
        ;(client as Client).on("guildCreate", (event, _signal, context) => step(event.id, context))
        return
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    await Effect.runPromise(
        (client as NativeClient)
            .on("guildCreate", (event, context) => Effect.promise(() => step(event.id, context)))
            .pipe(Scope.provide(scope)),
    )
}

describeBothApis("session epochs", (mode) => {
    test("a Resume keeps a shard's epoch and cached lists, while a new session changes it and releases them", async () => {
        const clock = sdkClock()
        const server = await startGatewayServer({ ready: () => ({ user: fixtures.botUser() }) })
        stubFetchWithHostedDiscovery(async () => Response.json({}))
        const client = (await setup(mode, { cache: { roles: true, members: true } })) as AnyClient
        // Settling runs a native lookup and passes a default lookup's value through
        const roles = () => settle((client as Client).roles.getAll(guildId))
        const self = () => settle((client as Client).members.getSelf(guildId))
        // No session has started yet
        expect(epochs(client)).toEqual([0])
        await settle((client as Client).connect())
        expect(epochs(client)).toEqual([1])
        await guildCreate(server, roles)
        expect(await self()).toMatchObject({ guildId, userId: fixtures.ids.bot })

        server.closeCurrent(4000)
        await recover(client, clock)
        await vi.waitFor(() => {
            expect(server.commandsWithOp(Opcode.resume)).toHaveLength(1)
            expect(client.state).toBe("Connected")
        })
        expect(epochs(client)).toEqual([1])
        expect(ids(await roles())).toEqual([guildId])
        expect(await self()).toBeDefined()

        // Fluxer refuses the session, so the shard starts a new one that replays nothing
        server.send({ op: Opcode.invalidSession, d: false }, server.sockets.at(-1))
        await recover(client, clock)
        await vi.waitFor(() => {
            expect(server.commandsWithOp(Opcode.identify)).toHaveLength(2)
            expect(client.state).toBe("Connected")
        })
        expect(epochs(client)).toEqual([2])
        expect(await roles()).toBeUndefined()
        expect(await self()).toBeUndefined()

        // Fluxer sends each community again after the new session's READY
        await guildCreate(server, roles)
        expect(await self()).toBeDefined()
    })

    test("an event queued before a new session keeps the epoch it arrived with", async () => {
        const clock = sdkClock()
        const server = await startGatewayServer({ ready: () => ({ user: fixtures.botUser() }) })
        stubFetchWithHostedDiscovery(async () => Response.json({}))
        const client = (await setup(mode)) as AnyClient
        // The documented comparison, kept per community, with the shard's current epoch beside it
        const seen = new Map<string, number>()
        const runs: { epoch: number; changed: boolean; current: number | undefined }[] = []
        let started!: () => void
        const blocked = new Promise<void>((resolve) => (started = resolve))
        let release!: () => void
        const released = new Promise<void>((resolve) => (release = resolve))
        await onGuildCreate(mode, client, async (id, context) => {
            const previous = seen.get(id)
            seen.set(id, context.sessionEpoch)
            const changed = previous !== undefined && previous !== context.sessionEpoch
            runs.push({ epoch: context.sessionEpoch, changed, current: epochs(client)[0] })
            if (runs.length === 1) {
                started()
                await released
            }
        })
        await settle((client as Client).connect())
        server.dispatch("GUILD_CREATE", fixtures.guildCreate())
        await blocked
        // An older snapshot waits behind the blocked handler while the shard starts a new session
        server.dispatch("GUILD_CREATE", fixtures.guildCreate())
        server.send({ op: Opcode.invalidSession, d: false }, server.sockets.at(-1))
        await recover(client, clock)
        await vi.waitFor(() => {
            expect(server.commandsWithOp(Opcode.identify)).toHaveLength(2)
            expect(client.state).toBe("Connected")
        })
        server.dispatch("GUILD_CREATE", fixtures.guildCreate())
        release()
        await vi.waitFor(() => expect(runs).toHaveLength(3), { interval: 5 })
        // The shard is already on epoch 2 when the queued snapshot runs, but its context keeps 1, so only the snapshot of
        // the new session reports the change
        expect(runs).toEqual([
            { epoch: 1, changed: false, current: 1 },
            { epoch: 1, changed: false, current: 2 },
            { epoch: 2, changed: true, current: 2 },
        ])
    })
})
