import { Cause, Deferred, Effect, Exit, Scope } from "effect"
import { err } from "neverthrow"
import { describe, expect, onTestFinished, test } from "vitest"
import { commands, ConfigurationError, type FailureReport } from "../../src/index.js"
import { commands as nativeCommands } from "../../src/effect.js"
import { snapshotBotCommandDelivery } from "../../src/internal/bot-runner.js"
import { createTestBot, createTestClient } from "../../src/testing.js"
import {
    createTestBot as createNativeTestBot,
    createTestClient as createNativeTestClient,
} from "../../src/effect-testing.js"
import { waitUntil } from "../support/clock.js"

/** Two channels, so partition "channel" gives the commands two keys */
const channels = { a: "1001", b: "1002" } as const

/** The error a native Effect failed or died with, instead of the FiberFailure wrapper */
async function unwrap<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
}

/** Run an Effect that must die, and return the defects it died with, so a failure in the error channel does not pass */
async function defects(effect: Effect.Effect<unknown, unknown>): Promise<readonly unknown[]> {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) throw new Error("The Effect succeeded")
    expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(["Die"])
    return exit.cause.reasons.flatMap((reason) => (reason._tag === "Die" ? [reason.defect] : []))
}

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

describe("default API partitionReady for commands", () => {
    test("a held key uses no command slot, and its commands run in receive order once the key is ready", async () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const ready = readiness()
        const ran: string[] = []
        // One slot only: a held key that used it would stall the other key
        commands
            .create({ prefix: "!" })
            .register({ name: "go", execute: ({ message }) => void ran.push(`${message.channelId}:${message.id}`) })
            .attach(test.client, {
                concurrency: 1,
                partition: "channel",
                partitionReady: (key) => {
                    ready.calls.push(key)
                    return key === channels.a ? ready.gate(key).promise : undefined
                },
            })
        await test.ready()
        const sent = [channels.a, channels.b, channels.a, channels.b].map((channel_id) => {
            const message = test.fixtures.message({ content: "!go", channel_id })
            test.emit("MESSAGE_CREATE", message)
            return `${channel_id}:${message.id}`
        })
        await waitUntil(() => ran.length === 2 && test.client.diagnostics().events.activeHandlers === 0)
        expect(ran).toEqual([sent[1], sent[3]])
        ready.gate(channels.a).resolve()
        await waitUntil(() => ran.length === 4)
        expect(ran).toEqual([sent[1], sent[3], sent[0], sent[2]])
        // Each key's hook ran once for its burst
        expect(ready.calls.toSorted()).toEqual([channels.a, channels.b])
    })

    test("a failing hook reports its waiting messages to the commands onError only, and runs no command", async () => {
        const clientReports: FailureReport[] = []
        const test = createTestClient({ onError: (report) => void clientReports.push(report) })
        onTestFinished(() => test.shutdown())
        const failure = new Error("setup failed")
        const attempt = Promise.withResolvers<void>()
        const reports: FailureReport[] = []
        const ran: string[] = []
        let received = 0
        commands
            .create({ prefix: "!" })
            .register({ name: "go", execute: ({ message }) => void ran.push(message.id) })
            .attach(test.client, {
                // The attach options type the payload as unknown
                partition: (message) => {
                    received++
                    return (message as { readonly channelId: string }).channelId
                },
                partitionReady: () => attempt.promise,
                onError: (report) => void reports.push(report),
            })
        await test.ready()
        for (let index = 0; index < 2; index++)
            test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!go", channel_id: channels.a }))
        // The partition function runs when a message is received, so both are waiting once it ran twice
        await waitUntil(() => received === 2)
        attempt.reject(failure)
        await waitUntil(() => reports.length === 2)
        expect(reports.map((report) => [report.kind, report.event, report.error])).toEqual([
            ["handler", "messageCreate", failure],
            ["handler", "messageCreate", failure],
        ])
        expect(ran).toEqual([])
        expect(clientReports).toEqual([])
    })

    test("a hook that returns an Err result and a throwing partition function reach the commands onError", async () => {
        const clientReports: FailureReport[] = []
        const test = createTestClient({ onError: (report) => void clientReports.push(report) })
        onTestFinished(() => test.shutdown())
        const rejected = new Error("setup rejected")
        const partitionFailure = new Error("no key")
        const reports: FailureReport[] = []
        commands
            .create({ prefix: "!" })
            .register({ name: "go", execute: () => undefined })
            .attach(test.client, {
                partition: (message) => {
                    if ((message as { readonly channelId: string }).channelId === channels.b) throw partitionFailure
                    return channels.a
                },
                partitionReady: () => err(rejected),
                onError: (report) => void reports.push(report),
            })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!go", channel_id: channels.a }))
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!go", channel_id: channels.b }))
        await waitUntil(() => reports.length === 2)
        expect(reports.map((report) => report.error)).toEqual(expect.arrayContaining([partitionFailure, rejected]))
        expect(clientReports).toEqual([])
    })

    test("the hook is misuse without a partition, or when it is not a function", () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const router = commands.create({ prefix: "!" }).register({ name: "go", execute: () => undefined })
        expect(() => router.attach(test.client, { partitionReady: () => undefined })).toThrow(
            expect.objectContaining({ _tag: "ConfigurationError", field: "partitionReady" }),
        )
        expect(() => router.attach(test.client, { partition: "channel", partitionReady: "ready" as never })).toThrow(
            expect.objectContaining({ _tag: "ConfigurationError", field: "partitionReady" }),
        )
    })

    test("runBot commands take the hook, and reject it without a partition", async () => {
        const ready = readiness()
        const ran: string[] = []
        const test = createTestBot({
            commands: {
                prefix: "!",
                concurrency: 1,
                partition: "channel",
                partitionReady: (key) => ready.gate(key).promise,
                commands: { go: { execute: ({ message }) => void ran.push(`${message.channelId}:${message.id}`) } },
            },
        })
        onTestFinished(() => test.shutdown())
        await test.ready()
        const first = test.fixtures.message({ content: "!go", channel_id: channels.a })
        const second = test.fixtures.message({ content: "!go", channel_id: channels.b })
        test.emit("MESSAGE_CREATE", first)
        test.emit("MESSAGE_CREATE", second)
        ready.gate(channels.b).resolve()
        await waitUntil(() => ran.length === 1)
        expect(ran).toEqual([`${channels.b}:${second.id}`])
        ready.gate(channels.a).resolve()
        await waitUntil(() => ran.length === 2)
        expect(ran).toEqual([`${channels.b}:${second.id}`, `${channels.a}:${first.id}`])
        expect(() => snapshotBotCommandDelivery({ partitionReady: () => undefined })).toThrow(
            expect.objectContaining({ _tag: "ConfigurationError", field: "partitionReady" }),
        )
        expect(() => snapshotBotCommandDelivery({ partition: "guild", partitionReady: "ready" })).toThrow(
            ConfigurationError,
        )
        expect(() =>
            createTestBot({
                commands: {
                    prefix: "!",
                    partitionReady: () => undefined,
                    commands: { go: { execute: () => undefined } },
                } as never,
            }),
        ).toThrow(expect.objectContaining({ _tag: "ConfigurationError", field: "partitionReady" }))
    })

    test("runBot commands report a failing hook to commands.onError only", async () => {
        const clientReports: FailureReport[] = []
        const reports: FailureReport[] = []
        const failure = new Error("setup failed")
        const test = createTestBot({
            onError: (report) => void clientReports.push(report),
            commands: {
                prefix: "!",
                partition: "channel",
                partitionReady: () => Promise.reject(failure),
                onError: (report) => void reports.push(report),
                commands: { go: { execute: () => undefined } },
            },
        })
        onTestFinished(() => test.shutdown())
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!go", channel_id: channels.a }))
        await waitUntil(() => reports.length === 1)
        expect(reports[0]).toMatchObject({ kind: "handler", event: "messageCreate", error: failure })
        expect(clientReports).toEqual([])
    })
})

