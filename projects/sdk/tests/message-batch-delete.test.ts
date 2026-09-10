import { Effect, Fiber } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

afterEach(() => vi.unstubAllGlobals())
const configuration = { token: "fixture-only-not-a-credential", cache: { messages: {} } }
const wire = (id: string) => ({ id, channel_id: "20", content: "fixture", author: { id: "30", username: "fixture" } })
function defaultApi() {
    const result = createClient(configuration)
    if (result.isErr()) throw result.error
    onTestFinished(async () => {
        await result.value.shutdown()
    })
    return result.value
}

test("default batches copy IDs, use canonical JSON and preserve unselected cached messages", async () => {
    const calls: RequestInit[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        if (init.method === "GET") return Response.json(wire(url.split("/").at(-1)!))
        expect(url).toBe("https://api.fluxer.app/v1/channels/20/messages/bulk-delete")
        calls.push(init)
        return new Response(null, { status: 204 })
    })
    const client = defaultApi()
    for (const id of ["10", "11", "12"])
        expect((await client.messages.fetch({ channelId: "20", id })).isOk()).toBe(true)
    const ids = ["10", "11"]
    const pending = client.messages.deleteMany("20", ids)
    ids.push("12")
    expect((await pending).isOk()).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: "POST", body: '{"message_ids":["10","11"]}' })
    for (const id of ["10", "11"])
        expect(await client.messages.get({ channelId: "20", id })).toMatchObject({ value: undefined })
    expect(await client.messages.get({ channelId: "20", id: "12" })).toMatchObject({ value: { id: "12" } })
})

test("invalid, duplicate, sparse or oversized selections do not dispatch", async () => {
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    const client = defaultApi()
    for (const ids of [
        [],
        ["-1"],
        ["10", "10"],
        ["bad"],
        new Array(2),
        Array.from({ length: 101 }, (_, i) => String(i + 1)),
    ]) {
        expect(await client.messages.deleteMany("20", ids)).toMatchObject({
            error: {
                _tag: "MessageOperationError",
                operation: "deleteMany",
                reason: "input",
                outcome: "notDispatched",
            },
        })
    }
    expect(await client.messages.deleteMany("bad", ["10"])).toMatchObject({ error: { reason: "input" } })
    expect(fetch).not.toHaveBeenCalled()
})

test.each([400, 500, 200, "network"])("dispatched failure %s evicts selected data without replay", async (status) => {
    let writes = 0
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        if (init.method === "GET") return Response.json(wire("10"))
        writes++
        if (status === "network") throw new Error("private upstream body")
        return new Response("private upstream body", { status: status as number })
    })
    const client = defaultApi()
    await client.messages.fetch({ channelId: "20", id: "10" })
    const result = await client.messages.deleteMany("20", ["10"])
    expect(result.isErr()).toBe(true)
    expect(JSON.stringify(result)).not.toContain("private upstream body")
    expect(writes).toBe(1)
    expect(await client.messages.get({ channelId: "20", id: "10" })).toMatchObject({ value: undefined })
})

test("native batches are lazy, repeatable and honor confirmed rate rejection", async () => {
    let writes = 0
    stubFetchWithHostedDiscovery(async () =>
        ++writes === 1 ? Response.json({ retry_after: 0.001 }, { status: 429 }) : new Response(null, { status: 204 }),
    )
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative(configuration)
                const remove = client.messages.deleteMany(
                    "20",
                    Array.from({ length: 100 }, (_, i) => String(i + 1)),
                )
                expect(writes).toBe(0)
                yield* remove
                yield* remove
                expect(writes).toBe(3)
            }),
        ),
    )
})

test("interrupted native deletion waits for fetch cleanup and evicts selected snapshots", async () => {
    let dispatched!: () => void
    const started = new Promise<void>((resolve) => {
        dispatched = resolve
    })
    let cleaned = false
    stubFetchWithHostedDiscovery((_url: string, init: RequestInit) => {
        if (init.method === "GET") return Promise.resolve(Response.json(wire("10")))
        return new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () =>
                setTimeout(() => {
                    cleaned = true
                    reject(new Error("aborted"))
                }, 10),
            )
            dispatched()
        })
    })
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative(configuration)
                yield* client.messages.fetch({ channelId: "20", id: "10" })
                const fiber = yield* client.messages.deleteMany("20", ["10"]).pipe(Effect.forkChild)
                yield* Effect.promise(() => started)
                yield* Fiber.interrupt(fiber)
                expect(cleaned).toBe(true)
                expect(yield* client.messages.get({ channelId: "20", id: "10" })).toBeUndefined()
            }),
        ),
    )
})

test("a batch deletion prevents an older queued read from restoring deleted messages", async () => {
    const releases: (() => void)[] = []
    let started = 0
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        if (init.method === "POST") return new Response(null, { status: 204 })
        started++
        await new Promise<void>((resolve) => releases.push(resolve))
        return Response.json(wire(url.split("/").at(-1)!))
    })
    const client = defaultApi()
    const reads = Array.from({ length: 5 }, () => client.messages.fetch({ channelId: "20", id: "10" }))
    await vi.waitFor(() => expect(started).toBe(4))
    const deletion = client.messages.deleteMany("20", ["10"])
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(started).toBe(5))
    expect((await deletion).isOk()).toBe(true)
    releases.splice(0).forEach((release) => release())
    await Promise.all(reads)
    expect(client.messages.get({ channelId: "20", id: "10" })).toMatchObject({ value: undefined })
})
