import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { RestRequestError, type DefaultRestRequest, type RestRequestFailure } from "../../src/index.js"
import { describeBothApis, setup, type FixtureClientOptions, type Mode } from "../support/both-apis.js"
import { driveSdkTime, sdkClock } from "../support/client-clock.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { captureLogs } from "../support/log-capture.js"
import { rateLimitHeaders, rateLimitedResponse } from "../support/rest-server.js"
import { expectErr, settle } from "../support/settle.js"

const discoveryUrl = "https://fluxer.app/.well-known/fluxer"
const api = "https://api.fluxer.app/v1"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

interface Call {
    readonly url: string
    readonly init: RequestInit
    readonly headers: Record<string, string>
    readonly body: string | undefined
}

/** Create a client whose only network is the given handler, behind the hosted discovery document */
async function restClient(
    mode: Mode,
    handler: (url: string, init: RequestInit, call: number) => Response | Promise<Response>,
    options: FixtureClientOptions = {},
) {
    // The platform fetch must never be reached when a transport fetch is configured
    vi.stubGlobal("fetch", () => Promise.reject(new Error("The platform fetch must not be used")))
    const calls: Call[] = []
    const client = await setup(mode, {
        ...options,
        transport: {
            fetch: async (url, init) => {
                if (url === discoveryUrl) return Response.json(hostedDiscoveryDocument)
                const body =
                    init.body === undefined || init.body === null
                        ? undefined
                        : typeof init.body === "string"
                          ? init.body
                          : await new Response(init.body).text()
                calls.push({ url, init, headers: { ...(init.headers as Record<string, string>) }, body })
                return handler(url, init, calls.length)
            },
        },
    })
    const request = <T = unknown>(input: DefaultRestRequest) =>
        mode === "default"
            ? (client as import("../../src/index.js").Client).rest.request<T>(input)
            : (client as import("../../src/effect.js").Client).rest.request<T>(input)
    return { client, calls, request }
}

const rejection = async (operation: Parameters<typeof expectErr>[0]) =>
    (await expectErr(operation)) as RestRequestFailure

