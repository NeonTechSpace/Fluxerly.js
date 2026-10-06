import { Session } from "node:inspector"
import { setImmediate as turn } from "node:timers/promises"
import { Clock, Context, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, SdkDefect, type DefaultCollectorOptions } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { modes, type Mode } from "../support/both-apis.js"
import { wsTarget } from "../support/ws-redirect.js"
import { startHostedLoopback } from "../support/instance.js"
import { settle, typedResult } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const wire = (id: string, authorId = "30", content = id) => ({
    id,
    channel_id: "20",
    content,
    author: { id: authorId, username: "fixture", bot: false },
})

async function fixture() {
    const { gateway } = await startHostedLoopback({
        fallback: (_request, response) => void response.writeHead(204).end(),
    })
    return {
        deliver: (id: string, authorId = "30", content = id) =>
            gateway.deliverNow("MESSAGE_CREATE", wire(id, authorId, content)),
    }
}

async function driver(mode: Mode) {
    const clientScope = Scope.makeUnsafe()
    const collectorScope = Scope.makeUnsafe()
    const defaultApi = mode === "default" ? createClient({ token: "fixture-only-not-a-credential" }) : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  createNative({ token: "fixture-only-not-a-credential" }).pipe(Scope.provide(clientScope)),
              )
            : undefined
    const shutdown = () => (defaultApi ? settle(defaultApi.shutdown()) : settle(native!.shutdown()))
    onTestFinished(async () => {
        await shutdown()
        await Effect.runPromise(Scope.close(collectorScope, Exit.void))
        await Effect.runPromise(Scope.close(clientScope, Exit.void))
    })
    return {
        defaultApi,
        native,
        collectorScope,
        connect: () => (defaultApi ? settle(defaultApi.connect()) : settle(native!.connect())),
        shutdown,
        collect: async (options?: import("../../src/collectors.js").CollectorOptions) => {
            if (defaultApi) {
                const collector = defaultApi.messages.collect("20", options)
                return {
                    close: async () => collector.close(),
                    wait: () => settle(collector.result()),
                }
            }
            const collector = await settle(native!.messages.collect("20", options).pipe(Scope.provide(collectorScope)))
            return {
                close: () => Effect.runPromise(collector.close()),
                wait: () => settle(collector.result()),
            }
        },
    }
}

async function progress(
    api: Awaited<ReturnType<typeof driver>>,
    defaultApi: NonNullable<DefaultCollectorOptions["onMessage"]>,
    native: NonNullable<import("../../src/effect.js").CollectorOptions<unknown>["onMessage"]>,
    options: import("../../src/collectors.js").CollectorOptions = {},
) {
    if (api.defaultApi) {
        const collector = api.defaultApi.messages.collect("20", { ...options, onMessage: defaultApi })
        return {
            close: async () => collector.close(),
            wait: () => settle(collector.result()),
        }
    }
    const collector = await Effect.runPromise(
        api.native!.messages.collect("20", { ...options, onMessage: native }).pipe(Scope.provide(api.collectorScope)),
    )
    return {
        close: () => Effect.runPromise(collector.close()),
        wait: () => settle(collector.result()),
    }
}

test.each(modes)("%s progress is sequential after selection, deduplication and byte admission", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    await api.connect()
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve
    })
    let releaseFinal!: () => void
    const finalHeld = new Promise<void>((resolve) => {
        releaseFinal = resolve
    })
    const calls: string[] = []
    const handler = async (message: import("../../src/index.js").Message) => {
        calls.push(message.id)
        expect(Object.isFrozen(message)).toBe(true)
        if (calls.length === 1) await firstHeld
        if (calls.length === 2) await finalHeld
    }
    try {
        const collector = await progress(api, handler, (message) => Effect.promise(() => handler(message)), {
            maxMessages: 2,
            filter: (message) => message.author.id !== "29",
        })
        let closed = false
        const result = collector.wait().then((value) => {
            closed = true
            return value
        })
        server.deliver("10", "29")
        server.deliver("11")
        server.deliver("11")
        server.deliver("12")
        await vi.waitFor(() => expect(calls).toEqual(["11"]))
        expect(closed).toBe(false)
        releaseFirst()
        await vi.waitFor(() => expect(calls).toEqual(["11", "12"]))
        expect(closed).toBe(false)
        releaseFinal()
        expect(await result).toMatchObject({ reason: "limit", messages: [{ id: "11" }, { id: "12" }] })
        expect(calls).toEqual(["11", "12"])

        let byteCalls = 0
        const rejected = await progress(
            api,
            () => {
                byteCalls++
            },
            () =>
                Effect.sync(() => {
                    byteCalls++
                }),
            { maxBytes: 1 },
        )
        server.deliver("13")
        await expect(rejected.wait()).rejects.toMatchObject({
            _tag: "CollectorError",
            reason: "overflow",
            limit: "maxBytes",
        })
        expect(byteCalls).toBe(0)
    } finally {
        releaseFirst()
        releaseFinal()
    }
})

