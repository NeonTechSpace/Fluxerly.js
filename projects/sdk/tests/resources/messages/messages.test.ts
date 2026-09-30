import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { SdkDefect, type DefaultMessageOperationOptions, type ReplyInput } from "../../../src/index.js"
import { createClient as createNative } from "../../../src/effect.js"
import { defaultApi } from "../../support/both-apis.js"
import { sdkClock } from "../../support/client-clock.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { startRestServer } from "../../support/rest-server.js"
import { expectErr, settle } from "../../support/settle.js"

// The first test checks this exact Authorization credential, so clients receive it explicitly
const token = "fixture-only-not-a-credential"
const realFetch = globalThis.fetch
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})
const wire = (id = "10", content = "!ping") => ({
    id,
    channel_id: "20",
    content,
    author: { id: "30", username: "fixture", bot: false },
})

/** Await a default operation that must reject, and return the rejection */
async function rejection(operation: unknown): Promise<unknown> {
    try {
        await operation
    } catch (error) {
        return error
    }
    return expect.fail("Expected the operation to reject")
}

/** A loopback REST server for message sends, reached through the SDK's hosted API address */
async function fixture() {
    const requests: Record<string, any>[] = []
    const fetched: { readonly url: string; readonly redirect: RequestRedirect | undefined }[] = []
    const control = {
        status: 200,
        retryAfter: 0.02,
        global: false,
        malformed: false,
        hold: false,
        failOnce: false,
        closed: 0,
    }
    const rest = await startRestServer({
        fallback: (request, response) => {
            const parsed = request.body as Record<string, any>
            requests.push(parsed)
            response.on("close", () => control.closed++)
            // A held response stays open until the SDK aborts it or the test server closes
            if (control.hold) return
            response.setHeader("Content-Type", "application/json")
            const status = parsed.message_reference?.message_id === "404" ? 404 : control.status
            response.writeHead(status)
            if (status === 429) {
                response.end(JSON.stringify({ retry_after: control.retryAfter, global: control.global }))
                if (control.failOnce) control.status = 200
            } else response.end(control.malformed ? "{}" : JSON.stringify(wire("99", parsed.content)))
        },
    })
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => {
        fetched.push({ url, redirect: init.redirect })
        return realFetch(url.replace("https://api.fluxer.app", rest.origin), init)
    })
    return { requests, fetched, rest, control }
}

test("text send and reply retain caller nonces, preserve payloads, suppress mentions and return frozen plain snapshots", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    const sent = await settle(client.messages.send("20", { content: "  hello  ", nonce: "send-correlation" }))
    expect(sent.content).toBe("  hello  ")
    expect(Object.isFrozen(sent)).toBe(true)
    expect(Object.isFrozen(sent.author)).toBe(true)
    expect("reply" in sent).toBe(false)
    await settle(
        client.messages.reply(sent, {
            content: "reply",
            nonce: 42,
            allowedMentions: { users: ["30"], repliedUser: true },
        }),
    )
    expect(server.requests[0]!.allowed_mentions).toEqual({ parse: [], users: [], roles: [], replied_user: false })
    expect(server.requests[1]!.message_reference).toEqual({ message_id: "99", channel_id: "20", type: 0 })
    expect(server.requests[0]!.nonce).toBe("send-correlation")
    expect(server.requests[1]!.nonce).toBe("42")
    expect(server.requests[1]!.allowed_mentions.replied_user).toBe(true)
    expect(await expectErr(client.messages.reply({ id: "404", channelId: "20" }, { content: "reply" }))).toMatchObject({
        _tag: "MessageError",
        reason: "rejected",
        outcome: "rejected",
        status: 404,
    })
    expect(server.requests).toHaveLength(3)
    expect(
        server.rest.requests.map((request) => [request.method, request.path, request.headers.authorization]),
    ).toEqual(Array.from({ length: 3 }, () => ["POST", "/v1/channels/20/messages", `Bot ${token}`]))
    expect(server.fetched).toEqual(
        Array.from({ length: 3 }, () => ({ url: "https://api.fluxer.app/v1/channels/20/messages", redirect: "error" })),
    )
})

test("confirmed rate limits retain a caller nonce, while server failure and malformed success never resend", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    server.control.status = 429
    server.control.failOnce = true
    await settle(client.messages.send("20", { content: "retry", nonce: "known-429" }))
    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]!.nonce).toBe("known-429")
    expect(server.requests[1]!.nonce).toBe("known-429")
    server.control.status = 500
    const rejected = await client.messages.send("20", { content: "do not repeat" })
    expect(rejected.isErr() && rejected.error._tag === "MessageError" && rejected.error.outcome).toBe("unknown")
    server.control.status = 200
    server.control.malformed = true
    const malformed = await client.messages.send("20", { content: "decode" })
    expect(malformed.isErr() && malformed.error._tag === "MessageError" && malformed.error.reason).toBe("response")
    expect(server.requests).toHaveLength(4)
})

