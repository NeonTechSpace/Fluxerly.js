import { Deferred, Effect, Exit, Scope } from "effect"
import { describe, expect, onTestFinished, test } from "vitest"
import { commands, type FailureReport } from "../../src/index.js"
import { commands as nativeCommands } from "../../src/effect.js"
import { createTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { waitUntil } from "../support/clock.js"

/** Reports of a router's own subscription (a failing partitionReady hook, a throwing partition function, overflow) and
 * the router's command failures share the router's onError queue: one delivery order, one log record and one count
 * per report
 */

const channels = { a: "1001", b: "1002" } as const
const logging = { level: "debug", dedupe: false } as const

describe("default API router subscription reports", () => {
    test("a setup failure and a later command failure arrive in order, are logged once and counted once", async () => {
        const clientReports: FailureReport[] = []
        const test = createTestClient({ logging, onError: (report) => void clientReports.push(report) })
        onTestFinished(() => test.shutdown())
        const setup = Promise.withResolvers<void>()
        const execution = Promise.withResolvers<void>()
        onTestFinished(() => execution.resolve())
        let admitted = 0
        let executing = false
        const reports: FailureReport[] = []
        const subscription = commands
            .create({ prefix: "!" })
            .register({ name: "go", execute: () => undefined })
            .register({
                name: "boom",
                execute: async () => {
                    executing = true
                    await execution.promise
                    throw new Error("boom")
                },
            })
            .attach(test.client, {
                // The attach options type the payload as unknown
                partition: (message) => {
                    admitted++
                    return (message as { readonly channelId: string }).channelId
                },
                partitionReady: (key) => (key === channels.a ? setup.promise : undefined),
                onError: (report) => void reports.push(report),
            })
        await test.ready()
        const a1 = test.fixtures.message({ content: "!go", channel_id: channels.a })
        const a2 = test.fixtures.message({ content: "!go", channel_id: channels.a })
        const b = test.fixtures.message({ content: "!boom", channel_id: channels.b })
        test.emit("MESSAGE_CREATE", a1)
        test.emit("MESSAGE_CREATE", a2)
        test.emit("MESSAGE_CREATE", b)
        await waitUntil(() => admitted === 3 && executing)
        // One synchronous turn: the setup of A fails and B's command is released to fail
        setup.reject(new Error("setup"))
        execution.resolve()
        await waitUntil(() => reports.length === 3)
        expect(reports.map((report) => report.message?.id)).toEqual([a1.id, a2.id, b.id])
        expect(reports.map((report) => report.command)).toEqual([undefined, undefined, "boom"])
        expect(reports.every((report) => report.subscriptionId === subscription.id)).toBe(true)
        await test.idle()
        expect(clientReports).toEqual([])
        expect(test.counters().handlerFailures).toBe(3)
        const records = test.logs().filter((record) => record.subscriptionId === subscription.id)
        expect(records.filter((record) => record.code === "events.handlerFailed")).toHaveLength(2)
        expect(records.filter((record) => record.code === "commands.failed")).toHaveLength(1)
    })

    test("overflow with overflow stop reaches the router onError", async () => {
        const clientReports: FailureReport[] = []
        const test = createTestClient({ onError: (report) => void clientReports.push(report) })
        onTestFinished(() => test.shutdown())
        const hold = Promise.withResolvers<void>()
        onTestFinished(() => hold.resolve())
        const reports: FailureReport[] = []
        const subscription = commands
            .create({ prefix: "!" })
            .register({ name: "go", execute: () => hold.promise })
            .attach(test.client, {
                concurrency: 1,
                maxPendingMessages: 1,
                overflow: "stop",
                onError: (report) => void reports.push(report),
            })
        await test.ready()
        for (let index = 0; index < 3; index++)
            test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!go", channel_id: channels.a }))
        await waitUntil(() => reports.length === 1)
        expect(reports[0]).toMatchObject({ kind: "overflow", event: "messageCreate", subscriptionId: subscription.id })
        expect(clientReports).toEqual([])
    })
})

describe("native API router subscription reports", () => {
    test("a setup failure and a later command failure arrive in order, are logged once and counted once", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const clientReports: FailureReport[] = []
        const test = await Effect.runPromise(
            createNativeTestClient({
                logging,
                onError: (report) => Effect.sync(() => void clientReports.push(report)),
            }).pipe(Scope.provide(scope)),
        )
        const setup = Deferred.makeUnsafe<void, string>()
        const execution = Deferred.makeUnsafe<void>()
        onTestFinished(() => void Deferred.doneUnsafe(execution, Effect.void))
        let admitted = 0
        let executing = false
        const reports: FailureReport[] = []
        const subscription = await Effect.runPromise(
            nativeCommands
                .create({ prefix: "!" })
                .register({ name: "go", execute: () => Effect.void })
                .register({
                    name: "boom",
                    execute: () =>
                        Effect.gen(function* () {
                            executing = true
                            yield* Deferred.await(execution)
                            return yield* Effect.fail("boom")
                        }),
                })
                .attach(test.client, {
                    // The attach options type the payload as unknown
                    partition: (message) => {
                        admitted++
                        return (message as { readonly channelId: string }).channelId
                    },
                    partitionReady: (key) => (key === channels.a ? Deferred.await(setup) : Effect.void),
                    onError: (report) => Effect.sync(() => void reports.push(report)),
                })
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        const a1 = test.fixtures.message({ content: "!go", channel_id: channels.a })
        const a2 = test.fixtures.message({ content: "!go", channel_id: channels.a })
        const b = test.fixtures.message({ content: "!boom", channel_id: channels.b })
        for (const message of [a1, a2, b]) await Effect.runPromise(test.emit("MESSAGE_CREATE", message))
        await waitUntil(() => admitted === 3 && executing)
        // One synchronous turn: the setup of A fails and B's command is released to fail
        Deferred.doneUnsafe(setup, Effect.fail("setup"))
        Deferred.doneUnsafe(execution, Effect.void)
        await waitUntil(() => reports.length === 3)
        expect(reports.map((report) => report.message?.id)).toEqual([a1.id, a2.id, b.id])
        expect(reports.map((report) => report.command)).toEqual([undefined, undefined, "boom"])
        expect(reports.every((report) => report.subscriptionId === subscription.id)).toBe(true)
        await Effect.runPromise(test.idle())
        expect(clientReports).toEqual([])
        expect(test.counters().handlerFailures).toBe(3)
        const records = test.logs().filter((record) => record.subscriptionId === subscription.id)
        expect(records.filter((record) => record.code === "events.handlerFailed")).toHaveLength(2)
        expect(records.filter((record) => record.code === "commands.failed")).toHaveLength(1)
    })

    test("a throwing partition function and overflow reach the router onError", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const clientReports: FailureReport[] = []
        const test = await Effect.runPromise(
            createNativeTestClient({ onError: (report) => Effect.sync(() => void clientReports.push(report)) }).pipe(
                Scope.provide(scope),
            ),
        )
        const failure = new Error("no key")
        const reports: FailureReport[] = []
        await Effect.runPromise(
            nativeCommands
                .create({ prefix: "!" })
                .register({ name: "go", execute: () => Effect.void })
                .attach(test.client, {
                    partition: () => {
                        throw failure
                    },
                    onError: (report) => Effect.sync(() => void reports.push(report)),
                })
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        await Effect.runPromise(
            test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!go", channel_id: channels.a })),
        )
        await waitUntil(() => reports.length === 1)
        expect(reports[0]).toMatchObject({ kind: "handler", event: "messageCreate", error: failure })
        expect(clientReports).toEqual([])
    })

    test("overflow with overflow stop reaches the router onError", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const clientReports: FailureReport[] = []
        const test = await Effect.runPromise(
            createNativeTestClient({ onError: (report) => Effect.sync(() => void clientReports.push(report)) }).pipe(
                Scope.provide(scope),
            ),
        )
        const hold = Deferred.makeUnsafe<void>()
        onTestFinished(() => void Deferred.doneUnsafe(hold, Effect.void))
        const reports: FailureReport[] = []
        const subscription = await Effect.runPromise(
            nativeCommands
                .create({ prefix: "!" })
                .register({ name: "go", execute: () => Deferred.await(hold) })
                .attach(test.client, {
                    concurrency: 1,
                    maxPendingMessages: 1,
                    overflow: "stop",
                    onError: (report) => Effect.sync(() => void reports.push(report)),
                })
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        for (let index = 0; index < 3; index++)
            await Effect.runPromise(
                test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!go", channel_id: channels.a })),
            )
        await waitUntil(() => reports.length === 1)
        expect(reports[0]).toMatchObject({ kind: "overflow", event: "messageCreate", subscriptionId: subscription.id })
        expect(clientReports).toEqual([])
    })
})
