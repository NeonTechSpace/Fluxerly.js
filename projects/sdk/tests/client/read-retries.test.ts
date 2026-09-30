import { typedResult } from "../support/settle.js"
import { Cause, Effect, Exit, Random, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    createClient,
    errors,
    type DefaultMessageOperationOptions,
    type LogRecord,
    type MessageOperationFailure,
} from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { modes, type Mode } from "../support/both-apis.js"
import { fakeHostTime, hostTurnsUntil } from "../support/client-clock.js"

const reads = ["fetch", "fetchHistory", "fetchReactionUsers", "fetchPins"] as const
const target = { id: "10", channelId: "20" }
const wire = { id: "10", channel_id: "20", content: "read", author: { id: "30", username: "fixture" } }
const body = (operation: (typeof reads)[number]) =>
    operation === "fetch"
        ? wire
        : operation === "fetchHistory"
          ? [wire]
          : operation === "fetchReactionUsers"
            ? { items: [{ id: "30", username: "fixture" }], has_more: false, next_after: null }
            : { items: [{ message: wire, pinned_at: "2026-09-08T12:00:00Z" }], has_more: false }
const unwrap = <A, E>(result: { isErr(): boolean; value?: A; error?: E }): A => {
    if (result.isErr()) throw result.error
    return result.value!
}
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

/** Fake host time with zero jitter, and record the client's rest.retry records, each logged before its wait starts */
function retryTime() {
    fakeHostTime()
    vi.spyOn(Math, "random").mockReturnValue(0)
    const records: LogRecord[] = []
    const retries = () => records.filter((record) => record.code === "rest.retry")
    return {
        logging: { categories: { rest: "debug" as const }, sink: (record: LogRecord) => void records.push(record) },
        retries,
        /** Wait until the given retry is scheduled, check that it does not run a millisecond early, then run it */
        async runRetry(count: number, delayMs: number, dispatched: () => number) {
            await hostTurnsUntil(() => retries().length >= count)
            expect(retries()[count - 1]).toMatchObject({ delayMs })
            const before = dispatched()
            await vi.advanceTimersByTimeAsync(delayMs - 1)
            expect(dispatched()).toBe(before)
            await vi.advanceTimersByTimeAsync(1)
            await hostTurnsUntil(() => dispatched() > before)
        },
        /** Settle an operation while advancing fake time until it completes */
        async drive<T>(operation: Promise<T>): Promise<T> {
            let done = false
            const tracked = operation.finally(() => {
                done = true
            })
            for (let step = 0; !done; step++) {
                if (step > 1_000) throw new Error("The operation did not settle")
                await vi.advanceTimersByTimeAsync(50)
            }
            return tracked
        },
    }
}