test("send deadlines include server waits and cancellation aborts HTTP without retrying", async () => {
    // Loopback I/O cannot consume the send's budget before its 429 is classified
    sdkClock()
    const server = await fixture()
    const client = defaultApi({ token })
    server.control.status = 429
    server.control.retryAfter = 10
    const limited = await client.messages.send("20", { content: "wait" }, { timeoutMs: 100 })
    expect(limited.isErr() && limited.error._tag === "MessageError" && limited.error.reason).toBe("rateLimit")
    expect(server.requests).toHaveLength(1)
    // Another channel is not blocked by this channel's rate-limit state
    server.control.status = 200
    server.control.hold = true
    const controller = new AbortController()
    const sending = client.messages.send("21", { content: "cancel" }, { signal: controller.signal })
    await vi.waitFor(() => expect(server.requests).toHaveLength(2))
    controller.abort()
    expect(await expectErr(sending)).toMatchObject({ _tag: "CancelledError" })
    await vi.waitFor(() => expect(server.control.closed).toBe(2))
    expect(server.requests).toHaveLength(2)
})

test("invalid message inputs and options fail without network work; native sends remain lazy", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    const failures: unknown[] = []
    for (const input of [
        { content: "" },
        { content: "hi", allowedMentions: null },
        { content: "hi", messageReference: null },
        { content: "hi", nonce: "" },
        { content: "hi", nonce: "x".repeat(33) },
        { content: "hi", nonce: -1 },
        { content: "hi", nonce: Number.MAX_SAFE_INTEGER + 1 },
        { content: "hi", nonce: true },
    ]) {
        failures.push(await expectErr(client.messages.send("20", input as any)))
    }
    for (const failure of failures)
        expect(failure).toMatchObject({ _tag: "MessageError", reason: "input", outcome: "notDispatched" })
    expect(await expectErr(client.messages.send("20", { content: "hi" }, { timeoutMs: null } as any))).toMatchObject({
        _tag: "MessageError",
        reason: "input",
        outcome: "notDispatched",
    })
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const native = yield* createNative({ token })
                native.messages.send("20", { content: "not executed" })
            }),
        ),
    )
    expect(server.requests).toHaveLength(0)
})

// A throwing input or options getter is application code read by the SDK, so it is classified as an
// application.defect with the thrown value kept as the cause
test("default reply rejects an application SdkDefect that keeps the thrown value for an eager input getter", async () => {
    const client = defaultApi({ token })
    const getterFailure = new Error("fixture input getter failure")
    const error = await rejection(
        client.messages.reply(
            { id: "10", channelId: "20" },
            Object.defineProperty({}, "content", {
                get() {
                    throw getterFailure
                },
            }) as ReplyInput,
        ),
    )
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        _tag: "SdkDefect",
        code: "application.defect",
        operation: "reply",
        reasons: [{ kind: "Defect", origin: "application", defect: getterFailure }],
    })
    expect((error as SdkDefect).cause).toBe(getterFailure)
})

test("default async operations reject an application SdkDefect that keeps the thrown value for an eager signal getter", async () => {
    const client = defaultApi({ token })
    const getterFailure = new Error("fixture signal getter failure")
    const error = await rejection(
        client.messages.fetch(
            { id: "10", channelId: "20" },
            Object.defineProperty({}, "signal", {
                get() {
                    throw getterFailure
                },
            }) as DefaultMessageOperationOptions,
        ),
    )
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        _tag: "SdkDefect",
        code: "application.defect",
        operation: "fetch",
        reasons: [{ kind: "Defect", origin: "application", defect: getterFailure }],
    })
    expect((error as SdkDefect).cause).toBe(getterFailure)
})

test("default sends, edits and operation deadlines report throwing input getters as application defects", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    const failures = [
        new Error("fixture content getter"),
        new Error("fixture edit getter"),
        new Error("fixture timeout"),
    ]
    const throwing = (key: string, failure: Error) =>
        Object.defineProperty({}, key, {
            get() {
                throw failure
            },
        })
    const errors = [
        await rejection(client.messages.send("20", throwing("content", failures[0]!) as never)),
        await rejection(
            client.messages.edit({ id: "10", channelId: "20" }, throwing("content", failures[1]!) as never),
        ),
        await rejection(
            client.messages.send("20", { content: "not sent" }, throwing("timeoutMs", failures[2]!) as never),
        ),
    ]
    expect(errors.map((error) => error instanceof SdkDefect)).toEqual([true, true, true])
    expect(errors).toMatchObject(
        ["send", "edit", "send"].map((operation, index) => ({
            code: "application.defect",
            operation,
            reasons: [{ kind: "Defect", origin: "application", defect: failures[index] }],
        })),
    )
    expect(errors.map((error) => (error as SdkDefect).cause)).toEqual(failures)
    expect(server.requests).toHaveLength(0)
})

