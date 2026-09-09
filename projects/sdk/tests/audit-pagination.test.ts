import { Effect, Exit, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, type AuditLogIterationQuery } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"

const modes = ["default", "native"] as const
const response = (ids: string[]) =>
    Response.json({
        audit_log_entries: ids.map((id) => ({ id, action_type: 1, user_id: "40", target_id: "20" })),
        users: [],
        webhooks: [],
    })
afterEach(() => vi.unstubAllGlobals())
async function fixture(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const defaultApi = mode === "default" ? createClient({ token: "fixture_only" })._unsafeUnwrap() : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(createNative({ token: "fixture_only" }).pipe(Scope.provide(scope)))
            : undefined
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
        respond: async (url: URL, _init: RequestInit) => {
            const before = url.searchParams.get("before")
            const limit = Number(url.searchParams.get("limit"))
            return response((before === null ? ["13", "12"] : before === "12" ? ["11"] : []).slice(0, limit))
        },
    }
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        const parsed = new URL(url)
        requests.push(parsed)
        expect(parsed.pathname).toBe("/v1/guilds/20/audit-logs")
        expect(init.method).toBe("GET")
        return control.respond(parsed, init)
    })
    const iterate = (query: AuditLogIterationQuery): AsyncIterable<unknown> => {
        if (native) return Stream.toAsyncIterable(native.auditLogs.iterate("20", query))
        return {
            async *[Symbol.asyncIterator]() {
                for await (const result of defaultApi!.auditLogs.iterate("20", query)) {
                    if (result.isErr()) throw result.error
                    yield result.value
                }
            },
        }
    }
    return { defaultApi, native, requests, control, iterate, close }
}
async function collect(input: AsyncIterable<unknown>) {
    const result: unknown[] = []
    for await (const item of input) result.push(item)
    return result
}

test.each(modes)("%s preserves audit filters and descending progress across short pages", async (mode) => {
    const api = await fixture(mode)
    const items = await collect(api.iterate({ userId: "40", actionType: 1, maxItems: 5, pageSize: 2 }))
    expect(items).toMatchObject([{ id: "13" }, { id: "12" }, { id: "11" }])
    expect(items.every(Object.isFrozen)).toBe(true)
    expect(api.requests.map((url) => url.searchParams.get("before"))).toEqual([null, "12", "11"])
    expect(
        api.requests.every(
            (url) => url.searchParams.get("user_id") === "40" && url.searchParams.get("action_type") === "1",
        ),
    ).toBe(true)
})

test.each(modes)("%s starts audit traversal lazily, copies filters and releases on early exit", async (mode) => {
    const api = await fixture(mode)
    const query = { userId: "40", maxItems: 3, pageSize: 2 }
    const iterable = api.iterate(query)
    expect(api.requests).toHaveLength(0)
    for await (const item of iterable) {
        expect(item).toMatchObject({ id: "13" })
        break
    }
    expect(api.requests).toHaveLength(1)
    api.requests.length = 0
    const iterator = iterable[Symbol.asyncIterator]()
    await iterator.next()
    query.userId = "41"
    await iterator.next()
    await iterator.next()
    expect((await iterator.next()).done).toBe(true)
    expect(api.requests.map((url) => url.searchParams.get("limit"))).toEqual(["2", "1"])
    expect(api.requests.every((url) => url.searchParams.get("user_id") === "40")).toBe(true)
})

test.each(modes)("%s rejects unfiltered and invalid audit traversals before dispatch", async (mode) => {
    const api = await fixture(mode)
    for (const query of [
        { maxItems: 2 },
        { userId: "40", maxItems: 0 },
        { actionType: 1, maxItems: 2, pageSize: 101 },
        { userId: "40", maxItems: 2, after: "30" },
        { userId: "bad", maxItems: 2 },
        { actionType: -1, maxItems: 2 },
        { userId: "40", maxItems: 2, before: "bad" },
    ])
        await expect(collect(api.iterate(query as AuditLogIterationQuery))).rejects.toMatchObject({
            _tag: "PaginationError",
            reason: "input",
        })
    expect(api.requests).toHaveLength(0)
})

test.each(modes)("%s bounds audit traversal and fails buffered pulls after client closure", async (mode) => {
    const api = await fixture(mode)
    await expect(collect(api.iterate({ userId: "40", maxItems: 5, pageSize: 2, maxPages: 1 }))).rejects.toMatchObject({
        reason: "pageLimit",
    })
    expect(api.requests).toHaveLength(1)
    const iterator = api.iterate({ userId: "40", maxItems: 5 })[Symbol.asyncIterator]()
    await iterator.next()
    await api.close()
    await expect(iterator.next()).rejects.toMatchObject({ _tag: "ClientClosedError" })
})

test.each(modes)("%s waits for audit HTTP cleanup on cancellation", async (mode) => {
    const api = await fixture(mode)
    let started!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
        started = resolve
    })
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    let cleaned = false
    api.control.respond = async (_url, init) => {
        await new Promise<void>((resolve) => {
            init.signal!.addEventListener("abort", () => resolve(), { once: true })
            started()
        })
        return new Response(
            new ReadableStream({
                async cancel() {
                    await held
                    cleaned = true
                },
            }),
            { status: 403 },
        )
    }
    const controller = new AbortController()
    const operation = api.defaultApi
        ? api.defaultApi.auditLogs
              .iterate("20", { userId: "40", maxItems: 1 }, { signal: controller.signal })
              [Symbol.asyncIterator]()
              .next()
        : Effect.runPromiseExit(Stream.runCollect(api.native!.auditLogs.iterate("20", { userId: "40", maxItems: 1 })), {
              signal: controller.signal,
          })
    let done = false
    const watched = operation.finally(() => {
        done = true
    })
    try {
        await ready
        controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 15))
        expect(done).toBe(false)
    } finally {
        release()
    }
    await watched
    expect(cleaned).toBe(true)
})