async function setup(mode: Mode, logging?: ReturnType<typeof retryTime>["logging"]) {
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture", cache: { messages: true }, ...(logging ? { logging } : {}) }
    const defaultApi = mode === "default" ? createClient(options) : undefined
    const native =
        mode === "native" ? await Effect.runPromise(createNative(options).pipe(Scope.provide(scope))) : undefined
    const random = vi.fn(() => 0)
    const run = <A>(effect: Effect.Effect<A, MessageOperationFailure>, signal?: AbortSignal) =>
        Effect.runPromise(
            typedResult(
                effect.pipe(Effect.provideService(Random.Random, { nextDoubleUnsafe: random, nextIntUnsafe: () => 0 })),
            ),
            signal ? { signal } : undefined,
        ).then((result) => {
            if (result._tag === "Failure") throw result.failure
            return result.success
        })
    const close = async () => {
        if (defaultApi) unwrap(await defaultApi.shutdown())
        else await Effect.runPromise(native!.shutdown())
    }
    onTestFinished(async () => {
        await close()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        defaultApi,
        native,
        random,
        close,
        read: async (operation: (typeof reads)[number] = "fetch", options?: DefaultMessageOperationOptions) => {
            if (defaultApi) {
                if (operation === "fetch") return unwrap(await defaultApi.messages.fetch(target, options))
                if (operation === "fetchHistory")
                    return unwrap(await defaultApi.messages.fetchHistory("20", { limit: 1, before: "11" }, options))
                if (operation === "fetchReactionUsers")
                    return unwrap(await defaultApi.messages.fetchReactionUsers(target, "👍", { limit: 1 }, options))
                return unwrap(await defaultApi.messages.fetchPins("20", { limit: 1 }, options))
            }
            const signal = options?.signal as AbortSignal | undefined
            if (operation === "fetch") return run(native!.messages.fetch(target, options), signal)
            if (operation === "fetchHistory")
                return run(native!.messages.fetchHistory("20", { limit: 1, before: "11" }, options), signal)
            if (operation === "fetchReactionUsers")
                return run(native!.messages.fetchReactionUsers(target, "👍", { limit: 1 }, options), signal)
            return run(native!.messages.fetchPins("20", { limit: 1 }, options), signal)
        },
        get: async () => (defaultApi ? defaultApi.messages.get(target) : run(native!.messages.get(target))),
        edit: async () =>
            defaultApi
                ? unwrap(await defaultApi.messages.edit(target, { content: "edited" }))
                : run(native!.messages.edit(target, { content: "edited" })),
    }
}

test.each(modes.flatMap((mode) => reads.map((operation) => ({ mode, operation }))))(
    "$mode $operation retries transport and server failures with the same query and a bounded allowance",
    async ({ mode, operation }) => {
        const time = retryTime()
        const calls: string[] = []
        let cancelled = 0
        stubFetchWithHostedDiscovery(async (url: string) => {
            calls.push(url)
            if (calls.length === 1) throw Error("private network detail")
            if (calls.length === 2)
                return new Response(
                    new ReadableStream({
                        cancel: () => {
                            cancelled++
                        },
                    }),
                    { status: 503 },
                )
            expect(cancelled).toBe(1)
            return Response.json(body(operation))
        })
        const api = await setup(mode, time.logging)
        const reading = api.read(operation)
        // With zero jitter the first retry waits its 125 ms minimum and the second its 250 ms minimum
        await time.runRetry(1, 125, () => calls.length)
        await time.runRetry(2, 250, () => calls.length)
        const result = await reading
        expect(Object.isFrozen(result)).toBe(true)
        expect(calls).toHaveLength(3)
        expect(new Set(calls).size).toBe(1)
        expect(time.retries()).toHaveLength(2)
        if (mode === "native") expect(api.random).toHaveBeenCalledTimes(2)
    },
)

test.each(modes)(
    "%s exhausts only eligible failures and never retries rejection or malformed success",
    async (mode) => {
        const time = retryTime()
        const api = await setup(mode)
        for (const status of [500, 502, 503, 504, 400, 401, 403, 404, 501, 505, 200]) {
            let calls = 0
            stubFetchWithHostedDiscovery(async () => {
                calls++
                return new Response("private body", { status })
            })
            const error = await time.drive(api.read().catch((error) => error))
            expect(error).toMatchObject({ _tag: "MessageOperationError", status })
            expect(JSON.stringify(error)).not.toContain("private body")
            expect(calls).toBe([500, 502, 503, 504].includes(status) ? 3 : 1)
        }
        let serviceCalls = 0
        stubFetchWithHostedDiscovery(async () => {
            serviceCalls++
            return Response.json({ code: "SERVICE_UNAVAILABLE", message: "private provider detail" }, { status: 503 })
        })
        const serviceError = await time.drive(api.read().catch((error) => error))
        expect(serviceError).toMatchObject({
            _tag: "MessageOperationError",
            status: 503,
            apiError: { providerCode: "SERVICE_UNAVAILABLE" },
        })
        expect(serviceCalls).toBe(3)
        let rateLimitCalls = 0
        stubFetchWithHostedDiscovery(async () => {
            rateLimitCalls++
            return Response.json(
                { code: "RATE_LIMITED", message: "private provider detail", retry_after: 0 },
                { status: 429 },
            )
        })
        const rateLimitError = await time.drive(api.read("fetch").catch((error) => error))
        expect(rateLimitError).toMatchObject({
            _tag: "MessageOperationError",
            reason: "rateLimit",
            status: 429,
            apiError: { providerCode: "RATE_LIMITED" },
        })
        expect(rateLimitCalls).toBe(1)
    },
)

test.each(modes)("%s rejects non-429 responses once while retaining only usable retry hints", async (mode) => {
    const api = await setup(mode)
    for (const [seconds, expectedMs] of [
        [2, 3_000],
        [4, 4_000],
        [1e308, 3_000],
    ] as const) {
        let calls = 0
        stubFetchWithHostedDiscovery(async () => {
            calls++
            return Response.json(
                { code: "RATE_LIMITED", retry_after: seconds },
                { status: 400, headers: { "retry-after": "3" } },
            )
        })
        await expect(api.read()).rejects.toMatchObject({
            reason: "rejected",
            status: 400,
            retryAfterMs: expectedMs,
            apiError: { providerCode: "RATE_LIMITED" },
        })
        expect(calls).toBe(1)
    }
})

test.each(modes)("%s preserves confirmed 429 handling separately from transient retries", async (mode) => {
    let calls = 0
    stubFetchWithHostedDiscovery(async () => {
        calls++
        if ([1, 3, 5].includes(calls)) return Response.json({ retry_after: 0.005 }, { status: 429 })
        if ([2, 4].includes(calls)) return new Response(null, { status: 502 })
        return Response.json(wire)
    })
    const api = await setup(mode)
    expect(await api.read()).toMatchObject({ id: "10" })
    expect(calls).toBe(6)
})

test.each(modes.flatMap((mode) => ["cancel", "shutdown"].map((reason) => ({ mode, reason }))))(
    "$mode $reason cancels queued Retry-After waits without dispatch or delayed cleanup",
    async ({ mode, reason }) => {
        let calls = 0,
            cancelled = 0
        stubFetchWithHostedDiscovery(async () => {
            calls++
            return new Response(
                new ReadableStream({
                    cancel: () => {
                        cancelled++
                    },
                }),
                { status: 503, headers: { "retry-after": "3" } },
            )
        })
        const api = await setup(mode)
        const controller = new AbortController()
        const result =
            reason === "cancel" && api.native
                ? Effect.runPromiseExit(api.native.messages.fetch(target), { signal: controller.signal })
                : api.read("fetch", { timeoutMs: 5_000, signal: controller.signal }).catch((error) => error)
        await vi.waitFor(() => expect(cancelled).toBe(1))
        if (reason === "cancel") controller.abort()
        if (reason === "shutdown") await api.close()
        const error = await result
        if (reason === "shutdown") expect(error).toMatchObject({ _tag: "ClientClosedError" })
        if (reason === "cancel") {
            if (api.native) expect(Exit.isFailure(error) && Cause.hasInterruptsOnly(error.cause)).toBe(true)
            else expect(error).toMatchObject({ _tag: "CancelledError" })
        }
        expect(calls).toBe(1)
        stubFetchWithHostedDiscovery(async () => Response.json(wire))
        if (reason !== "shutdown") expect(await api.read()).toMatchObject({ id: "10" })
    },
)

test.each(modes)(
    "%s returns the received failure at once when the next retry would pass the deadline",
    async (mode) => {
        let calls = 0
        stubFetchWithHostedDiscovery(async () => {
            calls++
            return new Response(null, { status: 503, headers: { "retry-after": "60" } })
        })
        const api = await setup(mode)
        fakeHostTime()
        let completed = false
        const pending = api
            .read("fetch", { timeoutMs: 5_000 })
            .catch((failure: unknown) => failure)
            .finally(() => {
                completed = true
            })
        await hostTurnsUntil(() => completed)
        const error = await pending
        expect(error).toMatchObject({ reason: "rejected", status: 503, retryAfterMs: 60_000 })
        expect(performance.now()).toBe(0)
        expect(calls).toBe(1)
    },
)

test.each(modes)("%s honors numeric and HTTP-date Retry-After without blocking unrelated requests", async (mode) => {
    const time = retryTime()
    const api = await setup(mode, time.logging)
    for (const [retry, retryAfter, required] of [
        [1, () => "0.3", 300],
        [2, () => new Date(Date.now() + 2_000).toUTCString(), 2_000],
    ] as const) {
        // Start on a whole second, so an HTTP-date names an exact wait
        vi.setSystemTime(Date.UTC(2026, 8, 26, 12, 0, retry * 10))
        const header = retryAfter()
        const calls: string[] = []
        let edited = false
        stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
            if (init.method === "PATCH") {
                edited = true
                return Response.json({ ...wire, content: "edited" })
            }
            calls.push(url)
            return calls.length === 1
                ? new Response(null, { status: 503, headers: { "retry-after": header } })
                : Response.json(wire)
        })
        const pending = api.read()
        await hostTurnsUntil(() => calls.length === 1)
        await api.edit()
        expect(edited).toBe(true)
        expect(calls).toHaveLength(1)
        // The server wait exceeds the 125 ms retry minimum, so the retry waits exactly the header's time
        await time.runRetry(retry, required, () => calls.length)
        expect(await pending).toMatchObject({ id: "10" })
    }
})

