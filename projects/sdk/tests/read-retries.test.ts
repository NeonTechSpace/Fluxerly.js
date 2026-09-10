import { Cause, Effect, Exit, Random, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    createClient,
    SdkDefect,
    type DefaultMessageOperationOptions,
    type MessageOperationFailure,
} from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
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
})

async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const defaultApi =
        mode === "default" ? unwrap(createClient({ token: "fixture", cache: { messages: true } })) : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  createNative({ token: "fixture", cache: { messages: true } }).pipe(Scope.provide(scope)),
              )
            : undefined
    const random = vi.fn(() => 0)
    const run = <A>(effect: Effect.Effect<A, MessageOperationFailure>, signal?: AbortSignal) =>
        Effect.runPromise(
            Effect.result(
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
        get: async () => (defaultApi ? unwrap(defaultApi.messages.get(target)) : run(native!.messages.get(target))),
        edit: async () =>
            defaultApi
                ? unwrap(await defaultApi.messages.edit(target, { content: "edited" }))
                : run(native!.messages.edit(target, { content: "edited" })),
    }
}

test.each(modes.flatMap((mode) => reads.map((operation) => ({ mode, operation }))))(
    "$mode $operation retries transport and server failures with the same query and a bounded allowance",
    async ({ mode, operation }) => {
        const calls: { url: string; at: number }[] = []
        let cancelled = 0
        stubFetchWithHostedDiscovery(async (url: string) => {
            calls.push({ url, at: performance.now() })
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
        const api = await setup(mode)
        const result = await api.read(operation)
        expect(Object.isFrozen(result)).toBe(true)
        expect(calls).toHaveLength(3)
        expect(new Set(calls.map((call) => call.url)).size).toBe(1)
        expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(124)
        expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(249)
        if (mode === "native") expect(api.random).toHaveBeenCalledTimes(2)
    },
)

test.each(modes)(
    "%s exhausts only eligible failures and never retries rejection, malformed success or body-cleanup defects",
    async (mode) => {
        const api = await setup(mode)
        for (const status of [500, 502, 503, 504, 400, 401, 403, 404, 501, 505, 200]) {
            let calls = 0
            stubFetchWithHostedDiscovery(async () => {
                calls++
                return new Response("private body", { status })
            })
            const error = await api.read().catch((error) => error)
            expect(error).toMatchObject({ _tag: "MessageOperationError", status })
            expect(JSON.stringify(error)).not.toContain("private body")
            expect(calls).toBe([500, 502, 503, 504].includes(status) ? 3 : 1)
        }
        let calls = 0
        const cleanup = new Error("private cleanup detail")
        stubFetchWithHostedDiscovery(async () => {
            calls++
            return new Response(
                new ReadableStream({
                    cancel: () => {
                        throw cleanup
                    },
                }),
                { status: 503 },
            )
        })
        if (mode === "default") {
            const error = await api.read().catch((error) => error)
            expect(error).toBeInstanceOf(SdkDefect)
            expect(error).toMatchObject({
                reasons: expect.arrayContaining([
                    {
                        kind: "Failure",
                        failure: expect.objectContaining({ _tag: "MessageOperationError", status: 503 }),
                    },
                    { kind: "Defect" },
                ]),
            })
            expect(JSON.stringify(error)).not.toContain("private cleanup detail")
        } else {
            const exit = await Effect.runPromiseExit(api.native!.messages.fetch(target))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                expect(failure).toMatchObject({
                    _tag: "Fail",
                    error: expect.objectContaining({ _tag: "MessageOperationError", status: 503 }),
                })
                const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
                expect(defect).toMatchObject({ _tag: "Die" })
                if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
            }
        }
        expect(calls).toBe(1)
    },
)

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

test.each(modes.flatMap((mode) => ["timeout", "cancel", "shutdown"].map((reason) => ({ mode, reason }))))(
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
                { status: 503, headers: { "retry-after": "60" } },
            )
        })
        const api = await setup(mode)
        const controller = new AbortController()
        const result =
            reason === "cancel" && api.native
                ? Effect.runPromiseExit(api.native.messages.fetch(target), { signal: controller.signal })
                : api
                      .read("fetch", { timeoutMs: reason === "timeout" ? 40 : 5_000, signal: controller.signal })
                      .catch((error) => error)
        await vi.waitFor(() => expect(cancelled).toBe(1))
        if (reason === "cancel") controller.abort()
        if (reason === "shutdown") await api.close()
        const error = await result
        if (reason === "timeout") expect(error).toMatchObject({ reason: "timeout" })
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

test.each(modes)("%s honors numeric and HTTP-date Retry-After without blocking unrelated requests", async (mode) => {
    const api = await setup(mode)
    for (const header of ["0.3", new Date(Date.now() + 1_500).toUTCString()]) {
        const calls: number[] = []
        let edited = false
        const required = /^\d/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            if (init.method === "PATCH") {
                edited = true
                return Response.json({ ...wire, content: "edited" })
            }
            calls.push(performance.now())
            return calls.length === 1
                ? new Response(null, { status: 503, headers: { "retry-after": header } })
                : Response.json(wire)
        })
        const pending = api.read()
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        await api.edit()
        expect(edited).toBe(true)
        expect(calls).toHaveLength(1)
        await pending
        expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(Math.max(125, required) - 20)
    }
})

test.each(modes)("%s retry backlogs share the existing pending count budget", async (mode) => {
    let calls = 0
    stubFetchWithHostedDiscovery(async () => {
        calls++
        return new Response(null, { status: 503, headers: { "retry-after": "60" } })
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
