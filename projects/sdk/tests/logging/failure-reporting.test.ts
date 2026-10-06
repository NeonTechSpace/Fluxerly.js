import { setImmediate as turn } from "node:timers/promises"
import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Client, FailureReport } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { modes, setup, type Mode } from "../support/both-apis.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs, counters } from "../support/log-capture.js"
import { settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type AnyClient = Client | NativeClient

async function connected(mode: Mode, options: Parameters<typeof setup>[1] = {}) {
    const server = await startGatewayServer()
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const client = (await setup(mode, options)) as AnyClient
    const registration = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(registration, Exit.void)))
    await settle(client.connect())
    return { server, client, registration }
}

/** Register a typingStart handler that throws the value chosen by the event's timestamp, with an optional hook */
async function failingHandler(
    mode: Mode,
    client: AnyClient,
    registration: Scope.Scope,
    thrown: (timestamp: number) => unknown,
    hook?: {
        readonly default: (report: FailureReport) => unknown
        readonly native: (report: FailureReport) => Effect.Effect<unknown>
    },
    handled?: number[],
) {
    if (mode === "default")
        await settle(
            (client as Client).on(
                "typingStart",
                (event) => {
                    handled?.push(event.timestamp)
                    throw thrown(event.timestamp)
                },
                hook ? { onError: hook.default as (report: FailureReport) => void } : {},
            ),
        )
    else
        await Effect.runPromise(
            (client as NativeClient)
                .on(
                    "typingStart",
                    (event) =>
                        Effect.sync(() => {
                            handled?.push(event.timestamp)
                            throw thrown(event.timestamp)
                        }),
                    hook ? { onError: hook.native } : {},
                )
                .pipe(Scope.provide(registration)),
        )
}

const typing = (timestamp: number) => ({ channel_id: "20", user_id: "30", timestamp })

async function shutdown(mode: Mode, client: AnyClient) {
    if (mode === "default") await settle((client as Client).shutdown())
    else await Effect.runPromise((client as NativeClient).shutdown())
}

test.each(modes)(
    "%s subscription hooks queue reports in order without holding handler slots, and shutdown does not wait for a stuck hook",
    async (mode) => {
        const logs = captureLogs()
        const { server, client, registration } = await connected(mode, { logging: { ...logs.logging, dedupe: false } })
        const calls: string[] = []
        const handled: number[] = []
        await failingHandler(
            mode,
            client,
            registration,
            (timestamp) => new Error(`fail-${timestamp}`),
            {
                // The first report's hook never finishes; the native one also ignores interruption
                default: (report) => {
                    calls.push((report.error as Error).message)
                    return new Promise(() => {})
                },
                native: (report) =>
                    Effect.sync(() => calls.push((report.error as Error).message)).pipe(
                        Effect.andThen(Effect.uninterruptible(Effect.never)),
                    ),
            },
            handled,
        )
        for (let timestamp = 1; timestamp <= 70; timestamp++) server.dispatch("TYPING_START", typing(timestamp))
        // The handler keeps running while the hook is stuck, so reporting never holds its only slot
        await vi.waitFor(() => expect(handled).toHaveLength(70))
        await vi.waitFor(() => expect(counters(client).reportsDropped).toBe(5))
        expect(calls).toEqual(["fail-1"])
        // The hook never resolves, so completed shutdown proves it was not awaited beyond bounded cleanup
        await shutdown(mode, client)
        const failures = logs.withCode("events.handlerFailed").filter((record) => record.level === "error")
        const logged = (outcome: string) =>
            failures.filter((record) => record.fields?.reportOutcome === outcome).map((record) => record.error?.message)
        expect(logged("queueFull")).toEqual(["fail-66", "fail-67", "fail-68", "fail-69", "fail-70"])
        expect(logged("interrupted")).toEqual(["fail-1"])
        // Every queued report is logged in its original order rather than dropped
        expect(logged("subscriptionClosed")).toEqual(Array.from({ length: 64 }, (_, index) => `fail-${index + 2}`))
        expect(failures).toHaveLength(70)
    },
    15_000,
)

test("a native client hook that interrupts itself logs that report and keeps delivering later ones", async () => {
    const logs = captureLogs()
    const delivered: string[] = []
    const { server, client, registration } = await connected("native", {
        logging: { ...logs.logging, dedupe: false },
        onError: (report: FailureReport) =>
            (report.error as Error).message === "fail-1"
                ? Effect.interrupt
                : Effect.sync(() => delivered.push((report.error as Error).message)),
    } as never)
    await failingHandler("native", client, registration, (timestamp) => new Error(`fail-${timestamp}`))
    for (const timestamp of [1, 2, 3]) server.dispatch("TYPING_START", typing(timestamp))
    await vi.waitFor(() => expect(delivered).toEqual(["fail-2", "fail-3"]))
    expect(logs.withCode("events.handlerFailed").filter((record) => record.level === "error")).toEqual([
        expect.objectContaining({
            level: "error",
            error: expect.objectContaining({ message: "fail-1" }),
            fields: { reportOutcome: "interrupted" },
        }),
    ])
})

