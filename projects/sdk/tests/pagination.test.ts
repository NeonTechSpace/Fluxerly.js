import { Effect, Exit, Scope, Stream, Cause, Logger } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Result } from "neverthrow"
import {
    createClient,
    type HistoryIterationQuery,
    type UserIterationQuery,
    type PinIterationQuery,
    type DefaultMessageOperationOptions,
} from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
type Kind = "history" | "members" | "reactors" | "pins"
const target = { channelId: "20", id: "30" }
const wire = (id: string) => ({ id, channel_id: "20", content: "fixture", author: { id: "40", username: "fixture" } })
const member = (id: string) => ({ user: { id, username: "fixture" }, roles: [], joined_at: "2026-09-08T00:00:00.000Z" })
const pin = (id: string, time: string) => ({ message: { ...wire(id), pinned: true }, pinned_at: time })
const firstTime = "2026-09-08T12:00:00.000Z",
    secondTime = "2026-09-08T11:00:00.000Z"
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function gather<A>(iterable: AsyncIterable<A>): Promise<A[]> {
    const items: A[] = []
    for await (const item of iterable) items.push(item)
    return items
}

async function* unwrap<A, E>(iterable: AsyncIterable<Result<A, E>>): AsyncIterable<A> {
    for await (const result of iterable) {
        if (result.isErr()) throw result.error
        yield result.value
    }
}
async function fixture(mode: (typeof modes)[number], caching = false) {
    const scope = Scope.makeUnsafe()
    const configuration = { token: "fixture-only-not-a-credential", cache: { messages: caching, members: caching } }
    const created = mode === "default" ? createClient(configuration) : undefined
    if (created?.isErr()) throw created.error
    const defaultApi = created?.isOk() ? created.value : undefined
    const native =
        mode === "native" ? await Effect.runPromise(createNative(configuration).pipe(Scope.provide(scope))) : undefined
    const close = async () => {
        if (defaultApi) await defaultApi.shutdown()
        else await Effect.runPromise(native!.shutdown())
    }
    onTestFinished(async () => {
        await close()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const requests: URL[] = []
    const control = {
        respond: async (url: URL, _init: RequestInit): Promise<Response> => {
            const cursor = url.searchParams.get("before") ?? url.searchParams.get("after")
            const limit = Number(url.searchParams.get("limit"))
            if (url.pathname.endsWith("/members"))
                return Response.json(
                    (cursor === null ? ["10", "11"] : cursor === "11" ? ["12"] : []).slice(0, limit).map(member),
                )
            if (url.pathname.includes("/reactions/")) {
                const ids = (cursor === null ? ["10", "11"] : ["12"]).slice(0, limit)
                return Response.json({
                    items: ids.map((id) => ({ id, username: "fixture" })),
                    has_more: cursor === null,
                    next_after: cursor === null ? ids.at(-1) : null,
                })
            }
            if (url.pathname.endsWith("/pins"))
                return Response.json({
                    items: (cursor === null
                        ? [pin("10", firstTime), pin("11", secondTime)]
                        : [pin("11", secondTime)]
                    ).slice(0, limit),
                    has_more: cursor === null,
                })
            return Response.json(
                (cursor === null ? ["13", "12"] : cursor === "12" ? ["11"] : []).slice(0, limit).map(wire),
            )
        },
    }
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const parsed = new URL(url)
        expect(parsed.origin).toBe("https://api.fluxer.app")
        expect(init.method).toBe("GET")
        requests.push(parsed)
        return control.respond(parsed, init)
    })
    const iterate = (
        kind: Kind,
        query: HistoryIterationQuery | UserIterationQuery | PinIterationQuery = { maxItems: 5, pageSize: 2 },
        options?: DefaultMessageOperationOptions,
    ): AsyncIterable<unknown> => {
        if (defaultApi) {
            if (kind === "history") return unwrap(defaultApi.messages.iterateHistory("20", query, options))
            if (kind === "members") return unwrap(defaultApi.members.iterate("20", query, options))
            if (kind === "reactors")
                return unwrap(defaultApi.messages.iterateReactionUsers(target, "👍", query, options))
            return unwrap(defaultApi.messages.iteratePins("20", query, options))
        }
        const stream =
            kind === "history"
                ? native!.messages.iterateHistory("20", query, options)
                : kind === "members"
                  ? native!.members.iterate("20", query, options)
                  : kind === "reactors"
                    ? native!.messages.iterateReactionUsers(target, "👍", query, options)
                    : native!.messages.iteratePins("20", query, options)
        return Stream.toAsyncIterable(stream as Stream.Stream<unknown, unknown>)
    }
    return { defaultApi, native, close, iterate, requests, control }
}

