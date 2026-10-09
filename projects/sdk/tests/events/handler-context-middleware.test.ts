import { Context, Effect, Exit, Layer, Scope } from "effect"
import { err } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Client, FailureReport, TypingStart } from "../../src/index.js"
import type { EventContext, EventInvocation } from "../../src/events.js"
import type { Client as NativeClient, FailureReport as NativeFailureReport } from "../../src/effect.js"
import type { ClientOwner } from "../../src/internal/client.js"
import { clientServices } from "../../src/internal/client-registry.js"
import { describeBothApis, setup, type FixtureClientOptions, type Mode } from "../support/both-apis.js"
import type { ReceivedCommand } from "../support/gateway-server.js"
import { sdkClock } from "../support/client-clock.js"
import { startHostedLoopback } from "../support/instance.js"
import { counters } from "../support/log-capture.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type AnyClient = Client | NativeClient

const typing = (channelId: string): TypingStart => Object.freeze({ channelId, userId: "30", timestamp: 1 })
const typingWire = (channelId: string) => ({ channel_id: channelId, user_id: "30", timestamp: 1 })

/** Offer one decoded event as if the given shard received it in a frame of the given size */
function offer(client: AnyClient, channelId: string, bytes = 10, shardId = 0) {
    const owner = clientServices(client) as unknown as ClientOwner
    owner.events.offer("typingStart", typing(channelId), bytes, shardId)
}

/** Register a typingStart handler in either API style, recording its payload and context */
async function handle(
    mode: Mode,
    client: AnyClient,
    record: (event: TypingStart, context: EventContext) => void,
    fail?: unknown,
) {
    if (mode === "default")
        return (client as Client).on("typingStart", (event, _signal, context) => {
            record(event, context)
            if (fail !== undefined) throw fail
        })
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(
        (client as NativeClient)
            .on("typingStart", (event, context) =>
                Effect.suspend(() => {
                    record(event, context)
                    return fail === undefined ? Effect.void : Effect.fail(fail)
                }),
            )
            .pipe(Scope.provide(scope)),
    )
}

