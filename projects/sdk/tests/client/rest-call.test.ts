import { Effect, Fiber } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { RestRequestError, type RestRequestFailure } from "../../src/index.js"
import type { Client as DefaultClient } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { describeBothApis, setup, type Mode } from "../support/both-apis.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { rateLimitHeaders } from "../support/rest-server.js"
import { expectErr, settle } from "../support/settle.js"

const discoveryUrl = "https://fluxer.com/.well-known/fluxer"
const api = "https://fluxer.com/api/v1"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

interface Call {
    readonly url: string
    readonly method: string | undefined
    readonly headers: Record<string, string>
    readonly body: string | undefined
}

/** A client whose only network is the handler, with both typed calls and caller-described requests */
async function restClient(mode: Mode, handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("The platform fetch must not be used")))
    const calls: Call[] = []
    const client = await setup(mode, {
        transport: {
            fetch: async (url, init) => {
                if (url === discoveryUrl) return Response.json(hostedDiscoveryDocument)
                const body =
                    init.body === undefined || init.body === null
                        ? undefined
                        : typeof init.body === "string"
                          ? init.body
                          : await new Response(init.body).text()
                calls.push({ url, method: init.method, headers: { ...(init.headers as Record<string, string>) }, body })
                return handler(url, init)
            },
        },
    })
    // Erased to the runtime signature, so the rejection cases can send what the types refuse
    const call = (route: unknown, input?: unknown) =>
        mode === "default"
            ? (client as DefaultClient).rest.call(route as "GET /users/@me", input as undefined)
            : (client as NativeClient).rest.call(route as "GET /users/@me", input as undefined)
    return { client, calls, call }
}

const rejection = async (operation: Parameters<typeof expectErr>[0]) =>
    (await expectErr(operation)) as RestRequestFailure

