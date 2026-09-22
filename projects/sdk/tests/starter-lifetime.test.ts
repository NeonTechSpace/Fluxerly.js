import { once } from "node:events"
import { createServer } from "node:http"
import { Cause, Deferred, Effect, Exit } from "effect"
import { err, ok } from "neverthrow"
import { WebSocket, WebSocketServer } from "ws"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import type { Client as DefaultClient, ConnectionState, Subscription as DefaultSubscription } from "../src/index.js"
import {
    ClientClosedError,
    type Client as NativeClient,
    type Subscription as NativeSubscription,
} from "../src/effect.js"
import { hostedDiscoveryDocument } from "./hosted-discovery.js"
// @ts-expect-error The JavaScript starter is checked directly with checkJs
import * as defaultLifetime from "../examples/starter/lifetime.js"
import {
    CriticalWorkerStoppedError as NativeCriticalWorkerStoppedError,
    runBot as runNativeBot,
    supervise as superviseNative,
} from "../examples/starter/lifetime-effect.js"

const {
    CriticalWorkerStoppedError: DefaultCriticalWorkerStoppedError,
    runBot: runDefaultBot,
    supervise: superviseDefault,
} = defaultLifetime

const transport = vi.hoisted(() => ({ url: "" }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(url: string, options: import("ws").ClientOptions) {
                super(transport.url || url, options)
            }
        },
    }
})

afterEach(() => {
    vi.unstubAllGlobals()
    transport.url = ""
})

function deferred<A>() {
    let resolve!: (value: A) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<A>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, reject, resolve }
}

function defaultHarness(options: { readonly shutdownFailure?: Error } = {}) {
    let state: ConnectionState = "Disconnected"
    let shutdowns = 0
    const started = deferred<void>()
    const closed = deferred<ReturnType<typeof ok<void>>>()
    const client = {
        get state() {
            return state
        },
        run: ({ signal }: { readonly signal: AbortSignal }) => {
            state = "Connecting"
            started.resolve()
            signal.addEventListener("abort", () => closed.resolve(ok(undefined)), { once: true })
            return closed.promise
        },
        shutdown: () => {
            shutdowns++
            state = "Closed"
            closed.resolve(ok(undefined))
            return options.shutdownFailure ? Promise.reject(options.shutdownFailure) : Promise.resolve(ok(undefined))
        },
    } as unknown as DefaultClient
    return { client, shutdowns: () => shutdowns, started: started.promise }
}

function defaultWorker(result: Promise<unknown>): DefaultSubscription {
    return {
        unsubscribe: () => undefined,
        waitForClose: () => result,
    } as unknown as DefaultSubscription
}

function failureReasons(error: unknown): readonly unknown[] {
    return error instanceof AggregateError ? error.errors : [error]
}

