import { Cause, Effect, Exit, Scope } from "effect"
import { describe, expect, onTestFinished, test, vi } from "vitest"
import { ClientClosedError, type LogRecord } from "../../src/index.js"
import {
    createTestClient as createDefaultTestClient,
    TestTimeoutError,
    UnhandledTestFailuresError,
    type TestClientOptions,
    type TestRequest,
    type TestResponse,
    type TestWaitOptions,
} from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"

const timers = vi.hoisted(() => ({ fake: false }))
// Test waits import their timers from node:timers so that faking the global timers leaves them real. While a test sets
// timers.fake, new waits use the global timers instead, so fake time can move their deadlines without real waiting
vi.mock("node:timers", async (original) => {
    const real = await original<typeof import("node:timers")>()
    const realHandles = new WeakSet<object>()
    return {
        ...real,
        setTimeout: (handler: () => void, delay: number) => {
            if (timers.fake) return globalThis.setTimeout(handler, delay)
            const handle = real.setTimeout(handler, delay)
            realHandles.add(handle)
            return handle
        },
        clearTimeout: (handle: ReturnType<typeof setTimeout> | undefined) =>
            handle !== undefined && realHandles.has(handle)
                ? real.clearTimeout(handle)
                : globalThis.clearTimeout(handle),
    }
})

/** Run a bounded wait on fake time: Still pending one millisecond before its deadline, then TestTimeoutError at it */
async function expiresAt(timeoutMs: number, start: () => Promise<unknown>) {
    timers.fake = true
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
        let outcome: unknown = "pending"
        const wait = start().then(
            () => "resolved",
            (error: unknown) => error,
        )
        void wait.then((value) => (outcome = value))
        await vi.advanceTimersByTimeAsync(timeoutMs - 1)
        expect(outcome).toBe("pending")
        await vi.advanceTimersByTimeAsync(1)
        expect(await wait).toBeInstanceOf(TestTimeoutError)
    } finally {
        vi.useRealTimers()
        timers.fake = false
    }
}

/**
 * One test client driven through either API style with promise-returning calls. Native waits run as Effects, native
 * handlers are Effects, and a native wait's typed failure or defect rejects with the underlying error
 */
interface Driver {
    readonly fixtures: ReturnType<typeof createDefaultTestClient>["fixtures"]
    ready(): Promise<void>
    emit(type: string, payload: unknown): Promise<void>
    /** Register a messageCreate handler. A handler that returns a promise keeps running until it settles */
    onMessage(handler: (content: string) => Promise<void> | void): Promise<void>
    /** Register a route answering message sends and return its next wait and request list */
    replies(response?: () => Promise<void>): {
        next(options?: TestWaitOptions): Promise<TestRequest>
        requests(): readonly TestRequest[]
    }
    reply(content: string): Promise<void>
    idle(options?: TestWaitOptions): Promise<void>
    failures(): readonly LogRecord[]
    shutdown(): Promise<void>
    /** End the test client the way a test ends it: Disposal for the default API, closing the scope for the native API */
    dispose(): Promise<void>
}

/** The error a native Effect failed or died with, instead of the FiberFailure wrapper */
async function unwrap<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
}

async function open(mode: Mode, options: TestClientOptions = {}): Promise<Driver> {
    if (mode === "default") {
        const test = createDefaultTestClient(options)
        // Tests that expect a shutdown failure consume it first, so a repeated shutdown here succeeds
        onTestFinished(() => test.shutdown())
        return {
            fixtures: test.fixtures,
            ready: () => test.ready(),
            emit: async (type, payload) => test.emit(type, payload),
            onMessage: async (handler) => {
                test.client.on("messageCreate", (message) => handler(message.content))
            },
            replies: (response) => {
                const route = test.rest.respond("POST /channels/:id/messages", async () => {
                    await response?.()
                    return { body: test.fixtures.message({ content: "Pong!" }) }
                })
                return { next: (waitOptions) => route.next(waitOptions), requests: () => route.requests() }
            },
            reply: async (content) => {
                const sent = await test.client.messages.send(test.fixtures.ids.channel, { content })
                if (sent.isErr()) throw sent.error
            },
            idle: (waitOptions) => test.idle(waitOptions),
            failures: () => test.failures(),
            shutdown: () => test.shutdown(),
            dispose: async () => await test[Symbol.asyncDispose](),
        }
    }
    const scope = Scope.makeUnsafe()
    // Closing an already closed scope succeeds, as a repeated default shutdown does after reporting its failures
    const dispose = () => unwrap(Scope.close(scope, Exit.void))
    onTestFinished(dispose)
    const test = await Effect.runPromise(createNativeTestClient(options as never).pipe(Scope.provide(scope)))
    return {
        fixtures: test.fixtures,
        ready: () => unwrap(test.ready()),
        emit: (type, payload) => unwrap(test.emit(type, payload)),
        onMessage: async (handler) => {
            await Effect.runPromise(
                test.client
                    .on("messageCreate", (message) => Effect.promise(async () => handler(message.content)))
                    .pipe(Scope.provide(scope)),
            )
        },
        replies: (response) => {
            const route = test.rest.respond("POST /channels/:id/messages", async () => {
                await response?.()
                return { body: test.fixtures.message({ content: "Pong!" }) }
            })
            return { next: (waitOptions) => unwrap(route.next(waitOptions)), requests: () => route.requests() }
        },
        reply: (content) =>
            unwrap(test.client.messages.send(test.fixtures.ids.channel, { content })).then(() => undefined),
        idle: (waitOptions) => unwrap(test.idle(waitOptions)),
        failures: () => test.failures(),
        shutdown: () => unwrap(test.shutdown()),
        dispose,
    }
}

