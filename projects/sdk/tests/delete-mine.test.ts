import { Effect, Fiber } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const configuration = { token: "fixture-only-not-a-credential", cache: { messages: {} } }
const message = (id: string) => ({
    id,
    channel_id: "20",
    content: "fixture",
    author: { id: "30", username: "fixture" },
})

afterEach(() => vi.unstubAllGlobals())

function defaultApi() {
    const result = createClient(configuration)
    if (result.isErr()) throw result.error
    onTestFinished(async () => {
        await result.value.shutdown()
    })
    return result.value
}

test("default deleteMine operations use exact bodyless 202 routes and reject invalid IDs before dispatch", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        requests.push({ url, init })
        return new Response(null, { status: 202 })
    })
    const client = defaultApi()
    expect((await client.messages.deleteMine("20")).isOk()).toBe(true)
    expect((await client.guilds.deleteMine("30")).isOk()).toBe(true)
    expect(requests.map(({ url }) => url)).toEqual([
        "https://api.fluxer.app/v1/channels/20/messages/bulk-delete-mine",
        "https://api.fluxer.app/v1/users/@me/guilds/30/messages/bulk-delete-mine",
    ])
    for (const request of requests) {
        expect(request.init.method).toBe("POST")
        expect(request.init.body).toBeUndefined()
    }
    expect(await client.messages.deleteMine("bad/id")).toMatchObject({
        error: { operation: "deleteMine", outcome: "notDispatched" },
    })
    expect(await client.guilds.deleteMine("bad/id")).toMatchObject({
        error: { operation: "guilds.deleteMine", outcome: "notDispatched" },
    })
    expect(requests).toHaveLength(2)
})

test("default deleteMine is eager, clears the whole message cache after dispatch, and blocks older reads", async () => {
    let release!: () => void
    let delayed = false
    const requests: RequestInit[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        if (init.method === "POST") {
            requests.push(init)
            return new Response(null, { status: 202 })
        }
        if (delayed)
            await new Promise<void>((resolve, reject) => {
                release = resolve
                init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
            })
        return Response.json(message(url.split("/").at(-1)!))
    })
    const client = defaultApi()
    await client.messages.fetch({ channelId: "20", id: "10" })
    await client.messages.fetch({ channelId: "20", id: "11" })
    delayed = true
    const oldRead = client.messages.fetch({ channelId: "20", id: "10" })
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    const deletion = client.messages.deleteMine("20")
    expect(requests).toHaveLength(1)
    expect(await client.messages.get({ channelId: "20", id: "10" })).toMatchObject({ value: undefined })
    expect(await client.messages.get({ channelId: "20", id: "11" })).toMatchObject({ value: undefined })
    release()
    expect((await deletion).isOk()).toBe(true)
    await oldRead
    expect(await client.messages.get({ channelId: "20", id: "10" })).toMatchObject({ value: undefined })
})

test("a read begun after deleteMine dispatch cannot admit its pre-deletion snapshot after completion", async () => {
    let releaseDeletion!: () => void
    let releaseRead!: () => void
    let deletionStarted!: () => void
    let readStarted!: () => void
    const deletionDispatched = new Promise<void>((resolve) => {
        deletionStarted = resolve
    })
    const readDispatched = new Promise<void>((resolve) => {
        readStarted = resolve
    })
    let holdRead = false
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => {
        if (init.method === "POST") {
            deletionStarted()
            return new Promise<Response>((resolve, reject) => {
                releaseDeletion = () => resolve(new Response(null, { status: 202 }))
                init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
            })
        }
        if (holdRead) {
            readStarted()
            return new Promise<Response>((resolve, reject) => {
                releaseRead = () => resolve(Response.json(message(url.split("/").at(-1)!)))
                init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
            })
        }
        return Promise.resolve(Response.json(message(url.split("/").at(-1)!)))
    })
    const client = defaultApi()
    await client.messages.fetch({ channelId: "20", id: "10" })
    const deletion = client.messages.deleteMine("20")
    await deletionDispatched
    holdRead = true
    const read = client.messages.fetch({ channelId: "20", id: "10" })
    await readDispatched
    releaseDeletion()
    expect((await deletion).isOk()).toBe(true)
    releaseRead()
    await read
    expect(await client.messages.get({ channelId: "20", id: "10" })).toMatchObject({ value: undefined })
})

