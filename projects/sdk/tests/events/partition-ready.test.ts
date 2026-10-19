import { Deferred, Effect, Exit, Scope } from "effect"
import { describe, expect, onTestFinished, test } from "vitest"
import { ConfigurationError, type FailureReport } from "../../src/index.js"
import { snapshotBotEvents } from "../../src/internal/bot-runner.js"
import { createTestBot, createTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { waitUntil } from "../support/clock.js"

/** A message whose content is "<key>:<label>", keyed by the part before the colon */
const keyOf = (message: { readonly content: string }) => message.content.split(":")[0]!

/** One deferred per key, so a test decides when each key becomes ready */
function readiness() {
    const gates = new Map<string, PromiseWithResolvers<void>>()
    const gate = (key: string) => {
        let entry = gates.get(key)
        if (!entry) gates.set(key, (entry = Promise.withResolvers<void>()))
        return entry
    }
    return { gate, calls: [] as string[] }
}

describe("default API partitionReady", () => {
    test("a held key uses no handler slot, and its events then run in receive order once, per burst", async () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const ready = readiness()
        const handled: string[] = []
        // One slot only: a held key that used it would stall every other key
        test.client.on("messageCreate", (message) => void handled.push(message.content), {
            concurrency: 1,
            partition: keyOf,
            partitionReady: (key) => {
                ready.calls.push(key)
                return key === "a" ? ready.gate(key).promise : undefined
            },
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:1" }))
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "b:1" }))
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:2" }))
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "b:2" }))
        await waitUntil(() => handled.length === 2 && test.client.diagnostics().events.activeHandlers === 0)
        expect(handled).toEqual(["b:1", "b:2"])
        ready.gate("a").resolve()
        await waitUntil(() => handled.length === 4)
        expect(handled).toEqual(["b:1", "b:2", "a:1", "a:2"])
        // Each key's hook ran once for its burst
        expect(ready.calls.toSorted()).toEqual(["a", "b"])
    })

    test("a key that went idle calls the hook again for its next event", async () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const calls: string[] = []
        const handled: string[] = []
        test.client.on("messageCreate", (message) => void handled.push(message.content), {
            partition: keyOf,
            partitionReady: (key) => void calls.push(key),
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:1" }))
        await waitUntil(() => handled.length === 1 && test.client.diagnostics().events.activeHandlers === 0)
        expect(calls).toEqual(["a"])
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:2" }))
        await waitUntil(() => handled.length === 2)
        expect(calls).toEqual(["a", "a"])
    })

    test("a hook returning a plain value or an already settled promise marks the key ready", async () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const handled: string[] = []
        test.client.on("messageCreate", (message) => void handled.push(message.content), {
            partition: keyOf,
            partitionReady: (key) => (key === "t" ? Promise.resolve() : "ready"),
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "v:1" }))
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "t:1" }))
        await waitUntil(() => handled.length === 2)
        expect(handled.toSorted()).toEqual(["t:1", "v:1"])
    })

    test("a rejecting hook reports each waiting event as a handler failure, and a later event calls it again", async () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const failure = new Error("setup failed")
        const reports: FailureReport[] = []
        const handled: string[] = []
        const attempts: PromiseWithResolvers<void>[] = []
        let keyCalls = 0
        test.client.on("messageCreate", (message) => void handled.push(message.content), {
            partition: (message) => {
                keyCalls++
                return keyOf(message)
            },
            partitionReady: () => {
                const attempt = Promise.withResolvers<void>()
                attempts.push(attempt)
                return attempt.promise
            },
            onError: (report) => void reports.push(report),
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:1" }))
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:2" }))
        // The partition function runs when an event is received, so both are waiting once it ran twice
        await waitUntil(() => keyCalls === 2 && attempts.length === 1)
        attempts[0]!.reject(failure)
        await waitUntil(() => reports.length === 2)
        expect(reports.map((report) => [report.kind, report.error])).toEqual([
            ["handler", failure],
            ["handler", failure],
        ])
        expect(handled).toEqual([])
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:3" }))
        await waitUntil(() => attempts.length === 2)
        attempts[1]!.resolve()
        await waitUntil(() => handled.length === 1)
        expect(handled).toEqual(["a:3"])
        expect(test.counters().handlerFailures).toBe(2)
    })

    test("the signal aborts when the subscription closes", async () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const signals: AbortSignal[] = []
        const subscription = test.client.on("messageCreate", () => undefined, {
            partition: keyOf,
            partitionReady: (_key, signal) => {
                signals.push(signal)
                return new Promise<void>(() => undefined)
            },
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:1" }))
        await waitUntil(() => signals.length === 1)
        expect(signals[0]!.aborted).toBe(false)
        subscription.close()
        await waitUntil(() => signals[0]!.aborted)
    })

    test("the signal aborts when the client shuts down", async () => {
        const test = createTestClient()
        const signals: AbortSignal[] = []
        test.client.on("messageCreate", () => undefined, {
            partition: keyOf,
            partitionReady: (_key, signal) => {
                signals.push(signal)
                return new Promise<void>(() => undefined)
            },
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:1" }))
        await waitUntil(() => signals.length === 1)
        await test.shutdown()
        expect(signals[0]!.aborted).toBe(true)
    })

    test("held events count as waiting work for a draining shutdown", async () => {
        const test = createTestClient()
        const ready = readiness()
        const handled: string[] = []
        test.client.on("messageCreate", (message) => void handled.push(message.content), {
            partition: keyOf,
            partitionReady: (key) => {
                ready.calls.push(key)
                return ready.gate(key).promise
            },
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:1" }))
        await waitUntil(() => ready.calls.length === 1)
        const draining = test.client.shutdown({ drainMs: 60_000 })
        ready.gate("a").resolve()
        await draining
        expect(handled).toEqual(["a:1"])
    })

    test("a hook is misuse without a partition, or when it is not a function", () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        expect(() => test.client.on("messageCreate", () => undefined, { partitionReady: () => undefined })).toThrow(
            expect.objectContaining({ _tag: "ConfigurationError", field: "partitionReady" }),
        )
        expect(() =>
            test.client.on("messageCreate", () => undefined, {
                partition: "channel",
                partitionReady: "ready" as never,
            }),
        ).toThrow(expect.objectContaining({ _tag: "ConfigurationError", field: "partitionReady" }))
    })

    test("misuse on a closing client throws before the closed subscription is logged", async () => {
        const test = createTestClient()
        await test.shutdown()
        expect(() => test.client.on("messageCreate", () => undefined, { partitionReady: () => undefined })).toThrow(
            expect.objectContaining({ _tag: "ConfigurationError", field: "partitionReady" }),
        )
        expect(test.logs().map((record) => record.code)).not.toContain("events.registeredAfterShutdown")
    })

    test("a runBot event handler takes the hook, and runBot rejects it without a partition", async () => {
        const ready = readiness()
        const handled: string[] = []
        const test = createTestBot({
            events: {
                messageCreate: {
                    partition: keyOf,
                    partitionReady: (key) => ready.gate(key).promise,
                    handler: ({ message }) => void handled.push(message.content),
                },
            },
        })
        onTestFinished(() => test.shutdown())
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:1" }))
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "b:1" }))
        ready.gate("b").resolve()
        await waitUntil(() => handled.length === 1)
        expect(handled).toEqual(["b:1"])
        ready.gate("a").resolve()
        await waitUntil(() => handled.length === 2)
        expect(handled).toEqual(["b:1", "a:1"])
        expect(() =>
            snapshotBotEvents({ messageCreate: { partitionReady: () => undefined, handler: () => undefined } }),
        ).toThrow(expect.objectContaining({ _tag: "ConfigurationError", field: "partitionReady" }))
        expect(() =>
            snapshotBotEvents({
                messageCreate: { partition: "guild", partitionReady: "ready", handler: () => undefined },
            }),
        ).toThrow(ConfigurationError)
    })
})

