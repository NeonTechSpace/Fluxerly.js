import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { SdkDefect, createClient } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { modes } from "../support/both-apis.js"
import { startRestServer } from "../support/rest-server.js"
import { sdkClock } from "../support/client-clock.js"

const target = { id: "10", channelId: "20" }
const cleanupRaceCases = modes.flatMap((mode) => (["rest", "discovery"] as const).map((owner) => ({ mode, owner })))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

function responseWithCleanupFailure(status: number, cleanup: unknown, cancelled?: () => void) {
    return new Response(
        new ReadableStream({
            cancel: () => {
                cancelled?.()
                throw cleanup
            },
        }),
        { status },
    )
}

function responseWithReaderReleaseFailure(response: Response, cleanup: unknown, readStarted?: () => void) {
    const body = response.body
    if (!body) throw new Error("Expected response body")
    const getReader = body.getReader.bind(body)
    vi.spyOn(body, "getReader").mockImplementation(() => {
        const reader = getReader()
        const read = reader.read.bind(reader)
        vi.spyOn(reader, "read").mockImplementation(() => {
            readStarted?.()
            return read()
        })
        const release = reader.releaseLock.bind(reader)
        vi.spyOn(reader, "releaseLock").mockImplementation(() => {
            release()
            throw cleanup
        })
        return reader
    })
    return response
}

const readerCleanupCases = [
    {
        name: "reader release fails",
        expectedCancellations: 0,
        create() {
            const cleanup = new Error("private error-reader release detail")
            return {
                response: responseWithReaderReleaseFailure(
                    Response.json({ message: "rejected" }, { status: 400 }),
                    cleanup,
                ),
                cancellations: () => 0,
                cleanups: [cleanup],
            }
        },
    },
    {
        name: "body cancellation and reader release fail",
        expectedCancellations: 1,
        create() {
            const releaseCleanup = new Error("private error-reader release detail")
            const cancelCleanup = new Error("private error-body cancellation detail")
            let cancellations = 0
            const response = new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(8_193))
                    },
                    cancel() {
                        cancellations++
                        throw cancelCleanup
                    },
                }),
                { status: 400, headers: { "content-type": "application/json" } },
            )
            return {
                response: responseWithReaderReleaseFailure(response, releaseCleanup),
                cancellations: () => cancellations,
                cleanups: [releaseCleanup, cancelCleanup],
            }
        },
    },
] as const

function expectedRejected400() {
    return expect.objectContaining({
        _tag: "MessageOperationError",
        operation: "fetch",
        reason: "rejected",
        outcome: "rejected",
        status: 400,
    })
}

/** Check that an error-body cleanup defect keeps every original reader failure as an ApiErrorBodyCleanupError cause */
function expectRetainedErrorBodyCleanups(defect: unknown, cleanups: readonly unknown[]) {
    const wrapped = cleanups.length === 1 ? [defect] : defect instanceof AggregateError ? defect.errors : []
    expect(wrapped).toEqual(cleanups.map(() => expect.objectContaining({ name: "ApiErrorBodyCleanupError" })))
    expect(wrapped.map((error) => (error as Error).cause)).toEqual(cleanups)
}

function expectDefaultRejected400WithCleanup(error: unknown, cleanups: readonly unknown[]) {
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        operation: "fetch",
        reasons: [
            {
                kind: "Failure",
                failure: expectedRejected400(),
            },
            expect.objectContaining({ kind: "Defect" }),
        ],
    })
    const defect = (error as SdkDefect).reasons.find((reason) => reason.kind === "Defect")
    expectRetainedErrorBodyCleanups(defect?.kind === "Defect" ? defect.defect : undefined, cleanups)
}

function expectNativeRejected400WithCleanup(exit: Exit.Exit<unknown, unknown>, cleanups: readonly unknown[]) {
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    expect(failure).toMatchObject({ _tag: "Fail", error: expectedRejected400() })
    const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
    expectRetainedErrorBodyCleanups(defect?._tag === "Die" ? defect.defect : undefined, cleanups)
}

