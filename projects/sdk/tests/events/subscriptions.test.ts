import { Cause, Deferred, Effect, Exit, Fiber, References, Scheduler, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    type ClientDiagnostics,
    ConfigurationError,
    SdkDefect,
    type EventHandlerOptions,
    type FailureReport,
    type LogRecord,
    type Message,
} from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { defaultApi } from "../support/both-apis.js"
import { waitUntil } from "../support/clock.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { settle } from "../support/settle.js"
import { expectThrown } from "../resources/defects.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
const token = "fixture-only-not-a-credential"
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})
const wire = (id = "10", content = "!ping", authorId = "30") => ({
    id,
    channel_id: "20",
    content,
    author: { id: authorId, username: "fixture", bot: false },
})

/** A loopback gateway for MESSAGE_CREATE dispatches, with message sends answered by a recording fetch stub */
async function fixture() {
    const replies: Record<string, any>[] = []
    const gateway = await startGatewayServer({ sessionId: "fixture-session" })
    stubFetchWithHostedDiscovery(async (url, init) => {
        if (url.endsWith("/v1/gateway/bot")) return Response.json({ url: "wss://gateway.fluxer.app" })
        const body = JSON.parse(String(init.body)) as Record<string, any>
        replies.push({ method: init.method, url, body })
        return Response.json(wire("99", body.content))
    })
    return {
        replies,
        dispatch: (id = "10", content = "!ping", authorId = "30") =>
            gateway.dispatch("MESSAGE_CREATE", wire(id, content, authorId)),
    }
}

test("default callback receive-and-reply runs sequentially and reports handler failure without retrying it", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    const started: string[] = []
    const reports: FailureReport[] = []
    const applicationFailure = new Error("fixture handler failure")
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const sub = await settle(
        client.on(
            "messageCreate",
            async (message, signal) => {
                started.push(message.id)
                if (message.id === "10") await gate
                if (message.id === "11") throw applicationFailure
                await settle(client.messages.reply(message, { content: "Pong!" }, { signal }))
            },
            {
                onError: (report) => {
                    reports.push(report)
                },
            },
        ),
    )
    // Registered after the handler, so the witness runs 12 only after the handler's subscription has received 11 and 12
    const witnessed: string[] = []
    await settle(
        client.on("messageCreate", (message) => {
            witnessed.push(message.id)
        }),
    )
    await settle(client.connect())
    server.dispatch("10")
    await vi.waitFor(() => expect(started).toEqual(["10"]))
    server.dispatch("11")
    server.dispatch("12")
    await waitUntil(() => witnessed.includes("12"))
    expect(started).toEqual(["10"])
    release()
    await vi.waitFor(() => expect(started).toEqual(["10", "11", "12"]))
    await vi.waitFor(() => expect(server.replies).toHaveLength(2))
    expect(server.replies.map((reply) => reply.body.message_reference.message_id)).toEqual(["10", "12"])
    expect(reports).toEqual([
        expect.objectContaining({
            event: "messageCreate",
            kind: "handler",
            error: applicationFailure,
            message: expect.objectContaining({ id: "11", channelId: "20" }),
        }),
    ])
    sub.close()
    await settle(sub.waitForClose())
    expect(client.state).toBe("Connected")
})

test("default message handler failures log the message reference without its content", async () => {
    const server = await fixture()
    const logs: LogRecord[] = []
    const client = defaultApi({ token, logging: { sink: (record) => logs.push(record) } })
    const sub = client.on("messageCreate", () => {
        throw new Error("fixture handler failure")
    })
    await settle(client.connect())
    server.dispatch("91", "private body")
    await waitUntil(() => logs.some((record) => record.code === "events.handlerFailed"))
    expect(logs.filter((record) => record.code === "events.handlerFailed")).toEqual([
        expect.objectContaining({
            event: "messageCreate",
            subscriptionId: sub.id,
            fields: expect.objectContaining({ messageId: "91", channelId: "20" }),
        }),
    ])
    expect(JSON.stringify(logs)).not.toContain("private body")
})

test("explicit default concurrency is bounded and close() signals callbacks without awaiting an uncooperative promise", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    const signals: { readonly aborted: boolean }[] = []
    const sub = await settle(
        client.on(
            "messageCreate",
            async (_message, signal) => {
                signals.push(signal)
                await new Promise<void>(() => {})
            },
            { concurrency: 2 },
        ),
    )
    await settle(client.connect())
    server.dispatch("10")
    server.dispatch("11")
    server.dispatch("12")
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    sub.close()
    await settle(sub.waitForClose())
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(signals).toHaveLength(2)
})

