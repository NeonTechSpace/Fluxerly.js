import { createServer, type ServerResponse } from "node:http"
import { once } from "node:events"
import { Effect, Fiber } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, MessageOperationError, type Client } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const target = { channelId: "20", id: "10" }
const wire = (content = "original") => ({
    id: "10",
    channel_id: "20",
    content,
    author: { id: "30", username: "fixture" },
})
const realFetch = globalThis.fetch
afterEach(() => vi.unstubAllGlobals())

async function fixture() {
    const requests: { method: string; path: string; body: any; contentType: string | undefined; at: number }[] = []
    const control = {
        respond: (response: ServerResponse, body: any, method: string) => {
            response.writeHead(method === "DELETE" ? 204 : 200)
            response.end(method === "DELETE" ? undefined : JSON.stringify(wire(body?.content)))
        },
        closed: 0,
    }
    const server = createServer(async (request, response) => {
        response.on("close", () => control.closed++)
        let text = ""
        for await (const chunk of request) text += chunk.toString()
        const body = text ? JSON.parse(text) : undefined
        expect(request.headers.authorization).toBe("Bot fixture-only-not-a-credential")
        requests.push({
            method: request.method!,
            path: request.url!,
            body,
            contentType: request.headers["content-type"],
            at: performance.now(),
        })
        control.respond(response, body, request.method!)
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture port")
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => {
        expect(url.startsWith("https://api.fluxer.app/v1/channels/")).toBe(true)
        expect(init.redirect).toBe("error")
        return realFetch(url.replace("https://api.fluxer.app", `http://127.0.0.1:${address.port}`), init)
    })
    onTestFinished(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return { requests, control }
}

function defaultApi(): Client {
    const created = createClient({ token: "fixture-only-not-a-credential" })
    if (created.isErr()) throw created.error
    onTestFinished(async () => {
        await created.value.shutdown()
    })
    return created.value
}

function value<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

test("default fetch, edit and delete use references without a gateway and return frozen remote snapshots", async () => {
    const server = await fixture()
    const client = defaultApi()
    const fetched = value(await client.messages.fetch(target))
    const edited = value(await client.messages.edit(fetched, { content: "  changed  " }))
    expect(edited.content).toBe("  changed  ")
    expect(fetched.content).toBe("original")
    expect(Object.isFrozen(edited) && Object.isFrozen(edited.author)).toBe(true)
    expect(value(await client.messages.delete(edited))).toBeUndefined()
    expect(client.state).toBe("Disconnected")
    expect(server.requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/v1/channels/20/messages/10"],
        ["PATCH", "/v1/channels/20/messages/10"],
        ["DELETE", "/v1/channels/20/messages/10"],
    ])
    expect(server.requests[0]!.body).toBeUndefined()
    expect(server.requests[2]!.contentType).toBeUndefined()
    expect(server.requests[1]!.body).toEqual({
        content: "  changed  ",
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    })
})

test("native methods are lazy, repeatable effects with matching results and typed missing-target failures", async () => {
    const server = await fixture()
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const fetch = client.messages.fetch(target)
                expect(server.requests).toHaveLength(0)
                const first = yield* fetch
                yield* fetch
                expect(server.requests).toHaveLength(2)
                const edited = yield* client.messages.edit(first, { content: "native" })
                expect(edited.content).toBe("native")
                expect(Object.isFrozen(edited.author)).toBe(true)
                expect(yield* client.messages.delete(edited)).toBeUndefined()
                server.control.respond = (response) => {
                    response.writeHead(404).end("{}")
                }
                for (const operation of [
                    client.messages.fetch(target),
                    client.messages.edit(target, { content: "x" }),
                    client.messages.delete(target),
                ]) {
                    const error = yield* operation.pipe(Effect.flip)
                    expect(error).toMatchObject({
                        _tag: "MessageOperationError",
                        reason: "notFound",
                        outcome: "rejected",
                        status: 404,
                    })
                }
            }),
        ),
    )
})

