import { Effect, Exit, Stream } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ClientClosedError, ConfigurationError, createClient, type Client } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { defaultApi, fixtureToken, nativeApi } from "../support/both-apis.js"
import { thrownBy } from "../support/client-creation.js"

const webSocket = vi.hoisted(() =>
    vi.fn(function () {
        throw new Error("Unexpected WebSocket creation")
    }),
)

vi.mock("ws", () => ({ default: webSocket }))

afterEach(() => {
    webSocket.mockClear()
    vi.unstubAllGlobals()
})

/** The defect a native Effect died with, failing the test when it succeeded or failed with a typed error */
async function defectOf(effect: Effect.Effect<unknown, unknown>): Promise<unknown> {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return expect.fail("Expected the Effect to die")
    expect(exit.cause.reasons.some((reason) => reason._tag === "Fail")).toBe(false)
    const die = exit.cause.reasons.find((reason) => reason._tag === "Die")
    return die?._tag === "Die" ? die.defect : expect.fail("Expected a defect")
}

const onMisuse = [
    { name: "an unknown event name", field: "event", args: ["messageCreated", () => undefined] },
    { name: "a handler that is not a function", field: "handler", args: ["messageCreate", "handler"] },
    {
        name: "an onError reporter that is not a function",
        field: "onError",
        args: ["messageCreate", () => undefined, { onError: 1 }],
    },
    {
        name: "an invalid concurrency",
        field: "concurrency",
        args: ["messageCreate", () => undefined, { concurrency: 0 }],
    },
] as const

describe("event registration misuse", () => {
    test.each(onMisuse)("default on throws ConfigurationError for $name before registering", ({ field, args }) => {
        const client: Client = defaultApi()
        const error = thrownBy(() => (client.on as (...values: unknown[]) => unknown)(...args))
        expect(error).toBeInstanceOf(ConfigurationError)
        expect(error).toMatchObject({ field })
        expect(client.diagnostics().events.subscriptions).toBe(0)
    })

    test.each(onMisuse)("native on dies with ConfigurationError for $name", async ({ field, args }) => {
        const client: NativeClient = await nativeApi()
        const [event, handler, options] = args
        // Keep an invalid handler as is, and give valid cases a native Effect handler
        const registration = (client.on as (...values: unknown[]) => Effect.Effect<unknown, never, never>)(
            event,
            typeof handler === "function" ? () => Effect.void : handler,
            options,
        )
        const defect = await defectOf(Effect.scoped(registration))
        expect(defect).toBeInstanceOf(ConfigurationError)
        expect(defect).toMatchObject({ field })
    })

    test("default subscribe throws ConfigurationError for an unknown event or invalid buffer options", () => {
        const client: Client = defaultApi()
        const unknown = thrownBy(() => client.subscribe("messageCreated" as "messageCreate"))
        expect(unknown).toBeInstanceOf(ConfigurationError)
        expect(unknown).toMatchObject({ field: "event" })
        const buffer = thrownBy(() => client.subscribe("messageCreate", { maxPendingMessages: 0 }))
        expect(buffer).toBeInstanceOf(ConfigurationError)
    })

    test("native subscribe streams die with ConfigurationError for an unknown event or invalid buffer options", async () => {
        const client: NativeClient = await nativeApi()
        const unknown = await defectOf(Stream.runDrain(client.subscribe("messageCreated" as "messageCreate")))
        expect(unknown).toBeInstanceOf(ConfigurationError)
        expect(unknown).toMatchObject({ field: "event" })
        const buffer = await defectOf(Stream.runDrain(client.subscribe("messageCreate", { maxPendingMessages: 0 })))
        expect(buffer).toBeInstanceOf(ConfigurationError)
    })

    test("native collectors die with ConfigurationError for invalid options", async () => {
        const client: NativeClient = await nativeApi()
        const messages = await defectOf(Effect.scoped(client.messages.collect("20", { maxMessages: 0 })))
        expect(messages).toBeInstanceOf(ConfigurationError)
        const reactions = await defectOf(
            Effect.scoped(client.messages.collectReactions({ id: "10", channelId: "20" }, { maxReactions: 0 })),
        )
        expect(reactions).toBeInstanceOf(ConfigurationError)
    })
})

describe("middleware and cache listener registration misuse", () => {
    test("default use and cache.onChange throw ConfigurationError for a non-function before registering", () => {
        const client: Client = defaultApi()
        const middleware = thrownBy(() => client.use("middleware" as never))
        expect(middleware).toBeInstanceOf(ConfigurationError)
        expect(middleware).toMatchObject({ field: "middleware" })
        const listener = thrownBy(() => client.cache.onChange({} as never))
        expect(listener).toBeInstanceOf(ConfigurationError)
        expect(listener).toMatchObject({ field: "listener" })
    })

    test("native use and cache.onChange die with ConfigurationError for a non-function", async () => {
        const client: NativeClient = await nativeApi()
        const middleware = await defectOf(Effect.scoped(client.use("middleware" as never)))
        expect(middleware).toBeInstanceOf(ConfigurationError)
        expect(middleware).toMatchObject({ field: "middleware" })
        const listener = await defectOf(Effect.scoped(client.cache.onChange({} as never)))
        expect(listener).toBeInstanceOf(ConfigurationError)
        expect(listener).toMatchObject({ field: "listener" })
    })

    test("native use dies with ClientClosedError after shutdown", async () => {
        const client: NativeClient = await nativeApi()
        await Effect.runPromise(client.shutdown())
        expect(await defectOf(Effect.scoped(client.use(() => Effect.void)))).toBeInstanceOf(ClientClosedError)
    })
})

// Event subscriptions and collectors registered during shutdown return closed handles instead, as covered by
// tests/client/shutdown-registration-race.test.ts
describe("middleware registration on a closing or closed default client", () => {
    test("use throws ClientClosedError while shutdown is in progress", async () => {
        const client = createClient({ token: fixtureToken })
        const closing = client.shutdown()
        expect(thrownBy(() => client.use(() => undefined))).toBeInstanceOf(ClientClosedError)
        expect((await closing).isOk()).toBe(true)
    })

    test("use throws ClientClosedError after shutdown", async () => {
        const client = createClient({ token: fixtureToken })
        expect((await client.shutdown()).isOk()).toBe(true)
        expect(thrownBy(() => client.use(() => undefined))).toBeInstanceOf(ClientClosedError)
    })
})
