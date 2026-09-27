import { err, errAsync, ok, type Result } from "neverthrow"
import { afterEach, expect, test, vi } from "vitest"
import { CollectorError, type Client, type FailureReport } from "../../src/index.js"
import { defaultApi, type FixtureClientOptions } from "../support/both-apis.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs, counters } from "../support/log-capture.js"
import { settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

// Err results returned by application callbacks are a default-API contract; native callbacks fail their Effect instead

async function connected(options: FixtureClientOptions = {}) {
    const server = await startGatewayServer()
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const client: Client = defaultApi(options)
    await settle(client.connect())
    return { server, client }
}

const typing = (timestamp: number) => ({ channel_id: "20", user_id: "30", timestamp })
const message = (id: string) => ({
    id,
    channel_id: "20",
    guild_id: "40",
    content: "fixture",
    author: { id: "30", username: "fixture" },
})

/** Ways a handler can hand back an Err result: returned directly, as a ResultAsync, or resolved by a promise */
const errForms: ReadonlyArray<{ readonly name: string; readonly make: (error: Error) => unknown }> = [
    { name: "a returned Err", make: (error) => err(error) },
    { name: "a returned ResultAsync Err", make: (error) => errAsync(error) },
    { name: "a promise resolving to Err", make: (error) => Promise.resolve(err(error)) },
]

test.each(errForms)("client.on reports $name like a thrown error of result.error", async ({ make }) => {
    const reports: FailureReport[] = []
    const { server, client } = await connected()
    const failure = new Error("handler Err")
    const handled: number[] = []
    const subscription = client.on(
        "typingStart",
        (event) => {
            handled.push(event.timestamp)
            // An Ok result is ignored like any other returned value
            return event.timestamp === 1 ? ok("ignored") : make(failure)
        },
        { onError: (report) => void reports.push(report) },
    )
    server.dispatch("TYPING_START", typing(1))
    server.dispatch("TYPING_START", typing(2))
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(handled).toEqual([1, 2])
    expect(reports[0]).toMatchObject({
        kind: "handler",
        event: "typingStart",
        subscriptionId: subscription.id,
        error: failure,
    })
    expect(counters(client).handlerFailures).toBe(1)
})

test("an Err returned by a subscription onError hook is treated as a failed hook", async () => {
    const logs = captureLogs()
    const { server, client } = await connected({ logging: { ...logs.logging, dedupe: false } })
    const handlerFailure = new Error("handler failure")
    const hookFailure = new Error("hook Err")
    const reports: FailureReport[] = []
    client.on(
        "typingStart",
        () => {
            throw handlerFailure
        },
        {
            onError: (report): Result<void, Error> => {
                reports.push(report)
                return err(hookFailure)
            },
        },
    )
    server.dispatch("TYPING_START", typing(1))
    await vi.waitFor(() => expect(logs.withCode("events.hookFailed")).toHaveLength(1))
    expect(reports.map((report) => report.error)).toEqual([handlerFailure])
    // Log records carry a serialized copy of the hook's error
    // The record text names the hook's own failure, not only the failure it was reporting
    expect(logs.withCode("events.hookFailed")[0]).toMatchObject({
        level: "error",
        message: expect.stringContaining(hookFailure.message),
        error: expect.objectContaining({ message: hookFailure.message }),
    })
    // The original failure is still logged in full because the hook did not handle it
    await vi.waitFor(() =>
        expect(logs.withCode("events.handlerFailed")).toEqual([
            expect.objectContaining({
                level: "error",
                error: expect.objectContaining({ message: handlerFailure.message }),
            }),
        ]),
    )
    expect(counters(client).hookFailures).toBe(1)
})

test("an Err returned by the client-level onError hook is treated as a failed hook", async () => {
    const logs = captureLogs()
    const hookFailure = new Error("client hook Err")
    const reports: FailureReport[] = []
    const { server, client } = await connected({
        logging: { ...logs.logging, dedupe: false },
        onError: (report: FailureReport) => {
            reports.push(report)
            return errAsync(hookFailure)
        },
    } as never)
    const handlerFailure = new Error("handler failure")
    client.on("typingStart", () => err(handlerFailure))
    server.dispatch("TYPING_START", typing(1))
    await vi.waitFor(() => expect(reports.map((report) => report.error)).toEqual([handlerFailure]))
    await vi.waitFor(() => expect(logs.withCode("events.hookFailed")).toHaveLength(1))
    expect(logs.withCode("events.hookFailed")[0]).toMatchObject({
        error: expect.objectContaining({ message: hookFailure.message }),
    })
    expect(counters(client).hookFailures).toBe(1)
})

test.each(errForms)(
    "a message collector onMessage returning $name fails collection with its cause",
    async ({ make }) => {
        const reports: FailureReport[] = []
        const { server, client } = await connected({
            onError: (report: FailureReport) => void reports.push(report),
        } as never)
        const failure = new Error("onMessage Err")
        const collector = client.messages.collect("20", { maxMessages: 2, onMessage: () => make(failure) })
        server.dispatch("MESSAGE_CREATE", message("10"))
        const result = await collector.result()
        expect(result.isErr()).toBe(true)
        if (result.isOk()) return
        expect(result.error).toBeInstanceOf(CollectorError)
        expect(result.error).toMatchObject({ reason: "handler" })
        expect((result.error as CollectorError).cause).toBe(failure)
        await vi.waitFor(() =>
            expect(reports).toEqual([
                expect.objectContaining({
                    kind: "collector",
                    error: failure,
                    message: expect.objectContaining({ id: "10" }),
                }),
            ]),
        )
    },
)

test("a reaction collector onReaction returning an Err fails collection with its cause", async () => {
    const { server, client } = await connected()
    const failure = new Error("onReaction Err")
    const collector = client.messages.collectReactions(
        { id: "10", channelId: "20" },
        { maxReactions: 2, onReaction: async () => err(failure) },
    )
    server.dispatch("MESSAGE_REACTION_ADD", {
        message_id: "10",
        channel_id: "20",
        user_id: "30",
        emoji: { name: "✅" },
    })
    const result = await collector.result()
    expect(result.isErr()).toBe(true)
    if (result.isOk()) return
    expect(result.error).toMatchObject({ _tag: "CollectorError", reason: "handler" })
    expect((result.error as CollectorError).cause).toBe(failure)
})

test("an Err returned by an observeState listener is reported as an observer failure without closing the client", async () => {
    const reports: FailureReport[] = []
    const failure = new Error("listener Err")
    const client: Client = defaultApi({ onError: (report: FailureReport) => void reports.push(report) } as never)
    const observer = client.observeState(() => err(failure))
    await vi.waitFor(() => expect(reports).toEqual([expect.objectContaining({ kind: "observer", error: failure })]))
    observer.close()
    expect(client.state).toBe("Disconnected")
})

test("handler and collector callbacks receive an AbortSignal that shutdown aborts", async () => {
    const { server, client } = await connected()
    const signals: AbortSignal[] = []
    const started = Promise.withResolvers<void>()
    client.on("typingStart", (_event, signal) => {
        signals.push(signal)
        started.resolve()
        return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    })
    const collectorStarted = Promise.withResolvers<void>()
    const collector = client.messages.collect("20", {
        maxMessages: 2,
        onMessage: (_message, signal) => {
            signals.push(signal)
            collectorStarted.resolve()
            return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        },
    })
    server.dispatch("TYPING_START", typing(1))
    server.dispatch("MESSAGE_CREATE", message("10"))
    await Promise.all([started.promise, collectorStarted.promise])
    expect(signals).toHaveLength(2)
    for (const signal of signals) {
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(signal.aborted).toBe(false)
    }
    await settle(client.shutdown())
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    await collector.result()
})