test("edit supports explicit clearing and mention opt-in without sending other fields", async () => {
    const server = await fixture()
    const client = defaultApi()
    expect(
        value(
            await client.messages.edit(target, {
                content: "",
                allowedMentions: { users: ["30"], roles: ["40"], everyone: true, repliedUser: true },
            }),
        ).content,
    ).toBe("")
    expect(server.requests[0]!.body).toEqual({
        content: "",
        allowed_mentions: { parse: ["everyone"], users: ["30"], roles: ["40"], replied_user: true },
    })
    server.control.respond = (response) => {
        response.writeHead(400).end("private server body")
    }
    const rejected = await client.messages.edit(target, { content: "" })
    expect(rejected.isErr() && rejected.error).toMatchObject({
        operation: "edit",
        reason: "rejected",
        outcome: "rejected",
        status: 400,
    })
})

test("invalid references, edit fields, mention permissions and deadlines fail before HTTP", async () => {
    const server = await fixture()
    const client = defaultApi()
    const results = [
        await client.messages.fetch({ id: "../other", channelId: "20" }),
        await client.messages.delete({ id: "10", channelId: "20?x" }),
        await client.messages.edit(target, {} as never),
        await client.messages.edit(target, { content: null } as never),
        await client.messages.edit(target, { content: "x", attachments: null } as never),
        await client.messages.edit(target, { content: "x", allowedMentions: { users: ["bad"] } }),
        await client.messages.fetch(target, { timeoutMs: 0 }),
        await client.messages.delete(target, { timeoutMs: Infinity }),
    ]
    for (const result of results)
        expect(result.isErr() && result.error).toMatchObject({
            _tag: "MessageOperationError",
            reason: "input",
            outcome: "notDispatched",
        })
    expect(server.requests).toHaveLength(0)
})

test.each(["fetch", "edit", "delete"] as const)(
    "%s maps missing targets without leaking server bodies",
    async (operation) => {
        const server = await fixture()
        server.control.respond = (response) => {
            response.writeHead(404).end("private body and fixture-only-not-a-credential")
        }
        const client = defaultApi()
        const result =
            operation === "edit"
                ? await client.messages.edit(target, { content: "private text" })
                : await client.messages[operation](target)
        expect(result.isErr() && result.error).toBeInstanceOf(MessageOperationError)
        expect(result.isErr() && result.error).toMatchObject({
            operation,
            reason: "notFound",
            outcome: "rejected",
            status: 404,
        })
        expect(JSON.stringify(result)).not.toMatch(/private|fixture-only/)
        expect(server.requests).toHaveLength(1)
    },
)

test.each(["edit", "delete"] as const)(
    "%s does not retry after a lost response or server failure",
    async (operation) => {
        const server = await fixture()
        const client = defaultApi()
        const call = () =>
            operation === "edit" ? client.messages.edit(target, { content: "changed" }) : client.messages.delete(target)
        server.control.respond = (response) => {
            response.destroy()
        }
        const lost = await call()
        expect(lost.isErr() && lost.error).toMatchObject({ operation, reason: "network", outcome: "unknown" })
        server.control.respond = (response) => {
            response.writeHead(500).end("private failure")
        }
        const failed = await call()
        expect(failed.isErr() && failed.error).toMatchObject({
            operation,
            reason: "rejected",
            outcome: "unknown",
            status: 500,
        })
        expect(server.requests).toHaveLength(2)
    },
)

test("fetch and edit reject malformed or mismatched snapshots; delete requires 204", async () => {
    const server = await fixture()
    const client = defaultApi()
    for (const data of [{}, { ...wire(), id: "11" }, { ...wire(), channel_id: "21" }]) {
        server.control.respond = (response) => {
            response.end(JSON.stringify(data))
        }
        const fetched = await client.messages.fetch(target)
        const edited = await client.messages.edit(target, { content: "x" })
        for (const result of [fetched, edited])
            expect(result.isErr() && result.error).toMatchObject({
                reason: "response",
                outcome: "unknown",
                status: 200,
            })
    }
    const deleted = await client.messages.delete(target)
    expect(deleted.isErr() && deleted.error).toMatchObject({ reason: "response", outcome: "unknown", status: 200 })
})

