import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Client, GuildHealthUpdate, RawDispatch } from "../../src/index.js"
import { Opcode } from "../../src/internal/protocol/gateway.js"
import { modes, setup } from "../support/both-apis.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { expectErr, settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

for (const mode of modes) {
    test(`${mode} guild health transitions reach frozen typed and raw handlers without lifecycle or cache changes`, async () => {
        const server = await startGatewayServer()
        stubFetchWithHostedDiscovery(async () =>
            Response.json({ id: "20", name: "fixture", owner_id: "90", features: [] }),
        )
        const client = (await setup(mode, { cache: { guilds: true } })) as Client
        const typed: GuildHealthUpdate[] = []
        const raw: RawDispatch[] = []
        const lifecycle: string[] = []
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const register = (operation: unknown) =>
            Effect.isEffect(operation)
                ? Effect.runPromise(
                      (operation as Effect.Effect<unknown, unknown, Scope.Scope>).pipe(Scope.provide(scope)),
                  )
                : settle(operation)
        const typedDone = Promise.withResolvers<void>()
        const rawDone = Promise.withResolvers<void>()
        const handler =
            <A>(accept: (event: A) => void) =>
            (event: A) =>
                mode === "native" ? Effect.sync(() => accept(event)) : accept(event)
        await register(
            client.on(
                "guildHealthUpdate",
                handler<GuildHealthUpdate>((event) => {
                    typed.push(event)
                    if (typed.length === 2) typedDone.resolve()
                }) as never,
            ),
        )
        await register(
            client.on(
                "raw",
                handler<RawDispatch>((event) => {
                    if (event.t !== "GUILD_HEALTH_UPDATE") return
                    raw.push(event)
                    if (raw.length === 3) rawDone.resolve()
                }) as never,
            ),
        )
        for (const event of ["guildCreate", "guildUpdate", "guildDelete"] as const)
            await register(
                client.on(
                    event,
                    handler(() => {
                        lifecycle.push(event)
                    }) as never,
                ),
            )
        await settle(client.connect())
        const cached = await settle(client.guilds.fetch("20"))
        server.deliverNow("GUILD_HEALTH_UPDATE", { guild_id: "20", degraded: true })
        server.deliverNow("GUILD_HEALTH_UPDATE", { guild_id: "20", degraded: "yes" })
        server.deliverNow("GUILD_HEALTH_UPDATE", { guild_id: "20", degraded: false })
        await Promise.all([typedDone.promise, rawDone.promise])
        expect(typed).toEqual([
            { guildId: "20", degraded: true },
            { guildId: "20", degraded: false },
        ])
        expect(typed.every(Object.isFrozen)).toBe(true)
        expect(raw.map((event) => event.d)).toEqual([
            { guild_id: "20", degraded: true },
            { guild_id: "20", degraded: "yes" },
            { guild_id: "20", degraded: false },
        ])
        expect(client.diagnostics().counters.eventsDropped.malformed).toBe(1)
        expect(await settle(client.guilds.get("20"))).toBe(cached)
        expect(client.state).toBe("Connected")
        expect(server.sockets).toHaveLength(1)
        expect(server.commandsWithOp(Opcode.identify)).toHaveLength(1)
        expect(server.commandsWithOp(Opcode.resume)).toHaveLength(0)
        expect(lifecycle).toEqual([])
        await settle(client.shutdown())
    })

    test(`${mode} malformed guild health obeys the terminate policy without recovery`, async () => {
        const server = await startGatewayServer()
        stubFetchWithHostedDiscovery(async () => Response.json({}))
        const client = (await setup(mode, { gateway: { onMalformedDispatch: "terminate" } })) as Client
        await settle(client.connect())
        const closed = expectErr(client.waitForClose())
        server.deliverNow("GUILD_HEALTH_UPDATE", { guild_id: "20" })
        expect(await closed).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
        expect(client.state).toBe("Closed")
        expect(server.sockets).toHaveLength(1)
        expect(server.commandsWithOp(Opcode.resume)).toHaveLength(0)
    })

    test(`${mode} automatic filtering retains guild health for a typed subscription`, async () => {
        const server = await startGatewayServer()
        stubFetchWithHostedDiscovery(async () => Response.json({}))
        const client = (await setup(mode, { gateway: { ignoredEvents: "auto" } })) as Client
        const received = settle(client.waitFor("guildHealthUpdate"))
        await settle(client.connect())
        expect(server.commandsWithOp(Opcode.identify)[0]!.d.ignored_events).not.toContain("GUILD_HEALTH_UPDATE")
        server.deliverNow("GUILD_HEALTH_UPDATE", { guild_id: "20", degraded: true })
        expect(await received).toEqual({ guildId: "20", degraded: true })
        await settle(client.shutdown())
    })
}