test.each(modes)(
    "%s traverses four page contracts with frozen snapshots, short-page continuation and pin deduplication",
    async (mode) => {
        const api = await fixture(mode)
        for (const kind of ["history", "members", "reactors", "pins"] as const) {
            api.requests.length = 0
            const items = await gather(api.iterate(kind))
            expect(items).toHaveLength(kind === "pins" ? 2 : 3)
            expect(items.every(Object.isFrozen)).toBe(true)
            expect(api.requests).toHaveLength(kind === "history" || kind === "members" ? 3 : 2)
            expect(
                api.requests[1]!.searchParams.get(kind === "members" || kind === "reactors" ? "after" : "before"),
            ).toBe(kind === "pins" ? secondTime : kind === "history" ? "12" : "11")
        }
    },
)

test.each(modes)(
    "%s is lazy and supports early exit, remaining limits and fresh independent consumption",
    async (mode) => {
        const api = await fixture(mode)
        const input = { maxItems: 3, pageSize: 2 }
        const iterable =
            mode === "default"
                ? api.defaultApi!.messages.iterateHistory("20", input)
                : Stream.toAsyncIterable(api.native!.messages.iterateHistory("20", input))
        expect(api.requests).toHaveLength(0)
        for await (const _item of iterable) break
        expect(api.requests).toHaveLength(1)
        api.requests.length = 0
        expect(await gather<unknown>(iterable)).toHaveLength(3)
        expect(api.requests.map((url) => url.searchParams.get("limit"))).toEqual(["2", "1"])
        api.requests.length = 0
        expect(await gather(api.iterate("history", { maxItems: 1 }))).toHaveLength(1)
        expect(api.requests.map((url) => url.searchParams.get("limit"))).toEqual(["1"])
    },
)

test.each(modes)("%s copies traversal input before requests and keeps repeated iterators independent", async (mode) => {
    const api = await fixture(mode)
    const query = { maxItems: 3, pageSize: 2, maxPages: 3 }
    const first = api.iterate("history", query)[Symbol.asyncIterator]()
    await first.next()
    query.maxItems = 1
    query.pageSize = 1
    query.maxPages = 1
    const second = api.iterate("history", query)[Symbol.asyncIterator]()
    expect((await second.next()).done).toBe(false)
    expect((await second.next()).done).toBe(true)
    expect((await first.next()).done).toBe(false)
    expect((await first.next()).done).toBe(false)
    expect((await first.next()).done).toBe(true)
})