test.each(["messages", "bytes"] as const)(
    "%s overflow is retained, isolates the subscriber and discards pending events",
    async (limit) => {
        const server = await fixture()
        const client = defaultApi({ token })
        const blocked = await settle(
            client.on("messageCreate", () => new Promise<void>(() => {}), {
                maxPendingMessages: 1,
                maxPendingBytes: limit === "bytes" ? 1 : 10000,
                overflow: "stop",
            }),
        )
        const other = await settle(client.subscribe("messageCreate"))
        await settle(client.connect())
        server.dispatch("10")
        await settle(other.next())
        server.dispatch("11")
        server.dispatch("12")
        const outcome = await blocked.waitForClose()
        expect(outcome.isErr() && outcome.error._tag).toBe("EventOverflowError")
        if (outcome.isErr() && outcome.error._tag === "EventOverflowError") expect(outcome.error.limit).toBe(limit)
        blocked.close()
        expect(await blocked.waitForClose()).toEqual(outcome)
        expect((await settle(other.next()))?.id).toBe("11")
        expect((await settle(other.next()))?.id).toBe("12")
        expect(client.state).toBe("Connected")
        other.close()
        expect(await settle(other.next())).toBe(null)
    },
)

// Busy and cancelled reads are covered for pull sources in general. This checks that cancelling one read leaves the
// source open for the next event
test("a cancelled pull read ends only that read and the source still delivers the next event", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    const source = await settle(client.subscribe("messageCreate"))
    const controller = new AbortController()
    const reading = source.next({ signal: controller.signal })
    controller.abort()
    const cancelled = await reading
    expect(cancelled.isErr() && cancelled.error._tag).toBe("CancelledError")
    await settle(client.connect())
    server.dispatch()
    expect((await settle(source.next()))?.id).toBe("10")
    source.close()
})

test("native handlers share concurrency controls, own cleanup and send replies through the native surface", async () => {
    const server = await fixture()
    const seen: string[] = []
    let cleaned = 0
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token })
                const sub = yield* client.on(
                    "messageCreate",
                    (message) =>
                        Effect.gen(function* () {
                            seen.push(message.id)
                            yield* client.messages.reply(message, { content: "native" })
                            yield* Effect.never
                        }).pipe(
                            Effect.ensuring(
                                Effect.sync(() => {
                                    cleaned++
                                }),
                            ),
                        ),
                    { concurrency: 2 },
                )
                yield* client.connect()
                server.dispatch("10")
                server.dispatch("11")
                server.dispatch("12")
                yield* Effect.promise(() => vi.waitFor(() => expect(server.replies).toHaveLength(2)))
                yield* sub.close()
                yield* sub.waitForClose()
            }),
        ),
    )
    expect(seen).toEqual(["10", "11"])
    expect(cleaned).toBe(2)
    expect(server.replies.map((reply) => reply.body.message_reference.message_id).sort()).toEqual(["10", "11"])
})

test("native stream is lazy, scoped and live with no history replay", async () => {
    const server = await fixture()
    const messages = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token })
                const stream = client.subscribe("messageCreate")
                yield* client.connect()
                const collecting = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 2)))
                // The stream has no history replay, so dispatch only once its source is open
                yield* Effect.promise(() => waitUntil(() => client.diagnostics().events.subscriptions === 1))
                server.dispatch("10")
                server.dispatch("11")
                return yield* Fiber.join(collecting)
            }),
        ),
    )
    expect(messages.map((message: Message) => message.id)).toEqual(["10", "11"])
})

test("invalid subscription options fail before registration in both API styles", async () => {
    const client = defaultApi({ token })
    expect(expectThrown(() => client.subscribe("messageCreate", { maxPendingMessages: 0 }))).toMatchObject({
        _tag: "ConfigurationError",
        field: "maxPendingMessages",
    })
    expect(expectThrown(() => client.on("messageCreate", () => {}, { concurrency: -1 }))).toMatchObject({
        _tag: "ConfigurationError",
        field: "concurrency",
    })
    const failure = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const native = yield* createNative({ token })
                return yield* Effect.exit(native.on("messageCreate", () => Effect.void, { concurrency: 0 }))
            }),
        ),
    )
    expect(Exit.isFailure(failure) && failure.cause.reasons).toEqual([
        expect.objectContaining({ _tag: "Die", defect: expect.any(ConfigurationError) }),
    ])
    expect(client.diagnostics().events.subscriptions).toBe(0)
})

