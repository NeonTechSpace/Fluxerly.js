import { Effect, Exit, Fiber, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
const target = { id: "10", channelId: "20" }
const other = { id: "11", channelId: "20" }

const wire = (message = target) => ({
    id: message.id,
    channel_id: message.channelId,
    content: "fixture",
    author: { id: "30", username: "fixture" },
})

afterEach(() => vi.unstubAllGlobals())

function mockRest(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
    stubFetchWithHostedDiscovery(async (url, init) => handler(url, init))
}

function unwrap<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const run = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) => {
        const result = await Effect.runPromise(Effect.result(effect), signal ? { signal } : undefined)
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const options = { token: "fixture-only-not-a-credential", cache: { messages: true } }
    const defaultApi = mode === "default" ? unwrap(createClient(options)) : undefined
    const native = mode === "native" ? await run(createNative(options).pipe(Scope.provide(scope))) : undefined
    const close = async () => {
        if (defaultApi) unwrap(await defaultApi.shutdown())
        else await run(native!.shutdown())
    }
    onTestFinished(async () => {
        await close()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        defaultApi,
        native,
        remove: async (
            message: unknown = target,
            attachmentId: unknown = "40",
            options?: { timeoutMs?: number; signal?: AbortSignal },
        ) =>
            defaultApi
                ? unwrap(await defaultApi.messages.deleteAttachment(message as never, attachmentId as never, options))
                : run(
                      native!.messages.deleteAttachment(message as never, attachmentId as never, options),
                      options?.signal,
                  ),
        fetch: async (message = target) =>
            defaultApi ? unwrap(await defaultApi.messages.fetch(message)) : run(native!.messages.fetch(message)),
        get: async (message = target) =>
            defaultApi ? unwrap(defaultApi.messages.get(message)) : run(native!.messages.get(message)),
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
    "%s evicts only the target cache entry after success or an unknown attachment deletion",
    async (mode) => {
        let unknown = false
        const calls: string[] = []
        mockRest((url, init) => {
            calls.push(`${init.method} ${url}`)
            if (init.method === "GET") return Response.json(wire(url.endsWith("/11") ? other : target))
            if (unknown) return Promise.reject(new Error("private fixture transport failure"))
            return new Response(null, { status: 204 })
        })
        const api = await setup(mode)
        await api.fetch()
        const retained = await api.fetch(other)

        await api.remove()
        expect(await api.get()).toBeUndefined()
        expect(await api.get(other)).toBe(retained)

        await api.fetch()
        unknown = true
        await expect(api.remove()).rejects.toMatchObject({
            operation: "deleteAttachment",
            reason: "network",
            outcome: "unknown",
        })
        expect(await api.get()).toBeUndefined()
        expect(await api.get(other)).toBe(retained)
        expect(calls).toEqual([
            "GET https://api.fluxer.app/v1/channels/20/messages/10",
            "GET https://api.fluxer.app/v1/channels/20/messages/11",
            "DELETE https://api.fluxer.app/v1/channels/20/messages/10/attachments/40",
            "GET https://api.fluxer.app/v1/channels/20/messages/10",
            "DELETE https://api.fluxer.app/v1/channels/20/messages/10/attachments/40",
        ])
    },
)

test.each(modes)("%s retries only a confirmed attachment-delete rate limit", async (mode) => {
    let calls = 0
    mockRest(() =>
        ++calls === 1 ? Response.json({ retry_after: 0.001 }, { status: 429 }) : new Response(null, { status: 204 }),
    )
    const api = await setup(mode)

    await api.remove()
    expect(calls).toBe(2)
})

test.each(modes)("%s never replays unknown attachment deletes or timeouts", async (mode) => {
    let calls = 0
    let timeout = false
    mockRest((_url, init) => {
        calls++
        if (!timeout) return Promise.reject(new Error("private fixture transport failure"))
        return new Promise((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
        )
    })
    const api = await setup(mode)

    await expect(api.remove()).rejects.toMatchObject({ reason: "network", outcome: "unknown" })
    expect(calls).toBe(1)
    timeout = true
    await expect(api.remove(target, "40", { timeoutMs: 10 })).rejects.toMatchObject({
        reason: "timeout",
        outcome: "unknown",
    })
    expect(calls).toBe(2)
})

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