test.each(modes)(
    "%s maps active progress defects to a handler failure that keeps the application error, without retrying",
    async (mode) => {
        const server = await fixture()
        const api = await driver(mode)
        await api.connect()
        const privateBody = "private progress defect"
        let calls = 0
        const collector = await progress(
            api,
            () => {
                calls++
                throw new Error(privateBody)
            },
            () =>
                Effect.sync(() => {
                    calls++
                }).pipe(Effect.andThen(Effect.die(privateBody))),
            { maxMessages: 2 },
        )
        server.deliver("10")
        const error = await collector.wait().catch((cause) => cause)
        expect(error).toMatchObject({ _tag: "CollectorError", reason: "handler" })
        expect(JSON.stringify(error)).toContain(privateBody)
        server.deliver("11")
        await turn()
        expect(calls).toBe(1)
    },
)

test.each(modes.flatMap((mode) => ["timeout", "idle"].map((reason) => ({ mode, reason }))))(
    "$mode rechecks $reason after synchronous progress",
    async ({ mode, reason }) => {
        const server = await fixture()
        const api = await driver(mode)
        await api.connect()
        let now = 0
        vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(
            () => BigInt(now) * 1_000_000n,
        )
        const advance = () => {
            now = 100
        }
        const collector = await progress(
            api,
            advance,
            () => Effect.sync(advance),
            reason === "idle" ? { idleMs: 100 } : { timeoutMs: 100 },
        )
        server.deliver("10")
        expect(await collector.wait()).toMatchObject({ reason, messages: [{ id: "10" }] })
    },
)

test.each(modes)("%s queued messages do not postpone idle completion during a callback", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    await api.connect()
    let now = 0
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    const started = Promise.withResolvers<void>()
    const calls: string[] = []
    const accept = (message: import("../../src/index.js").Message) => {
        calls.push(message.id)
        started.resolve()
    }
    const collector = await progress(
        api,
        async (message, signal) => {
            accept(message)
            await new Promise<void>((resolve) => {
                if (signal.aborted) resolve()
                else signal.addEventListener("abort", () => resolve(), { once: true })
            })
        },
        (message) => Effect.sync(() => accept(message)).pipe(Effect.andThen(Effect.never)),
        { idleMs: 100, maxMessages: 5 },
    )
    server.deliver("10")
    await started.promise
    now = 99
    server.deliver("11")
    await turn()
    now = 100
    server.deliver("12")
    expect(await collector.wait()).toMatchObject({ reason: "idle", messages: [{ id: "10" }] })
    expect(calls).toEqual(["10"])
})

test.each(modes)("%s rejects an invalid onMessage handler locally", async (mode) => {
    const api = await driver(mode)
    if (api.defaultApi) {
        expect(() =>
            api.defaultApi!.messages.collect("20", { onMessage: 3 } as unknown as DefaultCollectorOptions),
        ).toThrow(expect.objectContaining({ _tag: "ConfigurationError", field: "onMessage" }))
        return
    }
    const exit = await Effect.runPromiseExit(
        api.native!.messages.collect("20", { onMessage: 3 } as never).pipe(Scope.provide(api.collectorScope)),
    )
    // Native registration misuse is a defect carrying the ConfigurationError
    const defect = Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Die") : undefined
    expect(defect?._tag === "Die" ? defect.defect : undefined).toMatchObject({
        _tag: "ConfigurationError",
        field: "onMessage",
    })
})