// A throwing options getter is application code read by the SDK, so it is classified as an application.defect with
// the thrown value kept as the cause
test("default subscriptions throw an application SdkDefect that keeps the thrown value for an eager reporter getter", () => {
    const client = defaultApi({ token })
    const getterFailure = new Error("fixture reporter getter failure")
    const error = expectThrown(() =>
        client.on(
            "messageCreate",
            () => {},
            Object.defineProperty({}, "onError", {
                get() {
                    throw getterFailure
                },
            }) as EventHandlerOptions,
        ),
    )
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        _tag: "SdkDefect",
        code: "application.defect",
        operation: "on",
        reasons: [{ kind: "Defect", origin: "application", defect: getterFailure }],
    })
    expect((error as SdkDefect).cause).toBe(getterFailure)
})

test("default subscribe and waitFor report throwing option getters as application defects", async () => {
    const client = defaultApi({ token })
    const bufferFailure = new Error("fixture buffer getter failure")
    const waitFailure = new Error("fixture wait getter failure")
    const throwing = (key: string, failure: Error) =>
        Object.defineProperty({}, key, {
            get() {
                throw failure
            },
        })
    const subscribed = expectThrown(() =>
        client.subscribe("messageCreate", throwing("maxPendingMessages", bufferFailure) as never),
    )
    let waited: unknown
    try {
        await client.waitFor("messageCreate", throwing("timeoutMs", waitFailure) as never)
    } catch (error) {
        waited = error
    }
    expect(subscribed).toBeInstanceOf(SdkDefect)
    expect(waited).toBeInstanceOf(SdkDefect)
    expect([subscribed, waited]).toMatchObject([
        {
            code: "application.defect",
            operation: "subscribe",
            reasons: [{ kind: "Defect", origin: "application", defect: bufferFailure }],
        },
        {
            code: "application.defect",
            operation: "waitFor",
            reasons: [{ kind: "Defect", origin: "application", defect: waitFailure }],
        },
    ])
    expect([(subscribed as SdkDefect).cause, (waited as SdkDefect).cause]).toEqual([bufferFailure, waitFailure])
    expect(client.diagnostics().events.subscriptions).toBe(0)
})

test("native callback retains caller annotations and cleanup defects remain in subscription closure", async () => {
    const server = await fixture()
    const observed: unknown[] = []
    const defect = new Error("fixture cleanup defect")
    let closed: Exit.Exit<void, unknown> | undefined
    const exit = await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token })
                const sub = yield* client.on("messageCreate", () =>
                    Effect.gen(function* () {
                        const annotations = yield* References.CurrentLogAnnotations
                        observed.push(annotations.requestId)
                        yield* Effect.never
                    }).pipe(Effect.ensuring(Effect.die(defect))),
                )
                yield* client.connect()
                server.dispatch()
                yield* Effect.promise(() => waitUntil(() => observed.length === 1))
                yield* sub.close()
                closed = yield* Effect.exit(sub.waitForClose())
            }),
        ).pipe(Effect.annotateLogs("requestId", "caller-context")),
    )
    expect(observed).toEqual(["caller-context"])
    expect(closed && Exit.isFailure(closed) && Cause.hasDies(closed.cause)).toBe(true)
    // An explicitly unsubscribed handler's failure is retained on its own handle, not used to stop unrelated work
    expect(exit).toMatchObject({ _tag: "Success" })
})

test("native shutdown invoked by a handler interrupts that handler without joining itself", async () => {
    const server = await fixture()
    let afterShutdown = false
    const state = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token })
                yield* client.on("messageCreate", () =>
                    client.shutdown().pipe(
                        Effect.andThen(
                            Effect.sync(() => {
                                afterShutdown = true
                            }),
                        ),
                    ),
                )
                yield* client.connect()
                server.dispatch()
                yield* client.waitForClose()
                return client.state
            }),
        ),
    )
    expect(state).toBe("Closed")
    expect(afterShutdown).toBe(false)
})