test("route limits group message IDs by method/channel without blocking other methods", async () => {
    const server = await fixture()
    const client = defaultApi()
    server.control.respond = (response, body, method) => {
        if (method === "PATCH" && server.requests.filter((r) => r.method === "PATCH").length === 1) {
            response.writeHead(429).end(JSON.stringify({ retry_after: 0.25 }))
        } else response.end(JSON.stringify(wire(body?.content)))
    }
    const edit = client.messages.edit(target, { content: "stable" })
    await vi.waitFor(() => expect(server.requests).toHaveLength(1))
    value(await client.messages.fetch(target))
    value(await edit)
    expect(server.requests.map((r) => r.method)).toEqual(["PATCH", "GET", "PATCH"])
    expect(server.requests[2]!.at - server.requests[0]!.at).toBeGreaterThanOrEqual(230)
    expect(server.requests[2]!.body).toEqual(server.requests[0]!.body)
    server.control.respond = (response) => {
        response.setHeader("x-ratelimit-remaining", "0")
        response.setHeader("x-ratelimit-reset-after", "0.2")
        response.end(JSON.stringify(wire()))
    }
    value(await client.messages.fetch(target))
    const queued = await client.messages.fetch({ ...target, id: "11" }, { timeoutMs: 30 })
    expect(queued.isErr() && queued.error).toMatchObject({ reason: "timeout", outcome: "notDispatched" })
})

test("global rejection defers send too, while an over-budget retry remains a confirmed rejection", async () => {
    const server = await fixture()
    const client = defaultApi()
    server.control.respond = (response) => {
        response.writeHead(429).end(JSON.stringify({ retry_after: 0.15, global: true }))
    }
    const rejected = await client.messages.delete(target, { timeoutMs: 50 })
    expect(rejected.isErr() && rejected.error).toMatchObject({
        reason: "rateLimit",
        outcome: "rejected",
        status: 429,
        retryAfterMs: 150,
    })
    server.control.respond = (response, body) => {
        response.end(JSON.stringify(wire(body?.content)))
    }
    value(await client.messages.send("20", { content: "send still works" }))
    expect(server.requests[1]!.at - server.requests[0]!.at).toBeGreaterThanOrEqual(130)
})

test("timeouts, default cancellation and shutdown await active request cleanup", async () => {
    const server = await fixture()
    server.control.respond = () => {}
    const client = defaultApi()
    const timeout = await client.messages.edit(target, { content: "x" }, { timeoutMs: 60 })
    expect(timeout.isErr() && timeout.error).toMatchObject({ reason: "timeout", outcome: "unknown" })
    await vi.waitFor(() => expect(server.control.closed).toBe(1))
    const controller = new AbortController()
    const cancelled = client.messages.delete(target, { signal: controller.signal })
    await vi.waitFor(() => expect(server.requests).toHaveLength(2))
    controller.abort()
    expect((await cancelled).isErr()).toBe(true)
    await vi.waitFor(() => expect(server.control.closed).toBe(2))
    const active = Array.from({ length: 5 }, () => client.messages.fetch(target))
    await vi.waitFor(() => expect(server.requests).toHaveLength(6))
    value(await client.shutdown())
    for (const result of await Promise.all(active))
        expect(result.isErr() && result.error).toMatchObject({ _tag: "ClientClosedError" })
    await vi.waitFor(() => expect(server.control.closed).toBe(6))
    expect((await client.messages.delete(target)).isErr()).toBe(true)
    expect(server.requests).toHaveLength(6)
})

test("native interruption cancels only its request and permits subsequent work", async () => {
    const server = await fixture()
    server.control.respond = () => {}
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const fiber = yield* Effect.forkScoped(client.messages.edit(target, { content: "x" }))
                yield* Effect.promise(() => vi.waitFor(() => expect(server.requests).toHaveLength(1)))
                yield* Fiber.interrupt(fiber)
                yield* Effect.promise(() => vi.waitFor(() => expect(server.control.closed).toBe(1)))
                server.control.respond = (response) => {
                    response.end(JSON.stringify(wire()))
                }
                expect((yield* client.messages.fetch(target)).content).toBe("original")
                expect(client.state).toBe("Disconnected")
            }),
        ),
    )
})
