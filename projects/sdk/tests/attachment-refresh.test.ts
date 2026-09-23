import { Cause, Effect, Exit, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, type Client as DefaultClient } from "../src/index.js"
import { createClient as createNative, type Client as NativeClient } from "../src/effect.js"
import type { RefreshedAttachmentUrl } from "../src/attachments.js"
import { hostedOperationCalls, stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
const operationUrl = "https://api.fluxer.app/v1/attachments/refresh-urls"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

async function settle<A>(value: ResultAsync<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) {
        const result = await Effect.runPromise(Effect.result(value))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = await value
    if (result.isErr()) throw result.error
    return result.value
}

async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const client =
        mode === "default"
            ? createClient({ token: "fixture-only-not-a-credential" })._unsafeUnwrap()
            : await Effect.runPromise(
                  createNative({ token: "fixture-only-not-a-credential" }).pipe(Scope.provide(scope)),
              )
    onTestFinished(async () => {
        const closed = client.shutdown()
        if (Effect.isEffect(closed)) await Effect.runPromise(closed)
        else await closed
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        client,
        refresh: async (
            urls: readonly string[],
            options?: { timeoutMs?: number; signal?: AbortSignal; [key: string]: unknown },
        ): Promise<readonly RefreshedAttachmentUrl[]> => {
            if (mode === "default") return settle(client.attachments.refreshUrls(urls, options))
            const { signal, ...request } = options ?? {}
            const result = await Effect.runPromise(
                Effect.result(
                    client.attachments.refreshUrls(urls, request as never) as Effect.Effect<unknown, unknown>,
                ),
                signal ? { signal } : undefined,
            )
            if (result._tag === "Failure") throw result.failure
            return result.success as readonly RefreshedAttachmentUrl[]
        },
    }
}

test.each(modes)("%s refreshes one URL without changing its original string or query", async (mode) => {
    const requested = "https://fluxerusercontent.com/attachments/10/20/a%2Fb.png?ex=1&is=2&hm=a%2Bb%3D%3D"
    const refreshed = "https://fluxerusercontent.com/attachments/10/20/a%2Fb.png?ex=9&is=8&hm=z%2Fy%3D"
    const calls: Array<{ url: string; init: RequestInit; body: unknown }> = []
    stubFetchWithHostedDiscovery(async (url, init) => {
        calls.push({ url, init, body: JSON.parse(String(init.body)) })
        return Response.json({ refreshed_urls: [{ original: requested, refreshed }] })
    })
    const api = await setup(mode)

    const result = await api.refresh([requested])
    expect(result).toEqual([{ original: requested, refreshed }])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result[0])).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: operationUrl, body: { attachment_urls: [requested] } })
    expect(calls[0]!.init.method).toBe("POST")
    expect(calls[0]!.init.redirect).toBe("error")
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bot fixture-only-not-a-credential")
})

test.each(modes)(
    "%s preserves an ordered batch of 50 results including unchanged non-instance strings",
    async (mode) => {
        const urls = Array.from({ length: 50 }, (_, index) =>
            index === 17
                ? "https://external.example.test/not-an-instance-attachment?keep=%2F%3F%26"
                : index === 18
                  ? "x".repeat(2_048)
                  : `https://fluxerusercontent.com/attachments/10/${index}/file?old=${index}&sig=%2B${index}`,
        )
        const expected = urls.map((original, index) => ({
            original,
            refreshed: index === 17 || index === 18 ? original : `${original}&fresh=${index}`,
        }))
        const fetch = stubFetchWithHostedDiscovery(async (_url, init) => {
            expect(JSON.parse(String(init.body))).toEqual({ attachment_urls: urls })
            return Response.json({ refreshed_urls: expected })
        })
        const api = await setup(mode)

        await expect(api.refresh(urls)).resolves.toEqual(expected)
        expect(hostedOperationCalls(fetch)).toHaveLength(1)
    },
)

test.each(modes)("%s snapshots bounded indexed entries without trusting a custom array iterator", async (mode) => {
    const urls = ["indexed-one?keep=%2F", "indexed-two?keep=%26"]
    urls[Symbol.iterator] = function* () {
        yield "iterator-value-that-must-not-be-sent"
        return undefined
    }
    const expected = [
        { original: urls[0], refreshed: `${urls[0]}&fresh=1` },
        { original: urls[1], refreshed: `${urls[1]}&fresh=2` },
    ]
    const fetch = stubFetchWithHostedDiscovery(async (_url, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ attachment_urls: [urls[0], urls[1]] })
        return Response.json({ refreshed_urls: expected })
    })
    const api = await setup(mode)

    await expect(api.refresh(urls)).resolves.toEqual(expected)
    expect(hostedOperationCalls(fetch)).toHaveLength(1)

    const sparse = Array.from({ length: 2 }) as unknown as string[]
    sparse[0] = "present"
    sparse[Symbol.iterator] = function* () {
        yield "present"
        yield "iterator-filled-hole"
        return undefined
    }
    await expect(api.refresh(sparse)).rejects.toMatchObject({
        _tag: "AttachmentRefreshError",
        reason: "input",
        outcome: "notDispatched",
    })
    expect(hostedOperationCalls(fetch)).toHaveLength(1)
})