test("native stream overflow is a typed stream failure once the held consumer pulls again", async () => {
    const server = await fixture()
    const taken: string[] = []
    const ended = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token })
                const held = yield* Deferred.make<void>()
                const reading = yield* Effect.forkChild(
                    Stream.runForEach(client.subscribe("messageCreate", { maxPendingMessages: 1 }), (message) =>
                        Effect.sync(() => taken.push(message.id)).pipe(Effect.andThen(Deferred.await(held))),
                    ),
                )
                yield* client.connect()
                yield* Effect.promise(() => waitUntil(() => client.diagnostics().events.subscriptions === 1))
                server.dispatch("11")
                yield* Effect.promise(() => waitUntil(() => taken.includes("11")))
                // The consumer is still held on 11, so 12 fills the one-event queue and 13 stops the source
                server.dispatch("12")
                server.dispatch("13")
                yield* Effect.promise(() => waitUntil(() => client.diagnostics().events.subscriptions === 0))
                yield* Deferred.succeed(held, undefined)
                return yield* Effect.exit(Fiber.join(reading))
            }),
        ),
    )
    expect(taken).toEqual(["11"])
    expect(
        Exit.isFailure(ended) &&
            ended.cause.reasons.some(
                (reason) =>
                    reason._tag === "Fail" &&
                    reason.error._tag === "EventOverflowError" &&
                    reason.error.limit === "messages" &&
                    reason.error.capacity === 1,
            ),
    ).toBe(true)
})

test("an uncooperative default reporter cannot hold subscription or client shutdown open", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    let reported = false
    const sub = await settle(
        client.on("messageCreate", () => new Promise<void>(() => {}), {
            maxPendingMessages: 1,
            overflow: "stop",
            onError: () => {
                reported = true
                return new Promise<void>(() => {})
            },
        }),
    )
    await settle(client.connect())
    server.dispatch("10")
    // The handler holds 10, so 11 fills the one-message queue and 12 overflows it
    await waitUntil(() => client.diagnostics().events.activeHandlers === 1)
    server.dispatch("11")
    server.dispatch("12")
    const closed = await sub.waitForClose()
    expect(closed.isErr() && closed.error._tag).toBe("EventOverflowError")
    await waitUntil(() => reported)
    expect((await client.shutdown()).isOk()).toBe(true)
    expect(client.state).toBe("Closed")
})

test("the default event queue retains 256 messages and the next event fails it without harming other consumers", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    const source = await settle(client.subscribe("messageCreate"))
    let delivered = 0
    const witness = await settle(
        client.on(
            "messageCreate",
            () => {
                delivered++
            },
            { maxPendingMessages: 1024 },
        ),
    )
    await settle(client.connect())
    for (let index = 0; index < 256; index++) server.dispatch(String(index + 100), "fixture", "0")
    await vi.waitFor(() => expect(delivered).toBe(256))
    for (let index = 0; index < 256; index++) {
        const message = await settle(source.next())
        expect(message?.id).toBe(String(index + 100))
        expect(message?.author.id).toBe("0")
    }
    for (let index = 0; index < 257; index++) server.dispatch(String(index + 1000))
    const overflow = await source.waitForClose()
    expect(overflow.isErr() && overflow.error._tag === "EventOverflowError" && overflow.error.capacity).toBe(256)
    await vi.waitFor(() => expect(delivered).toBe(513))
    witness.close()
})

test("high configured concurrency allocates no idle worker array and can close before receiving messages", async () => {
    const client = defaultApi({ token })
    const sub = await settle(client.on("messageCreate", () => {}, { concurrency: Number.MAX_SAFE_INTEGER }))
    sub.close()
    await settle(sub.waitForClose())
})

test.each(["default", "native"] as const)(
    "%s handlers drop the oldest waiting event by default and keep running",
    async (mode) => {
        const server = await fixture()
        const handled: string[] = []
        let release!: () => void
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        const handle = async (id: string) => {
            handled.push(id)
            if (id === "10") await held
        }
        const options = { maxPendingMessages: 1 }
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        let client: { connect(): unknown; shutdown(): unknown; diagnostics(): ClientDiagnostics }
        if (mode === "default") {
            const created = defaultApi({ token })
            await settle(created.on("messageCreate", (message) => handle(message.id), options))
            client = created
        } else {
            const created = await Effect.runPromise(createNative({ token }).pipe(Scope.provide(scope)))
            await settle(
                created
                    .on("messageCreate", (message) => Effect.promise(() => handle(message.id)), options)
                    .pipe(Scope.provide(scope)),
            )
            client = created
        }
        await settle(client.connect())
        server.dispatch("10")
        await waitUntil(() => client.diagnostics().events.activeHandlers === 1)
        // 11 waits in the one-message queue, and 12 replaces it
        server.dispatch("11")
        server.dispatch("12")
        await waitUntil(() => client.diagnostics().counters.eventsDropped.overflow === 1)
        release()
        await waitUntil(() => handled.length === 2)
        expect(handled).toEqual(["10", "12"])
        expect(client.diagnostics().events.subscriptions).toBe(1)
        await settle(client.shutdown())
    },
)

