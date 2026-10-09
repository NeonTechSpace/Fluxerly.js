import { Effect, Fiber } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { defaultApi as createDefault, modes, nativeApi, type Mode } from "../../support/both-apis.js"
import { fakeHostTime, hostTurnsUntil } from "../../support/client-clock.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { settle, typedResult } from "../../support/settle.js"

const target = { id: "10", channelId: "20" }
const other = { id: "11", channelId: "20" }

const wire = (message = target) => ({
    id: message.id,
    channel_id: message.channelId,
    content: "fixture",
    author: { id: "30", username: "fixture" },
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

function mockRest(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
    stubFetchWithHostedDiscovery(async (url, init) => handler(url, init))
}

async function setup(mode: Mode) {
    // Unlike settle(), this forwards a caller signal so Effect.runPromise interrupts the native operation on abort
    const run = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) => {
        const result = await Effect.runPromise(typedResult(effect), signal ? { signal } : undefined)
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const options = { cache: { messages: true } }
    const defaultApi = mode === "default" ? createDefault(options) : undefined
    const native = mode === "native" ? await nativeApi(options) : undefined
    return {
        defaultApi,
        native,
        remove: async (
            message: unknown = target,
            attachmentId: unknown = "40",
            options?: { timeoutMs?: number; signal?: AbortSignal },
        ) =>
            defaultApi
                ? settle(defaultApi.messages.deleteAttachment(message as never, attachmentId as never, options))
                : run(
                      native!.messages.deleteAttachment(message as never, attachmentId as never, options),
                      options?.signal,
                  ),
        fetch: async (message = target) =>
            settle(defaultApi ? defaultApi.messages.fetch(message) : native!.messages.fetch(message)),
        get: async (message = target) =>
            settle(defaultApi ? defaultApi.messages.get(message) : native!.messages.get(message)),
    }
}

test.each(modes)("%s deletes one exact attachment with one 204 request and no hidden fetch", async (mode) => {
    const calls: { url: string; init: RequestInit }[] = []
    mockRest((url, init) => {
        calls.push({ url, init })
        return new Response(null, { status: 204 })
    })
    const api = await setup(mode)

    expect(await api.remove()).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
        url: "https://api.fluxer.app/v1/channels/20/messages/10/attachments/40",
        init: { method: "DELETE", redirect: "error" },
    })
    expect(calls[0]!.init.body).toBeUndefined()
})

test.each(modes)("%s rejects invalid message and attachment IDs before dispatch", async (mode) => {
    const calls: unknown[] = []
    mockRest((url) => {
        calls.push(url)
        return new Response(null, { status: 204 })
    })
    const api = await setup(mode)

    for (const [message, attachmentId] of [
        [null, "40"],
        [{ id: "10/11", channelId: "20" }, "40"],
        [{ id: "10", channelId: "020" }, "40"],
        [target, ""],
        [target, "04"],
        [target, "4/0"],
        [target, null],
    ])
        await expect(api.remove(message, attachmentId)).rejects.toMatchObject({
            _tag: "MessageOperationError",
            operation: "deleteAttachment",
            reason: "input",
            outcome: "notDispatched",
        })
    expect(calls).toEqual([])
})

test.each(modes)("%s classifies rejected attachment deletion without treating 404 as message absence", async (mode) => {
    let status = 200
    mockRest((url) => {
        if (url.endsWith("/messages/10")) return Response.json(wire())
        return new Response(null, { status })
    })
    const api = await setup(mode)
    const cached = await api.fetch()

    for (const [code, reason, outcome] of [
        [404, "notFound", "rejected"],
        [403, "rejected", "rejected"],
        [500, "rejected", "unknown"],
        [200, "response", "unknown"],
    ] as const) {
        status = code
        await expect(api.remove()).rejects.toMatchObject({
            _tag: "MessageOperationError",
            operation: "deleteAttachment",
            reason,
            outcome,
            status: code,
        })
        expect(await api.get()).toBe(outcome === "unknown" ? undefined : cached)
        if (outcome === "unknown") {
            status = 200
            await api.fetch()
        }
    }
})

