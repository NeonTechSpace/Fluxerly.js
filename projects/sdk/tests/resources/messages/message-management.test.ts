import type { ServerResponse } from "node:http"
import { Effect, Fiber } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { MessageOperationError } from "../../../src/index.js"
import { createClient as createNative } from "../../../src/effect.js"
import { defaultApi } from "../../support/both-apis.js"
import { sdkClock } from "../../support/client-clock.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { startRestServer } from "../../support/rest-server.js"
import { settle } from "../../support/settle.js"

// The fixture asserts this exact Authorization credential, so clients receive it explicitly
const token = "fixture-only-not-a-credential"
const target = { channelId: "20", id: "10" }
const wire = (content = "original") => ({
    id: "10",
    channel_id: "20",
    content,
    author: { id: "30", username: "fixture" },
})
const realFetch = globalThis.fetch
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function fixture(now = () => performance.now()) {
    const requests: { method: string; path: string; body: any; contentType: string | undefined; at: number }[] = []
    const control = {
        respond: (response: ServerResponse, body: any, method: string) => {
            response.writeHead(method === "DELETE" ? 204 : 200)
            response.end(method === "DELETE" ? undefined : JSON.stringify(wire(body?.content)))
        },
        closed: 0,
    }
    const rest = await startRestServer({
        fallback: (request, response) => {
            response.on("close", () => control.closed++)
            expect(request.headers.authorization).toBe(`Bot ${token}`)
            requests.push({
                method: request.method,
                path: request.query.size ? `${request.path}?${request.query}` : request.path,
                body: request.body,
                contentType: request.headers["content-type"],
                at: now(),
            })
            control.respond(response, request.body, request.method)
        },
    })
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => {
        expect(url.startsWith("https://api.fluxer.app/v1/channels/")).toBe(true)
        expect(init.redirect).toBe("error")
        return realFetch(url.replace("https://api.fluxer.app", rest.origin), init)
    })
    return { requests, control }
}

test("default fetch, edit and delete use references without a gateway and return frozen remote snapshots", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    const fetched = await settle(client.messages.fetch(target))
    const edited = await settle(client.messages.edit(fetched, { content: "  changed  " }))
    expect(edited.content).toBe("  changed  ")
    expect(fetched.content).toBe("original")
    expect(Object.isFrozen(edited) && Object.isFrozen(edited.author)).toBe(true)
    expect(await settle(client.messages.delete(edited))).toBeUndefined()
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
    let targetReads = 0
    const changingTarget = {
        channelId: "20",
        get id() {
            return ++targetReads === 1 ? "10" : "11"
        },
    }
    expect(await settle(client.messages.delete(changingTarget))).toBeUndefined()
    expect(targetReads).toBe(1)
    expect(server.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/channels/20/messages/10" })
})

test("native methods are lazy, repeatable effects with matching results and typed missing-target failures", async () => {
    const server = await fixture()
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token })
                const fetch = client.messages.fetch(target)
                expect(server.requests).toHaveLength(0)
                const first = yield* fetch
                yield* fetch
                expect(server.requests).toHaveLength(2)
                const edited = yield* client.messages.edit(first, { content: "native" })
                expect(edited.content).toBe("native")
                expect(Object.isFrozen(edited.author)).toBe(true)
                expect(yield* client.messages.delete(edited)).toBeUndefined()
                let targetReads = 0
                const changingTarget = {
                    channelId: "20",
                    get id() {
                        return ++targetReads === 1 ? "10" : "11"
                    },
                }
                expect(yield* client.messages.delete(changingTarget)).toBeUndefined()
                expect(targetReads).toBe(1)
                expect(server.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/channels/20/messages/10" })
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
    const client = defaultApi({ token })
    expect(
        (
            await settle(
                client.messages.edit(target, {
                    content: "",
                    allowedMentions: { users: ["30"], roles: ["40"], everyone: true, repliedUser: true },
                }),
            )
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
    const client = defaultApi({ token })
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
        const client = defaultApi({ token })
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

test("fetch and edit reject malformed or mismatched snapshots; delete requires 204", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
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
    const clock = sdkClock()
    const server = await fixture(clock.now)
    const client = defaultApi({ token })
    server.control.respond = (response, body, method) => {
        if (method === "PATCH" && server.requests.filter((r) => r.method === "PATCH").length === 1) {
            response.writeHead(429).end(JSON.stringify({ retry_after: 0.25 }))
        } else response.end(JSON.stringify(wire(body?.content)))
    }
    const edit = client.messages.edit(target, { content: "stable" })
    await clock.waiting(250)
    await settle(client.messages.fetch(target))
    expect(server.requests.map((r) => r.method)).toEqual(["PATCH", "GET"])
    await clock.advance(250)
    await settle(edit)
    expect(server.requests.map((r) => r.method)).toEqual(["PATCH", "GET", "PATCH"])
    expect(server.requests[2]!.at - server.requests[0]!.at).toBe(250)
    expect(server.requests[2]!.body).toEqual(server.requests[0]!.body)
    server.control.respond = (response) => {
        response.setHeader("x-ratelimit-remaining", "0")
        response.setHeader("x-ratelimit-reset-after", "0.2")
        response.end(JSON.stringify(wire()))
    }
    await settle(client.messages.fetch(target))
    const refused = await client.messages.fetch({ ...target, id: "11" }, { timeoutMs: 30 })
    expect(refused.isErr() && refused.error).toMatchObject({
        reason: "rateLimit",
        outcome: "notDispatched",
        retryAfterMs: 200,
    })
    expect(server.requests).toHaveLength(4)
})

test("native interruption cancels only its request and permits subsequent work", async () => {
    const server = await fixture()
    server.control.respond = () => {}
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token })
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