test("a handler at its concurrency limit waits for the next free slot without spinning", async () => {
    // Counts every Effect operation of the subscription's fibers, which inherit the registration context
    class CountingScheduler extends Scheduler.MixedScheduler {
        operations = 0
        override shouldYield(fiber: Parameters<Scheduler.MixedScheduler["shouldYield"]>[0]) {
            this.operations++
            return super.shouldYield(fiber)
        }
    }
    const scheduler = new CountingScheduler()
    const server = await fixture()
    const ids = Array.from({ length: 20 }, (_, index) => String(index + 10))
    const result = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token })
                const release = yield* Deferred.make<void>()
                const handled: string[] = []
                yield* client
                    .on("messageCreate", (message) =>
                        Effect.sync(() => handled.push(message.id)).pipe(
                            Effect.andThen(message.id === ids[0] ? Deferred.await(release) : Effect.void),
                        ),
                    )
                    .pipe(
                        Effect.provideService(References.Scheduler, scheduler),
                        // A large operation budget lets a loop that never waits run for the whole budget
                        Effect.provideService(References.MaxOpsBeforeYield, 1_000_000),
                    )
                // A second source sees the same intake, so once it has every message the handler's queue holds the backlog
                const witness = yield* Effect.forkChild(
                    Stream.runCollect(Stream.take(client.subscribe("messageCreate"), ids.length)),
                )
                yield* client.connect()
                yield* Effect.promise(() => waitUntil(() => client.diagnostics().events.subscriptions === 2))
                for (const id of ids) server.dispatch(id)
                yield* Fiber.join(witness)
                const before = scheduler.operations
                yield* Deferred.succeed(release, undefined)
                yield* Effect.promise(() => waitUntil(() => handled.length === ids.length))
                return { handled, operations: scheduler.operations - before }
            }),
        ),
    )
    expect(result.handled).toEqual(ids)
    expect(result.operations).toBeLessThan(100_000)
})

test("native immediate close and client shutdown retain completed subscription closure", async () => {
    const state = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token })
                const stopped = yield* client.on("messageCreate", () => Effect.void)
                yield* stopped.close()
                yield* stopped.waitForClose()
                const owned = yield* client.on("messageCreate", () => Effect.void)
                yield* client.shutdown()
                yield* owned.waitForClose()
                return client.state
            }),
        ),
    )
    expect(state).toBe("Closed")
})

test("client shutdown waits for other native cleanup even when one finalizer defects", async () => {
    const server = await fixture()
    let started = 0
    let cleanupStarted = false
    let cleaned = false
    const observed: {
        pendingWhileCleanupHeld?: boolean
        shutdown?: Exit.Exit<void, unknown>
        terminal?: Exit.Exit<void, unknown>
    } = {}
    const exit = await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token })
                const release = yield* Deferred.make<void>()
                const handler = Effect.sync(() => {
                    started++
                }).pipe(Effect.andThen(Effect.never))
                yield* client.on("messageCreate", () =>
                    handler.pipe(Effect.ensuring(Effect.die(new Error("fixture finalizer failure")))),
                )
                yield* client.on("messageCreate", () =>
                    handler.pipe(
                        Effect.ensuring(
                            Effect.sync(() => {
                                cleanupStarted = true
                            }).pipe(
                                Effect.andThen(Deferred.await(release)),
                                Effect.andThen(
                                    Effect.sync(() => {
                                        cleaned = true
                                    }),
                                ),
                            ),
                        ),
                    ),
                )
                yield* client.connect()
                server.dispatch()
                yield* Effect.promise(() => waitUntil(() => started === 2))
                const shutting = yield* Effect.forkChild(Effect.exit(client.shutdown()))
                yield* Effect.promise(() => waitUntil(() => cleanupStarted))
                // Shutdown is still pending while the second handler's cleanup is held
                observed.pendingWhileCleanupHeld = shutting.pollUnsafe() === undefined
                yield* Deferred.succeed(release, undefined)
                observed.shutdown = yield* Fiber.join(shutting)
                observed.terminal = yield* Effect.exit(client.waitForClose())
            }),
        ),
    )
    expect(observed.pendingWhileCleanupHeld).toBe(true)
    expect(cleaned).toBe(true)
    expect(observed.shutdown && Exit.isFailure(observed.shutdown) && Cause.hasDies(observed.shutdown.cause)).toBe(true)
    expect(observed.terminal && Exit.isFailure(observed.terminal) && Cause.hasDies(observed.terminal.cause)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
})