test.each(modes)("%s retry backlogs share the existing pending count budget", async (mode) => {
    let calls = 0
    stubFetchWithHostedDiscovery(async () => {
        calls++
        return new Response(null, { status: 503, headers: { "retry-after": "3" } })
    })
    const api = await setup(mode)
    const pending = Array.from({ length: 260 }, () => api.read().catch((error) => error))
    await vi.waitFor(() => expect(calls).toBe(260))
    await expect(api.read()).rejects.toMatchObject({ reason: "busy" })
    expect(calls).toBe(260)
    await api.close()
    const results = await Promise.all(pending)
    expect(results.every((error) => error._tag === "ClientClosedError" || error.reason === "busy")).toBe(true)
})

test.each(modes)("%s POST, PATCH, PUT and DELETE never use transient read retries", async (mode) => {
    const api = await setup(mode)
    let calls = 0
    for (const network of [false, true]) {
        stubFetchWithHostedDiscovery(async () => {
            calls++
            if (network) throw Error("private network failure")
            return new Response(null, { status: 503, headers: { "retry-after": "0.001" } })
        })
        const operations = api.defaultApi
            ? [
                  () => api.defaultApi!.messages.send("20", { content: "fixture" }).then(unwrap),
                  () => api.defaultApi!.messages.edit(target, { content: "fixture" }).then(unwrap),
                  () => api.defaultApi!.messages.pin(target).then(unwrap),
                  () => api.defaultApi!.messages.delete(target).then(unwrap),
              ]
            : [
                  () => Effect.runPromise(api.native!.messages.send("20", { content: "fixture" })),
                  () => Effect.runPromise(api.native!.messages.edit(target, { content: "fixture" })),
                  () => Effect.runPromise(api.native!.messages.pin(target)),
                  () => Effect.runPromise(api.native!.messages.delete(target)),
              ]
        for (const operation of operations) {
            const before = calls
            await expect(operation()).rejects.toBeInstanceOf(Error)
            expect(calls).toBe(before + 1)
        }
    }
})

