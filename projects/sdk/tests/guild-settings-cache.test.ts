import { Effect, Exit, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
afterEach(() => vi.unstubAllGlobals())

async function settle<A>(value: ResultAsync<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) {
        const result = await Effect.runPromise(Effect.result(value))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = await value
    if (result.isErr()) throw result.error
    return result.value
}

async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture_only", cache: { guilds: true, channels: true } }
    const client =
        mode === "default"
            ? createClient(options)._unsafeUnwrap()
            : await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        const closed = client.shutdown()
        if (Effect.isEffect(closed)) await Effect.runPromise(closed)
        else await closed
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return client
}

test.each(modes)("%s invalidates channels and pending reads when a settings patch may sanitize names", async (mode) => {
    const client = await setup(mode)
    const channel = { id: "100", guild_id: "200", type: 0, name: "Flexible Name" }
    const guild = { id: "200", owner_id: "300", name: "Guild", features: [] }
    let hold = false,
        release!: () => void,
        started!: () => void
    const ready = new Promise<void>((resolve) => {
        started = resolve
    })
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        if (init.method === "GET") {
            if (hold) {
                started()
                await held
            }
            return Response.json(url.endsWith("/channels/100") ? channel : guild)
        }
        throw Error("Discarded settings response")
    })
    await settle(client.channels.fetch("100"))
    await settle(client.guilds.fetch("200"))
    hold = true
    const pending = settle(client.channels.fetch("100"))
    await ready
    try {
        await expect(settle(client.guilds.edit("200", { featureToggles: [] }))).rejects.toMatchObject({
            outcome: "unknown",
        })
        const local = client.channels.get("100")
        expect(Effect.isEffect(local) ? await Effect.runPromise(local) : local._unsafeUnwrap()).toBeUndefined()
    } finally {
        release()
    }
    await pending
    const after = client.channels.get("100")
    expect(Effect.isEffect(after) ? await Effect.runPromise(after) : after._unsafeUnwrap()).toBeUndefined()
})

test.each(modes)(
    "%s leaves channel observations alone for a server rename or retained flexible names",
    async (mode) => {
        const client = await setup(mode)
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) =>
            Response.json(
                init.method === "GET"
                    ? { id: "100", guild_id: "200", type: 0, name: "Flexible Name" }
                    : { id: "200", owner_id: "300", name: "Renamed", features: ["TEXT_CHANNEL_FLEXIBLE_NAMES"] },
            ),
        )
        await settle(client.channels.fetch("100"))
        await settle(client.guilds.edit("200", { name: "Renamed" }))
        await settle(client.guilds.edit("200", { featureToggles: ["TEXT_CHANNEL_FLEXIBLE_NAMES"] }))
        const local = client.channels.get("100")
        expect(Effect.isEffect(local) ? await Effect.runPromise(local) : local._unsafeUnwrap()).toMatchObject({
            name: "Flexible Name",
        })
    },
)