describe.each(modes)("%s test client failures", (mode) => {
    test("shutdown rejects with the handler failure a test did not handle, once", async () => {
        const driver = await open(mode)
        await driver.onMessage(() => {
            throw new Error("handler bug")
        })
        await driver.ready()
        await driver.emit("MESSAGE_CREATE", driver.fixtures.message({ content: "!ping" }))
        await driver.idle()
        const failure = await driver.shutdown().then(
            () => expect.fail("Expected shutdown to report the handler failure"),
            (error: unknown) => error,
        )
        expect(failure).toBeInstanceOf(UnhandledTestFailuresError)
        expect((failure as UnhandledTestFailuresError).failures).toEqual([
            expect.objectContaining({ level: "error", code: "events.handlerFailed" }),
        ])
        expect((failure as UnhandledTestFailuresError).message).toContain("handler bug")
        // The failure was reported, so a later shutdown succeeds
        await driver.shutdown()
    })

    test("ending the test client without an explicit shutdown still reports the unhandled failure", async () => {
        const driver = await open(mode)
        await driver.onMessage(() => {
            throw new Error("handler bug")
        })
        await driver.ready()
        await driver.emit("MESSAGE_CREATE", driver.fixtures.message())
        await driver.idle()
        await expect(driver.dispose()).rejects.toBeInstanceOf(UnhandledTestFailuresError)
    })

    test("a handler that returns a failed reply counts as an unhandled failure until the test reads it", async () => {
        const rejectReplies = (rest: { respond(matcher: string, response: TestResponse): unknown }) =>
            rest.respond("POST /channels/:id/messages", {
                status: 400,
                body: { code: "INVALID_FORM_BODY", message: "Invalid form body" },
            })
        let failures: readonly LogRecord[]
        if (mode === "default") {
            const test = createDefaultTestClient()
            onTestFinished(() => test.shutdown())
            rejectReplies(test.rest)
            test.client.on("messageCreate", (message) => test.client.messages.reply(message, "Pong!"))
            await test.ready()
            await test.emit("MESSAGE_CREATE", test.fixtures.message())
            await test.idle()
            const failure = await test.shutdown().then(
                () => expect.fail("Expected shutdown to report the failed reply"),
                (error: unknown) => error,
            )
            expect(failure).toBeInstanceOf(UnhandledTestFailuresError)
            failures = (failure as UnhandledTestFailuresError).failures
        } else {
            const scope = Scope.makeUnsafe()
            onTestFinished(() => unwrap(Scope.close(scope, Exit.void)))
            const test = await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
            rejectReplies(test.rest)
            await Effect.runPromise(
                test.client
                    .on("messageCreate", (message) => test.client.messages.reply(message, "Pong!"))
                    .pipe(Scope.provide(scope)),
            )
            await unwrap(test.ready())
            await unwrap(test.emit("MESSAGE_CREATE", test.fixtures.message()))
            await unwrap(test.idle())
            failures = test.failures()
            // The test read the failure, so closing the scope succeeds
            await unwrap(Scope.close(scope, Exit.void))
        }
        expect(failures).toEqual([expect.objectContaining({ level: "error", code: "events.handlerFailed" })])
    })

    test("a silent logging level does not hide an unhandled failure from failures() or shutdown", async () => {
        const failing = async (driver: Driver) => {
            await driver.onMessage(() => {
                throw new Error("handler bug")
            })
            await driver.ready()
            await driver.emit("MESSAGE_CREATE", driver.fixtures.message())
            await driver.idle()
        }
        const reading = await open(mode, { logging: { level: "silent" } })
        await failing(reading)
        expect(reading.failures()).toEqual([expect.objectContaining({ level: "error", code: "events.handlerFailed" })])
        await reading.shutdown()

        const unread = await open(mode, { logging: { level: "silent" } })
        await failing(unread)
        await expect(unread.shutdown()).rejects.toBeInstanceOf(UnhandledTestFailuresError)
    })

    test("each repeated failure appears in failures() once, even when log deduplication suppresses its output", async () => {
        const driver = await open(mode)
        await driver.onMessage(() => {
            throw new Error("handler bug")
        })
        await driver.ready()
        // The same failure twice within the deduplication window prints only the first until shutdown
        for (let index = 0; index < 2; index++) {
            await driver.emit("MESSAGE_CREATE", driver.fixtures.message())
            await driver.idle()
        }
        expect(driver.failures()).toEqual([
            expect.objectContaining({ code: "events.handlerFailed" }),
            expect.objectContaining({ code: "events.handlerFailed" }),
        ])
        // Both failures were read, so the summary of suppressed repeats that shutdown prints does not fail it again
        await driver.shutdown()
    })

    test("failures read by the test and failures passed to onError do not fail shutdown", async () => {
        const handled: unknown[] = []
        const onError = (report: { readonly error: unknown }) =>
            mode === "default" ? void handled.push(report.error) : Effect.sync(() => void handled.push(report.error))
        const hooked = await open(mode, { onError: onError as never })
        const expecting = await open(mode)
        for (const driver of [hooked, expecting]) {
            await driver.onMessage(() => {
                throw new Error("expected failure")
            })
            await driver.ready()
            await driver.emit("MESSAGE_CREATE", driver.fixtures.message())
            await driver.idle()
        }
        expect(expecting.failures()).toEqual([expect.objectContaining({ code: "events.handlerFailed" })])
        await expecting.shutdown()
        await expect.poll(() => handled).toHaveLength(1)
        expect(hooked.failures()).toEqual([])
        await hooked.shutdown()
    })
})