/** Register middleware built from before and after steps around next, in either API style */
async function use(
    mode: Mode,
    client: AnyClient,
    steps: {
        readonly before?: (invocation: EventInvocation) => void
        readonly after?: (invocation: EventInvocation) => void
        readonly skip?: (invocation: EventInvocation) => boolean
        readonly fail?: unknown
    },
): Promise<{ close(): Promise<void> }> {
    if (mode === "default") {
        const registration = (client as Client).use(async (invocation, next) => {
            steps.before?.(invocation)
            if (!steps.skip?.(invocation)) await next()
            steps.after?.(invocation)
            if (steps.fail !== undefined) throw steps.fail
        })
        return { close: async () => registration.close() }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const registration = await Effect.runPromise(
        (client as NativeClient)
            .use((invocation, next) =>
                Effect.gen(function* () {
                    steps.before?.(invocation)
                    if (!steps.skip?.(invocation)) yield* next
                    steps.after?.(invocation)
                    if (steps.fail !== undefined) return yield* Effect.fail(steps.fail)
                }),
            )
            .pipe(Scope.provide(scope)),
    )
    return { close: () => Effect.runPromise(registration.close()) }
}

async function reportingClient(mode: Mode) {
    const reports: (FailureReport | NativeFailureReport)[] = []
    const onError =
        mode === "default"
            ? (report: FailureReport) => void reports.push(report)
            : (report: NativeFailureReport) => Effect.sync(() => void reports.push(report))
    const client = await setup(mode, { onError } as FixtureClientOptions)
    return { client, reports }
}

describeBothApis("handler context", (mode) => {
    test("carries the receiving shard and the byte length of each received frame", async () => {
        const clock = sdkClock()
        const { gateway } = await startHostedLoopback({
            gateway: { ready: (identify: ReceivedCommand) => ({ shard: identify.d.shard }) },
        })
        const client = await setup(mode, { sharding: { totalShards: 2 } })
        const received: [string, EventContext][] = []
        await handle(mode, client, (event, context) => void received.push([event.channelId, context]))
        const connecting =
            mode === "default"
                ? (client as Client).connect().then((result) => expect(result.isOk()).toBe(true))
                : Effect.runPromise((client as NativeClient).connect())
        // The SDK starts the second shard's session one second after the first
        await clock.waiting(1_000)
        await clock.advance(1_000)
        await connecting

        const socketOf = (shardId: number) => {
            const identify = gateway.commands.find((command) => command.op === 2 && command.d.shard[0] === shardId)!
            return gateway.sockets[identify.connection]!
        }
        // Sequence numbers above READY's keep each session moving forward
        const frames = [
            { shardId: 1, frame: { op: 0, s: 50, t: "TYPING_START", d: typingWire("21") } },
            { shardId: 0, frame: { op: 0, s: 51, t: "TYPING_START", d: { ...typingWire("20"), guild_id: "4" } } },
        ]
        for (const { shardId, frame } of frames) gateway.send(frame, socketOf(shardId))
        await vi.waitFor(() => expect(received).toHaveLength(2))
        const byChannel = new Map(received)
        for (const { shardId, frame } of frames) {
            const context = byChannel.get(frame.d.channel_id)!
            expect(context).toEqual({ shardId, receivedBytes: Buffer.byteLength(JSON.stringify(frame)) })
            expect(Object.isFrozen(context)).toBe(true)
        }
    })
})

describeBothApis("event middleware", (mode) => {
    test("runs around handlers in registration order, including handlers registered earlier", async () => {
        const client = await setup(mode)
        const order: string[] = []
        const invocations: EventInvocation[] = []
        const subscription = await handle(mode, client, (event, context) =>
            order.push(`handler ${event.channelId} shard ${context.shardId}`),
        )
        await use(mode, client, {
            before: (invocation) => {
                invocations.push(invocation)
                order.push("outer before")
            },
            after: () => order.push("outer after"),
        })
        await use(mode, client, { before: () => order.push("inner before"), after: () => order.push("inner after") })
        offer(client, "20", 64, 3)
        await vi.waitFor(() => expect(order).toHaveLength(5))
        expect(order).toEqual(["outer before", "inner before", "handler 20 shard 3", "inner after", "outer after"])
        expect(invocations).toEqual([
            {
                event: "typingStart",
                payload: typing("20"),
                context: { shardId: 3, receivedBytes: 64 },
                subscriptionId: subscription.id,
            },
        ])
        expect(Object.isFrozen(invocations[0])).toBe(true)
    })

    test("skips the handler when next is not called and stops applying after close", async () => {
        const client = await setup(mode)
        const handled: string[] = []
        await handle(mode, client, (event) => void handled.push(event.channelId))
        const registration = await use(mode, client, {
            skip: (invocation) => invocation.event === "typingStart" && invocation.payload.channelId === "20",
        })
        offer(client, "20")
        offer(client, "21")
        await vi.waitFor(() => expect(handled).toEqual(["21"]))
        await registration.close()
        offer(client, "20")
        await vi.waitFor(() => expect(handled).toEqual(["21", "20"]))
    })

    test("reports middleware and handler failures like handler failures, without letting middleware hide them", async () => {
        const { client, reports } = await reportingClient(mode)
        const handlerError = new Error("handler broke")
        const middlewareError = new Error("middleware broke")
        const after: string[] = []
        const subscription = await handle(mode, client, () => undefined, handlerError)
        await use(mode, client, { after: () => after.push("ran after a failed handler"), fail: middlewareError })
        offer(client, "20")
        await vi.waitFor(() => expect(reports).toHaveLength(2))
        expect(after).toEqual(["ran after a failed handler"])
        expect(reports.map((report) => [report.kind, report.error, report.event, report.subscriptionId])).toEqual([
            ["handler", handlerError, "typingStart", subscription.id],
            ["handler", middlewareError, "typingStart", subscription.id],
        ])
        expect(counters(client).handlerFailures).toBe(2)
    })
})

test("default middleware that returns an Err result or calls next after finishing is reported", async () => {
    const { client, reports } = await reportingClient("default")
    const defaultClient = client as Client
    const handled: string[] = []
    await handle("default", client, (event) => void handled.push(event.channelId))
    const returned = new Error("middleware returned Err")
    let late: (() => Promise<void>) | undefined
    defaultClient.use((invocation, next) => {
        if (invocation.event === "typingStart" && invocation.payload.channelId === "21") {
            late = next
            return undefined
        }
        return next().then(() => err(returned))
    })
    offer(client, "20")
    offer(client, "21")
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toMatchObject({ kind: "handler", error: returned })
    await late!()
    await vi.waitFor(() => expect(reports).toHaveLength(2))
    expect(reports[1]!.error).toMatchObject({ _tag: "ConfigurationError" })
    expect(handled).toEqual(["20"])
})

test("default middleware receives the handler's cancellation signal", async () => {
    const client = (await setup("default")) as Client
    const signals: AbortSignal[] = []
    const subscription = client.on("typingStart", () => new Promise(() => undefined))
    client.use((_invocation, next, signal) => {
        signals.push(signal)
        return next()
    })
    offer(client, "20")
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    expect(signals[0]!.aborted).toBe(false)
    subscription.close()
    expect((await subscription.waitForClose()).isOk()).toBe(true)
    expect(signals[0]!.aborted).toBe(true)
})

test("native middleware runs with its registration services while next keeps the handler's services", async () => {
    class Label extends Context.Service<Label, string>()("fixture/Label") {}
    const client = (await setup("native")) as NativeClient
    const seen: string[] = []
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    await Effect.runPromise(
        client
            .on("typingStart", () =>
                Effect.gen(function* () {
                    seen.push(`handler ${yield* Label}`)
                }),
            )
            .pipe(Effect.provide(Layer.succeed(Label, "handler services")), Scope.provide(scope)),
    )
    await Effect.runPromise(
        client
            .use((_invocation, next) =>
                Effect.gen(function* () {
                    seen.push(`middleware ${yield* Label}`)
                    yield* next
                }),
            )
            .pipe(Effect.provide(Layer.succeed(Label, "middleware services")), Scope.provide(scope)),
    )
    offer(client, "20")
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen).toEqual(["middleware middleware services", "handler handler services"])
})
