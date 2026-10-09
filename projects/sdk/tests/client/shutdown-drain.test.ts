import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { fakeHostTime, hostTurnsUntil, sdkClock } from "../support/client-clock.js"
import { ConfigurationError, runBot, type LogRecord } from "../../src/index.js"
import { runBot as runNativeBot } from "../../src/effect.js"
import { createTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { TestHarness } from "../../src/internal/testing/harness.js"

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

const codes = (logs: readonly LogRecord[]) => logs.map((record) => record.code)

function open() {
    const test = createTestClient()
    onTestFinished(() => test.shutdown())
    test.rest.respond("POST /channels/:id/messages", { body: test.fixtures.message({ content: "done" }) })
    return test
}

async function openNative() {
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
    test.rest.respond("POST /channels/:id/messages", { body: test.fixtures.message({ content: "done" }) })
    return { test, scope }
}

describe("default API drain", () => {
    test("a drain lets a running handler finish its reply while new events are refused", async () => {
        const test = open()
        const gate = Promise.withResolvers<void>()
        const started: string[] = []
        const outcomes: boolean[] = []
        test.client.on("messageCreate", async (message, signal) => {
            started.push(message.content)
            await gate.promise
            const reply = await test.client.messages.reply(message, "done", { signal })
            outcomes.push(reply.isOk())
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "first" }))
        await vi.waitFor(() => expect(started).toEqual(["first"]))

        const stopping = test.client.shutdown({ drainMs: 10_000 })
        // Intake has stopped, so an event received during the drain never reaches the handler
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "during drain" }))
        await vi.waitFor(() => expect(codes(test.logs())).toContain("lifecycle.draining"))
        expect(test.client.state).toBe("Connected")
        gate.resolve()
        expect((await stopping).isOk()).toBe(true)

        expect(outcomes).toEqual([true])
        expect(started).toEqual(["first"])
        expect(test.requests().filter((request) => request.method === "POST")).toHaveLength(1)
        expect(codes(test.logs())).toContain("lifecycle.drained")
        expect(test.client.state).toBe("Closed")
    })

    test("the drain deadline cancels unfinished work and logs how much it cut off", async () => {
        const clock = sdkClock()
        const test = open()
        let aborted = false
        test.client.on("typingStart", (_event, signal) => {
            return new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => {
                    aborted = true
                    resolve()
                })
            })
        })
        await test.ready()
        test.emit("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 })
        await vi.waitFor(() => expect(test.client.diagnostics().events.activeHandlers).toBe(1))

        const stopping = test.client.shutdown({ drainMs: 50 })
        await clock.waiting(50)
        expect(aborted).toBe(false)
        await clock.advance(50)
        expect((await stopping).isOk()).toBe(true)
        expect(aborted).toBe(true)
        const timedOut = test.logs().find((record) => record.code === "lifecycle.drainTimedOut")
        expect(timedOut).toMatchObject({ level: "warn", fields: { running: 1, waiting: 0, drainMs: 50 } })
    })

    test("a draining shutdown records how many events it refused, instead of dropping them silently", async () => {
        const test = open()
        const gate = Promise.withResolvers<void>()
        test.client.on("messageCreate", () => gate.promise)
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "first" }))
        await vi.waitFor(() => expect(test.client.diagnostics().events.activeHandlers).toBe(1))
        const stopping = test.client.shutdown({ drainMs: 10_000 })
        await vi.waitFor(() => expect(codes(test.logs())).toContain("lifecycle.draining"))
        for (const content of ["second", "third"]) test.emit("MESSAGE_CREATE", test.fixtures.message({ content }))
        gate.resolve()
        expect((await stopping).isOk()).toBe(true)
        expect(test.logs().filter((record) => record.code === "events.refused")).toEqual([
            expect.objectContaining({ level: "info", fields: { refused: 2 } }),
        ])
        expect(test.client.diagnostics().counters.eventsDropped.closed).toBe(2)
    })

    test("a draining shutdown also records refused events that only a collector would have received", async () => {
        // Catches: Refusals were counted only for subscriptions, so events only a collector wanted vanished unrecorded
        // Collectors open after ready, so the session must not suppress the dispatches only they receive
        const test = createTestClient({ gateway: { ignoredEvents: [] } })
        onTestFinished(() => test.shutdown())
        const gate = Promise.withResolvers<void>()
        test.client.on("typingStart", () => gate.promise)
        const channelId = test.fixtures.ids.channel
        const target = { channelId, id: test.fixtures.nextId() }
        await test.ready()
        test.client.messages.collect(channelId)
        test.client.messages.collectReactions(target)
        test.emit("TYPING_START", { channel_id: channelId, user_id: test.fixtures.ids.user, timestamp: 1 })
        await vi.waitFor(() => expect(test.client.diagnostics().events.activeHandlers).toBe(1))
        const stopping = test.client.shutdown({ drainMs: 10_000 })
        await vi.waitFor(() => expect(codes(test.logs())).toContain("lifecycle.draining"))
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "during drain" }))
        test.emit("MESSAGE_REACTION_ADD", {
            message_id: target.id,
            channel_id: channelId,
            guild_id: test.fixtures.ids.guild,
            user_id: test.fixtures.ids.user,
            emoji: { name: "👍" },
        })
        gate.resolve()
        expect((await stopping).isOk()).toBe(true)
        expect(test.logs().filter((record) => record.code === "events.refused")).toEqual([
            expect.objectContaining({ level: "info", fields: { refused: 2 } }),
        ])
        expect(test.client.diagnostics().counters.eventsDropped.closed).toBe(2)
    })

    test("a shutdown records the waiting events it discards, once per subscription", async () => {
        const test = open()
        const subscription = test.client.on(
            "messageCreate",
            (_message, signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
        )
        await test.ready()
        // The first event runs and blocks the only handler slot, so the other two wait in the queue
        for (const content of ["first", "second", "third"])
            test.emit("MESSAGE_CREATE", test.fixtures.message({ content }))
        await vi.waitFor(() => expect(test.client.diagnostics().events.activeHandlers).toBe(1))
        expect((await test.client.shutdown()).isOk()).toBe(true)
        expect(test.logs().filter((record) => record.code === "events.discarded")).toEqual([
            expect.objectContaining({
                level: "info",
                subscriptionId: subscription.id,
                fields: { discarded: 2, reason: "clientClosed" },
            }),
        ])
        expect(test.client.diagnostics().counters.eventsDropped.closed).toBe(2)
    })

    test("closing a subscription records the waiting events it drops at Debug", async () => {
        const test = createTestClient({ logging: { categories: { events: "debug" } } })
        onTestFinished(() => test.shutdown())
        const subscription = test.client.on(
            "messageCreate",
            (_message, signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
        )
        await test.ready()
        for (const content of ["first", "second", "third"])
            test.emit("MESSAGE_CREATE", test.fixtures.message({ content }))
        await vi.waitFor(() => expect(test.client.diagnostics().events.activeHandlers).toBe(1))
        subscription.close()
        expect((await subscription.waitForClose()).isOk()).toBe(true)
        expect(test.logs().filter((record) => record.code === "events.discarded")).toEqual([
            expect.objectContaining({
                level: "debug",
                subscriptionId: subscription.id,
                fields: { discarded: 2, reason: "subscriptionClosed" },
            }),
        ])
        expect(test.client.diagnostics().counters.eventsDropped.closed).toBe(2)
    })

    test("an idle client ends the drain at once without drain records", async () => {
        const test = open()
        await test.ready()
        fakeHostTime()
        let completed = false
        const stopping = test.client.shutdown({ drainMs: 60_000 })
        void stopping.then(() => {
            completed = true
        })
        await hostTurnsUntil(() => completed)
        expect((await stopping).isOk()).toBe(true)
        expect(performance.now()).toBe(0)
        expect(codes(test.logs())).not.toContain("lifecycle.draining")
    })

    test("invalid shutdown options throw ConfigurationError before shutdown starts", () => {
        const test = open()
        for (const options of [{ drainMs: -1 }, { drainMs: 1.5 }, { drainMs: "5s" }, { drain: 5 }, "fast"])
            expect(() => test.client.shutdown(options as never)).toThrow(ConfigurationError)
        expect(() => test.client.shutdown({ drainMs: -1 })).toThrow(expect.objectContaining({ field: "drainMs" }))
        expect(test.client.state).toBe("Disconnected")
    })

    test("runBot drains running handlers by default when its signal stops the bot", async () => {
        const harness = new TestHarness({})
        onTestFinished(() => void harness.close())
        harness.http.respond("POST /channels/:id/messages", { body: harness.fixtures.message({ content: "done" }) })
        const controller = new AbortController()
        const gate = Promise.withResolvers<void>()
        const started = Promise.withResolvers<void>()
        const outcomes: boolean[] = []
        const run = runBot({
            ...harness.clientOptions({}),
            signal: controller.signal,
            events: {
                messageCreate: async ({ reply }) => {
                    started.resolve()
                    await gate.promise
                    outcomes.push((await reply("done")).isOk())
                },
            },
        })
        await vi.waitFor(() => harness.gateway.emit("MESSAGE_CREATE", harness.fixtures.message(), undefined))
        await started.promise
        controller.abort()
        await vi.waitFor(() => expect(codes(harness.logs())).toContain("lifecycle.draining"))
        gate.resolve()
        expect((await run).isOk()).toBe(true)
        expect(outcomes).toEqual([true])
    })

    test("runBot with drainMs 0 cancels running handlers at once", async () => {
        const harness = new TestHarness({})
        onTestFinished(() => void harness.close())
        const controller = new AbortController()
        const started = Promise.withResolvers<void>()
        let aborted = false
        const run = runBot({
            ...harness.clientOptions({}),
            signal: controller.signal,
            drainMs: 0,
            events: {
                messageCreate: ({ signal }) =>
                    new Promise<void>((resolve) => {
                        started.resolve()
                        signal.addEventListener("abort", () => {
                            aborted = true
                            resolve()
                        })
                    }),
            },
        })
        await vi.waitFor(() => harness.gateway.emit("MESSAGE_CREATE", harness.fixtures.message(), undefined))
        await started.promise
        controller.abort()
        expect((await run).isOk()).toBe(true)
        expect(aborted).toBe(true)
        expect(codes(harness.logs())).not.toContain("lifecycle.draining")
    })

    test("runBot rejects an invalid drainMs before creating a client", () => {
        expect(() => runBot({ token: "fixture-token-value", drainMs: -5 })).toThrow(
            expect.objectContaining({ _tag: "ConfigurationError", field: "drainMs" }),
        )
    })
})