const readerCleanupTestCases = modes.flatMap((mode) => readerCleanupCases.map((cleanup) => ({ mode, ...cleanup })))

test.each(readerCleanupTestCases)(
    "$mode preserves a 400 rejection when $name",
    async ({ mode, create, expectedCancellations }) => {
        const fixture = create()
        const fetch = vi.fn(async () => fixture.response)
        stubFetchWithHostedDiscovery(fetch)

        if (mode === "default") {
            const client = createClient({ token: "fixture" })
            try {
                const error = await Promise.resolve(client.messages.fetch(target)).catch((error) => error)
                expectDefaultRejected400WithCleanup(error, fixture.cleanups)
            } finally {
                await client.shutdown()
            }
        } else {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
            try {
                const exit = await Effect.runPromiseExit(client.messages.fetch(target))
                expectNativeRejected400WithCleanup(exit, fixture.cleanups)
            } finally {
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        }
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(fixture.cancellations()).toBe(expectedCancellations)
    },
)

test.each(modes)("%s retains caller cancellation and error-reader cleanup failure", async (mode) => {
    const cleanup = new Error("private cancelled error-reader release detail")
    let startedReading!: () => void
    const reading = new Promise<void>((resolve) => {
        startedReading = resolve
    })
    let bodyCancelled!: () => void
    const cancelled = new Promise<void>((resolve) => {
        bodyCancelled = resolve
    })
    let cancellations = 0
    const fetch = vi.fn(async () => {
        const response = new Response(
            new ReadableStream({
                cancel() {
                    cancellations++
                    bodyCancelled()
                },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
        )
        return responseWithReaderReleaseFailure(response, cleanup, startedReading)
    })
    stubFetchWithHostedDiscovery(fetch)

    if (mode === "default") {
        const client = createClient({ token: "fixture" })
        const controller = new AbortController()
        try {
            const result = Promise.resolve(client.messages.fetch(target, { signal: controller.signal }))
            await reading
            controller.abort()
            await cancelled
            const error = await result.catch((error) => error)
            expect(error).toBeInstanceOf(SdkDefect)
            expect(error).toMatchObject({
                operation: "fetch",
                reasons: expect.arrayContaining([
                    { kind: "Interruption" },
                    expect.objectContaining({ kind: "Defect" }),
                ]),
            })
            const defect = (error as SdkDefect).reasons.find((reason) => reason.kind === "Defect")
            expectRetainedErrorBodyCleanups(defect?.kind === "Defect" ? defect.defect : undefined, [cleanup])
        } finally {
            await client.shutdown()
        }
    } else {
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
        const controller = new AbortController()
        try {
            const result = Effect.runPromiseExit(client.messages.fetch(target), { signal: controller.signal })
            await reading
            controller.abort()
            await cancelled
            const exit = await result
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                expect(Cause.hasInterrupts(exit.cause)).toBe(true)
                const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
                expectRetainedErrorBodyCleanups(defect?._tag === "Die" ? defect.defect : undefined, [cleanup])
            }
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cancellations).toBe(1)
})

test.each(modes)("%s preserves REST rejection and response-cleanup defects without a retry", async (mode) => {
    for (const status of [401, 503]) {
        const cleanup = new Error("private REST cleanup detail")
        let cancellations = 0
        const fetch = vi.fn(async () => responseWithCleanupFailure(status, cleanup, () => cancellations++))
        stubFetchWithHostedDiscovery(fetch)

        if (mode === "default") {
            const client = createClient({ token: "fixture" })
            try {
                const error = await Promise.resolve(client.messages.fetch(target)).catch((error) => error)
                expect(cancellations).toBe(1)
                expect(error).toBeInstanceOf(SdkDefect)
                expect(error).toMatchObject({
                    operation: "fetch",
                    reasons: [
                        {
                            kind: "Failure",
                            failure: expect.objectContaining({
                                _tag: "MessageOperationError",
                                operation: "fetch",
                                status,
                            }),
                        },
                        expect.objectContaining({ kind: "Defect" }),
                    ],
                })
                expect(JSON.stringify(error)).toContain("private REST cleanup detail")
            } finally {
                await client.shutdown()
            }
        } else {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
            try {
                const exit = await Effect.runPromiseExit(client.messages.fetch(target))
                expect(cancellations).toBe(1)
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isFailure(exit)) {
                    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                    expect(failure).toMatchObject({
                        _tag: "Fail",
                        error: expect.objectContaining({ _tag: "MessageOperationError", operation: "fetch", status }),
                    })
                    const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
                    expect(defect).toMatchObject({ _tag: "Die" })
                    if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
                }
            } finally {
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        }
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(cancellations).toBe(1)
        vi.unstubAllGlobals()
    }
})

test.each(modes)("%s preserves discovery HTTP failure and response-cleanup defects", async (mode) => {
    const cleanup = new Error("private discovery cleanup detail")
    let cancellations = 0
    const fetch = vi.fn(async () => responseWithCleanupFailure(401, cleanup, () => cancellations++))
    vi.stubGlobal("fetch", fetch)

    if (mode === "default") {
        const client = createClient({ token: "fixture", connection: { maxStartupAttempts: 2 } })
        try {
            const error = await Promise.resolve(client.connect()).catch((error) => error)
            expect(cancellations).toBe(1)
            expect(error).toBeInstanceOf(SdkDefect)
            expect(error).toMatchObject({
                operation: "connect",
                reasons: [
                    {
                        kind: "Failure",
                        failure: expect.objectContaining({
                            _tag: "ConnectionError",
                            phase: "discovery",
                            reason: "network",
                            status: 401,
                        }),
                    },
                    { kind: "Defect", defect: cleanup },
                ],
            })
            expect(JSON.stringify(error)).toContain("private discovery cleanup detail")
        } finally {
            await client.shutdown()
        }
    } else {
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(
            createNative({ token: "fixture", connection: { maxStartupAttempts: 2 } }).pipe(Scope.provide(scope)),
        )
        try {
            const exit = await Effect.runPromiseExit(client.connect())
            expect(cancellations).toBe(1)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                expect(failure).toMatchObject({
                    _tag: "Fail",
                    error: expect.objectContaining({
                        _tag: "ConnectionError",
                        phase: "discovery",
                        reason: "network",
                        status: 401,
                    }),
                })
                const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
                expect(defect).toMatchObject({ _tag: "Die" })
                if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
            }
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cancellations).toBe(1)
})

test.each(modes)("%s aborts a pending discovery body read before reporting interruption", async (mode) => {
    let startedRead!: () => void
    const reading = new Promise<void>((resolve) => {
        startedRead = resolve
    })
    let observedAbort!: () => void
    const aborted = new Promise<void>((resolve) => {
        observedAbort = resolve
    })
    let cancellations = 0
    let cancellationAfterAbort = false
    const fetch = vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(
            new Response(
                new ReadableStream({
                    pull: () => {
                        startedRead()
                        return new Promise<void>((_resolve, reject) => {
                            init.signal?.addEventListener(
                                "abort",
                                () => {
                                    observedAbort()
                                    reject(new Error("test body aborted"))
                                },
                                { once: true },
                            )
                        })
                    },
                    cancel: () => {
                        cancellations++
                        cancellationAfterAbort = init.signal?.aborted === true
                    },
                }),
                { status: 200 },
            ),
        ),
    )
    vi.stubGlobal("fetch", fetch)

    if (mode === "default") {
        const client = createClient({ token: "fixture" })
        const controller = new AbortController()
        try {
            const result = Promise.resolve(client.connect({ signal: controller.signal }))
            await reading
            controller.abort()
            await aborted
            const outcome = await result
            expect(outcome.isErr()).toBe(true)
            if (outcome.isErr()) expect(outcome.error).toMatchObject({ _tag: "CancelledError" })
        } finally {
            await client.shutdown()
        }
    } else {
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
        const controller = new AbortController()
        try {
            const result = Effect.runPromiseExit(client.connect(), { signal: controller.signal })
            await reading
            controller.abort()
            await aborted
            const exit = await result
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cancellations).toBe(1)
    expect(cancellationAfterAbort).toBe(true)
})

test.each(modes)("%s retains a foreign late discovery abort defect with interruption", async (mode) => {
    const cleanup = new DOMException("private late discovery cleanup detail", "AbortError")
    let resolveFetch!: (response: Response) => void
    let observedAbort!: () => void
    const aborted = new Promise<void>((resolve) => {
        observedAbort = resolve
    })
    let cancellations = 0
    const fetch = vi.fn(
        (_url: string, init: RequestInit) =>
            new Promise<Response>((resolve) => {
                resolveFetch = resolve
                init.signal?.addEventListener("abort", observedAbort, { once: true })
            }),
    )
    vi.stubGlobal("fetch", fetch)

    if (mode === "default") {
        const client = createClient({ token: "fixture" })
        const controller = new AbortController()
        try {
            const result = Promise.resolve(client.connect({ signal: controller.signal }))
            await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"))
            controller.abort()
            await aborted
            let settled = false
            void result.then(
                () => {
                    settled = true
                },
                () => {
                    settled = true
                },
            )
            await Promise.resolve()
            expect(settled).toBe(false)
            resolveFetch(responseWithCleanupFailure(200, cleanup, () => cancellations++))
            const error = await result.catch((error) => error)
            expect(error).toBeInstanceOf(SdkDefect)
            expect(error).toMatchObject({
                operation: "connect",
                reasons: expect.arrayContaining([
                    { kind: "Interruption" },
                    expect.objectContaining({ kind: "Defect" }),
                ]),
            })
            expect(JSON.stringify(error)).toContain("private late discovery cleanup detail")
        } finally {
            await client.shutdown()
        }
    } else {
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
        const controller = new AbortController()
        try {
            const result = Effect.runPromiseExit(client.connect(), { signal: controller.signal })
            await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"))
            controller.abort()
            await aborted
            let settled = false
            void result.then(() => {
                settled = true
            })
            await Promise.resolve()
            expect(settled).toBe(false)
            resolveFetch(responseWithCleanupFailure(200, cleanup, () => cancellations++))
            const exit = await result
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                expect(Cause.hasInterrupts(exit.cause)).toBe(true)
                const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
                expect(defect).toMatchObject({ _tag: "Die" })
                if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
            }
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cancellations).toBe(1)
})

test.each(modes)("%s ignores only its own late discovery abort reason", async (mode) => {
    let resolveFetch!: (response: Response) => void
    let observedAbort!: () => void
    const aborted = new Promise<void>((resolve) => {
        observedAbort = resolve
    })
    let responseSignal: AbortSignal | undefined
    let cancellations = 0
    const fetch = vi.fn(
        (_url: string, init: RequestInit) =>
            new Promise<Response>((resolve) => {
                responseSignal = init.signal ?? undefined
                resolveFetch = resolve
                init.signal?.addEventListener("abort", observedAbort, { once: true })
            }),
    )
    vi.stubGlobal("fetch", fetch)

    if (mode === "default") {
        const client = createClient({ token: "fixture" })
        const controller = new AbortController()
        try {
            const result = Promise.resolve(client.connect({ signal: controller.signal }))
            await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"))
            controller.abort()
            await aborted
            resolveFetch(
                new Response(
                    new ReadableStream({
                        cancel: () => {
                            cancellations++
                            throw responseSignal!.reason
                        },
                    }),
                    { status: 200 },
                ),
            )
            const outcome = await result
            expect(outcome.isErr()).toBe(true)
            if (outcome.isErr()) expect(outcome.error).toMatchObject({ _tag: "CancelledError" })
        } finally {
            await client.shutdown()
        }
    } else {
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
        const controller = new AbortController()
        try {
            const result = Effect.runPromiseExit(client.connect(), { signal: controller.signal })
            await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"))
            controller.abort()
            await aborted
            resolveFetch(
                new Response(
                    new ReadableStream({
                        cancel: () => {
                            cancellations++
                            throw responseSignal!.reason
                        },
                    }),
                    { status: 200 },
                ),
            )
            const exit = await result
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                expect(Cause.hasInterrupts(exit.cause)).toBe(true)
                expect(Cause.hasDies(exit.cause)).toBe(false)
            }
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cancellations).toBe(1)
})

test.each(cleanupRaceCases)(
    "$mode $owner retains an HTTP failure and cleanup defect when interrupted during cleanup",
    async ({ mode, owner }) => {
        const cleanup = new Error("private interrupted cleanup detail")
        let cancellations = 0
        let release!: () => void
        const released = new Promise<void>((resolve) => {
            release = resolve
        })
        let cancelling!: () => void
        const cancellingStarted = new Promise<void>((resolve) => {
            cancelling = resolve
        })
        const fetch = vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        cancel: async () => {
                            cancellations++
                            cancelling()
                            await released
                            throw cleanup
                        },
                    }),
                    { status: 401 },
                ),
        )
        if (owner === "rest") stubFetchWithHostedDiscovery(fetch)
        else vi.stubGlobal("fetch", fetch)

        const configuration =
            owner === "rest" ? { token: "fixture" } : { token: "fixture", connection: { maxStartupAttempts: 2 } }
        const operation = owner === "rest" ? "fetch" : "connect"
        const authenticationFailure =
            owner === "rest"
                ? expect.objectContaining({ _tag: "MessageOperationError", operation: "fetch", status: 401 })
                : expect.objectContaining({
                      _tag: "ConnectionError",
                      phase: "discovery",
                      reason: "network",
                      status: 401,
                  })

        if (mode === "default") {
            const client = createClient(configuration)
            const controller = new AbortController()
            try {
                const result = Promise.resolve(
                    owner === "rest"
                        ? client.messages.fetch(target, { signal: controller.signal })
                        : client.connect({ signal: controller.signal }),
                )
                await cancellingStarted
                controller.abort()
                let settled = false
                void result.then(
                    () => {
                        settled = true
                    },
                    () => {
                        settled = true
                    },
                )
                await Promise.resolve()
                expect(settled).toBe(false)
                release()
                const error = await result.catch((error) => error)
                expect(cancellations).toBe(1)
                expect(error).toBeInstanceOf(SdkDefect)
                expect(error).toMatchObject({
                    operation,
                    reasons: expect.arrayContaining([
                        { kind: "Interruption" },
                        {
                            kind: "Failure",
                            failure: authenticationFailure,
                        },
                        expect.objectContaining({ kind: "Defect" }),
                    ]),
                })
                expect(JSON.stringify(error)).toContain("private interrupted cleanup detail")
            } finally {
                release()
                await client.shutdown()
            }
        } else {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(createNative(configuration).pipe(Scope.provide(scope)))
            const controller = new AbortController()
            try {
                const request: Effect.Effect<void, unknown> =
                    owner === "rest" ? client.messages.fetch(target).pipe(Effect.asVoid) : client.connect()
                const result = Effect.runPromiseExit(request, { signal: controller.signal })
                await cancellingStarted
                controller.abort()
                let settled = false
                void result.then(() => {
                    settled = true
                })
                await Promise.resolve()
                expect(settled).toBe(false)
                release()
                const exit = await result
                expect(cancellations).toBe(1)
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isFailure(exit)) {
                    expect(Cause.hasInterrupts(exit.cause)).toBe(true)
                    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                    expect(failure).toMatchObject({
                        _tag: "Fail",
                        error: authenticationFailure,
                    })
                    const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
                    expect(defect).toMatchObject({ _tag: "Die" })
                    if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
                }
            } finally {
                release()
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        }
    },
)

