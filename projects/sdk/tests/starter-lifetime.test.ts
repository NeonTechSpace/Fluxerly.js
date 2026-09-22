import { Deferred, Effect, Exit } from "effect"
import { err, ok } from "neverthrow"
import { describe, expect, test } from "vitest"
import type { Client as DefaultClient, ConnectionState, Subscription as DefaultSubscription } from "../src/index.js"
import type { Client as NativeClient, Subscription as NativeSubscription } from "../src/effect.js"
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

describe("native starter lifetime", () => {
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
