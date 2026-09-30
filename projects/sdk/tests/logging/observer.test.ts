import { Effect, Exit, Scope } from "effect"
import { describe, expect, onTestFinished, test, vi } from "vitest"
import { ConfigurationError, createClient, type Observation } from "../../src/index.js"
import { createTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"

/**
 * One test client per API style that records observations, with the calls these tests need as promises.
 * Handlers fail by throwing in the default API and by failing their Effect in the native API
 */
// A short first recovery ceiling keeps the reconnect well inside the default wait, instead of racing a one-second backoff
const connection = { recovery: { minDelayMs: 100 } }

async function open(mode: Mode, observe: (observation: Observation) => void) {
    if (mode === "default") {
        const test = createTestClient({ observe, connection })
        onTestFinished(() => test.shutdown().catch(() => undefined))
        return {
            test,
            ready: () => test.ready(),
            emit: async (type: string, payload: unknown) => test.emit(type, payload),
            disconnect: async () => test.disconnect(),
            send: async (channelId: string) => void (await test.client.messages.send(channelId, "hello")),
            onTyping: async (fail: boolean) =>
                void test.client.on(
                    "typingStart",
                    () => {
                        if (fail) throw new TypeError("handler failed")
                    },
                    { onError: () => undefined },
                ),
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(async () => void (await Effect.runPromiseExit(Scope.close(scope, Exit.void))))
    const test = await Effect.runPromise(createNativeTestClient({ observe, connection }).pipe(Scope.provide(scope)))
    return {
        test,
        ready: () => Effect.runPromise(test.ready()),
        emit: (type: string, payload: unknown) => Effect.runPromise(test.emit(type, payload)),
        disconnect: () => Effect.runPromise(test.disconnect()),
        send: (channelId: string) => Effect.runPromise(Effect.asVoid(test.client.messages.send(channelId, "hello"))),
        onTyping: async (fail: boolean) =>
            void (await Effect.runPromise(
                test.client
                    .on("typingStart", () => (fail ? Effect.fail(new TypeError("handler failed")) : Effect.void), {
                        onError: () => Effect.void,
                    })
                    .pipe(Scope.provide(scope)),
            )),
    }
}

const typing = { channel_id: "20", user_id: "30", timestamp: 1 }

describe.each(modes)("%s observer", (mode) => {
    test("REST attempts report their route template, status and attempt, and a rate-limit wait reports its delay", async () => {
        const observations: Observation[] = []
        const driver = await open(mode, (observation) => void observations.push(observation))
        let calls = 0
        driver.test.rest.respond("POST /channels/:id/messages", () =>
            ++calls === 1
                ? {
                      status: 429,
                      body: { message: "Slow down", code: "RATE_LIMITED", retry_after: 0.02, global: false },
                  }
                : { body: driver.test.fixtures.message({ content: "hello" }) },
        )
        await driver.send(driver.test.fixtures.ids.channel)
        const rest = observations.filter((observation) => observation.type === "rest")
        expect(rest).toEqual([
            expect.objectContaining({ method: "POST", route: "/channels/:id/messages", status: 429, attempt: 1 }),
            expect.objectContaining({ method: "POST", route: "/channels/:id/messages", status: 200, attempt: 2 }),
        ])
        expect(rest.every((observation) => Object.isFrozen(observation))).toBe(true)
        expect(observations).toContainEqual({
            type: "rateLimit",
            method: "POST",
            route: "/channels/:id/messages",
            waitMs: 20,
            global: false,
        })
        // Observations carry route templates, never the resource IDs of the request
        expect(JSON.stringify(observations)).not.toContain(driver.test.fixtures.ids.channel)
    })

    test("handler invocations report their duration and outcome, with the failure's error name", async () => {
        const observations: Observation[] = []
        const driver = await open(mode, (observation) => void observations.push(observation))
        await driver.onTyping(false)
        await driver.onTyping(true)
        await driver.ready()
        await driver.emit("TYPING_START", typing)
        await vi.waitFor(() => expect(observations.filter((item) => item.type === "handler")).toHaveLength(2))
        const handlers = observations.filter((observation) => observation.type === "handler")
        expect(handlers).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ event: "typingStart", shardId: 0, outcome: "success" }),
                expect.objectContaining({
                    event: "typingStart",
                    shardId: 0,
                    outcome: "failure",
                    errorName: "TypeError",
                }),
            ]),
        )
        for (const handler of handlers) expect(handler.durationMs).toBeGreaterThanOrEqual(0)
    })

    test("a lost connection reports the reconnection attempt and the resumed session", async () => {
        const observations: Observation[] = []
        const driver = await open(mode, (observation) => void observations.push(observation))
        await driver.ready()
        await driver.disconnect()
        await vi.waitFor(() =>
            expect(observations).toContainEqual(expect.objectContaining({ type: "resume", shardId: 0 })),
        )
        expect(observations).toContainEqual({ type: "reconnect", shardId: 0 })
    })

    test("a throwing observer is counted as an output failure without changing the request outcome", async () => {
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
        const driver = await open(mode, () => {
            throw new Error("observer failed")
        })
        driver.test.rest.respond("POST /channels/:id/messages", { body: driver.test.fixtures.message() })
        await driver.send(driver.test.fixtures.ids.channel)
        expect(driver.test.client.diagnostics().counters.sinkFailures).toBeGreaterThan(0)
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("observer failed"))
    })
})

test("a non-function observe option fails creation with ConfigurationError", () => {
    expect(() => createClient({ token: "fixture-token-value", observe: "metrics" as never })).toThrow(
        expect.objectContaining({ _tag: "ConfigurationError", field: "observe" }),
    )
    expect(() => createClient({ token: "fixture-token-value", observe: {} as never })).toThrow(ConfigurationError)
})
