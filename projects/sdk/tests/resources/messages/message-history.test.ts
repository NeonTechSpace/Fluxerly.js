import type { ServerResponse } from "node:http"
import { Effect, Fiber } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import type { MessageHistoryQuery } from "../../../src/index.js"
import { createClient as createNative } from "../../../src/effect.js"
import { defaultApi } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { startRestServer } from "../../support/rest-server.js"
import { settle } from "../../support/settle.js"

// The fixture asserts this exact Authorization credential, so clients receive it explicitly
const token = "fixture-only-not-a-credential"
const wire = (id: string, channel = "20") => ({
    id,
    channel_id: channel,
    content: `Message ${id}`,
    author: { id: "30", username: "fixture" },
    attachments: [],
})
const realFetch = globalThis.fetch
afterEach(() => vi.unstubAllGlobals())

async function fixture() {
    const requests: { url: URL; at: number }[] = []
    const control = {
        respond: (response: ServerResponse, url: URL) => {
            response.end(JSON.stringify([wire("10", url.pathname.split("/")[3])]))
        },
        closed: 0,
    }
    const rest = await startRestServer({
        fallback: (request, response) => {
            response.on("close", () => control.closed++)
            const url = new URL(
                request.query.size ? `${request.path}?${request.query}` : request.path,
                "http://fixture",
            )
            expect(request.method).toBe("GET")
            expect(request.headers.authorization).toBe(`Bot ${token}`)
            expect(request.headers["content-type"]).toBeUndefined()
            requests.push({ url, at: performance.now() })
            control.respond(response, url)
        },
    })
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => {
        expect(url.startsWith("https://api.fluxer.app/v1/channels/")).toBe(true)
        expect(init.redirect).toBe("error")
        expect(init.body).toBeUndefined()
        return realFetch(url.replace("https://api.fluxer.app", rest.origin), init)
    })
    return { requests, control }
}

test("history fetches one frozen remote page with defaults, without a gateway or synthetic events", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    const received = vi.fn()
    await settle(client.on("messageCreate", received))
    server.control.respond = (response) =>
        response.end(JSON.stringify([wire("1000000000000000001"), wire("999999999999999999")]))
    const page = await settle(client.messages.fetchHistory("20"))
    expect(page.map((m) => m.id)).toEqual(["1000000000000000001", "999999999999999999"])
    expect(Object.isFrozen(page)).toBe(true)
    for (const message of page) {
        expect(Object.isFrozen(message) && Object.isFrozen(message.author)).toBe(true)
        expect(message.attachments).toEqual([])
        expect(Object.isFrozen(message.attachments)).toBe(true)
    }
    expect(server.requests.map((r) => r.url.pathname + r.url.search)).toEqual(["/v1/channels/20/messages?limit=50"])
    expect(client.state).toBe("Disconnected")
    expect(received).not.toHaveBeenCalled()
    server.control.respond = (response) => response.end("[]")
    const empty = await settle(client.messages.fetchHistory("20", { before: page.at(-1)!.id }))
    expect(empty).toEqual([])
    expect(Object.isFrozen(empty)).toBe(true)
    expect(server.requests).toHaveLength(2)
})

test("history sends each explicit cursor and supports a full 100-message page without fetching another", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    server.control.respond = (response, url) => {
        const count = Number(url.searchParams.get("limit"))
        response.end(JSON.stringify(Array.from({ length: count }, (_, index) => wire(String(110 - index)))))
    }
    for (const query of [
        { limit: 100 },
        { limit: 1, before: "111" },
        { limit: 2, after: "108" },
        { limit: 3, around: "109" },
    ]) {
        const page = await settle(client.messages.fetchHistory("20", query))
        expect(page).toHaveLength(query.limit)
        expect(Object.fromEntries(server.requests.at(-1)!.url.searchParams)).toEqual(
            Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
        )
    }
    expect(server.requests).toHaveLength(4)
})