test.each(modes)(
    "%s evicts only the target cache entry after success or an unknown network or timeout deletion without replay",
    async (mode) => {
        // The deadline reads the Effect Clock, which follows the faked host time, so a slow machine cannot pass it
        // before the delete is dispatched
        fakeHostTime()
        let failure: "network" | "timeout" | undefined
        let dispatched = false
        let aborted = false
        const calls: string[] = []
        mockRest((url, init) => {
            calls.push(`${init.method} ${url}`)
            if (init.method === "GET") return Response.json(wire(url.endsWith("/11") ? other : target))
            if (failure === "network") return Promise.reject(new Error("private fixture transport failure"))
            // A dispatched delete that never answers, so only its deadline ends it
            if (failure === "timeout") {
                dispatched = true
                return new Promise((_resolve, reject) =>
                    init.signal!.addEventListener(
                        "abort",
                        () => {
                            aborted = true
                            reject(init.signal!.reason)
                        },
                        { once: true },
                    ),
                )
            }
            return new Response(null, { status: 204 })
        })
        const api = await setup(mode)
        await api.fetch()
        const retained = await api.fetch(other)

        await api.remove()
        expect(await api.get()).toBeUndefined()
        expect(await api.get(other)).toBe(retained)

        for (const reason of ["network", "timeout"] as const) {
            await api.fetch()
            failure = reason
            const options = reason === "timeout" ? { timeoutMs: 100 } : undefined
            const removal = expect(api.remove(target, "40", options)).rejects.toMatchObject({
                _tag: "MessageOperationError",
                operation: "deleteAttachment",
                reason,
                outcome: "unknown",
            })
            if (reason === "timeout") {
                // The deadline ends the dispatched delete at exactly its limit, not before
                await hostTurnsUntil(() => dispatched)
                await vi.advanceTimersByTimeAsync(99)
                expect(aborted).toBe(false)
                await vi.advanceTimersByTimeAsync(1)
                expect(aborted).toBe(true)
            }
            await removal
            failure = undefined
            expect(await api.get()).toBeUndefined()
            expect(await api.get(other)).toBe(retained)
        }
        const fetchTarget = "GET https://api.fluxer.app/v1/channels/20/messages/10"
        const removeTarget = "DELETE https://api.fluxer.app/v1/channels/20/messages/10/attachments/40"
        // Each unknown delete was sent once and never replayed
        expect(calls).toEqual([
            fetchTarget,
            "GET https://api.fluxer.app/v1/channels/20/messages/11",
            removeTarget,
            fetchTarget,
            removeTarget,
            fetchTarget,
            removeTarget,
        ])
    },
)

test.each(modes)("%s cancellation releases an attachment-delete request without replay", async (mode) => {
    let active = 0
    let calls = 0
    let hold = true
    mockRest((_url, init) => {
        calls++
        if (!hold) return new Response(null, { status: 204 })
        active++
        return new Promise((_resolve, reject) =>
            init.signal!.addEventListener(
                "abort",
                () => {
                    active--
                    reject(init.signal!.reason)
                },
                { once: true },
            ),
        )
    })
    const api = await setup(mode)

    if (mode === "default") {
        const controller = new AbortController()
        const pending = api.defaultApi!.messages.deleteAttachment(target, "40", { signal: controller.signal })
        await vi.waitFor(() => expect(active).toBe(1))
        controller.abort()
        const result = await pending
        expect(result.isErr() && result.error).toMatchObject({ _tag: "CancelledError" })
    } else {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const fiber = yield* Effect.forkScoped(api.native!.messages.deleteAttachment(target, "40"))
                    yield* Effect.promise(() => vi.waitFor(() => expect(active).toBe(1)))
                    yield* Fiber.interrupt(fiber)
                }),
            ),
        )
    }
    await vi.waitFor(() => expect(active).toBe(0))
    expect(calls).toBe(1)
    hold = false
    await api.remove()
    expect(calls).toBe(2)
})
