import { Cause, Config, ConfigProvider, Effect, Exit, Layer, Redacted } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { ConfigurationError, type LogRecord } from "../../src/index.js"
import type { Client } from "../../src/effect.js"
import * as nativeClientModule from "../../src/api/effect/client.js"
import { FluxerClient } from "../../src/api/effect/service.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const token = "fixture-only-not-a-credential"
const selfWire = {
    id: "30",
    username: "fixture",
    discriminator: "0001",
    global_name: null,
    avatar: null,
    avatar_color: null,
    flags: 0,
    bot: true,
}

/** Answer every HTTP request with the bot user, recording the Authorization header of each */
function recordAuthorization() {
    const authorization: (string | null)[] = []
    const fetch = stubFetchWithHostedDiscovery(async (_url, init) => {
        authorization.push(new Headers(init.headers).get("Authorization"))
        return Response.json(selfWire)
    })
    return { authorization, fetch }
}

/** Run one program against a layer with an environment-shaped ConfigProvider */
function runWith<A, E>(
    program: Effect.Effect<A, E, FluxerClient>,
    layer: Layer.Layer<FluxerClient, unknown>,
    env: Record<string, string> = {},
) {
    return Effect.runPromiseExit(
        program.pipe(
            Effect.provide(layer),
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
        ),
    )
}

test("layer creates one unconnected client for the program and shuts it down when the layer scope closes", async () => {
    const { fetch } = recordAuthorization()
    let observed: Client | undefined
    const exit = await runWith(
        Effect.gen(function* () {
            observed = yield* FluxerClient
            // The same service value is returned for every read within one provide
            expect(yield* FluxerClient).toBe(observed)
            expect(observed.state).toBe("Disconnected")
        }),
        FluxerClient.layer({ token }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(observed!.state).toBe("Closed")
})

test("layerConfig reads a Redacted token and other settings from Config and never logs the token", async () => {
    const { authorization } = recordAuthorization()
    const records: LogRecord[] = []
    const secret = "fixture-config-token-not-a-credential"
    const exit = await runWith(
        FluxerClient.use((client) => client.users.fetchSelf()),
        FluxerClient.layerConfig({
            token: Config.Redacted("FLUXER_BOT_TOKEN"),
            logging: Config.succeed({ sink: (record: LogRecord) => void records.push(record), debug: true }),
        }),
        { FLUXER_BOT_TOKEN: secret },
    )
    expect(Exit.isSuccess(exit) && exit.value.id).toBe("30")
    expect(authorization).toEqual([`Bot ${secret}`])
    expect(records.length).toBeGreaterThan(0)
    expect(JSON.stringify(records)).not.toContain(secret)
})

test("layerConfig accepts plain and Redacted token values without a ConfigProvider entry", async () => {
    const { authorization } = recordAuthorization()
    for (const value of [token, Redacted.make(token)]) {
        const exit = await runWith(
            FluxerClient.use((client) => client.users.fetchSelf()),
            FluxerClient.layerConfig({ token: value }),
        )
        expect(Exit.isSuccess(exit)).toBe(true)
    }
    expect(authorization).toEqual([`Bot ${token}`, `Bot ${token}`])
})

test("a missing Config token fails the layer with ConfigError before any client exists", async () => {
    const create = vi.spyOn(nativeClientModule, "createClient")
    const program = vi.fn(() => Effect.void)
    const exit = await runWith(
        FluxerClient.use(program),
        FluxerClient.layerConfig({ token: Config.Redacted("FLUXER_BOT_TOKEN") }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(failure).toMatchObject({ _tag: "ConfigError" })
    expect(create).not.toHaveBeenCalled()
    expect(program).not.toHaveBeenCalled()
})

test("a blank token or invalid setting is misuse, and both layers die with ConfigurationError", async () => {
    const program = vi.fn(() => Effect.void)
    for (const layer of [
        FluxerClient.layerConfig({ token: Config.Redacted("FLUXER_BOT_TOKEN") }),
        FluxerClient.layer({ token: "   " }),
        FluxerClient.layer({ token, logging: { format: "xml" } as never }),
    ]) {
        const exit = await runWith(FluxerClient.use(program), layer, { FLUXER_BOT_TOKEN: "  " })
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(ConfigurationError)
    }
    expect(program).not.toHaveBeenCalled()
})