test("default sends keep an SDK fault after input validation as an sdk.defect", async () => {
    const server = await fixture()
    const client = defaultApi({ token })
    const fault = new Error("fixture SDK sizing fault")
    const byteLength = Buffer.byteLength
    // Only the admission sizing of this send's validated body faults, after every caller field was read
    vi.spyOn(Buffer, "byteLength").mockImplementation((input, encoding) => {
        if (typeof input === "string" && input.includes("sizing-fault-marker")) throw fault
        return byteLength(input, encoding)
    })
    const error = await rejection(client.messages.send("20", { content: "sizing-fault-marker" }))
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        code: "sdk.defect",
        operation: "send",
        reasons: [{ kind: "Defect", origin: "sdk", defect: fault }],
    })
    expect(server.requests).toHaveLength(0)
})

// Removing the listener runs the caller signal method, so its throw is an application fault kept beside the failure
test("default async operations keep the primary failure and the application listener cleanup defect together", async () => {
    const client = defaultApi({ token })
    const cleanupFailure = new Error("fixture listener cleanup failure")
    const listeners = new Set<() => void>()
    let removals = 0
    const error = await rejection(
        client.messages.fetch(
            { id: "invalid", channelId: "20" },
            {
                signal: {
                    aborted: false,
                    addEventListener: (_type, listener) => {
                        listeners.add(listener)
                    },
                    removeEventListener: (_type, listener) => {
                        removals++
                        listeners.delete(listener)
                        throw cleanupFailure
                    },
                },
            },
        ),
    )
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        _tag: "SdkDefect",
        code: "application.defect",
        operation: "fetch",
        reasons: [
            { kind: "Failure", failure: { _tag: "MessageOperationError", reason: "input", outcome: "notDispatched" } },
            { kind: "Defect", origin: "application", defect: cleanupFailure },
        ],
    })
    expect((error as SdkDefect).cause).toBe(cleanupFailure)
    expect(removals).toBe(1)
    expect(listeners.size).toBe(0)
})

test("a full outgoing queue rejects only new work, queued cancellation releases admission and shutdown closes active HTTP", async () => {
    const server = await fixture()
    server.control.hold = true
    const client = defaultApi({ token })
    const active = Array.from({ length: 4 }, () => client.messages.send("20", { content: "active" }))
    await vi.waitFor(() => expect(server.requests).toHaveLength(4))
    const controller = new AbortController()
    const queued = Array.from({ length: 256 }, () =>
        client.messages.send("20", { content: "queued" }, { signal: controller.signal }),
    )
    const rejected = await client.messages.send("20", { content: "rejected" })
    expect(rejected.isErr() && rejected.error._tag === "MessageError" && rejected.error.reason).toBe("busy")
    controller.abort()
    const cancelled = await Promise.all(queued)
    expect(cancelled.every((result) => result.isErr() && result.error._tag === "CancelledError")).toBe(true)
    const admitted = client.messages.send("20", { content: "newly admitted" })
    await settle(client.shutdown())
    const stopped = await Promise.all([...active, admitted])
    expect(stopped.every((result) => result.isErr() && result.error._tag === "ClientClosedError")).toBe(true)
    expect(server.requests).toHaveLength(4)
    await vi.waitFor(() => expect(server.control.closed).toBe(4))
})

test("outgoing byte budget applies independently of request count and queued deadlines release their entries", async () => {
    const clock = sdkClock()
    const server = await fixture()
    server.control.hold = true
    const client = defaultApi({ token })
    const active = Array.from({ length: 4 }, () => client.messages.send("20", { content: "active" }))
    await vi.waitFor(() => expect(server.requests).toHaveLength(4))
    const large = client.messages.send("20", { content: "x".repeat(3 * 1024 * 1024) }, { timeoutMs: 150 })
    const rejected = await client.messages.send("20", { content: "y".repeat(2 * 1024 * 1024) })
    expect(rejected.isErr() && rejected.error._tag === "MessageError" && rejected.error.reason).toBe("busy")
    await clock.waiting(150)
    await clock.advance(150)
    const expired = await large
    expect(expired.isErr() && expired.error._tag === "MessageError" && expired.error.outcome).toBe("notDispatched")
    await settle(client.shutdown())
    await Promise.all(active)
    expect(server.requests).toHaveLength(4)
})