test.each(modes)(
    "%s rejects invalid traversal inputs locally, including unknown keys and default-only native signals",
    async (mode) => {
        const api = await fixture(mode)
        const invalid = [
            undefined,
            {},
            null,
            { maxItems: 0 },
            { maxItems: 1.5 },
            { maxItems: Infinity },
            { maxItems: 2, maxPages: null },
            { maxItems: 2, pageSize: null },
            { maxItems: 2, pageSize: 101 },
            { maxItems: 2, after: "30" },
            { maxItems: 2, before: "not-id" },
            { maxItems: 2, extra: true },
        ]
        for (const query of invalid) {
            const iterable = api.defaultApi
                ? unwrap(api.defaultApi.messages.iterateHistory("20", query as HistoryIterationQuery))
                : Stream.toAsyncIterable(api.native!.messages.iterateHistory("20", query as HistoryIterationQuery))
            await expect(gather(iterable)).rejects.toMatchObject({ _tag: "PaginationError", reason: "input" })
        }
        for (const options of [{ timeoutMs: 0 }, { extra: true }, { signal: {} }])
            await expect(
                gather(api.iterate("history", { maxItems: 2 }, options as DefaultMessageOperationOptions)),
            ).rejects.toMatchObject({ reason: "input" })
        if (api.native)
            await expect(
                gather(api.iterate("history", { maxItems: 2 }, { signal: new AbortController().signal })),
            ).rejects.toMatchObject({ reason: "input" })
        expect(api.requests).toHaveLength(0)
    },
)

test.each(modes)(
    "%s preserves delivered items before remote or page-budget failure and never treats a cap as exhaustion",
    async (mode) => {
        const api = await fixture(mode)
        const source = api.iterate("history", { maxItems: 10, pageSize: 2, maxPages: 1 })[Symbol.asyncIterator]()
        await source.next()
        await source.next()
        await expect(source.next()).rejects.toMatchObject({ _tag: "PaginationError", reason: "pageLimit" })
        expect(api.requests).toHaveLength(1)
        api.requests.length = 0
        api.control.respond = async (url) =>
            url.searchParams.has("before") ? new Response("private", { status: 403 }) : Response.json([wire("10")])
        const remote = api.iterate("history")[Symbol.asyncIterator]()
        expect((await remote.next()).done).toBe(false)
        await expect(remote.next()).rejects.toMatchObject({
            _tag: "MessageOperationError",
            operation: "fetchHistory",
            status: 403,
        })
        expect(api.requests).toHaveLength(2)
    },
)

test.each(modes)("%s stops on pin cursor ties without discarding newly observed pin IDs", async (mode) => {
    const api = await fixture(mode)
    api.control.respond = async (url) =>
        Response.json({ items: [pin(url.searchParams.has("before") ? "11" : "10", firstTime)], has_more: true })
    const stream = api.iterate("pins")[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ message: { id: "10" } })
    expect((await stream.next()).value).toMatchObject({ message: { id: "11" } })
    await expect(stream.next()).rejects.toMatchObject({ reason: "cursorStalled" })
    expect(api.requests).toHaveLength(2)
})

test.each(modes)(
    "%s bounds duplicate-only pin pages even when their timestamp cursor keeps advancing",
    async (mode) => {
        const api = await fixture(mode)
        let page = 0
        api.control.respond = async () =>
            Response.json({
                items: [pin("10", new Date(Date.parse(firstTime) - page++ * 1000).toISOString())],
                has_more: true,
            })
        const iterator = api.iterate("pins", { maxItems: 2, maxPages: 3 })[Symbol.asyncIterator]()
        await iterator.next()
        await expect(iterator.next()).rejects.toMatchObject({ reason: "pageLimit" })
        expect(api.requests).toHaveLength(3)
    },
)

test.each(modes)(
    "%s keeps cache admission owned by underlying reads and closure fails buffered pulls",
    async (mode) => {
        const api = await fixture(mode, true)
        await gather(api.iterate("history", { maxItems: 2 }))
        await gather(api.iterate("members", { maxItems: 2 }))
        if (api.defaultApi) {
            expect(api.defaultApi.messages.get({ channelId: "20", id: "13" })._unsafeUnwrap()).toMatchObject({
                id: "13",
            })
            expect(api.defaultApi.members.get({ guildId: "20", userId: "10" })._unsafeUnwrap()).toMatchObject({
                userId: "10",
            })
        } else {
            expect(await Effect.runPromise(api.native!.messages.get({ channelId: "20", id: "13" }))).toMatchObject({
                id: "13",
            })
            expect(await Effect.runPromise(api.native!.members.get({ guildId: "20", userId: "10" }))).toMatchObject({
                userId: "10",
            })
        }
        const iterator = api.iterate("history")[Symbol.asyncIterator]()
        await iterator.next()
        await api.close()
        await expect(iterator.next()).rejects.toMatchObject({ _tag: "ClientClosedError" })
    },
)