describe.each(modes)("%s test client waits", (mode) => {
    test("TestRoute.next returns each answered request once, in order, including one that arrived before the call", async () => {
        const driver = await open(mode)
        const replies = driver.replies()
        await driver.reply("first")
        expect((await replies.next()).body).toMatchObject({ content: "first" })
        const pending = replies.next()
        await driver.reply("second")
        expect((await pending).body).toMatchObject({ content: "second" })
        expect(replies.requests()).toHaveLength(2)
        // Both requests were returned, so a further wait has nothing to return
        await expiresAt(20, () => replies.next({ timeoutMs: 20 }))
    })

    test("TestRoute.next fails with TestTimeoutError without a request and ClientClosedError at shutdown", async () => {
        const driver = await open(mode)
        const replies = driver.replies()
        await expiresAt(20, () => replies.next({ timeoutMs: 20 }))
        const waiting = replies.next({ timeoutMs: 60_000 })
        await driver.shutdown()
        await expect(waiting).rejects.toBeInstanceOf(ClientClosedError)
    })

    test("idle waits for a running handler and its pending request, and confirms that an ignored message sent nothing", async () => {
        const driver = await open(mode)
        const response = Promise.withResolvers<void>()
        const replies = driver.replies(() => response.promise)
        const handled: string[] = []
        await driver.onMessage(async (content) => {
            await Promise.resolve()
            handled.push(content)
            if (content === "!ping") await driver.reply("Pong!")
        })
        await driver.ready()
        await driver.emit("MESSAGE_CREATE", driver.fixtures.message({ content: "hello" }))
        await driver.idle()
        // The handler ran before idle returned, so the empty request list means it sent nothing
        expect(handled).toEqual(["hello"])
        expect(replies.requests()).toEqual([])

        await driver.emit("MESSAGE_CREATE", driver.fixtures.message({ content: "!ping" }))
        // The response handler has not answered yet, so the client is still busy
        await expect(driver.idle({ timeoutMs: 50 })).rejects.toBeInstanceOf(TestTimeoutError)
        response.resolve()
        await driver.idle()
        expect(replies.requests()).toHaveLength(1)
        expect(driver.failures()).toEqual([])
    })

    test("idle and wait timeouts settle while the test fakes timers other than setImmediate", async () => {
        const driver = await open(mode)
        const replies = driver.replies()
        const handled: string[] = []
        await driver.onMessage((content) => {
            handled.push(content)
        })
        await driver.ready()
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
        try {
            await driver.emit("MESSAGE_CREATE", driver.fixtures.message({ content: "hello" }))
            await driver.idle()
            expect(handled).toEqual(["hello"])
            await expect(replies.next({ timeoutMs: 20 })).rejects.toBeInstanceOf(TestTimeoutError)
        } finally {
            vi.useRealTimers()
        }
    })

    test("idle explains instead of settling early when fake timers stop setImmediate", async () => {
        const driver = await open(mode)
        const handled: string[] = []
        await driver.onMessage((content) => {
            handled.push(content)
        })
        await driver.ready()
        vi.useFakeTimers()
        try {
            await driver.emit("MESSAGE_CREATE", driver.fixtures.message({ content: "hello" }))
            // No handler can run, so settling would falsely report that the bot did nothing
            await expect(driver.idle()).rejects.toMatchObject({
                _tag: "ConfigurationError",
                hint: expect.stringContaining("setImmediate"),
            })
        } finally {
            // Run the immediates the fake timers held, so the SDK continues once real timers are back
            vi.runOnlyPendingTimers()
            vi.useRealTimers()
        }
        await driver.idle()
        expect(handled).toEqual(["hello"])
    })
})