describeBothApis("rest.call", (mode) => {
    test("fills the path template, sends the query and the JSON body as given and returns the parsed body", async () => {
        const { calls, client } = await restClient(mode, () => Response.json({ id: "30", content: "Hello" }))
        const input = {
            params: { channel_id: "20" },
            body: { content: "Hello", allowed_mentions: { parse: [] }, message_reference: null },
            auditReason: "fixture",
        } as const
        const response = await settle(
            mode === "default"
                ? (client as DefaultClient).rest.call("POST /channels/{channel_id}/messages", input)
                : (client as NativeClient).rest.call("POST /channels/{channel_id}/messages", input),
        )
        expect(response.status).toBe(200)
        expect(response.body).toEqual({ id: "30", content: "Hello" })
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ url: `${api}/channels/20/messages`, method: "POST" })
        expect(calls[0]!.headers["X-Audit-Log-Reason"]).toBe("fixture")
        // Fluxer's field names reach the server unchanged, including an explicit null
        expect(JSON.parse(calls[0]!.body!)).toEqual(input.body)
    })

    test("sends a numeric query value as text and an array once per item, in order", async () => {
        const { calls, client } = await restClient(mode, () => Response.json({ threads: [] }))
        const input = {
            params: { channel_id: 20 },
            query: { tag: ["101", "102"], archived: false, limit: 5, name: undefined },
        } as const
        await settle(
            mode === "default"
                ? (client as DefaultClient).rest.call("GET /channels/{channel_id}/threads/search", input)
                : (client as NativeClient).rest.call("GET /channels/{channel_id}/threads/search", input),
        )
        expect(calls.map((item) => item.url)).toEqual([
            `${api}/channels/20/threads/search?tag=101&tag=102&archived=false&limit=5`,
        ])
    })

    test("percent-encodes each path parameter as one segment and resolves a body-less answer with undefined", async () => {
        const { calls, call } = await restClient(mode, () => new Response(null, { status: 204 }))
        const response = await settle(
            call("PUT /channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me", {
                params: { channel_id: "20", message_id: "30", emoji: "party:40" },
            }),
        )
        expect(response.body).toBeUndefined()
        expect(calls[0]).toMatchObject({
            url: `${api}/channels/20/messages/30/reactions/party%3A40/@me`,
            method: "PUT",
        })
    })

    test("sends a route without input and message files as multipart", async () => {
        const { calls, call } = await restClient(mode, () => Response.json({ id: "1" }))
        await settle(call("GET /users/@me"))
        await settle(
            call("POST /channels/{channel_id}/messages", {
                params: { channel_id: "20" },
                body: { content: "with file" },
                files: [{ data: new TextEncoder().encode("file-bytes"), filename: "note.txt" }],
            }),
        )
        expect(calls[0]).toMatchObject({ url: `${api}/users/@me`, method: "GET", body: undefined })
        const contentType = calls[1]!.headers["Content-Type"]!
        const form = await new Response(calls[1]!.body, { headers: { "content-type": contentType } }).formData()
        expect(JSON.parse(form.get("payload_json") as string)).toEqual({
            content: "with file",
            attachments: [{ id: 0, filename: "note.txt", flags: 0 }],
        })
    })

    const formOf = async (call: { headers: Record<string, string>; body: string | undefined }) => {
        const contentType = call.headers["Content-Type"]!
        return new Response(call.body, { headers: { "content-type": contentType } }).formData()
    }
    const file = { data: new TextEncoder().encode("file-bytes"), filename: "note.txt" }

    // Fluxer replaces an edited message's attachments with the sent list, so a kept attachment must stay in it
    test("keeps the caller's existing attachments beside new files when editing", async () => {
        const { calls, call } = await restClient(mode, () => Response.json({ id: "30" }))
        await settle(
            call("PATCH /channels/{channel_id}/messages/{message_id}", {
                params: { channel_id: "20", message_id: "30" },
                body: { content: "edited", attachments: [{ id: "900", description: "kept" }] },
                files: [file],
            }),
        )
        const form = await formOf(calls[0]!)
        expect(JSON.parse(form.get("payload_json") as string)).toEqual({
            content: "edited",
            attachments: [
                { id: "900", description: "kept" },
                { id: 0, filename: "note.txt", flags: 0 },
            ],
        })
        expect(await (form.get("files[0]") as Blob).text()).toBe("file-bytes")
    })

    test("adds a caller's title and description to the new file whose index its entry names", async () => {
        const { calls, call } = await restClient(mode, () => Response.json({ id: "30" }))
        await settle(
            call("POST /channels/{channel_id}/messages", {
                params: { channel_id: "20" },
                // The typed inline attachment entry repeats the filename, which matches the files entry
                body: { attachments: [{ id: 0, filename: "note.txt", title: "Report", description: "A chart" }] },
                files: [file],
            }),
        )
        expect(JSON.parse((await formOf(calls[0]!)).get("payload_json") as string)).toEqual({
            attachments: [{ id: 0, filename: "note.txt", flags: 0, title: "Report", description: "A chart" }],
        })
    })

    test.each([
        ["a field set in both places", [{ id: "0", description: "b" }], "body.attachments[].description"],
        ["two entries for one file", [{ id: 0 }, { id: "0" }], "body.attachments[]"],
        [
            "a filename that differs from the files entry",
            [{ id: 0, filename: "other.txt" }],
            "body.attachments[].filename",
        ],
        ["a key Fluxer's new-file entry does not take", [{ id: 0, content_type: "text/plain" }], "body.attachments[]"],
        ["an entry without an id", [{ description: "x" }], "body.attachments[]"],
    ])("refuses %s beside files before any request", async (_name, attachments, path) => {
        const { calls, call } = await restClient(mode, () => Response.json({}))
        const error = await rejection(
            call("POST /channels/{channel_id}/messages", {
                params: { channel_id: "20" },
                body: { attachments },
                files: [{ ...file, description: "a" }],
            }),
        )
        expect(error).toMatchObject({ reason: "input", outcome: "notDispatched" })
        expect((error as RestRequestError).inputValidation?.path).toBe(path)
        expect(calls).toHaveLength(0)
    })

    test("shares learned rate limits with client.rest.request for the same route", async () => {
        const { calls, client, call } = await restClient(mode, () =>
            Response.json([], {
                headers: rateLimitHeaders({ bucket: "fixture-bucket", remaining: 0, resetAfterSeconds: 60 }),
            }),
        )
        await settle(call("GET /channels/{channel_id}/messages", { params: { channel_id: "20" } }))
        const request = { method: "GET", path: "/channels/20/messages", timeoutMs: 50 } as const
        const held = await rejection(
            mode === "default"
                ? (client as DefaultClient).rest.request(request)
                : (client as NativeClient).rest.request(request),
        )
        expect(held).toMatchObject({ operation: "rest.request", reason: "rateLimit", outcome: "notDispatched" })
        expect(calls).toHaveLength(1)
    })

    test("fails a non-2xx answer with the same RestRequestError as client.rest.request", async () => {
        const { call } = await restClient(mode, () =>
            Response.json({ code: "UNKNOWN_CHANNEL", message: "provider text" }, { status: 404 }),
        )
        const error = await rejection(call("GET /channels/{channel_id}", { params: { channel_id: "20" } }))
        expect(error).toBeInstanceOf(RestRequestError)
        expect(error).toMatchObject({
            operation: "rest.request",
            reason: "notFound",
            status: 404,
            apiError: { providerCode: "UNKNOWN_CHANNEL" },
        })
    })

    test.each([
        ["a route that is not a string", 5, undefined, "route"],
        ["a route without a method", "/users/@me", undefined, "route"],
        ["a lowercase method", "get /users/@me", undefined, "route"],
        ["input that is not an object", "GET /users/@me", "x", "input"],
        ["a raw request field", "GET /users/@me", { path: "/users/@me" }, "input"],
        ["params that are not an object", "GET /channels/{channel_id}", { params: "20" }, "params"],
        ["a missing path parameter", "GET /channels/{channel_id}", { params: {} }, "params"],
        ["missing params", "GET /channels/{channel_id}", undefined, "params"],
        [
            "an extra path parameter",
            "GET /channels/{channel_id}",
            { params: { channel_id: "20", guild_id: "1" } },
            "params",
        ],
        ["an empty path parameter", "GET /channels/{channel_id}", { params: { channel_id: "" } }, "params"],
        ["a fractional path parameter", "GET /channels/{channel_id}", { params: { channel_id: 1.5 } }, "params"],
        ["an object path parameter", "GET /channels/{channel_id}", { params: { channel_id: {} } }, "params"],
        // An encoded slash would reach another route, so the shared path check refuses it
        [
            "a path parameter with a slash",
            "GET /channels/{channel_id}",
            { params: { channel_id: "20/messages" } },
            "path",
        ],
        ["a dot-dot path parameter", "GET /channels/{channel_id}", { params: { channel_id: ".." } }, "path"],
        ["a body on a read", "GET /users/@me", { body: {} }, "body"],
    ])("rejects %s before any request", async (_name, route, input, path) => {
        const { calls, call } = await restClient(mode, () => Response.json({}))
        const error = await rejection(call(route, input))
        expect(error).toBeInstanceOf(RestRequestError)
        expect(error).toMatchObject({ operation: "rest.request", reason: "input", outcome: "notDispatched" })
        expect((error as RestRequestError).inputValidation?.path).toBe(path)
        expect(calls).toHaveLength(0)
    })
})

test("default rest.call cancels through its signal", async () => {
    let entered = 0
    const { client } = await restClient("default", (_url, init) => {
        entered++
        return new Promise<Response>((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
        )
    })
    const controller = new AbortController()
    const pending = (client as DefaultClient).rest.call("GET /users/@me", { signal: controller.signal })
    await vi.waitFor(() => expect(entered).toBe(1))
    controller.abort()
    expect(await rejection(pending)).toMatchObject({ _tag: "CancelledError" })
})

test("Effect rest.call stops the HTTP exchange on interruption", async () => {
    let aborted = false
    let entered = 0
    const { client } = await restClient("native", (_url, init) => {
        entered++
        return new Promise<Response>((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => {
                aborted = true
                reject(init.signal!.reason)
            }),
        )
    })
    const fiber = Effect.runFork((client as NativeClient).rest.call("GET /users/@me"))
    await vi.waitFor(() => expect(entered).toBe(1))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(aborted).toBe(true)
})