describe("native API drain", () => {
    test("a drain lets a running handler finish its reply", async () => {
        const { test, scope } = await openNative()
        const gate = Deferred.makeUnsafe<void>()
        const outcomes: boolean[] = []
        await Effect.runPromise(
            test.client
                .on("messageCreate", (message) =>
                    Deferred.await(gate).pipe(
                        Effect.andThen(test.client.messages.reply(message, "done")),
                        Effect.exit,
                        Effect.map((exit) => void outcomes.push(Exit.isSuccess(exit))),
                    ),
                )
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message()))
        await vi.waitFor(() => expect(test.client.diagnostics().events.activeHandlers).toBe(1))

        const stopping = Effect.runPromise(test.client.shutdown({ drainMs: 10_000 }))
        await vi.waitFor(() => expect(codes(test.logs())).toContain("lifecycle.draining"))
        Deferred.doneUnsafe(gate, Effect.void)
        await stopping
        expect(outcomes).toEqual([true])
        expect(codes(test.logs())).toContain("lifecycle.drained")
    })

    test("a draining shutdown records how many events it refused, instead of dropping them silently", async () => {
        const { test, scope } = await openNative()
        const gate = Deferred.makeUnsafe<void>()
        await Effect.runPromise(test.client.on("messageCreate", () => Deferred.await(gate)).pipe(Scope.provide(scope)))
        await Effect.runPromise(test.ready())
        await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "first" })))
        await vi.waitFor(() => expect(test.client.diagnostics().events.activeHandlers).toBe(1))
        const stopping = Effect.runPromise(test.client.shutdown({ drainMs: 10_000 }))
        await vi.waitFor(() => expect(codes(test.logs())).toContain("lifecycle.draining"))
        for (const content of ["second", "third"])
            await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content })))
        Deferred.doneUnsafe(gate, Effect.void)
        await stopping
        expect(test.logs().filter((record) => record.code === "events.refused")).toEqual([
            expect.objectContaining({ level: "info", fields: { refused: 2 } }),
        ])
        expect(test.client.diagnostics().counters.eventsDropped.closed).toBe(2)
    })

    test("a draining shutdown also records refused events that only a collector would have received", async () => {
        // Catches: Refusals were counted only for subscriptions, so events only a collector wanted vanished unrecorded
        // Collectors open after ready, so the session must not suppress the dispatches only they receive
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const test = await Effect.runPromise(
            createNativeTestClient({ gateway: { ignoredEvents: [] } }).pipe(Scope.provide(scope)),
        )
        const gate = Deferred.makeUnsafe<void>()
        const channelId = test.fixtures.ids.channel
        const target = { channelId, id: test.fixtures.nextId() }
        await Effect.runPromise(test.client.on("typingStart", () => Deferred.await(gate)).pipe(Scope.provide(scope)))
        await Effect.runPromise(test.ready())
        await Effect.runPromise(
            Effect.gen(function* () {
                yield* test.client.messages.collect(channelId)
                yield* test.client.messages.collectReactions(target)
            }).pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(
            test.emit("TYPING_START", { channel_id: channelId, user_id: test.fixtures.ids.user, timestamp: 1 }),
        )
        await vi.waitFor(() => expect(test.client.diagnostics().events.activeHandlers).toBe(1))
        const stopping = Effect.runPromise(test.client.shutdown({ drainMs: 10_000 }))
        await vi.waitFor(() => expect(codes(test.logs())).toContain("lifecycle.draining"))
        await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "during drain" })))
        await Effect.runPromise(
            test.emit("MESSAGE_REACTION_ADD", {
                message_id: target.id,
                channel_id: channelId,
                guild_id: test.fixtures.ids.guild,
                user_id: test.fixtures.ids.user,
                emoji: { name: "👍" },
            }),
        )
        Deferred.doneUnsafe(gate, Effect.void)
        await stopping
        expect(test.logs().filter((record) => record.code === "events.refused")).toEqual([
            expect.objectContaining({ level: "info", fields: { refused: 2 } }),
        ])
        expect(test.client.diagnostics().counters.eventsDropped.closed).toBe(2)
    })

    test("a shutdown records the waiting events it discards, once per subscription", async () => {
        const { test, scope } = await openNative()
        const subscription = await Effect.runPromise(
            test.client.on("messageCreate", () => Effect.never).pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        // The first event runs and blocks the only handler slot, so the other two wait in the queue
        for (const content of ["first", "second", "third"])
            await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content })))
        await vi.waitFor(() => expect(test.client.diagnostics().events.activeHandlers).toBe(1))
        await Effect.runPromise(test.client.shutdown())
        expect(test.logs().filter((record) => record.code === "events.discarded")).toEqual([
            expect.objectContaining({
                level: "info",
                subscriptionId: subscription.id,
                fields: { discarded: 2, reason: "clientClosed" },
            }),
        ])
        expect(test.client.diagnostics().counters.eventsDropped.closed).toBe(2)
    })

    test("closing a subscription records the waiting events it drops at Debug", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const test = await Effect.runPromise(
            createNativeTestClient({ logging: { categories: { events: "debug" } } }).pipe(Scope.provide(scope)),
        )
        const subscription = await Effect.runPromise(
            test.client.on("messageCreate", () => Effect.never).pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        for (const content of ["first", "second", "third"])
            await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content })))
        await vi.waitFor(() => expect(test.client.diagnostics().events.activeHandlers).toBe(1))
        await Effect.runPromise(subscription.close())
        await Effect.runPromise(subscription.waitForClose())
        expect(test.logs().filter((record) => record.code === "events.discarded")).toEqual([
            expect.objectContaining({
                level: "debug",
                subscriptionId: subscription.id,
                fields: { discarded: 2, reason: "subscriptionClosed" },
            }),
        ])
        expect(test.client.diagnostics().counters.eventsDropped.closed).toBe(2)
    })

    test("a handler that starts a draining shutdown ends at once instead of holding the drain open", async () => {
        const { test, scope } = await openNative()
        await Effect.runPromise(
            test.client.on("typingStart", () => test.client.shutdown({ drainMs: 60_000 })).pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        fakeHostTime()
        await Effect.runPromise(test.emit("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 }))
        let completed = false
        const closed = Effect.runPromise(test.client.waitForClose()).finally(() => {
            completed = true
        })
        await hostTurnsUntil(() => completed)
        await closed
        expect(performance.now()).toBe(0)
        expect(codes(test.logs())).not.toContain("lifecycle.drainTimedOut")
    })

    test("invalid shutdown options are a defect carrying ConfigurationError", async () => {
        const { test } = await openNative()
        const exit = await Effect.runPromiseExit(test.client.shutdown({ drainMs: -1 }))
        expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
            _tag: "Die",
            defect: expect.objectContaining({ _tag: "ConfigurationError", field: "drainMs" }),
        })
        expect(test.client.state).toBe("Disconnected")
    })

    test("runBot drains running handlers when its signal stops the bot", async () => {
        const harness = new TestHarness({})
        onTestFinished(() => void harness.close())
        harness.http.respond("POST /channels/:id/messages", { body: harness.fixtures.message({ content: "done" }) })
        const controller = new AbortController()
        const gate = Deferred.makeUnsafe<void>()
        const started = Deferred.makeUnsafe<void>()
        const outcomes: boolean[] = []
        const run = Effect.runFork(
            runNativeBot({
                ...harness.clientOptions({}),
                signal: controller.signal,
                events: {
                    messageCreate: ({ reply }) =>
                        Deferred.succeed(started, undefined).pipe(
                            Effect.andThen(Deferred.await(gate)),
                            Effect.andThen(reply("done")),
                            Effect.exit,
                            Effect.map((exit) => void outcomes.push(Exit.isSuccess(exit))),
                        ),
                },
            }),
        )
        await vi.waitFor(() => harness.gateway.emit("MESSAGE_CREATE", harness.fixtures.message(), undefined))
        await Effect.runPromise(Deferred.await(started))
        controller.abort()
        await vi.waitFor(() => expect(codes(harness.logs())).toContain("lifecycle.draining"))
        Deferred.doneUnsafe(gate, Effect.void)
        expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(run)))).toBe(true)
        expect(outcomes).toEqual([true])
    })
})