test("invalid history inputs fail locally, including mixed cursors and non-integer or excessive limits", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    const queries: unknown[] = [
        null,
        [],
        { limit: 0 },
        { limit: 101 },
        { limit: 1.5 },
        { limit: NaN },
        { limit: "50" },
        { limit: null },
        { before: "../other" },
        { after: 10 },
        { around: null },
        { before: "10", after: "9" },
        { before: "10", around: "9" },
        { after: "10", around: "9" },
        { offset: 0 },
    ]
    for (const query of queries) {
        const result = await client.messages.fetchHistory("20", query as MessageHistoryQuery)
        expect(result.isErr() && result.error).toMatchObject({
            operation: "fetchHistory",
            reason: "input",
            outcome: "notDispatched",
        })
    }
    const invalidChannel = await client.messages.fetchHistory("20?limit=100")
    expect(invalidChannel.isErr() && invalidChannel.error).toMatchObject({ reason: "input" })
    const deadline = await client.messages.fetchHistory("20", undefined, { timeoutMs: 0 })
    expect(deadline.isErr() && deadline.error).toMatchObject({ reason: "input" })
    const abort = new AbortController()
    abort.abort()
    const cancelled = await client.messages.fetchHistory("20", undefined, { signal: abort.signal })
    expect(cancelled.isErr() && cancelled.error).toMatchObject({ _tag: "CancelledError" })
    expect(server.requests).toHaveLength(0)
})

test("history rejects whole malformed, oversized, mismatched, duplicate or out-of-order pages", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    for (const body of [
        "{broken",
        "null",
        "{}",
        JSON.stringify([wire("10"), {}]),
        JSON.stringify([wire("10", "21")]),
        JSON.stringify([wire("10"), wire("10")]),
        JSON.stringify([wire("9"), wire("10")]),
        JSON.stringify([wire("11"), wire("10"), wire("9")]),
    ]) {
        server.control.respond = (response) => response.end(body)
        const result = await client.messages.fetchHistory("20", { limit: 2 })
        expect(result.isErr() && result.error).toMatchObject({
            operation: "fetchHistory",
            reason: "response",
            status: 200,
        })
    }
    server.control.respond = (response) => response.end(JSON.stringify([wire("10")]))
    for (const query of [{ before: "10" }, { after: "10" }]) {
        const result = await client.messages.fetchHistory("20", query)
        expect(result.isErr() && result.error).toMatchObject({ reason: "response" })
    }
    server.control.respond = (response) => response.writeHead(204).end()
    const unexpectedStatus = await client.messages.fetchHistory("20")
    expect(unexpectedStatus.isErr() && unexpectedStatus.error).toMatchObject({ reason: "response", status: 204 })
})

test("history shares its channel bucket across pages, separately from single fetch and other channels", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    server.control.respond = (response, url) => {
        if (server.requests.length === 1) {
            response.writeHead(429).end(JSON.stringify({ retry_after: 0.3 }))
        } else
            response.end(
                JSON.stringify(url.pathname.endsWith("/10") ? wire("10") : [wire("10", url.pathname.split("/")[3])]),
            )
    }
    const first = client.messages.fetchHistory("20")
    await vi.waitFor(() => expect(server.requests).toHaveLength(1))
    await settle(client.messages.fetch({ channelId: "20", id: "10" }))
    await settle(client.messages.fetchHistory("21"))
    const queued = await client.messages.fetchHistory("20", { before: "12" }, { timeoutMs: 30 })
    expect(queued.isErr() && queued.error).toMatchObject({ reason: "timeout", outcome: "notDispatched" })
    await settle(first)
    expect(server.requests).toHaveLength(4)
    expect(server.requests.at(-1)!.at - server.requests[0]!.at).toBeGreaterThanOrEqual(280)
    expect(server.requests.at(-1)!.url.search).toBe(server.requests[0]!.url.search)
})

test("native history is lazy and repeatable, with frozen pages and interruption isolated to its own request", async () => {
    const server = await fixture()
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token })
                const history = client.messages.fetchHistory("20", { after: "9" })
                expect(server.requests).toHaveLength(0)
                const first = yield* history
                const second = yield* history
                expect(first).toEqual(second)
                expect(first).not.toBe(second)
                expect(Object.isFrozen(first) && Object.isFrozen(first[0]!.author)).toBe(true)
                server.control.respond = () => {}
                const fiber = yield* Effect.forkScoped(history)
                yield* Effect.promise(() => vi.waitFor(() => expect(server.requests).toHaveLength(3)))
                yield* Fiber.interrupt(fiber)
                yield* Effect.promise(() => vi.waitFor(() => expect(server.control.closed).toBe(3)))
                server.control.respond = (response) => response.end("[]")
                expect(yield* history).toEqual([])
                server.control.respond = (response) => response.writeHead(404).end("{}")
                const error = yield* history.pipe(Effect.flip)
                expect(error).toMatchObject({
                    _tag: "MessageOperationError",
                    operation: "fetchHistory",
                    reason: "notFound",
                })
                expect(client.state).toBe("Disconnected")
            }),
        ),
    )
})