test.each(modes)("%s a mutation overlapping a successful retry prevents stale cache admission", async (mode) => {
    const api = await setup(mode)
    let calls = 0
    let respond!: (response: Response) => void
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        if (init.method === "PATCH") return Response.json({ ...wire, content: "edited" })
        if (++calls === 1) return new Response(null, { status: 500 })
        return new Promise<Response>((resolve) => {
            respond = resolve
        })
    })
    const pending = api.read()
    await vi.waitFor(() => expect(calls).toBe(2))
    await api.edit()
    respond(Response.json(wire))
    expect(await pending).toMatchObject({ content: "read" })
    expect(await api.get()).toBeUndefined()
})

test.each(modes)(
    "%s a read that failed after dispatch stays retryable, unlike a write with an unknown outcome",
    async (mode) => {
        const api = await setup(mode)
        stubFetchWithHostedDiscovery(async () => {
            throw Error("private network failure")
        })
        const read: unknown = await api.read().catch((error: unknown) => error)
        expect(read).toMatchObject({ reason: "network", outcome: "unknown", details: { read: true } })
        expect(errors.isRetryable(read)).toBe(true)
        const write: unknown = api.defaultApi
            ? await api.defaultApi.messages
                  .edit(target, { content: "fixture" })
                  .then((result) => result.isErr() && result.error)
            : await Effect.runPromise(Effect.flip(api.native!.messages.edit(target, { content: "fixture" })))
        expect(write).toMatchObject({ reason: "network", outcome: "unknown" })
        expect((write as { details: object }).details).not.toHaveProperty("read")
        expect(errors.isRetryable(write)).toBe(false)
    },
)