describe("scripted restart", () => {
    test("many starting servers drop nothing and each server's events run once in order", async () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const servers = Array.from({ length: 50 }, (_, index) => `g${index}`)
        const perServer = 3
        const ready = readiness()
        const handled = new Map<string, string[]>()
        let all = 0
        test.client.on(
            "messageCreate",
            (message) => {
                const key = keyOf(message)
                handled.set(key, [...(handled.get(key) ?? []), message.content])
                all++
            },
            {
                concurrency: 8,
                partition: keyOf,
                partitionReady: (key) => {
                    ready.calls.push(key)
                    return ready.gate(key).promise
                },
            },
        )
        await test.ready()
        // Interleave the servers: one event of each, then the next round
        for (let round = 1; round <= perServer; round++)
            for (const server of servers)
                test.emit("MESSAGE_CREATE", test.fixtures.message({ content: `${server}:${round}` }))
        // Every server is waiting on its own setup, which holds no handler slot
        await waitUntil(() => ready.calls.length === servers.length)
        expect(all).toBe(0)
        expect(test.client.diagnostics().events.activeHandlers).toBe(0)
        // Servers finish starting in a scripted order: the odd ones backwards, then the even ones
        const order = [
            ...servers.filter((_, index) => index % 2 === 1).reverse(),
            ...servers.filter((_, i) => i % 2 === 0),
        ]
        for (const server of order) ready.gate(server).resolve()
        await waitUntil(() => all === servers.length * perServer)
        for (const server of servers)
            expect(handled.get(server)).toEqual([1, 2, 3].map((round) => `${server}:${round}`))
        expect(test.counters().eventsDropped.overflow).toBe(0)
        expect(test.counters().eventsDroppedByEvent).toEqual({})
    })
})

