import { setImmediate as turn } from "node:timers/promises"
import { runInNewContext } from "node:vm"
import { Effect, Exit, Fiber, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { startHostedLoopback } from "../support/instance.js"
import { settle, typedResult } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
})

const wire = (id: string, content: string) => ({
    id,
    channel_id: "20",
    content,
    author: { id: "30", username: "fixture" },
})

async function fixture() {
    const { rest, gateway } = await startHostedLoopback()
    return {
        dispatch(content: string, id = content) {
            gateway.dispatch("MESSAGE_CREATE", wire(id, content))
        },
        get requests() {
            return rest.requests.length
        },
    }
}

async function waitForFilter(
    dispatch: (content: string, id?: string) => void,
    seen: readonly string[],
    content = "probe",
) {
    for (let attempt = 0; attempt < 20 && !seen.includes(content); attempt++) {
        dispatch(content, String(100 + attempt))
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(seen).toContain(content)
}

test("default waits filter future events, share source fan-out and make no REST request after connection", async () => {
    const server = await fixture()
    const client = createClient({ token: "fixture-only-not-a-credential" })
    onTestFinished(async () => {
        await client.shutdown()
    })
    await settle(client.connect())
    const control: string[] = []
    client.on("messageCreate", (message) => {
        control.push(message.content)
    })
    server.dispatch("control", "10")
    await vi.waitFor(() => expect(control).toEqual(["control"]))
    expect(client.state).toBe("Connected")
    const events = client.subscribe("messageCreate")
    const filtered: string[] = []
    const waiting = client.waitFor("messageCreate", {
        filter: (message) => {
            filtered.push(message.content)
            return message.content === "answer"
        },
        timeoutMs: 1_000,
    })
    await waitForFilter((content, id) => server.dispatch(content, id), filtered, "ignore")
    server.dispatch("answer", "2")
    expect(await settle(waiting)).toMatchObject({ id: "2", content: "answer" })
    while (true) {
        const event = await settle(events.next())
        if (!event) throw new Error("Event source closed before answer")
        if (event.content === "answer") {
            expect(event).toMatchObject({ id: "2", content: "answer" })
            break
        }
        expect(event.content).toBe("ignore")
    }
    expect(server.requests).toBe(0)
})

test("native waits are lazy and use observed filter delivery rather than fork scheduling as a registration barrier", async () => {
    const server = await fixture()
    const seen: string[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const wait = client.waitFor("messageCreate", {
                    filter: (message) => {
                        seen.push(message.content)
                        return message.content === "answer"
                    },
                    timeoutMs: 1_000,
                })
                const invalid = client.waitFor("messageCreate", { timeoutMs: 0 } as never)
                expect(seen).toEqual([])
                const invalidExit = yield* Effect.exit(invalid)
                expect(Exit.isFailure(invalidExit)).toBe(true)
                if (Exit.isFailure(invalidExit))
                    expect(invalidExit.cause.reasons).toContainEqual(
                        expect.objectContaining({
                            _tag: "Fail",
                            error: expect.objectContaining({ _tag: "ConfigurationError", field: "timeoutMs" }),
                        }),
                    )
                yield* client.connect()
                const control: string[] = []
                yield* client.on("messageCreate", (message) =>
                    Effect.sync(() => {
                        control.push(message.content)
                    }),
                )
                const fiber = yield* Effect.forkScoped(wait)
                yield* Effect.promise(() =>
                    waitForFilter((content, id) => server.dispatch(content, id), seen, "ignore"),
                )
                server.dispatch("answer", "2")
                const event = yield* Fiber.join(fiber)
                expect(event).toMatchObject({ id: "2", content: "answer" })
                const interruptedSeen: string[] = []
                const interrupted = yield* Effect.forkScoped(
                    client.waitFor("messageCreate", {
                        filter: (message) => {
                            interruptedSeen.push(message.content)
                            return false
                        },
                    }),
                )
                yield* Effect.promise(() =>
                    waitForFilter((content, id) => server.dispatch(content, id), interruptedSeen, "interrupt-probe"),
                )
                yield* Fiber.interrupt(interrupted)
                const stopped = [...interruptedSeen]
                server.dispatch("after-native-interrupt", "201")
                // A still-registered wait would see this dispatch no later than the control subscription
                yield* Effect.promise(() => vi.waitFor(() => expect(control).toContain("after-native-interrupt")))
                expect(interruptedSeen).toEqual(stopped)
                yield* client.shutdown()
            }),
        ),
    )
})