describeBothApis("rest.request", (mode) => {
    test("sends an authenticated request and projects status, lower-case headers and the parsed body", async () => {
        const { calls, request } = await restClient(mode, () =>
            Response.json({ id: "30", username: "fixture" }, { headers: { "X-Fixture-Header": "kept" } }),
        )
        const response = await settle(
            request<{ id: string }>({
                method: "GET",
                path: "/users/@me",
                query: { with_mutual_guilds: true, limit: 5, skipped: undefined, name: "a b&c" },
            }),
        )
        expect(response.status).toBe(200)
        expect(response.body).toEqual({ id: "30", username: "fixture" })
        expect(response.headers["x-fixture-header"]).toBe("kept")
        expect(response.headers["content-type"]).toBe("application/json")
        expect(Object.isFrozen(response)).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.url).toBe(`${api}/users/@me?with_mutual_guilds=true&limit=5&name=a+b%26c`)
        expect(calls[0]!.init).toMatchObject({ method: "GET", redirect: "error" })
        expect(calls[0]!.headers.Authorization).toBe("Bot fixture-only-not-a-credential")
        expect(calls[0]!.body).toBeUndefined()
    })

    test("sends JSON bodies and audit reasons, and returns undefined for an empty response", async () => {
        const { calls, request } = await restClient(mode, () => new Response(null, { status: 204 }))
        const response = await settle(
            request({
                method: "PATCH",
                path: "/guilds/20/members/30",
                body: { nick: "fixture" },
                auditReason: "  fixture reason  ",
            }),
        )
        expect(response).toEqual({ status: 204, headers: {}, body: undefined })
        expect(calls[0]!.url).toBe(`${api}/guilds/20/members/30`)
        expect(calls[0]!.headers["Content-Type"]).toBe("application/json")
        expect(calls[0]!.headers["X-Audit-Log-Reason"]).toBe("fixture reason")
        expect(JSON.parse(calls[0]!.body!)).toEqual({ nick: "fixture" })
    })

    test("sends files inline as multipart with their metadata in payload_json", async () => {
        const { calls, request } = await restClient(mode, () => Response.json({ ok: true }))
        await settle(
            request({
                method: "POST",
                path: "/channels/20/messages",
                body: { content: "with file" },
                files: [{ data: new TextEncoder().encode("file-bytes"), filename: "note.txt" }],
            }),
        )
        const contentType = calls[0]!.headers["Content-Type"]!
        expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
        const form = await new Response(calls[0]!.body, { headers: { "content-type": contentType } }).formData()
        expect(JSON.parse(form.get("payload_json") as string)).toEqual({
            content: "with file",
            attachments: [{ id: 0, filename: "note.txt", flags: 0 }],
        })
        expect(await (form.get("files[0]") as Blob).text()).toBe("file-bytes")
    })

    test.each([
        ["not an object", "x", "input"],
        ["unknown field", { method: "GET", path: "/users/@me", headers: {} }, "input"],
        ["unsupported method", { method: "HEAD", path: "/users/@me" }, "method"],
        ["absolute URL", { method: "GET", path: "https://evil.example/users/@me" }, "path"],
        ["protocol-relative host", { method: "GET", path: "//evil.example/users" }, "path"],
        ["missing leading slash", { method: "GET", path: "users/@me" }, "path"],
        ["backslash", { method: "GET", path: "/users\\@me" }, "path"],
        ["parent segment", { method: "GET", path: "/channels/../users/@me" }, "path"],
        ["encoded parent segment", { method: "GET", path: "/channels/%2E%2e/users/@me" }, "path"],
        ["encoded slash", { method: "GET", path: "/channels/1%2F2" }, "path"],
        ["empty segment", { method: "GET", path: "/users//@me" }, "path"],
        ["query in path", { method: "GET", path: "/users/@me?limit=1" }, "path"],
        ["fragment in path", { method: "GET", path: "/users/@me#x" }, "path"],
        ["invalid escape", { method: "GET", path: "/users/%zz" }, "path"],
        ["version prefix", { method: "GET", path: "/v1/users/@me" }, "path"],
        ["encoded version prefix", { method: "GET", path: "/%761/users/@me" }, "path"],
        ["encoded webhook route", { method: "POST", path: "/%77ebhooks/10/secret-token-value" }, "path"],
        ["encoded webhook suffix", { method: "GET", path: "/webhook%73/10/secret-token-value/messages/20" }, "path"],
        ["overlong path", { method: "GET", path: `/${"a".repeat(2048)}` }, "path"],
        ["webhook token route", { method: "POST", path: "/webhooks/10/secret-token-value" }, "path"],
        ["non-finite query number", { method: "GET", path: "/users/@me", query: { limit: Number.NaN } }, "query"],
        ["object query value", { method: "GET", path: "/users/@me", query: { limit: {} } }, "query"],
        ["GET body", { method: "GET", path: "/users/@me", body: {} }, "body"],
        ["unserializable body", { method: "POST", path: "/users/@me", body: { value: 1n } }, "body"],
        ["files with array body", { method: "POST", path: "/channels/20/messages", body: [], files: [] }, undefined],
        [
            "files with attachments in body",
            {
                method: "POST",
                path: "/channels/20/messages",
                body: { attachments: [] },
                files: [{ data: new Uint8Array(1), filename: "a.txt" }],
            },
            "body",
        ],
        ["invalid file", { method: "POST", path: "/channels/20/messages", files: [{ filename: "a" }] }, "files[]"],
        [
            "audit reason with control character",
            { method: "DELETE", path: "/guilds/20", auditReason: "a\nb" },
            "auditReason",
        ],
        ["zero timeout", { method: "GET", path: "/users/@me", timeoutMs: 0 }, "timeoutMs"],
    ])("rejects %s before any request", async (_name, input, path) => {
        const { calls, request } = await restClient(mode, () => Response.json({}))
        if (path === undefined) {
            // An empty file list means no files, so an array body stays a valid JSON body
            await settle(request(input as DefaultRestRequest))
            return
        }
        const error = await rejection(request(input as DefaultRestRequest))
        expect(error).toBeInstanceOf(RestRequestError)
        expect(error).toMatchObject({ operation: "rest.request", reason: "input", outcome: "notDispatched" })
        expect((error as RestRequestError).inputValidation?.path).toBe(path)
        expect(calls).toHaveLength(0)
        // The explanation is SDK text, never the rejected value
        expect(JSON.stringify(error)).not.toContain("secret-token-value")
        expect(JSON.stringify(error)).not.toContain("evil.example")
    })

    test("logs only a masked route template for caller paths", async () => {
        const logs = captureLogs()
        const secret = "AbCdEf0123456789Secret"
        const { request } = await restClient(mode, () => Response.json({ code: secret }), {
            logging: { ...logs.logging, level: "debug" },
        })
        await settle(request({ method: "GET", path: `/gifts/${secret}`, query: { code: secret } }))
        await settle(request({ method: "GET", path: "/invites/hidden-invite/details" }))
        const records = logs.withCode("rest.request")
        expect(records.map((record) => record.route)).toEqual(["/gifts/:value", "/invites/:code/details"])
        expect(JSON.stringify(logs.records)).not.toContain(secret)
        expect(JSON.stringify(logs.records)).not.toContain("hidden-invite")
    })

    test("maps non-2xx responses to sanitized failures with their status", async () => {
        const { calls, request } = await restClient(mode, (url) =>
            url.endsWith("/missing")
                ? Response.json({ code: "UNKNOWN_CHANNEL", message: "provider text" }, { status: 404 })
                : Response.json({ code: "MISSING_PERMISSIONS", message: "provider text" }, { status: 403 }),
        )
        const forbidden = await rejection(request({ method: "POST", path: "/channels/20/forbidden", body: {} }))
        expect(forbidden).toMatchObject({
            _tag: "RestRequestError",
            reason: "rejected",
            outcome: "rejected",
            status: 403,
            apiError: { providerCode: "MISSING_PERMISSIONS" },
        })
        expect(JSON.stringify(forbidden)).not.toContain("provider text")
        const missing = await rejection(request({ method: "GET", path: "/channels/20/missing" }))
        expect(missing).toMatchObject({
            reason: "notFound",
            status: 404,
            apiError: { providerCode: "UNKNOWN_CHANNEL" },
        })
        expect(calls).toHaveLength(2)
    })

    test("fails with reason response for a success body that is not JSON, without a shape Warn", async () => {
        const logs = captureLogs()
        const { request } = await restClient(mode, () => new Response("not json", { status: 200 }), {
            logging: logs.logging,
        })
        expect(await rejection(request({ method: "GET", path: "/users/@me" }))).toMatchObject({
            reason: "response",
            status: 200,
        })
        // The caller chose the route, so the SDK has no expected shape to report a Fluxer change against
        expect(logs.withCode("rest.responseRejected")).toEqual([])
    })

    test("never repeats a write with an uncertain outcome but retries reads within the bounded policy", async () => {
        const clock = sdkClock()
        const { calls, request } = await restClient(mode, (url) =>
            url.endsWith("/network")
                ? Promise.reject(new TypeError("socket reset"))
                : new Response(null, { status: 503 }),
        )
        expect(await rejection(request({ method: "POST", path: "/channels/20/network", body: {} }))).toMatchObject({
            reason: "network",
            outcome: "unknown",
        })
        expect(await rejection(request({ method: "PUT", path: "/channels/20/unavailable" }))).toMatchObject({
            reason: "rejected",
            status: 503,
            outcome: "unknown",
        })
        expect(calls.map((call) => call.init.method)).toEqual(["POST", "PUT"])
        const read = await driveSdkTime(clock, rejection(request({ method: "GET", path: "/channels/20/network" })))
        expect(read).toMatchObject({ reason: "network", outcome: "unknown" })
        expect(calls.map((call) => call.init.method)).toEqual(["POST", "PUT", "GET", "GET", "GET"])
    })

    // A connection lost mid-body was reported as an unusable response with a cleanup defect, so reads were never retried
    test("treats a connection lost while the body arrives as a network failure, retrying only a read", async () => {
        const dropped = () =>
            new Response(
                new ReadableStream({
                    start: (controller) => controller.enqueue(new TextEncoder().encode('{"id":')),
                    pull: (controller) =>
                        controller.error(Object.assign(new Error("socket reset"), { code: "ECONNRESET" })),
                }),
            )
        const clock = sdkClock()
        const { calls, request } = await restClient(mode, (_url, init, call) =>
            init.method === "GET" && call === 2 ? Response.json({ id: "30" }) : dropped(),
        )
        expect((await driveSdkTime(clock, settle(request({ method: "GET", path: "/users/@me" })))).body).toEqual({
            id: "30",
        })
        expect(await rejection(request({ method: "POST", path: "/channels/20/custom", body: {} }))).toMatchObject({
            reason: "network",
            outcome: "unknown",
            cause: { name: "TransportError", code: "ECONNRESET" },
        })
        expect(calls.map((call) => call.init.method)).toEqual(["GET", "GET", "POST"])
    })

    test("waits out a confirmed 429 and sends the write again", async () => {
        const clock = sdkClock()
        const logs = captureLogs()
        const { calls, request } = await restClient(
            mode,
            (_url, _init, call) =>
                call === 1 ? rateLimitedResponse({ retryAfterSeconds: 0.02 }) : Response.json({ id: "1" }),
            { logging: { ...logs.logging, level: "debug" } },
        )
        const pending = settle(request({ method: "POST", path: "/channels/20/messages", body: { content: "x" } }))
        await clock.waiting(20)
        // The write is held for the whole required wait, so it is not sent again early
        await clock.advance(19)
        expect(calls).toHaveLength(1)
        await clock.advance(1)
        const response = await pending
        expect(response.body).toEqual({ id: "1" })
        expect(calls).toHaveLength(2)
        expect(calls[1]!.body).toBe(calls[0]!.body)
        expect(logs.withCode("ratelimit.wait")[0]).toMatchObject({ route: "/channels/:id/messages", status: 429 })
    })

    test("learns a rate-limit bucket and refuses later requests to the route that cannot wait for its reset", async () => {
        const { calls, request } = await restClient(mode, () =>
            Response.json(
                {},
                { headers: rateLimitHeaders({ bucket: "fixture-bucket", remaining: 0, resetAfterSeconds: 60 }) },
            ),
        )
        await settle(request({ method: "GET", path: "/channels/20/custom" }))
        const held = await rejection(request({ method: "GET", path: "/channels/20/custom", timeoutMs: 50 }))
        expect(held).toMatchObject({ reason: "rateLimit", outcome: "notDispatched" })
        expect((held as RestRequestError).retryAfterMs).toBeGreaterThan(50)
        // Another channel is a different resource, so it is not held
        await settle(request({ method: "GET", path: "/channels/21/custom" }))
        expect(calls.map((call) => call.url)).toEqual([`${api}/channels/20/custom`, `${api}/channels/21/custom`])
    })

    test("fails without waiting when the required 429 wait passes the deadline", async () => {
        const { calls, request } = await restClient(mode, () => rateLimitedResponse({ retryAfterSeconds: 60 }))
        expect(
            await rejection(request({ method: "DELETE", path: "/channels/20/custom", timeoutMs: 1_000 })),
        ).toMatchObject({ reason: "rateLimit", outcome: "rejected", status: 429, retryAfterMs: 60_000 })
        expect(calls).toHaveLength(1)
    })

    test("fails with ClientClosedError after shutdown", async () => {
        const { client, calls, request } = await restClient(mode, () => Response.json({}))
        if (mode === "default") await (client as import("../../src/index.js").Client).shutdown()
        else await Effect.runPromise((client as import("../../src/effect.js").Client).shutdown())
        expect(await rejection(request({ method: "GET", path: "/users/@me" }))).toMatchObject({
            _tag: "ClientClosedError",
        })
        expect(calls).toHaveLength(0)
    })
})

test("default rest.request cancels through its signal", async () => {
    let entered = 0
    const { request } = await restClient("default", (_url, init) => {
        entered++
        return new Promise<Response>((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
        )
    })
    const controller = new AbortController()
    const pending = request({ method: "GET", path: "/users/@me", signal: controller.signal })
    // Abort while the request is in flight, so cancellation must reach the dispatched transport call
    await vi.waitFor(() => expect(entered).toBe(1))
    controller.abort()
    expect(await rejection(pending)).toMatchObject({ _tag: "CancelledError" })
})
