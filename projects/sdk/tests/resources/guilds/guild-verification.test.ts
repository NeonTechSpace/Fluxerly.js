import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { Guild, GuildEdit } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"

const guild = (verificationLevel: number) => ({
    id: "20",
    owner_id: "30",
    name: "fixture",
    features: ["ANNOUNCEMENT_CHANNELS_DISABLED"],
    verification_level: verificationLevel,
})

test.each(modes)("%s rejects retired verification level 4 before dispatch", async (mode) => {
    const api = await setup(mode)
    const route = api.rest.respond("PATCH /guilds/20", { body: guild(3) })
    await expect(api.edit({ verificationLevel: 4 } as unknown as GuildEdit)).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "guilds.edit",
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "verificationLevel", constraint: "allowedValue" },
    })
    expect(route.requests()).toEqual([])
    expect(api.requests()).toEqual([])
})

test.each(modes)(
    "%s normalizes received legacy level 4 to High and rejects other out-of-range levels",
    async (mode) => {
        const api = await setup(mode)
        let verificationLevel = 3
        api.rest.respond("GET /guilds/20", () => ({ body: guild(verificationLevel) }))
        for (const supported of [3, 4]) {
            verificationLevel = supported
            const received = await api.fetch()
            expect(received).toMatchObject({
                id: "20",
                name: "fixture",
                verificationLevel: 3,
                features: ["ANNOUNCEMENT_CHANNELS_DISABLED"],
            })
            expect(Object.isFrozen(received)).toBe(true)
        }
        for (const invalid of [5, -1, 4.5]) {
            verificationLevel = invalid
            await expect(api.fetch()).rejects.toMatchObject({
                _tag: "GuildOperationError",
                operation: "guilds.fetch",
                reason: "response",
                outcome: "unknown",
                status: 200,
            })
        }
    },
)

test.each(modes)("%s delivers legacy level 4 guild create and update events as High", async (mode) => {
    const api = await setup(mode)
    const seen: Array<{ event: string; value: Guild; cached: Guild | undefined }> = []
    for (const event of ["guildCreate", "guildUpdate"] as const)
        await api.onGuild(event, async (value) => {
            seen.push({ event, value, cached: await api.get(value.id) })
        })
    await api.ready()
    await api.emit("GUILD_CREATE", api.fixtures.guildCreate({ guild: { verification_level: 4 } }))
    await api.idle()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
        event: "guildCreate",
        value: { verificationLevel: 3 },
        cached: { verificationLevel: 3 },
    })
    await api.emit("GUILD_UPDATE", api.fixtures.guild({ verification_level: 4, name: "legacy update" }))
    await api.idle()
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({
        event: "guildUpdate",
        value: { verificationLevel: 3, name: "legacy update" },
        cached: { verificationLevel: 3, name: "legacy update" },
    })
})

async function setup(mode: Mode) {
    const options = { cache: { guilds: true }, gateway: { ignoredEvents: [] } } as const
    const scope = Scope.makeUnsafe()
    const defaultTest = mode === "default" ? createDefaultTestClient(options) : undefined
    const nativeTest =
        mode === "native"
            ? await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
            : undefined
    onTestFinished(async () => {
        if (defaultTest) await defaultTest.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        rest: (defaultTest ?? nativeTest)!.rest,
        fixtures: (defaultTest ?? nativeTest)!.fixtures,
        requests: () => (defaultTest ?? nativeTest)!.requests(),
        get: async (id: string) =>
            defaultTest ? defaultTest.client.guilds.get(id) : settle(nativeTest!.client.guilds.get(id)),
        ready: () => (defaultTest ? defaultTest.ready() : Effect.runPromise(nativeTest!.ready())),
        emit: async (type: string, value: unknown) =>
            defaultTest ? defaultTest.emit(type, value) : Effect.runPromise(nativeTest!.emit(type, value)),
        idle: () => (defaultTest ? defaultTest.idle() : Effect.runPromise(nativeTest!.idle())),
        onGuild: async (event: "guildCreate" | "guildUpdate", handler: (value: Guild) => Promise<void>) =>
            defaultTest
                ? defaultTest.client.on(event, handler)
                : Effect.runPromise(
                      nativeTest!.client
                          .on(event, (value) => Effect.promise(() => handler(value)))
                          .pipe(Scope.provide(scope)),
                  ),
        fetch: () =>
            defaultTest ? settle(defaultTest.client.guilds.fetch("20")) : settle(nativeTest!.client.guilds.fetch("20")),
        edit: (input: GuildEdit) =>
            defaultTest
                ? settle(defaultTest.client.guilds.edit("20", input))
                : settle(nativeTest!.client.guilds.edit("20", input)),
    }
}