test("default cancellation before dispatch is one terminal Err, including after buffered items", async () => {
    const api = await fixture("default")
    const abort = new AbortController()
    abort.abort()
    const initial = await gather(
        api.defaultApi!.messages.iterateHistory("20", { maxItems: 2 }, { signal: abort.signal }),
    )
    expect(initial).toHaveLength(1)
    expect(initial[0]!._unsafeUnwrapErr()).toMatchObject({ _tag: "CancelledError" })
    expect(api.requests).toHaveLength(0)
    const controller = new AbortController()
    const iterator = api
        .defaultApi!.messages.iterateHistory("20", { maxItems: 3 }, { signal: controller.signal })
        [Symbol.asyncIterator]()
    await iterator.next()
    controller.abort()
    const error = await iterator.next()
    expect(error.value._unsafeUnwrapErr()).toMatchObject({ _tag: "CancelledError" })
    expect((await iterator.next()).done).toBe(true)
    expect(api.requests).toHaveLength(1)
})

test.each(modes)("%s cancellation waits for in-flight response cleanup before completing", async (mode) => {
    const api = await fixture(mode)
    let release!: () => void, started!: () => void
    const ready = new Promise<void>((resolve) => {
        started = resolve
    })
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    let cancelled = false
    api.control.respond = async (_url, init) => {
        await new Promise<void>((resolve) => {
            init.signal!.addEventListener("abort", () => resolve(), { once: true })
            started()
        })
        return new Response(
            new ReadableStream({
                async cancel() {
                    await held
                    cancelled = true
                },
            }),
            { status: 403 },
        )
    }
    const abort = new AbortController()
    let settled = false
    const result = api.defaultApi
        ? api.defaultApi.messages
              .iterateHistory("20", { maxItems: 2 }, { signal: abort.signal })
              [Symbol.asyncIterator]()
              .next()
        : Effect.runPromiseExit(Stream.runCollect(api.native!.messages.iterateHistory("20", { maxItems: 2 })), {
              signal: abort.signal,
          })
    const watched = result.finally(() => {
        settled = true
    })
    try {
        await ready
        abort.abort()
        await new Promise((resolve) => setTimeout(resolve, 15))
        expect(settled).toBe(false)
    } finally {
        release()
    }
    const outcome = await watched
    expect(cancelled).toBe(true)
    if (api.native)
        expect(
            Exit.isFailure(outcome as Exit.Exit<unknown, unknown>) &&
                Cause.hasInterrupts((outcome as Exit.Failure<unknown, unknown>).cause),
        ).toBe(true)
})

test("native traversal stays in the caller's Effect logger context", async () => {
    const api = await fixture("native")
    const records: string[] = []
    const logger = Logger.make((entry) => {
        records.push(String(entry.message))
    })
    await Effect.runPromise(
        api.native!.messages.iterateHistory("20", { maxItems: 1 }).pipe(
            Stream.runForEach(() => Effect.log("pagination-context")),
            Effect.provide(Logger.layer([logger])),
        ),
    )
    expect(records).toEqual(["pagination-context"])
})

test("default traversal preparation sanitizes unexpected input-access defects before dispatch", async () => {
    const api = await fixture("default")
    const options = {
        get timeoutMs(): number {
            throw new Error("private input detail")
        },
    }
    const iterator = api.defaultApi!.messages.iterateHistory("20", { maxItems: 2 }, options)[Symbol.asyncIterator]()
    const failure = await iterator.next().catch((error) => error)
    expect(failure).toMatchObject({ name: "SdkDefect", operation: "iterateHistory", reasons: [{ kind: "Defect" }] })
    expect(String(failure)).not.toContain("private input detail")
    expect(api.requests).toHaveLength(0)
})