test.each(
    modes.flatMap((mode) =>
        (mode === "default"
            ? ["cancel", "stop", "timeout", "idle", "recovery", "shutdown", "overflow"]
            : ["scope", "stop", "timeout", "idle", "recovery", "shutdown", "overflow"]
        ).map((reason) => ({ mode, reason })),
    ),
)("$mode $reason interrupts active progress and completion waits for cleanup", async ({ mode, reason }) => {
    const server = await fixture()
    const api = await driver(mode)
    await api.connect()
    const controller = new AbortController()
    let started = false,
        cancelled = false,
        cleaned = false,
        closed = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    try {
        const collector = await progress(
            api,
            async (_message, signal) => {
                started = true
                await new Promise<void>((resolve) => {
                    if (signal.aborted) resolve()
                    else signal.addEventListener("abort", () => resolve(), { once: true })
                })
                cancelled = true
                await held
                cleaned = true
            },
            () =>
                Effect.sync(() => {
                    started = true
                }).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(
                        Effect.promise(async () => {
                            cancelled = true
                            await held
                            cleaned = true
                        }),
                    ),
                ),
            {
                maxMessages: 10,
                maxPendingMessages: reason === "overflow" ? 1 : 256,
                timeoutMs: reason === "timeout" ? 100 : 10_000,
                idleMs: reason === "idle" ? 100 : 5_000,
                ...(mode === "default" ? { signal: controller.signal } : {}),
            } as import("../../src/collectors.js").CollectorOptions,
        )
        const result = collector.wait().then(
            (value) => {
                closed = true
                return value
            },
            (error) => {
                closed = true
                return error
            },
        )
        server.deliver("10")
        await vi.waitFor(() => expect(started).toBe(true))
        let operation: PromiseLike<unknown> = Promise.resolve()
        if (reason === "cancel") controller.abort()
        if (reason === "stop") operation = collector.close()
        if (reason === "scope") operation = Effect.runPromise(Scope.close(api.collectorScope, Exit.void))
        if (reason === "recovery") wsTarget.sockets.at(-1)!.terminate()
        if (reason === "shutdown") operation = api.shutdown()
        if (reason === "overflow") {
            server.deliver("11")
            server.deliver("12")
        }
        let operationSettled = false
        void operation.then(
            () => {
                operationSettled = true
            },
            () => {
                operationSettled = true
            },
        )
        await vi.waitFor(() => expect(cancelled).toBe(true))
        if (reason === "stop" && mode === "native") await operation
        expect(closed).toBe(false)
        expect(cleaned).toBe(false)
        if (reason === "scope" || reason === "shutdown") expect(operationSettled).toBe(false)
        release()
        await operation
        const outcome = await result
        expect(cleaned).toBe(true)
        expect(outcome).toMatchObject(
            reason === "cancel"
                ? { _tag: "CancelledError" }
                : reason === "shutdown"
                  ? { _tag: "ClientClosedError" }
                  : reason === "recovery" || reason === "overflow"
                    ? {
                          _tag: "CollectorError",
                          reason: reason === "recovery" ? "connectionLost" : "overflow",
                      }
                    : { reason: reason === "timeout" || reason === "idle" ? reason : "stopped" },
        )
    } finally {
        release()
    }
})

test("native progress retains the registration context", async () => {
    const server = await fixture()
    const api = await driver("native")
    await api.connect()
    const Label = Context.Service<string>("message-progress-label")
    const labels: string[] = []
    const collector = await Effect.runPromise(
        api
            .native!.messages.collect("20", {
                onMessage: () =>
                    Effect.gen(function* () {
                        labels.push(yield* Label)
                    }),
            })
            .pipe(Effect.provideService(Label, "registration"), Scope.provide(api.collectorScope)),
    )
    server.deliver("10")
    await Effect.runPromise(collector.result())
    expect(labels).toEqual(["registration"])
})

test("native progress can request client shutdown without joining itself", async () => {
    const server = await fixture()
    const api = await driver("native")
    await api.connect()
    let finalized = false
    let continuedAfterShutdown = false
    const collector = await Effect.runPromise(
        api
            .native!.messages.collect("20", {
                onMessage: () =>
                    api
                        .native!.shutdown()
                        .pipe(Effect.ensuring(Effect.sync(() => (finalized = true))))
                        .pipe(Effect.andThen(Effect.sync(() => (continuedAfterShutdown = true)))),
            })
            .pipe(Scope.provide(api.collectorScope)),
    )
    server.deliver("10")
    await vi.waitFor(() => expect(finalized).toBe(true), { interval: 5 })
    const outcome = await Effect.runPromise(typedResult(collector.result()))
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "ClientClosedError" } })
    // Collector cleanup is not the client shutdown barrier, which also owns gateway and REST cleanup
    await api.shutdown()
    expect(api.native!.state).toBe("Closed")
    expect(continuedAfterShutdown).toBe(false)
})