/** Values that break naive String() or property access, thrown by application code */
const unusualValues = (): unknown[] => [
    Object.create(null),
    new Proxy(
        {},
        {
            get: () => {
                throw new Error("hostile get")
            },
            getPrototypeOf: () => {
                throw new Error("hostile prototype")
            },
        },
    ),
    null,
    undefined,
    Symbol("thrown symbol"),
    10n,
]

test.each(modes)("%s failures with unusual thrown values are reported and logged without escaping", async (mode) => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", onRejection)
    onTestFinished(() => void process.off("unhandledRejection", onRejection))
    const logs = captureLogs()
    const reports: FailureReport[] = []
    const described: string[] = []
    const values = unusualValues()
    const { server, client, registration } = await connected(mode, { logging: { ...logs.logging, dedupe: false } })
    // One subscription reports to a hook that describes each report, the other falls back to the Error log
    await failingHandler(mode, client, registration, (timestamp) => values[timestamp - 1], {
        default: (report) => {
            reports.push(report)
            described.push(report.describe())
        },
        native: (report) =>
            Effect.sync(() => {
                reports.push(report)
                described.push(report.describe())
            }),
    })
    await failingHandler(mode, client, registration, (timestamp) => values[timestamp - 1])
    for (let timestamp = 1; timestamp <= values.length; timestamp++) server.dispatch("TYPING_START", typing(timestamp))
    await vi.waitFor(() => expect(described).toHaveLength(values.length))
    await vi.waitFor(() =>
        expect(logs.withCode("events.handlerFailed").filter((record) => record.level === "error")).toHaveLength(
            values.length,
        ),
    )
    expect(reports.map((report) => [report.kind, report.event])).toEqual(values.map(() => ["handler", "typingStart"]))
    expect(described.every((text) => typeof text === "string" && text.length > 0)).toBe(true)
    expect(counters(client).sinkFailures).toBe(0)
    await turn()
    expect(rejections).toEqual([])
})

test.each(modes)("%s collector filter and callback failures reach onError with message IDs", async (mode) => {
    const reports: FailureReport[] = []
    const onError =
        mode === "default"
            ? (report: FailureReport) => void reports.push(report)
            : (report: FailureReport) => Effect.sync(() => void reports.push(report))
    const { server, client, registration } = await connected(mode, { onError } as never)
    const filterFailure = new Error("filter detail")
    const callbackFailure = new Error("callback detail")
    const filter = () => {
        throw filterFailure
    }
    let filtered: Promise<unknown>
    let called: Promise<unknown>
    if (mode === "default") {
        const api = client as Client
        const first = await settle(api.messages.collect("20", { filter, maxMessages: 1 }))
        const second = await settle(
            api.messages.collect("21", {
                maxMessages: 1,
                onMessage: () => {
                    throw callbackFailure
                },
            }),
        )
        filtered = (async () => first.result())()
        called = (async () => second.result())()
    } else {
        const api = client as NativeClient
        const first = await Effect.runPromise(
            api.messages.collect("20", { filter, maxMessages: 1 }).pipe(Scope.provide(registration)),
        )
        const second = await Effect.runPromise(
            api.messages
                .collect("21", { maxMessages: 1, onMessage: () => Effect.fail(callbackFailure) })
                .pipe(Scope.provide(registration)),
        )
        filtered = Effect.runPromise(Effect.exit(first.result()))
        called = Effect.runPromise(Effect.exit(second.result()))
    }
    const message = (id: string, channel: string) => ({
        id,
        channel_id: channel,
        guild_id: "40",
        content: "private content",
        author: { id: "30", username: "fixture" },
    })
    server.dispatch("MESSAGE_CREATE", message("10", "20"))
    server.dispatch("MESSAGE_CREATE", message("11", "21"))
    await vi.waitFor(() => expect(reports).toHaveLength(2))
    await Promise.all([filtered, called])
    const byKind = Object.fromEntries(reports.map((report) => [report.kind, report]))
    expect(byKind.filter).toMatchObject({
        error: filterFailure,
        message: { id: "10", channelId: "20", guildId: "40" },
    })
    expect(byKind.collector).toMatchObject({
        error: callbackFailure,
        message: { id: "11", channelId: "21", guildId: "40" },
    })
    expect(JSON.stringify(reports.map((report) => report.describe()))).not.toContain("private content")
})