describe("default starter lifetime", () => {
    test("external stop awaits shutdown and removes process handlers", async () => {
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
        const abort = new AbortController()
        const fixture = defaultHarness()
        const workerClosed = deferred<ReturnType<typeof ok<void>>>()
        const worker = defaultWorker(workerClosed.promise)
        const running = superviseDefault(fixture.client, [worker], abort.signal)
        await fixture.started
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(
            before.map((count) => count + 1),
        )
        abort.abort()
        workerClosed.resolve(ok(undefined))
        await running
        expect(fixture.shutdowns()).toBe(1)
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
    })

    test("unexpected successful critical worker closure stops the client", async () => {
        const fixture = defaultHarness()
        await expect(
            superviseDefault(fixture.client, [defaultWorker(Promise.resolve(ok(undefined)))]),
        ).rejects.toBeInstanceOf(DefaultCriticalWorkerStoppedError)
        expect(fixture.shutdowns()).toBe(1)
    })

    test("operation, worker and shutdown failures are all retained", async () => {
        const operation = new Error("operation failed")
        const workerFailure = new Error("worker failed")
        const cleanup = new Error("cleanup failed")
        const fixture = defaultHarness({ shutdownFailure: cleanup })
        const client = {
            ...fixture.client,
            run: () => Promise.resolve(err(operation)),
        } as unknown as DefaultClient
        const failure = await superviseDefault(client, [defaultWorker(Promise.resolve(err(workerFailure)))]).catch(
            (error: unknown) => error,
        )
        expect(failureReasons(failure)).toEqual(expect.arrayContaining([operation, workerFailure, cleanup]))
    })

    test("non-Error NaN failure is retained alone and alongside cleanup failure", async () => {
        const client = (cleanup?: Error) => {
            const fixture = defaultHarness(cleanup ? { shutdownFailure: cleanup } : {})
            return {
                ...fixture.client,
                run: () => Promise.resolve(err(Number.NaN)),
            } as unknown as DefaultClient
        }
        const alone = await superviseDefault(client(), []).catch((error: unknown) => error)
        expect(Number.isNaN(alone)).toBe(true)

        const cleanup = new Error("cleanup failed")
        const combined = await superviseDefault(client(cleanup), []).catch((error: unknown) => error)
        expect(combined).toBeInstanceOf(AggregateError)
        if (!(combined instanceof AggregateError)) throw new Error("Expected aggregate failure")
        expect(combined.errors).toHaveLength(2)
        expect(Number.isNaN(combined.errors[0])).toBe(true)
        expect(combined.errors[1]).toBe(cleanup)
    })

    test("pre-aborted startup and local creation or install failure do not leak a client", async () => {
        const stopped = AbortSignal.abort()
        await expect(runDefaultBot({ token: "" }, () => [], stopped)).resolves.toBeUndefined()
        await expect(runDefaultBot({ token: "" }, () => [])).rejects.toMatchObject({ _tag: "ConfigurationError" })

        let client: DefaultClient | undefined
        const installation = new Error("install failed")
        await expect(
            runDefaultBot({ token: "fixture-only-not-a-credential" }, (created: DefaultClient) => {
                client = created
                throw installation
            }),
        ).rejects.toBe(installation)
        expect(client?.state).toBe("Closed")

        let nanClient: DefaultClient | undefined
        const nonError = await runDefaultBot({ token: "fixture-only-not-a-credential" }, (created: DefaultClient) => {
            nanClient = created
            throw Number.NaN
        }).catch((error: unknown) => error)
        expect(Number.isNaN(nonError)).toBe(true)
        expect(nanClient?.state).toBe("Closed")
    })
})

function nativeFixture(
    run: Effect.Effect<void, Error>,
    workers: readonly Effect.Effect<void, Error>[],
    cleanup?: Error,
) {
    let state: ConnectionState = "Disconnected"
    return {
        client: {
            get state() {
                return state
            },
            run: () => run,
            shutdown: () =>
                Effect.sync(() => {
                    state = "Closed"
                    if (cleanup) throw cleanup
                }),
        } as unknown as NativeClient,
        workers: workers.map(
            (wait) =>
                ({
                    unsubscribe: () => Effect.void,
                    waitForClose: () => wait,
                }) as NativeSubscription,
        ),
    }
}

async function starterGateway(holdReady: boolean) {
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    const sockets: WebSocket[] = []
    const identified = deferred<void>()
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const command = JSON.parse(data.toString()) as { op: number }
            if (command.op !== 2) return
            identified.resolve()
            if (!holdReady)
                socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fixture-session" } }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected loopback listener")
    transport.url = `ws://127.0.0.1:${address.port}`
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(hostedDiscoveryDocument)),
    )
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return { identified: identified.promise }
}