test.each(cleanupRaceCases)(
    "$mode $owner retains HTTP and cleanup failures when its deadline expires during cleanup",
    async ({ mode, owner }) => {
        // The SDK deadline runs on the controlled Effect Clock, so it expires only when the test advances it
        const clock = sdkClock()
        const cleanup = new Error("private timed cleanup detail")
        let release!: () => void
        const released = new Promise<void>((resolve) => {
            release = resolve
        })
        let cancelling!: () => void
        const cancellingStarted = new Promise<void>((resolve) => {
            cancelling = resolve
        })
        const fetch = vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        cancel: async () => {
                            cancelling()
                            await released
                            throw cleanup
                        },
                    }),
                    { status: 401 },
                ),
        )
        if (owner === "rest") stubFetchWithHostedDiscovery(fetch)
        else vi.stubGlobal("fetch", fetch)

        const configuration =
            owner === "rest"
                ? { token: "fixture" }
                : { token: "fixture", connection: { maxStartupAttempts: 2, startupTimeoutMs: 100 } }
        const operation = owner === "rest" ? "fetch" : "connect"
        const timeoutFailure =
            owner === "rest"
                ? expect.objectContaining({ _tag: "MessageOperationError", operation: "fetch", reason: "timeout" })
                : expect.objectContaining({ _tag: "ConnectionTimeoutError" })
        const authenticationFailure =
            owner === "rest"
                ? expect.objectContaining({ _tag: "MessageOperationError", operation: "fetch", status: 401 })
                : expect.objectContaining({
                      _tag: "ConnectionError",
                      phase: "discovery",
                      reason: "network",
                      status: 401,
                  })

        if (mode === "default") {
            const client = createClient(configuration)
            try {
                const result = Promise.resolve(
                    owner === "rest" ? client.messages.fetch(target, { timeoutMs: 100 }) : client.connect(),
                )
                await cancellingStarted
                await clock.advance(100)
                release()
                const error = await result.catch((error) => error)
                expect(error).toBeInstanceOf(SdkDefect)
                expect(error).toMatchObject({
                    operation,
                    reasons: expect.arrayContaining([
                        {
                            kind: "Failure",
                            failure: timeoutFailure,
                        },
                        {
                            kind: "Failure",
                            failure: authenticationFailure,
                        },
                        expect.objectContaining({ kind: "Defect" }),
                    ]),
                })
                expect(JSON.stringify(error)).toContain("private timed cleanup detail")
            } finally {
                release()
                await client.shutdown()
            }
        } else {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(createNative(configuration).pipe(Scope.provide(scope)))
            try {
                const request: Effect.Effect<void, unknown> =
                    owner === "rest"
                        ? client.messages.fetch(target, { timeoutMs: 100 }).pipe(Effect.asVoid)
                        : client.connect()
                const result = Effect.runPromiseExit(request)
                await cancellingStarted
                await clock.advance(100)
                release()
                const exit = await result
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isFailure(exit)) {
                    const failures = exit.cause.reasons.filter((reason) => reason._tag === "Fail")
                    expect(failures).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({
                                error: timeoutFailure,
                            }),
                            expect.objectContaining({
                                error: authenticationFailure,
                            }),
                        ]),
                    )
                    const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
                    expect(defect).toMatchObject({ _tag: "Die" })
                    if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
                }
            } finally {
                release()
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        }
    },
)