test.each(modes)("%s validates 0, 51 and overlong URL batches before discovery or dispatch", async (mode) => {
    const fetch = stubFetchWithHostedDiscovery(async () => Response.json({ refreshed_urls: [] }))
    const api = await setup(mode)
    for (const urls of [[], Array.from({ length: 51 }, () => "x"), ["x".repeat(2_049)]]) {
        await expect(api.refresh(urls)).rejects.toMatchObject({
            _tag: "AttachmentRefreshError",
            operation: "attachments.refreshUrls",
            reason: "input",
            outcome: "notDispatched",
        })
    }
    await expect(api.refresh(["x"], { timeoutMs: 0 })).rejects.toMatchObject({
        _tag: "AttachmentRefreshError",
        reason: "input",
        outcome: "notDispatched",
    })
    await expect(api.refresh(["x"], { unknown: true })).rejects.toMatchObject({
        _tag: "AttachmentRefreshError",
        reason: "input",
        outcome: "notDispatched",
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s rejects malformed, missing and out-of-order refresh responses", async (mode) => {
    const originals = ["first?keep=%2F", "second?keep=%26"]
    const malformed: unknown[] = [
        {},
        { refreshed_urls: "not-an-array" },
        { refreshed_urls: [{ original: originals[0], refreshed: "one" }] },
        {
            refreshed_urls: [
                { original: originals[1], refreshed: "two" },
                { original: originals[0], refreshed: "one" },
            ],
        },
        {
            refreshed_urls: [
                { original: originals[0], refreshed: 1 },
                { original: originals[1], refreshed: "two" },
            ],
        },
    ]
    let index = 0
    stubFetchWithHostedDiscovery(async () => Response.json(malformed[index++]))
    const api = await setup(mode)

    for (const _value of malformed)
        await expect(api.refresh(originals)).rejects.toMatchObject({
            _tag: "AttachmentRefreshError",
            reason: "response",
            outcome: "unknown",
            status: 200,
        })
})

test.each(modes)("%s bounds the refresh response body and cancels its reader", async (mode) => {
    let cancelled = false
    let supplied = false
    stubFetchWithHostedDiscovery(
        async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    pull(controller) {
                        if (supplied) return
                        supplied = true
                        controller.enqueue(new Uint8Array(16_777_217))
                    },
                    cancel() {
                        cancelled = true
                    },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
            ),
    )
    const api = await setup(mode)

    await expect(api.refresh(["x"])).rejects.toMatchObject({
        _tag: "AttachmentRefreshError",
        reason: "response",
        outcome: "unknown",
    })
    expect(cancelled).toBe(true)
})

test.each(modes)("%s applies the shared request deadline and awaits abort cleanup", async (mode) => {
    vi.useFakeTimers({ now: 0, toFake: ["Date", "performance", "setTimeout", "clearTimeout"] })
    let cleaned = false
    let markRequestStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve
    })
    stubFetchWithHostedDiscovery(
        (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
                markRequestStarted()
                init.signal?.addEventListener(
                    "abort",
                    () => {
                        cleaned = true
                        reject(new Error("aborted"))
                    },
                    { once: true },
                )
            }),
    )
    const api = await setup(mode)

    const pending = api.refresh(["x"], { timeoutMs: 10 })
    const failure = expect(pending).rejects.toMatchObject({
        _tag: "AttachmentRefreshError",
        reason: "timeout",
        outcome: "unknown",
    })
    await requestStarted
    expect(cleaned).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    await failure
    expect(cleaned).toBe(true)
})

test.each(modes)("%s exposes cancellation only after the credentialed request is aborted", async (mode) => {
    let started = false
    let cleaned = false
    stubFetchWithHostedDiscovery(
        (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
                started = true
                init.signal?.addEventListener(
                    "abort",
                    () => {
                        cleaned = true
                        reject(new Error("aborted"))
                    },
                    { once: true },
                )
            }),
    )
    const api = await setup(mode)
    const controller = new AbortController()

    if (mode === "default") {
        const client = api.client as DefaultClient
        const pending = client.attachments.refreshUrls(["x"], { signal: controller.signal })
        while (!started) await new Promise((resolve) => setTimeout(resolve, 0))
        controller.abort()
        const result = await pending
        expect(result.isErr() && result.error._tag).toBe("CancelledError")
    } else {
        const client = api.client as NativeClient
        const pending = Effect.runPromiseExit(client.attachments.refreshUrls(["x"]), {
            signal: controller.signal,
        })
        while (!started) await new Promise((resolve) => setTimeout(resolve, 0))
        controller.abort()
        const exit = await pending
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }
    expect(cleaned).toBe(true)
})

test.each(modes)("%s reports an unsupported 404 without exposing the response body", async (mode) => {
    stubFetchWithHostedDiscovery(async () =>
        Response.json({ message: "fixture-private-provider-body" }, { status: 404 }),
    )
    const api = await setup(mode)

    let failure: unknown
    try {
        await api.refresh(["x"])
    } catch (error) {
        failure = error
    }
    expect(failure).toMatchObject({
        _tag: "AttachmentRefreshError",
        reason: "notFound",
        outcome: "rejected",
        status: 404,
    })
    expect(JSON.stringify(failure)).not.toContain("fixture-private-provider-body")
})

test.each(modes)("%s never follows a credentialed refresh redirect to a media or external origin", async (mode) => {
    const calls: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = []
    const fetch = stubFetchWithHostedDiscovery(async (url, init) => {
        calls.push({
            url,
            authorization: new Headers(init.headers).get("authorization"),
            redirect: init.redirect,
        })
        return new Response(null, {
            status: 307,
            headers: { location: "https://external.example.test/attachments/credential-target" },
        })
    })
    const api = await setup(mode)

    await expect(api.refresh(["https://external.example.test/untrusted?exact=%2F"])).rejects.toMatchObject({
        _tag: "AttachmentRefreshError",
        reason: "rejected",
        status: 307,
    })
    expect(hostedOperationCalls(fetch)).toHaveLength(1)
    expect(calls).toEqual([
        {
            url: operationUrl,
            authorization: "Bot fixture-only-not-a-credential",
            redirect: "error",
        },
    ])
})