describe("native starter lifetime", () => {
    test("external stop closes a real client during held discovery without reporting closure", async () => {
        const entered = deferred<void>()
        let fetchAborts = 0
        vi.stubGlobal(
            "fetch",
            vi.fn(
                (_url: RequestInfo | URL, init: RequestInit) =>
                    new Promise<Response>((_resolve, reject) => {
                        init.signal?.addEventListener(
                            "abort",
                            () => {
                                fetchAborts++
                                reject(init.signal?.reason)
                            },
                            { once: true },
                        )
                        entered.resolve()
                    }),
            ),
        )
        const abort = new AbortController()
        let client: NativeClient | undefined
        const running = Effect.runPromiseExit(
            runNativeBot(
                { token: "fixture-only-not-a-credential" },
                (created) =>
                    Effect.sync(() => {
                        client = created
                        return []
                    }),
                abort.signal,
            ),
        )
        onTestFinished(async () => {
            abort.abort()
            await running
        })
        try {
            await entered.promise
            abort.abort()
            expect(Exit.isSuccess(await running)).toBe(true)
            expect(fetchAborts).toBe(1)
            expect(client?.state).toBe("Closed")
        } finally {
            abort.abort()
            await running
        }
    })

    test.each([true, false])("external stop closes a real client after HELLO with holdReady=%s", async (holdReady) => {
        const gateway = await starterGateway(holdReady)
        const abort = new AbortController()
        let client: NativeClient | undefined
        const running = Effect.runPromiseExit(
            runNativeBot(
                { token: "fixture-only-not-a-credential" },
                (created) =>
                    Effect.sync(() => {
                        client = created
                        return []
                    }),
                abort.signal,
            ),
        )
        onTestFinished(async () => {
            abort.abort()
            await running
        })
        try {
            await gateway.identified
            if (!holdReady) await vi.waitFor(() => expect(client?.state).toBe("Connected"))
            abort.abort()
            expect(Exit.isSuccess(await running)).toBe(true)
            expect(client?.state).toBe("Closed")
        } finally {
            abort.abort()
            await running
        }
    })

    test("external stop awaits native shutdown and removes process handlers", async () => {
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
        const abort = new AbortController()
        const started = deferred<void>()
        const running = Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const closed = yield* Deferred.make<void>()
                    const client = {
                        state: "Disconnected",
                        run: () =>
                            Effect.sync(() => started.resolve()).pipe(
                                Effect.andThen(Deferred.await(closed)),
                                Effect.asVoid,
                            ),
                        shutdown: () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                    } as unknown as NativeClient
                    const worker = {
                        unsubscribe: () => Effect.void,
                        waitForClose: () => Deferred.await(closed),
                    } as NativeSubscription
                    return yield* superviseNative(client, [worker], abort.signal)
                }),
            ),
        )
        await started.promise
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(
            before.map((count) => count + 1),
        )
        abort.abort()
        await running
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
    })

    test("stop-induced run closure does not hide shutdown defects", async () => {
        const abort = new AbortController()
        const started = deferred<void>()
        const closed = Deferred.makeUnsafe<void>()
        const cleanup = new Error("cleanup failed")
        const client = {
            state: "Connecting",
            run: () =>
                Effect.sync(() => started.resolve()).pipe(
                    Effect.andThen(Deferred.await(closed)),
                    Effect.andThen(Effect.fail(new ClientClosedError())),
                ),
            shutdown: () =>
                Effect.sync(() => {
                    Deferred.doneUnsafe(closed, Effect.void)
                    throw cleanup
                }),
        } as unknown as NativeClient
        const running = Effect.runPromise(Effect.scoped(Effect.exit(superviseNative(client, [], abort.signal))))
        await started.promise
        abort.abort()
        const result = await running
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
            expect(result.cause.reasons.some((reason) => reason._tag === "Die" && reason.defect === cleanup)).toBe(true)
        }
    })

    test("stop-induced run closure does not hide a combined run defect", async () => {
        const abort = new AbortController()
        const started = deferred<void>()
        const closed = Deferred.makeUnsafe<void>()
        const runDefect = new Error("run cleanup failed")
        const client = {
            state: "Connecting",
            run: () =>
                Effect.sync(() => started.resolve()).pipe(
                    Effect.andThen(Deferred.await(closed)),
                    Effect.andThen(
                        Effect.failCause(Cause.combine(Cause.fail(new ClientClosedError()), Cause.die(runDefect))),
                    ),
                ),
            shutdown: () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
        } as unknown as NativeClient
        const running = Effect.runPromise(Effect.scoped(Effect.exit(superviseNative(client, [], abort.signal))))
        await started.promise
        abort.abort()
        const result = await running
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
            expect(result.cause.reasons.some((reason) => reason._tag === "Die" && reason.defect === runDefect)).toBe(
                true,
            )
    })

    test("an already-closing client's run failure is not treated as supervisor-induced", async () => {
        const abort = new AbortController()
        const started = deferred<void>()
        const closed = Deferred.makeUnsafe<void>()
        const client = {
            state: "Closing",
            run: () =>
                Effect.sync(() => started.resolve()).pipe(
                    Effect.andThen(Deferred.await(closed)),
                    Effect.andThen(Effect.fail(new ClientClosedError())),
                ),
            shutdown: () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
        } as unknown as NativeClient
        const running = Effect.runPromise(Effect.scoped(Effect.exit(superviseNative(client, [], abort.signal))))
        await started.promise
        abort.abort()
        const result = await running
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
            expect(
                result.cause.reasons.some(
                    (reason) => reason._tag === "Fail" && reason.error._tag === "ClientClosedError",
                ),
            ).toBe(true)
    })

    test("unexpected worker success is a typed failure after client shutdown", async () => {
        const result = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const closed = yield* Deferred.make<void>()
                    const fixture = nativeFixture(Deferred.await(closed), [Effect.void])
                    const client = {
                        ...fixture.client,
                        shutdown: () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                    } as unknown as NativeClient
                    return yield* Effect.exit(superviseNative(client, fixture.workers))
                }),
            ),
        )
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
            expect(
                result.cause.reasons.some(
                    (reason) => reason._tag === "Fail" && reason.error instanceof NativeCriticalWorkerStoppedError,
                ),
            ).toBe(true)
    })

    test("a worker that finishes while requesting stop is normal shutdown", async () => {
        const abort = new AbortController()
        const result = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const closed = yield* Deferred.make<void>()
                    const fixture = nativeFixture(Deferred.await(closed), [
                        Effect.sync(() => {
                            abort.abort()
                        }),
                    ])
                    const client = {
                        ...fixture.client,
                        shutdown: () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                    } as unknown as NativeClient
                    return yield* Effect.exit(superviseNative(client, fixture.workers, abort.signal))
                }),
            ),
        )
        expect(Exit.isSuccess(result)).toBe(true)
    })

    test("simultaneous operation, worker and cleanup causes are retained", async () => {
        const operation = new Error("operation failed")
        const workerFailure = new Error("worker failed")
        const cleanup = new Error("cleanup failed")
        const fixture = nativeFixture(Effect.fail(operation), [Effect.fail(workerFailure)], cleanup)
        const result = await Effect.runPromise(
            Effect.scoped(Effect.exit(superviseNative(fixture.client, fixture.workers))),
        )
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
            expect(result.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error === operation)).toBe(
                true,
            )
            expect(
                result.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error === workerFailure),
            ).toBe(true)
            expect(result.cause.reasons.some((reason) => reason._tag === "Die" && reason.defect === cleanup)).toBe(true)
        }
    })

    test("pre-aborted startup and install failure preserve normal scope cleanup", async () => {
        const stopped = await Effect.runPromise(
            Effect.exit(runNativeBot({ token: "" }, () => Effect.succeed([]), AbortSignal.abort())),
        )
        expect(Exit.isSuccess(stopped)).toBe(true)

        const invalid = await Effect.runPromise(Effect.exit(runNativeBot({ token: "" }, () => Effect.succeed([]))))
        expect(Exit.isFailure(invalid)).toBe(true)
        if (Exit.isFailure(invalid))
            expect(
                invalid.cause.reasons.some(
                    (reason) => reason._tag === "Fail" && reason.error._tag === "ConfigurationError",
                ),
            ).toBe(true)

        const installation = new Error("install failed")
        let client: NativeClient | undefined
        const failed = await Effect.runPromise(
            Effect.exit(
                runNativeBot({ token: "fixture-only-not-a-credential" }, (created) => {
                    client = created
                    return Effect.fail(installation)
                }),
            ),
        )
        expect(Exit.isFailure(failed)).toBe(true)
        if (Exit.isFailure(failed))
            expect(failed.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error === installation)).toBe(
                true,
            )
        expect(client?.state).toBe("Closed")
    })
})