test.each(modes)("%s defaults to 100 logical pages and counts transient retries within the same page", async (mode) => {
    const api = await fixture(mode)
    let id = 1000
    api.control.respond = async () => Response.json([wire(String(id--))])
    await expect(gather(api.iterate("history", { maxItems: 200, pageSize: 1 }))).rejects.toMatchObject({
        reason: "pageLimit",
    })
    expect(api.requests).toHaveLength(100)
    api.requests.length = 0
    api.control.respond = async () =>
        api.requests.length === 1 ? new Response(null, { status: 503 }) : Response.json([wire("10")])
    expect(await gather(api.iterate("history", { maxItems: 1, maxPages: 1 }))).toHaveLength(1)
    expect(api.requests).toHaveLength(2)
})

test.each(modes)("%s copies selected reaction identity and uses the explicit starting cursor", async (mode) => {
    const api = await fixture(mode)
    const message = { channelId: "20", id: "30" },
        emoji = { name: "custom", id: "60" }
    const query = { maxItems: 5, after: "10", pageSize: 1 }
    api.control.respond = async () =>
        Response.json({
            items: [{ id: String(10 + api.requests.length), username: "fixture" }],
            has_more: api.requests.length === 1,
            next_after: api.requests.length === 1 ? "11" : null,
        })
    const iterator = (
        api.defaultApi
            ? unwrap(api.defaultApi.messages.iterateReactionUsers(message, emoji, query))
            : Stream.toAsyncIterable(api.native!.messages.iterateReactionUsers(message, emoji, query))
    )[Symbol.asyncIterator]()
    await iterator.next()
    message.id = "99"
    emoji.name = "changed"
    emoji.id = "98"
    query.after = "97"
    await iterator.next()
    await iterator.return?.()
    expect(api.requests.map((url) => url.pathname)).toEqual([
        "/v1/channels/20/messages/30/reactions/custom%3A60/users",
        "/v1/channels/20/messages/30/reactions/custom%3A60/users",
    ])
    expect(api.requests.map((url) => url.searchParams.get("after"))).toEqual(["10", "11"])
})

test.each(modes)(
    "%s rejects an entire malformed later page and leaves existing pin cache behavior unchanged",
    async (mode) => {
        const api = await fixture(mode, true)
        api.control.respond = async () =>
            api.requests.length === 1
                ? Response.json([wire("13")])
                : Response.json([wire("12"), { ...wire("11"), channel_id: "99" }])
        const iterator = api.iterate("history")[Symbol.asyncIterator]()
        expect((await iterator.next()).value).toMatchObject({ id: "13" })
        await expect(iterator.next()).rejects.toMatchObject({ reason: "response", operation: "fetchHistory" })
        api.control.respond = async () => Response.json({ items: [pin("10", firstTime)], has_more: false })
        expect(await gather(api.iterate("pins"))).toHaveLength(1)
        const cached = api.defaultApi
            ? api.defaultApi.messages.get({ channelId: "20", id: "10" })._unsafeUnwrap()
            : await Effect.runPromise(api.native!.messages.get({ channelId: "20", id: "10" }))
        expect(cached).toBeUndefined()
    },
)

test.each(modes)("%s starts a new per-page deadline after slow caller processing", async (mode) => {
    const api = await fixture(mode)
    api.control.respond = async () => Response.json([wire(String(20 - api.requests.length))])
    const iterator = api.iterate("history", { maxItems: 2, pageSize: 1 }, { timeoutMs: 50 })[Symbol.asyncIterator]()
    await iterator.next()
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect((await iterator.next()).done).toBe(false)
    expect((await iterator.next()).done).toBe(true)
    expect(api.requests).toHaveLength(2)
})
