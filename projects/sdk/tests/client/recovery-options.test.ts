import { Cause, Effect, Exit, Fiber, Schedule, Scope } from "effect"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { WebSocket } from "ws"
import { ConfigurationError, createClient, type ClientOptions } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { validateConfiguration } from "../../src/internal/configuration.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { modes, type Mode } from "../support/both-apis.js"
import { wsTarget } from "../support/ws-redirect.js"
import { sdkClock, type SdkClock } from "../support/client-clock.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    wsTarget.url = ""
    wsTarget.sockets = []
    wsTarget.requested = []
})

async function fixture() {
    const options = { holdReady: false }
    const gateway = await startGatewayServer({ heartbeatIntervalMs: 600_000, autoReady: () => !options.holdReady })
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(hostedDiscoveryDocument)),
    )
    return { options, sockets: gateway.sockets }
}

async function driver(mode: Mode, connection: object) {
    const options = { token: "fixture-only", connection }
    if (mode === "default") {
        const client = createClient(options as ClientOptions)
        onTestFinished(async () => void (await client.shutdown()))
        return {
            client,
            run: () => Promise.resolve(client.run()).then((result) => (result.isOk() ? "Success" : result.error._tag)),
            connect: async () => expect((await client.connect()).isOk()).toBe(true),
        }
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createNative(options as never).pipe(Scope.provide(scope)))
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return {
        client,
        run: () =>
            Effect.runPromiseExit(Fiber.join(Effect.runFork(client.run()))).then((exit) => {
                if (Exit.isSuccess(exit)) return "Success"
                const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                return failure?._tag === "Fail" ? (failure.error as { _tag: string })._tag : Cause.pretty(exit.cause)
            }),
        connect: () => Effect.runPromise(client.connect()),
    }
}

async function connected(client: { readonly state: string }) {
    await vi.waitFor(() => expect(client.state).toBe("Connected"), { interval: 5 })
}

/** Close the current connection and check the next recovery wait and the reconnect it leads to */
async function recoversAfter(
    clock: SdkClock,
    server: Awaited<ReturnType<typeof fixture>>,
    client: { readonly state: string },
    delay: number,
) {
    const count = server.sockets.length
    server.sockets.at(-1)!.close(4000)
    await clock.waiting(delay)
    await clock.advance(delay - 1)
    expect(server.sockets).toHaveLength(count)
    await clock.advance(1)
    await connected(client)
    expect(server.sockets).toHaveLength(count + 1)
}

describe.each(modes)("%s connection.recovery", (mode) => {
    test("uses minDelayMs as the first ceiling and caps the doubling at maxDelayMs", async () => {
        const clock = sdkClock()
        const server = await fixture()
        const api = await driver(mode, { recovery: { minDelayMs: 4_000, maxDelayMs: 10_000 } })
        await api.connect()
        // Math.random is 0.5, so each wait is half the ceiling: 4,000, 8,000, then 10,000 twice
        for (const delay of [2_000, 4_000, 5_000, 5_000]) await recoversAfter(clock, server, api.client, delay)
    })

    test("bounds each recovery attempt by attemptTimeoutMs", async () => {
        const clock = sdkClock()
        const server = await fixture()
        const api = await driver(mode, { recovery: { attemptTimeoutMs: 2_000 } })
        await api.connect()
        server.options.holdReady = true
        server.sockets[0]!.close(4000)
        await clock.waiting(500)
        await clock.advance(500)
        await vi.waitFor(() => expect(server.sockets).toHaveLength(2), { interval: 5 })
        await clock.waiting(2_000)
        await clock.advance(1_999)
        expect(wsTarget.sockets[1]!.readyState).not.toBe(WebSocket.CLOSED)
        await clock.advance(1)
        // The expired attempt is retried with the next backoff step
        await clock.waiting(1_000)
        server.options.holdReady = false
        await clock.advance(1_000)
        await connected(api.client)
        expect(server.sockets).toHaveLength(3)
    })

    test("restarts the backoff sequence after healthyResetMs connected", async () => {
        const clock = sdkClock()
        const server = await fixture()
        const api = await driver(mode, { recovery: { healthyResetMs: 5_000 } })
        await api.connect()
        await recoversAfter(clock, server, api.client, 500)
        await clock.advance(4_999)
        await recoversAfter(clock, server, api.client, 1_000)
        await clock.advance(5_000)
        await recoversAfter(clock, server, api.client, 500)
    })
})

test("a native recovery schedule decides delays and its completion ends recovery with the last failure", async () => {
    const clock = sdkClock()
    const server = await fixture()
    const api = await driver("native", {
        recovery: { schedule: Schedule.spaced("3 seconds").pipe(Schedule.upTo({ times: 1 })) },
    })
    const run = api.run()
    await connected(api.client)
    await recoversAfter(clock, server, api.client, 3_000)
    server.sockets.at(-1)!.close(4000)
    expect(await run).toBe("ConnectionError")
    expect(api.client.state).toBe("Closed")
    expect(server.sockets).toHaveLength(2)
})

describe("recovery option validation", () => {
    const token = "fixture-only"
    const failure = (recovery: unknown, native = false) => {
        const exit = Effect.runSyncExit(validateConfiguration({ token, connection: { recovery } }, native))
        if (Exit.isSuccess(exit)) return undefined
        const reason = exit.cause.reasons.find((item) => item._tag === "Fail")
        return reason?._tag === "Fail" ? (reason.error as ConfigurationError) : undefined
    }
    const accepted = (recovery: unknown, native = false) => {
        const exit = Effect.runSyncExit(validateConfiguration({ token, connection: { recovery } }, native))
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
        return exit.value.recovery
    }

    test("defaults to 1,000, 30,000, 30,000 and 60,000 ms, raising the default ceiling to a larger minimum", () => {
        expect(accepted(undefined)).toMatchObject({
            minDelayMs: 1_000,
            maxDelayMs: 30_000,
            attemptTimeoutMs: 30_000,
            healthyResetMs: 60_000,
        })
        expect(accepted({ minDelayMs: 45_000 })).toMatchObject({ minDelayMs: 45_000, maxDelayMs: 45_000 })
    })

    test.each([
        { recovery: { minDelayMs: 99 }, field: "minDelayMs" },
        { recovery: { minDelayMs: 2_000, maxDelayMs: 1_999 }, field: "maxDelayMs" },
        { recovery: { attemptTimeoutMs: 999 }, field: "attemptTimeoutMs" },
        { recovery: { healthyResetMs: 2_147_483_648 }, field: "healthyResetMs" },
        { recovery: { minDelayMs: 1.5 }, field: "minDelayMs" },
        { recovery: { jitter: false }, field: "recovery" },
        { recovery: [], field: "recovery" },
    ])("rejects $recovery", ({ recovery, field }) => {
        expect(failure(recovery)).toMatchObject({ _tag: "ConfigurationError", field })
    })

    test("accepts a schedule only in the native API and never together with delay bounds", () => {
        const schedule = Schedule.spaced("1 second")
        expect(failure({ schedule })).toMatchObject({
            field: "recovery",
            hint: expect.stringContaining("Effect"),
        })
        expect(accepted({ schedule }, true).schedule).toBe(schedule)
        expect(failure({ schedule, minDelayMs: 1_000 }, true)).toMatchObject({ field: "schedule" })
        expect(failure({ schedule: () => 1_000 }, true)).toMatchObject({ field: "schedule" })
    })
})