test.each(modes)("%s waits for a late response cleanup and retains interruption with its defect", async (mode) => {
    const cleanup = new Error("private late cleanup detail")
    let resolveFetch!: (response: Response) => void
    let observedAbort!: () => void
    const aborted = new Promise<void>((resolve) => {
        observedAbort = resolve
    })
    let cancellations = 0
    const fetch = vi.fn(
        (_url: string, init: RequestInit) =>
            new Promise<Response>((resolve) => {
                resolveFetch = resolve
                init.signal?.addEventListener("abort", observedAbort, { once: true })
            }),
    )
    stubFetchWithHostedDiscovery(fetch)

    if (mode === "default") {
        const client = createClient({ token: "fixture" })
        const controller = new AbortController()
        try {
            const result = Promise.resolve(client.messages.fetch(target, { signal: controller.signal }))
            await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"))
            controller.abort()
            await aborted
            let settled = false
            void result.then(
                () => {
                    settled = true
                },
                () => {
                    settled = true
                },
            )
            await Promise.resolve()
            expect(settled).toBe(false)
            resolveFetch(responseWithCleanupFailure(200, cleanup, () => cancellations++))
            const error = await result.catch((error) => error)
            expect(error).toBeInstanceOf(SdkDefect)
            expect(error).toMatchObject({
                operation: "fetch",
                reasons: expect.arrayContaining([
                    { kind: "Interruption" },
                    expect.objectContaining({ kind: "Defect" }),
                ]),
            })
            expect(JSON.stringify(error)).toContain("private late cleanup detail")
        } finally {
            await client.shutdown()
        }
    } else {
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
        const controller = new AbortController()
        try {
            const result = Effect.runPromiseExit(client.messages.fetch(target), { signal: controller.signal })
            await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"))
            controller.abort()
            await aborted
            let settled = false
            void result.then(() => {
                settled = true
            })
            await Promise.resolve()
            expect(settled).toBe(false)
            resolveFetch(responseWithCleanupFailure(200, cleanup, () => cancellations++))
            const exit = await result
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                expect(Cause.hasInterrupts(exit.cause)).toBe(true)
                const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
                expect(defect).toMatchObject({ _tag: "Die" })
                if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
            }
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cancellations).toBe(1)
})