describe("native API partitionReady for commands", () => {
    test("a held key waits without a slot and runs once ready, and the hook is interrupted when the subscription closes", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const test = await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
        const gate = Deferred.makeUnsafe<void>()
        const interrupted = Deferred.makeUnsafe<void>()
        const ran: string[] = []
        const calls: string[] = []
        const subscription = await Effect.runPromise(
            nativeCommands
                .create({ prefix: "!" })
                .register({ name: "go", execute: ({ message }) => Effect.sync(() => void ran.push(message.id)) })
                .attach(test.client, {
                    concurrency: 1,
                    partition: "channel",
                    partitionReady: (key) => {
                        calls.push(key)
                        if (key === channels.b) return Effect.void
                        return key === channels.a
                            ? Deferred.await(gate)
                            : Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
                    },
                })
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        const sent = [channels.a, channels.b, channels.a].map((channel_id) =>
            test.fixtures.message({ content: "!go", channel_id }),
        )
        for (const message of sent) await Effect.runPromise(test.emit("MESSAGE_CREATE", message))
        await waitUntil(() => ran.length === 1)
        expect(ran).toEqual([sent[1]!.id])
        Deferred.doneUnsafe(gate, Effect.void)
        await waitUntil(() => ran.length === 3)
        expect(ran).toEqual([sent[1]!.id, sent[0]!.id, sent[2]!.id])
        // A key whose hook never finishes is interrupted when the subscription closes
        await Effect.runPromise(
            test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!go", channel_id: "1003" })),
        )
        await waitUntil(() => calls.includes("1003"))
        await Effect.runPromise(subscription.close())
        await Effect.runPromise(Deferred.await(interrupted))
    })

    test("a failing hook reports its waiting messages to the commands onError only, and runs no command", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const clientReports: FailureReport[] = []
        const test = await Effect.runPromise(
            createNativeTestClient({ onError: (report) => Effect.sync(() => void clientReports.push(report)) }).pipe(
                Scope.provide(scope),
            ),
        )
        const reports: FailureReport[] = []
        const ran: string[] = []
        await Effect.runPromise(
            nativeCommands
                .create({ prefix: "!" })
                .register({ name: "go", execute: ({ message }) => Effect.sync(() => void ran.push(message.id)) })
                .attach(test.client, {
                    partition: "channel",
                    partitionReady: () => Effect.fail("not ready"),
                    onError: (report) => Effect.sync(() => void reports.push(report)),
                })
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        await Effect.runPromise(
            test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!go", channel_id: channels.a })),
        )
        await waitUntil(() => reports.length === 1)
        expect(reports[0]).toMatchObject({ kind: "handler", event: "messageCreate", error: "not ready" })
        expect(ran).toEqual([])
        expect(clientReports).toEqual([])
    })

    test("runBot commands report a failing hook to commands.onError only", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const clientReports: FailureReport[] = []
        const reports: FailureReport[] = []
        const test = await unwrap(
            createNativeTestBot({
                onError: (report) => Effect.sync(() => void clientReports.push(report)),
                commands: {
                    prefix: "!",
                    partition: "channel",
                    partitionReady: () => Effect.fail("not ready"),
                    onError: (report: FailureReport) => Effect.sync(() => void reports.push(report)),
                    commands: { go: { execute: () => Effect.void } },
                },
            }).pipe(Scope.provide(scope)),
        )
        await unwrap(test.ready())
        await unwrap(test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!go", channel_id: channels.a })))
        await waitUntil(() => reports.length === 1)
        expect(reports[0]).toMatchObject({ kind: "handler", event: "messageCreate", error: "not ready" })
        expect(clientReports).toEqual([])
    })

    test("the hook is misuse without a partition, and dies with ConfigurationError", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const test = await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
        const attached = nativeCommands
            .create({ prefix: "!" })
            .register({ name: "go", execute: () => Effect.void })
            .attach(test.client, { partitionReady: () => Effect.void })
            .pipe(Scope.provide(scope))
        expect(await defects(attached)).toEqual([
            expect.objectContaining({ _tag: "ConfigurationError", field: "partitionReady" }),
        ])
    })

    test("runBot commands take the hook, and reject it without a partition", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const gates = new Map<string, Deferred.Deferred<void>>()
        const gate = (key: string) => {
            let entry = gates.get(key)
            if (!entry) gates.set(key, (entry = Deferred.makeUnsafe<void>()))
            return entry
        }
        const ran: string[] = []
        const test = await unwrap(
            createNativeTestBot({
                commands: {
                    prefix: "!",
                    concurrency: 1,
                    partition: "channel",
                    partitionReady: (key: string) => Deferred.await(gate(key)),
                    commands: {
                        go: {
                            execute: ({ message }) =>
                                Effect.sync(() => void ran.push(`${message.channelId}:${message.id}`)),
                        },
                    },
                },
            }).pipe(Scope.provide(scope)),
        )
        await unwrap(test.ready())
        const first = test.fixtures.message({ content: "!go", channel_id: channels.a })
        const second = test.fixtures.message({ content: "!go", channel_id: channels.b })
        await unwrap(test.emit("MESSAGE_CREATE", first))
        await unwrap(test.emit("MESSAGE_CREATE", second))
        Deferred.doneUnsafe(gate(channels.b), Effect.void)
        await waitUntil(() => ran.length === 1)
        expect(ran).toEqual([`${channels.b}:${second.id}`])
        Deferred.doneUnsafe(gate(channels.a), Effect.void)
        await waitUntil(() => ran.length === 2)
        expect(ran).toEqual([`${channels.b}:${second.id}`, `${channels.a}:${first.id}`])
        const misuse = createNativeTestBot({
            commands: {
                prefix: "!",
                partitionReady: () => Effect.void,
                commands: { go: { execute: () => Effect.void } },
            } as never,
        }).pipe(Scope.provide(scope))
        expect(await defects(misuse)).toEqual([
            expect.objectContaining({ _tag: "ConfigurationError", field: "partitionReady" }),
        ])
    })
})