describe("native API partitionReady", () => {
    test("a held key waits without a slot, runs once ready, and the hook is interrupted on close", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const test = await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
        const gate = Deferred.makeUnsafe<void>()
        const interrupted = Deferred.makeUnsafe<void>()
        const handled: string[] = []
        const calls: string[] = []
        const subscription = await Effect.runPromise(
            test.client
                .on("messageCreate", (message) => Effect.sync(() => void handled.push(message.content)), {
                    concurrency: 1,
                    partition: keyOf,
                    partitionReady: (key) => {
                        calls.push(key)
                        if (key === "b") return Effect.void
                        return key === "a"
                            ? Deferred.await(gate)
                            : Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
                    },
                })
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        for (const content of ["a:1", "b:1", "a:2"])
            await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content })))
        await waitUntil(() => handled.length === 1)
        expect(handled).toEqual(["b:1"])
        Deferred.doneUnsafe(gate, Effect.void)
        await waitUntil(() => handled.length === 3)
        expect(handled).toEqual(["b:1", "a:1", "a:2"])
        // A key whose hook never finishes is interrupted when the subscription closes
        await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "c:1" })))
        await waitUntil(() => calls.includes("c"))
        await Effect.runPromise(subscription.close())
        await Effect.runPromise(Deferred.await(interrupted))
    })

    test("a failing hook reports its waiting events as handler failures", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const test = await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
        const reports: FailureReport[] = []
        const handled: string[] = []
        await Effect.runPromise(
            test.client
                .on("messageCreate", (message) => Effect.sync(() => void handled.push(message.content)), {
                    partition: keyOf,
                    partitionReady: () => Effect.fail("not ready"),
                    onError: (report) => Effect.sync(() => void reports.push(report)),
                })
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        await Effect.runPromise(test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a:1" })))
        await waitUntil(() => reports.length === 1)
        expect(reports[0]).toMatchObject({ kind: "handler", event: "messageCreate", error: "not ready" })
        expect(handled).toEqual([])
    })
})