test("cancels an unread real-fetch 401 response before aborting its controller", async () => {
    const realFetch = globalThis.fetch
    let closed = false
    const server = await startRestServer({
        fallback: (_request, response) => {
            // A body that is not JSON is never read as an API error, so only the release step cancels it
            response.writeHead(401, { "content-type": "text/plain" })
            response.flushHeaders()
            response.write("{")
            response.once("close", () => {
                closed = true
            })
        },
    })
    const order: string[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        init.signal?.addEventListener("abort", () => order.push("abort"), { once: true })
        const response = await realFetch(url.replace("https://api.fluxer.app", server.origin), init)
        const body = response.body!
        const cancel = body.cancel.bind(body)
        body.cancel = (reason) => {
            order.push("cancel")
            return cancel(reason)
        }
        return response
    })
    const client = createClient({ token: "fixture" })
    try {
        const result = await client.messages.fetch(target)
        expect(result.isErr()).toBe(true)
        if (result.isErr())
            expect(result.error).toMatchObject({ _tag: "MessageOperationError", operation: "fetch", status: 401 })
        expect(order).toEqual(["cancel", "abort"])
        await vi.waitFor(() => expect(closed).toBe(true))
    } finally {
        await client.shutdown()
    }
})

test.each(modes)("%s retains a cleanup defect after a successful presigned upload", async (mode) => {
    const cleanup = new Error("private successful cleanup detail")
    let cancellations = 0
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/attachments")) {
            const request = JSON.parse(String(init.body)) as {
                attachments: { id: number; filename: string; file_size: number }[]
            }
            return Response.json({
                attachments: request.attachments.map((file) => ({
                    ...file,
                    content_type: "application/octet-stream",
                    upload_filename: "fixture-upload",
                    upload_mode: "singlepart",
                    upload_url: "https://uploads.fluxer.app/fixture-upload",
                })),
            })
        }
        if (url === "https://uploads.fluxer.app/fixture-upload") {
            await new Response(init.body).arrayBuffer()
            return responseWithCleanupFailure(200, cleanup, () => cancellations++)
        }
        throw new Error(`Unexpected request ${url}`)
    })
    stubFetchWithHostedDiscovery(fetch)
    const input = { attachments: [{ data: new Uint8Array([1]), filename: "fixture.bin" }] }

    if (mode === "default") {
        const client = createClient({ token: "fixture" })
        try {
            const error = await Promise.resolve(client.messages.send("20", input)).catch((error) => error)
            expect(error).toBeInstanceOf(SdkDefect)
            expect(error).toMatchObject({ operation: "send", reasons: [expect.objectContaining({ kind: "Defect" })] })
            expect(JSON.stringify(error)).toContain("private successful cleanup detail")
        } finally {
            await client.shutdown()
        }
    } else {
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
        try {
            const exit = await Effect.runPromiseExit(client.messages.send("20", input))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                expect(exit.cause.reasons).toHaveLength(1)
                const [defect] = exit.cause.reasons
                expect(defect).toMatchObject({ _tag: "Die" })
                if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
            }
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        "https://api.fluxer.app/v1/channels/20/attachments",
        "https://uploads.fluxer.app/fixture-upload",
    ])
    expect(cancellations).toBe(1)
})