test("event waits retain typed timeout and safe filter failures", async () => {
    const server = await fixture()
    const defaultApi = createClient({ token: "fixture-only-not-a-credential" })
    onTestFinished(async () => {
        await defaultApi.shutdown()
    })
    await settle(defaultApi.connect())
    const timeout = await defaultApi.waitFor("messageCreate", { timeoutMs: 20 })
    expect(timeout.isErr() && timeout.error).toMatchObject({ _tag: "EventWaitError", reason: "timeout" })
    const invalidTimeout = await defaultApi.waitFor("messageCreate", { timeoutMs: Infinity } as never)
    expect(invalidTimeout.isErr() && invalidTimeout.error).toMatchObject({
        _tag: "ConfigurationError",
        field: "timeoutMs",
    })
    const filterCalls: string[] = []
    const failed = defaultApi.waitFor("messageCreate", {
        filter: (message) => {
            filterCalls.push(message.content)
            if (message.content === "probe") return false
            throw new Error("private event-wait filter")
        },
    })
    await waitForFilter((content, id) => server.dispatch(content, id), filterCalls)
    server.dispatch("answer", "200")
    const failure = await failed
    expect(failure.isErr() && failure.error).toMatchObject({ _tag: "EventWaitError", reason: "filter" })
    expect(JSON.stringify(failure)).toContain("private event-wait filter")

    const scope = Scope.makeUnsafe()
    const native = await Effect.runPromise(
        createNative({ token: "fixture-only-not-a-credential" }).pipe(Scope.provide(scope)),
    )
    try {
        await Effect.runPromise(native.connect())
        const nativeSeen: string[] = []
        const nativeFailure = await Effect.runPromise(
            Effect.gen(function* () {
                const fiber = yield* Effect.forkIn(
                    Effect.exit(
                        native.waitFor("messageCreate", {
                            filter: (message) => {
                                nativeSeen.push(message.content)
                                if (message.content === "probe") return false
                                return Promise.reject(new Error("private thenable")) as never
                            },
                        }),
                    ),
                    scope,
                )
                yield* Effect.promise(() => waitForFilter((content, id) => server.dispatch(content, id), nativeSeen))
                server.dispatch("native-filter", "200")
                return yield* Fiber.join(fiber)
            }),
        )
        expect(Exit.isFailure(nativeFailure)).toBe(true)
        if (Exit.isFailure(nativeFailure))
            expect(nativeFailure.cause.reasons).toContainEqual(
                expect.objectContaining({
                    _tag: "Fail",
                    error: expect.objectContaining({ _tag: "EventWaitError", reason: "filter" }),
                }),
            )
        expect(JSON.stringify(nativeFailure)).not.toContain("private thenable")
    } finally {
        await Effect.runPromise(native.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
})

test.each(["default", "native"] as const)(
    "%s waits contain invalid rejected filter returns across realms and hostile properties",
    async (mode) => {
        const server = await fixture()
        const rejections: unknown[] = []
        const observe = (reason: unknown) => rejections.push(reason)
        process.on("unhandledRejection", observe)
        onTestFinished(() => {
            process.off("unhandledRejection", observe)
        })
        const scope = Scope.makeUnsafe()
        const defaultApi = mode === "default" ? createClient({ token: "fixture-only-not-a-credential" }) : undefined
        const native =
            mode === "native"
                ? await Effect.runPromise(
                      createNative({ token: "fixture-only-not-a-credential" }).pipe(Scope.provide(scope)),
                  )
                : undefined
        onTestFinished(async () => {
            if (defaultApi) await settle(defaultApi.shutdown())
            if (native) {
                await Effect.runPromise(native.shutdown())
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        })
        if (defaultApi) await settle(defaultApi.connect())
        else await Effect.runPromise(native!.connect())
        const delivered: string[] = []
        if (defaultApi)
            defaultApi.on("messageCreate", (message) => {
                delivered.push(message.content)
            })
        else
            await Effect.runPromise(
                native!
                    .on("messageCreate", (message) =>
                        Effect.sync(() => {
                            delivered.push(message.content)
                        }),
                    )
                    .pipe(Scope.provide(scope)),
            )
        for (const foreign of [false, true])
            for (const hostile of [false, true]) {
                const seen: string[] = []
                const filter = (message: import("../../src/index.js").Message) => {
                    seen.push(message.content)
                    if (message.content === "probe") return false
                    const reason = new Error("private rejected wait filter")
                    const rejected = foreign
                        ? (runInNewContext("Promise.reject(reason)", { reason }) as Promise<never>)
                        : Promise.reject(reason)
                    if (hostile)
                        for (const key of ["then", "catch"])
                            // oxlint-disable-next-line typescript/no-floating-promises -- defineProperty returns the rejected promise, which the filter returns below
                            Object.defineProperty(rejected, key, {
                                get() {
                                    throw new Error("private filter property")
                                },
                            })
                    return rejected as never
                }
                const waiting = defaultApi
                    ? defaultApi
                          .waitFor("messageCreate", { filter, timeoutMs: 1_000 })
                          .then((result) => (result.isErr() ? result.error : result.value))
                    : Effect.runPromise(
                          typedResult(native!.waitFor("messageCreate", { filter, timeoutMs: 1_000 })),
                      ).then((result) => (result._tag === "Failure" ? result.failure : result.success))
                await waitForFilter((content, id) => server.dispatch(content, id), seen)
                server.dispatch("invalid", "200")
                const error = await waiting
                expect(error).toMatchObject({ _tag: "EventWaitError", reason: "filter" })
                expect(JSON.stringify(error)).not.toContain("private")
                await turn()
                expect(rejections).toEqual([])
                const stopped = [...seen]
                const afterFailureDeliveries = delivered.filter((content) => content === "after-failure").length
                server.dispatch("after-failure", "201")
                await vi.waitFor(() =>
                    expect(delivered.filter((content) => content === "after-failure")).toHaveLength(
                        afterFailureDeliveries + 1,
                    ),
                )
                expect(seen).toEqual(stopped)
            }
        expect((defaultApi ?? native)!.state).toBe("Connected")
    },
)

test("event registration rejects unknown names and prototype keys in both public styles", async () => {
    const defaultApi = createClient({ token: "fixture-only-not-a-credential" })
    onTestFinished(async () => {
        await settle(defaultApi.shutdown())
    })
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const native = yield* createNative({ token: "fixture-only-not-a-credential" })
                for (const event of ["unknown", "toString", "constructor", "__proto__", undefined, 1]) {
                    expect(() => defaultApi.subscribe(event as never)).toThrow(
                        expect.objectContaining({ _tag: "ConfigurationError", field: "event" }),
                    )
                    const waited = yield* typedResult(native.waitFor(event as never))
                    expect(waited._tag === "Failure" && waited.failure).toMatchObject({
                        _tag: "ConfigurationError",
                        field: "event",
                    })
                }
            }),
        ),
    )
})

