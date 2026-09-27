// Registration during shutdown is a runtime race, not misuse: a handler still running when shutdown begins can register
// a subscription or collector. Both APIs return an already-closed handle instead of throwing or dying, invalid
// arguments stay misuse, and the late registration is recorded rather than silent
import { Effect, Exit, Scope, Stream } from "effect"
import { expect, test } from "vitest"
import { ClientClosedError, commands, ConfigurationError, createClient, type Client } from "../../src/index.js"
import {
    commands as nativeCommands,
    createClient as createNative,
    type Client as NativeClient,
} from "../../src/effect.js"
import { createTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { fixtureToken } from "../support/both-apis.js"
import { captureLogs } from "../support/log-capture.js"

const lateCode = "events.registeredAfterShutdown"

/** Register every subscription and collector kind on a default client and read each handle's outcome */
async function registerDefault(client: Client) {
    const handled: unknown[] = []
    const on = client.on("messageCreate", (message) => {
        handled.push(message)
    })
    const subscription = client.subscribe("messageCreate")
    const collector = client.messages.collect("20")
    const reactions = client.messages.collectReactions({ id: "10", channelId: "20" })
    return {
        handled,
        onClosed: await on.waitForClose(),
        next: await subscription.next(),
        subscriptionClosed: await subscription.waitForClose(),
        collected: await collector.result(),
        reactions: await reactions.result(),
    }
}

function expectDefaultClosed(outcome: Awaited<ReturnType<typeof registerDefault>>) {
    expect(outcome.handled).toEqual([])
    expect(outcome.onClosed.isOk()).toBe(true)
    expect(outcome.next._unsafeUnwrap()).toBeNull()
    expect(outcome.subscriptionClosed.isOk()).toBe(true)
    expect(outcome.collected._unsafeUnwrapErr()).toBeInstanceOf(ClientClosedError)
    expect(outcome.reactions._unsafeUnwrapErr()).toBeInstanceOf(ClientClosedError)
}

/** Register every subscription and collector kind on a native client and read each handle's outcome */
const registerNative = (client: NativeClient) =>
    Effect.scoped(
        Effect.gen(function* () {
            const handled: unknown[] = []
            const on = yield* client.on("messageCreate", (message) => Effect.sync(() => handled.push(message)))
            const streamed = yield* Stream.runCollect(client.subscribe("messageCreate"))
            const collector = yield* client.messages.collect("20")
            const reactions = yield* client.messages.collectReactions({ id: "10", channelId: "20" })
            return {
                handled,
                onClosed: yield* Effect.exit(on.waitForClose()),
                streamed,
                collected: yield* Effect.exit(collector.result()),
                reactions: yield* Effect.exit(reactions.result()),
            }
        }),
    )

function expectNativeClosed(outcome: Effect.Success<ReturnType<typeof registerNative>>) {
    expect(outcome.handled).toEqual([])
    expect(Exit.isSuccess(outcome.onClosed)).toBe(true)
    expect(outcome.streamed).toEqual([])
    for (const exit of [outcome.collected, outcome.reactions] as readonly Exit.Exit<unknown, unknown>[]) {
        const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
        expect(reason?._tag).toBe("Fail")
        if (reason?._tag === "Fail") expect(reason.error).toBeInstanceOf(ClientClosedError)
    }
}

test("default handler that registers while shutdown interrupts it gets closed handles instead of a thrown error", async () => {
    const tester = createTestClient()
    await tester.ready()
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    let late: Promise<Awaited<ReturnType<typeof registerDefault>>> | undefined
    tester.client.on("messageCreate", async (_message, signal) => {
        started()
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
        // Shutdown has begun; this still-running handler registers as application code commonly does
        late = registerDefault(tester.client)
        await late
    })
    tester.emit("MESSAGE_CREATE", tester.fixtures.message())
    await running
    await tester.shutdown()
    expectDefaultClosed(await late!)
    // The registrations neither failed the handler nor went unrecorded
    expect(tester.logs().filter((record) => record.code === "events.handlerFailed")).toEqual([])
    expect(tester.logs().filter((record) => record.code === lateCode)).toHaveLength(2)
})

test("native handler that registers while shutdown interrupts it gets closed handles instead of a defect", async () => {
    const scope = Scope.makeUnsafe()
    const tester = await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
    await Effect.runPromise(tester.ready())
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    let late: Exit.Exit<Effect.Success<ReturnType<typeof registerNative>>, unknown> | undefined
    await Effect.runPromise(
        tester.client
            .on("messageCreate", () =>
                Effect.sync(() => started()).pipe(
                    Effect.andThen(Effect.never),
                    // Shutdown interrupts this handler; its cleanup registers as application code can
                    Effect.onInterrupt(() =>
                        Effect.exit(registerNative(tester.client)).pipe(
                            Effect.map((exit) => {
                                late = exit
                            }),
                        ),
                    ),
                ),
            )
            .pipe(Scope.provide(scope)),
    )
    await Effect.runPromise(tester.emit("MESSAGE_CREATE", tester.fixtures.message()))
    await running
    await Effect.runPromise(tester.shutdown())
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(late).toMatchObject({ _tag: "Success" })
    if (late && Exit.isSuccess(late)) expectNativeClosed(late.value)
    expect(tester.logs().filter((record) => record.code === "events.handlerFailed")).toEqual([])
    expect(tester.logs().filter((record) => record.code === lateCode)).toHaveLength(2)
})

test("default registrations once shutdown began and after it finished return closed handles, and misuse still throws", async () => {
    const logs = captureLogs()
    const client = createClient({ token: fixtureToken, logging: logs.logging })
    const closing = client.shutdown()
    expectDefaultClosed(await registerDefault(client))
    expect((await closing).isOk()).toBe(true)
    expectDefaultClosed(await registerDefault(client))
    expect(logs.withCode(lateCode)).toHaveLength(4)
    expect(logs.withCode(lateCode)[0]).toMatchObject({ level: "warn", event: "messageCreate" })
    expect(client.diagnostics().events.subscriptions).toBe(0)
    // Invalid arguments are misuse whatever the client state
    expect(() => client.on("messageCreated" as "messageCreate", () => undefined)).toThrow(ConfigurationError)
    expect(() => client.subscribe("messageCreate", { maxPendingMessages: 0 })).toThrow(ConfigurationError)
    expect(() => client.messages.collect("20", { maxMessages: 0 })).toThrow(ConfigurationError)
    expect(() => client.messages.collectReactions({ id: "10", channelId: "20" }, { maxReactions: 0 })).toThrow(
        ConfigurationError,
    )
})

test("native registrations after shutdown return closed handles, and misuse still dies", async () => {
    const logs = captureLogs()
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createNative({ token: fixtureToken, logging: logs.logging }).pipe(Scope.provide(scope)),
    )
    await Effect.runPromise(client.shutdown())
    expectNativeClosed(await Effect.runPromise(registerNative(client)))
    expect(logs.withCode(lateCode)).toHaveLength(2)
    expect(client.diagnostics().events.subscriptions).toBe(0)
    const misuse = [
        Effect.scoped(client.on("messageCreated" as "messageCreate", () => Effect.void)),
        Stream.runDrain(client.subscribe("messageCreate", { maxPendingMessages: 0 })),
        Effect.scoped(client.messages.collect("20", { maxMessages: 0 })),
        Effect.scoped(client.messages.collectReactions({ id: "10", channelId: "20" }, { maxReactions: 0 })),
    ]
    for (const effect of misuse) {
        const exit = await Effect.runPromiseExit(effect as Effect.Effect<unknown>)
        expect(Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Die").toBe(true)
        if (Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Die")
            expect(exit.cause.reasons[0].defect).toBeInstanceOf(ConfigurationError)
    }
    await Effect.runPromise(Scope.close(scope, Exit.void))
})

test("default router attach on a closing or closed client returns a closed subscription instead of throwing", async () => {
    const logs = captureLogs()
    const client = createClient({ token: fixtureToken, logging: logs.logging })
    const router = commands.create({ prefix: "!" }).register({ name: "ping", execute: () => undefined })
    const closing = client.shutdown()
    const during = router.attach(client)
    expect((await during.waitForClose()).isOk()).toBe(true)
    expect((await closing).isOk()).toBe(true)
    const after = router.attach(client)
    expect((await after.waitForClose()).isOk()).toBe(true)
    expect(logs.withCode(lateCode)).toHaveLength(2)
    expect(client.diagnostics().events.subscriptions).toBe(0)
    expect(() => router.attach(client, { concurrency: 0 })).toThrow(ConfigurationError)
})

test("native router attach on a closed client succeeds with a closed subscription instead of dying", async () => {
    const logs = captureLogs()
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createNative({ token: fixtureToken, logging: logs.logging }).pipe(Scope.provide(scope)),
    )
    const router = nativeCommands.create({ prefix: "!" }).register({ name: "ping", execute: () => Effect.void })
    await Effect.runPromise(client.shutdown())
    const closed = await Effect.runPromise(
        Effect.scoped(
            Effect.flatMap(router.attach(client), (subscription) => Effect.exit(subscription.waitForClose())),
        ),
    )
    expect(Exit.isSuccess(closed)).toBe(true)
    expect(logs.withCode(lateCode)).toHaveLength(1)
    expect(client.diagnostics().events.subscriptions).toBe(0)
    await Effect.runPromise(Scope.close(scope, Exit.void))
})