test.each([403, 500, "network"] as const)(
    "default message deletion has a single %s uncertain or rejected attempt",
    async (status) => {
        let attempts = 0
        stubFetchWithHostedDiscovery(async () => {
            attempts++
            if (status === "network") throw new TypeError("test-owned transport failure")
            return new Response(null, { status })
        })
        const result = await defaultApi().messages.deleteMine("20")
        expect(result).toMatchObject({
            error: {
                operation: "deleteMine",
                reason: status === "network" ? "network" : "rejected",
                outcome: status === 403 ? "rejected" : "unknown",
            },
        })
        if (status === 500) expect(result).toMatchObject({ error: { reason: "rejected", outcome: "unknown" } })
        expect(attempts).toBe(1)
    },
)

test("default cancellation before and after guild deletion dispatch does not replay", async () => {
    let attempts = 0
    let started!: () => void
    const dispatched = new Promise<void>((resolve) => {
        started = resolve
    })
    stubFetchWithHostedDiscovery((_url: string, init: RequestInit) => {
        attempts++
        started()
        return new Promise((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
        )
    })
    const client = defaultApi()
    const before = new AbortController()
    before.abort()
    expect(await client.guilds.deleteMine("30", { signal: before.signal })).toMatchObject({
        error: { _tag: "CancelledError" },
    })
    expect(attempts).toBe(0)
    const after = new AbortController()
    const pending = client.guilds.deleteMine("30", { signal: after.signal })
    await dispatched
    after.abort()
    expect(await pending).toMatchObject({ error: { _tag: "CancelledError" } })
    expect(attempts).toBe(1)
})

test("native deleteMine operations are lazy, retry only confirmed 429, and retain cancellation cleanup", async () => {
    let attempts = 0
    let started!: () => void
    const dispatched = new Promise<void>((resolve) => {
        started = resolve
    })
    stubFetchWithHostedDiscovery((_url: string, init: RequestInit) => {
        attempts++
        if (attempts === 1) return Promise.resolve(Response.json({ retry_after: 0.001 }, { status: 429 }))
        if (attempts === 2) return Promise.resolve(new Response(null, { status: 202 }))
        started()
        return new Promise((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
        )
    })
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative(configuration)
                const lazy = client.messages.deleteMine("20")
                expect(attempts).toBe(0)
                yield* lazy
                expect(attempts).toBe(2)
                const fiber = yield* client.guilds.deleteMine("30").pipe(Effect.forkChild)
                yield* Effect.promise(() => dispatched)
                yield* Fiber.interrupt(fiber)
                expect(attempts).toBe(3)
            }),
        ),
    )
})

test("native deleteMine operations use exact bodyless routes and preserve provider failures", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        requests.push({ url, init })
        return requests.length === 3
            ? Response.json({ code: "MISSING_PERMISSIONS", message: "Synthetic private text" }, { status: 403 })
            : new Response(null, { status: 202 })
    })
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative(configuration)
                yield* client.messages.deleteMine("20")
                yield* client.guilds.deleteMine("30")
                const rejected = yield* Effect.result(client.guilds.deleteMine("30"))
                expect(rejected).toMatchObject({
                    _tag: "Failure",
                    failure: {
                        operation: "guilds.deleteMine",
                        reason: "rejected",
                        outcome: "rejected",
                        status: 403,
                        apiError: { providerCode: "MISSING_PERMISSIONS" },
                        message: expect.stringContaining(
                            "The provider reports that the bot lacks a required permission",
                        ),
                    },
                })
                expect(JSON.stringify(rejected)).not.toContain("Synthetic private text")
            }),
        ),
    )
    expect(requests.map(({ url }) => url)).toEqual([
        "https://api.fluxer.app/v1/channels/20/messages/bulk-delete-mine",
        "https://api.fluxer.app/v1/users/@me/guilds/30/messages/bulk-delete-mine",
        "https://api.fluxer.app/v1/users/@me/guilds/30/messages/bulk-delete-mine",
    ])
    for (const request of requests) {
        expect(request.init.method).toBe("POST")
        expect(request.init.body).toBeUndefined()
    }
})

test("closed clients reject deleteMine without dispatch in both entry points", async () => {
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    const client = defaultApi()
    await client.shutdown()
    expect(await client.messages.deleteMine("20")).toMatchObject({ error: { _tag: "ClientClosedError" } })
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const native = yield* createNative(configuration)
                yield* native.shutdown()
                const result = yield* Effect.result(native.guilds.deleteMine("30"))
                expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ClientClosedError" } })
            }),
        ),
    )
    expect(fetch).not.toHaveBeenCalled()
})