test("event wait cancellation releases intake before later dispatch", async () => {
    const server = await fixture()
    const client = createClient({ token: "fixture-only-not-a-credential" })
    onTestFinished(async () => {
        await client.shutdown()
    })
    await settle(client.connect())
    const delivered: string[] = []
    client.on("messageCreate", (message) => {
        delivered.push(message.content)
    })
    const controller = new AbortController()
    const seen: string[] = []
    const waiting = client.waitFor("messageCreate", {
        signal: controller.signal,
        filter: (message) => {
            seen.push(message.content)
            return false
        },
    })
    await waitForFilter((content, id) => server.dispatch(content, id), seen)
    controller.abort()
    const cancelled = await waiting
    expect(cancelled.isErr() && cancelled.error).toMatchObject({ _tag: "CancelledError" })
    const stopped = [...seen]
    server.dispatch("after-cancel", "200")
    // A still-registered wait would see this dispatch no later than the control subscription
    await vi.waitFor(() => expect(delivered).toContain("after-cancel"))
    expect(seen).toEqual(stopped)
    expect(client.state).toBe("Connected")
})

test("event-source overflow does not interrupt a concurrent wait and shutdown closes a pending wait", async () => {
    const server = await fixture()
    const client = createClient({ token: "fixture-only-not-a-credential" })
    onTestFinished(async () => {
        await client.shutdown()
    })
    await settle(client.connect())
    const overflowing = client.subscribe("messageCreate", { maxPendingMessages: 1 })
    const filtered: string[] = []
    const waiting = client.waitFor("messageCreate", {
        filter: (message) => {
            filtered.push(message.content)
            return message.content === "answer"
        },
        timeoutMs: 1_000,
    })
    await waitForFilter((content, id) => server.dispatch(content, id), filtered)
    server.dispatch("one", "1")
    server.dispatch("two", "2")
    const overflow = await overflowing.waitForClose()
    expect(overflow.isErr() && overflow.error).toMatchObject({ _tag: "EventOverflowError", limit: "messages" })
    server.dispatch("answer", "3")
    expect(await settle(waiting)).toMatchObject({ id: "3", content: "answer" })
    expect(client.state).toBe("Connected")

    const closingSeen: string[] = []
    const closing = client.waitFor("messageCreate", {
        filter: (message) => {
            closingSeen.push(message.content)
            return false
        },
        timeoutMs: 1_000,
    })
    await waitForFilter((content, id) => server.dispatch(content, id), closingSeen)
    await client.shutdown()
    const closed = await closing
    expect(closed.isErr() && closed.error).toMatchObject({ _tag: "ClientClosedError" })
})