test("native progress retains terminal cleanup defects in its Cause", async () => {
    const server = await fixture()
    const api = await driver("native")
    await api.connect()
    let started = false
    const collector = await Effect.runPromise(
        api
            .native!.messages.collect("20", {
                onMessage: () =>
                    Effect.sync(() => {
                        started = true
                    }).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.die("fixture cleanup defect"))),
            })
            .pipe(Scope.provide(api.collectorScope)),
    )
    server.deliver("10")
    await vi.waitFor(() => expect(started).toBe(true))
    await Effect.runPromise(collector.close())
    const exit = await Effect.runPromiseExit(collector.result())
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
})

test("default onMessage getter defects become an application SdkDefect carrying the thrown value", async () => {
    const api = await driver("default")
    const privateBody = "private onMessage getter defect"
    const getterFailure = new Error(privateBody)
    const options = Object.defineProperty({}, "onMessage", {
        get() {
            throw getterFailure
        },
    })
    let error: unknown
    try {
        api.defaultApi!.messages.collect("20", options as DefaultCollectorOptions)
    } catch (caught) {
        error = caught
    }
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        code: "application.defect",
        operation: "collect",
        reasons: [{ kind: "Defect", origin: "application", defect: getterFailure }],
    })
    expect((error as SdkDefect).cause).toBe(getterFailure)
    expect(JSON.stringify(error)).toContain(privateBody)
})

test.each(modes)("%s releases progress callbacks and failed message snapshots after closure", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    await api.connect()
    const weak: WeakRef<object>[] = []

    async function trackedFailure() {
        const defaultApi = (message: import("../../src/index.js").Message) => {
            weak.push(new WeakRef(message))
            throw new Error("fixture failure")
        }
        const native = (message: import("../../src/index.js").Message) => Effect.sync(() => defaultApi(message))
        weak.push(new WeakRef(defaultApi), new WeakRef(native))
        return progress(api, defaultApi, native, { maxMessages: 2 })
    }

    const failed = await trackedFailure()
    server.deliver("10")
    await expect(failed.wait()).rejects.toMatchObject({ _tag: "CollectorError", reason: "handler" })

    const controller = new AbortController()
    let started = false
    async function trackedCancellation() {
        const defaultApi = async (
            message: import("../../src/index.js").Message,
            signal: Parameters<NonNullable<DefaultCollectorOptions["onMessage"]>>[1],
        ) => {
            weak.push(new WeakRef(message))
            started = true
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        }
        const native = (message: import("../../src/index.js").Message) =>
            Effect.sync(() => {
                weak.push(new WeakRef(message))
                started = true
            }).pipe(Effect.andThen(Effect.never))
        weak.push(new WeakRef(defaultApi), new WeakRef(native))
        return progress(api, defaultApi, native, {
            maxMessages: 2,
            ...(mode === "default" ? { signal: controller.signal } : {}),
        } as import("../../src/collectors.js").CollectorOptions)
    }

    const cancelled = await trackedCancellation()
    server.deliver("11")
    await vi.waitFor(() => expect(started).toBe(true))
    if (mode === "default") controller.abort()
    else wsTarget.sockets.at(-1)!.terminate()
    await expect(cancelled.wait()).rejects.toMatchObject(
        mode === "default" ? { _tag: "CancelledError" } : { _tag: "CollectorError", reason: "connectionLost" },
    )

    const session = new Session()
    session.connect()
    try {
        for (let attempt = 0; attempt < 10; attempt++) {
            await turn()
            await new Promise<void>((resolve, reject) =>
                session.post("HeapProfiler.collectGarbage", (error) => (error ? reject(error) : resolve())),
            )
            if (weak.every((reference) => reference.deref() === undefined)) break
        }
        expect(weak.map((reference) => reference.deref() === undefined)).toEqual([true, true, true, true, true, true])
    } finally {
        session.disconnect()
    }
})
