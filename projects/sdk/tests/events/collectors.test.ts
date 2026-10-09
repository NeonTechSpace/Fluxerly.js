import { getEventListeners } from "node:events"
import { Session } from "node:inspector"
import { setImmediate as turn } from "node:timers/promises"
import { runInNewContext } from "node:vm"
import { Cause, Clock, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    createClient,
    SdkDefect,
    type CollectorResult,
    type DefaultCollectorOptions,
    type Message,
} from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { modes, type Mode } from "../support/both-apis.js"
import { sdkClock } from "../support/client-clock.js"
import { startHostedLoopback } from "../support/instance.js"
import { sendJson } from "../support/rest-server.js"
import { settle } from "../support/settle.js"
import { ownedResources } from "../support/owned-resources.js"
import { wsTarget } from "../support/ws-redirect.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

const wire = (id: string, channel = "20", content = id) => ({
    id,
    channel_id: channel,
    content,
    author: { id: "30", username: "fixture", bot: true },
})
const metadataWire = (id: string, channel = "20", content = id) => ({
    ...wire(id, channel, content),
    timestamp: "2026-09-09T12:00:00.000Z",
    edited_timestamp: null,
    type: 19,
    flags: 4,
    guild_id: "40",
    mentions: [{ id: "31", username: "mentioned" }],
    mention_roles: ["50"],
    mention_channels: null,
    reactions: [{ emoji: { id: null, name: "👍", animated: null }, count: 2, me: null }],
    message_reference: { message_id: "70", channel_id: "71", guild_id: null, type: 1 },
    referenced_message: {
        id: "70",
        channel_id: "71",
        content: "reply context",
        author: { id: "32", username: "reply-author" },
    },
})
const projection = (id: string, content = id) => ({
    id,
    channelId: "20",
    content,
    embeds: [],
    attachments: [],
    stickers: [],
    author: { id: "30", username: "fixture", isBot: true },
})
const metadataProjection = (id: string, content = id) => ({
    ...projection(id, content),
    createdAt: "2026-09-09T12:00:00.000Z",
    editedAt: null,
    type: 19,
    flags: 4,
    guildId: "40",
    mentions: [{ id: "31", username: "mentioned", isBot: false }],
    mentionRoleIds: ["50"],
    mentionChannels: null,
    reactions: [{ emoji: { id: null, name: "👍", animated: null }, count: 2, me: null }],
    messageReference: { id: "70", channelId: "71", guildId: null, type: 1 },
    referencedMessage: {
        id: "70",
        channelId: "71",
        content: "reply context",
        embeds: [],
        attachments: [],
        stickers: [],
        author: { id: "32", username: "reply-author", isBot: false },
    },
})
function outcome<A, E>(exit: Exit.Exit<A, E>): A | E | "Interrupted" {
    if (Exit.isSuccess(exit)) return exit.value
    if (Cause.hasDies(exit.cause)) throw new Error("Unexpected native defect", { cause: exit.cause })
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    return failure?._tag === "Fail" ? failure.error : "Interrupted"
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function fixture() {
    const { rest, gateway } = await startHostedLoopback({
        // Sends echo their content and history reads return one message, so any REST read reaches a collector visibly
        fallback: (request, response) => {
            const message = wire("900", "20", (request.body as { content?: string } | undefined)?.content ?? "history")
            sendJson(response, request.query.size > 0 ? [message] : message)
        },
        gateway: { heartbeatIntervalMs: 600_000 },
    })
    // READY takes sequence 1 and each later dispatch takes the next number, mirroring the gateway fixture's counter
    let sequence = 1
    return {
        requests: rest.requests,
        prepare(body: unknown) {
            const bytes = Buffer.byteLength(JSON.stringify({ op: 0, s: ++sequence, t: "MESSAGE_CREATE", d: body }))
            return {
                bytes,
                deliver() {
                    let delivered = 0
                    wsTarget.sockets.at(-1)!.prependOnceListener("message", (data: Buffer) => {
                        delivered = data.length
                    })
                    gateway.deliverNow("MESSAGE_CREATE", body)
                    // A drifted sequence mirror would change the digit count, so confirm the frame size actually delivered
                    expect(delivered).toBe(bytes)
                },
            }
        },
        send(body: unknown, event = "MESSAGE_CREATE") {
            sequence++
            gateway.dispatch(event, body)
        },
        // Controlled transport delivery makes same-turn queue/race boundaries deterministic; normal cases use loopback I/O above
        deliver(body: unknown, event = "MESSAGE_CREATE") {
            sequence++
            gateway.deliverNow(event, body)
        },
        gap() {
            gateway.closeCurrent(4000)
        },
    }
}

async function driver(mode: Mode, connected = true, cache = true) {
    const clientScope = Scope.makeUnsafe()
    const collectorScope = Scope.makeUnsafe()
    const defaultApi =
        mode === "default"
            ? createClient({ token: "fixture-only-not-a-credential", cache: { messages: cache } })
            : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  createNative({ token: "fixture-only-not-a-credential", cache: { messages: cache } }).pipe(
                      Scope.provide(clientScope),
                  ),
              )
            : undefined
    const shutdown = async () => {
        if (defaultApi) await settle(defaultApi.shutdown())
        else await Effect.runPromise(native!.shutdown())
    }
    onTestFinished(async () => {
        await shutdown()
        await Effect.runPromise(Scope.close(collectorScope, Exit.void))
        await Effect.runPromise(Scope.close(clientScope, Exit.void))
    })
    const connect = async () => {
        if (defaultApi) await settle(defaultApi.connect())
        else await Effect.runPromise(native!.connect())
    }
    if (connected) await connect()
    return {
        defaultApi,
        native,
        collectorScope,
        connect,
        shutdown,
        state: () => (defaultApi ?? native)!.state,
        async open(options?: Omit<DefaultCollectorOptions, "onMessage">, channelId = "20") {
            if (defaultApi) {
                const collector = defaultApi.messages.collect(channelId, options)
                return {
                    close: async () => collector.close(),
                    wait: async (signal?: AbortSignal) => {
                        const result = await collector.result(signal ? { signal } : undefined)
                        return result.isErr() ? result.error : result.value
                    },
                }
            }
            const exit = await Effect.runPromiseExit(
                native!.messages.collect(channelId, options).pipe(Scope.provide(collectorScope)),
            )
            if (Exit.isFailure(exit)) {
                // Registration misuse is a defect in the native API, so surface the ConfigurationError or ClientClosedError it carries
                const misuse = exit.cause.reasons.find((reason) => reason._tag === "Die")
                throw misuse?._tag === "Die" ? misuse.defect : outcome(exit)
            }
            const collector = exit.value
            return {
                close: () => Effect.runPromise(collector.close()),
                wait: (signal?: AbortSignal) =>
                    Effect.runPromiseExit(collector.result(), signal ? { signal } : undefined).then(outcome),
            }
        },
        async send() {
            if (defaultApi) return settle(defaultApi.messages.send("20", { content: "prompt" }))
            return Effect.runPromise(native!.messages.send("20", { content: "prompt" }))
        },
    }
}

test.each(modes)("%s registration validates locally and never implicitly connects", async (mode) => {
    const server = await fixture()
    const api = await driver(mode, false)
    // A gateway that is not ready is a runtime outcome, read through the returned handle
    await expect((await api.open()).wait()).resolves.toMatchObject({ _tag: "CollectorError", reason: "notConnected" })
    for (const options of [
        null,
        { maxMessages: 0 },
        { maxMessages: 1.5 },
        { maxBytes: Infinity },
        { timeoutMs: 2_147_483_648 },
        { timeoutMs: -1 },
        { maxPendingMessages: NaN },
        { maxPendingBytes: "20" },
        { filter: 1 },
        { unknown: true },
    ])
        await expect(api.open(options as any)).rejects.toMatchObject({ _tag: "ConfigurationError" })
    for (const idleMs of [0, -1, 1.5, NaN, Infinity, "1", null, 2_147_483_648])
        await expect(api.open({ idleMs } as any)).rejects.toMatchObject({
            _tag: "ConfigurationError",
            field: "idleMs",
        })
    await expect((await api.open({ idleMs: 2_147_483_647 })).wait()).resolves.toMatchObject({ reason: "notConnected" })
    await expect(api.open({}, "not-an-id")).rejects.toMatchObject({ _tag: "ConfigurationError", field: "channelId" })
    expect(server.requests).toEqual([])
    await api.shutdown()
    // Shutdown can race a registering handler, so a closed client returns a handle whose result is ClientClosedError,
    // while invalid options stay misuse
    await expect((await api.open()).wait()).resolves.toMatchObject({ _tag: "ClientClosedError" })
    await expect(api.open({ maxMessages: 0 })).rejects.toMatchObject({ _tag: "ConfigurationError" })
})

test.each(modes)(
    "%s registers before send, ignores REST/cache history and collects matching new bot messages",
    async (mode) => {
        const server = await fixture()
        const api = await driver(mode)
        const calls: string[] = []
        server.deliver(wire("9"))
        const collector = await api.open({
            maxMessages: 2,
            filter: (message) => {
                calls.push(message.id)
                return message.content === "answer"
            },
        })
        await api.send()
        server.send(wire("10", "21", "answer"))
        server.send(wire("11", "20", "ignored"))
        server.send(wire("12", "20", "answer"))
        server.send(wire("12", "20", "edited duplicate"))
        server.send(wire("12", "20", "updated"), "MESSAGE_UPDATE")
        server.send({ id: "12", channel_id: "20" }, "MESSAGE_DELETE")
        server.send(wire("13", "20", "answer"))
        const result = (await collector.wait()) as CollectorResult
        expect(result).toEqual({ reason: "limit", messages: [projection("12", "answer"), projection("13", "answer")] })
        expect(calls).toEqual(["11", "12", "13"])
        expect(
            Object.isFrozen(result) && Object.isFrozen(result.messages) && Object.isFrozen(result.messages[0]?.author),
        ).toBe(true)
        await collector.close()
        expect(await collector.wait()).toBe(result)
        expect(server.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
            "POST /v1/channels/20/messages",
        ])
    },
)

test.each(modes)(
    "%s collector retains frozen received metadata and counts it against the result byte budget",
    async (mode) => {
        const server = await fixture()
        const api = await driver(mode)
        const metadataBytes = Buffer.byteLength(JSON.stringify(metadataProjection("10")))
        const tooSmall = await api.open({ maxBytes: metadataBytes - 1 })
        server.send(metadataWire("10"))
        await expect(tooSmall.wait()).resolves.toMatchObject({
            _tag: "CollectorError",
            reason: "overflow",
            limit: "maxBytes",
        })

        const exact = await api.open({ maxBytes: metadataBytes })
        server.send(metadataWire("11"))
        const result = (await exact.wait()) as CollectorResult
        expect(result).toEqual({ reason: "limit", messages: [metadataProjection("11")] })
        const message = result.messages[0]!
        expect(
            Object.isFrozen(message) &&
                Object.isFrozen(message.mentions) &&
                Object.isFrozen(message.reactions) &&
                Object.isFrozen(message.reactions?.[0]?.emoji) &&
                Object.isFrozen(message.messageReference) &&
                Object.isFrozen(message.referencedMessage) &&
                Object.isFrozen(message.referencedMessage?.author),
        ).toBe(true)
    },
)

test.each(modes)(
    "%s default count is one, bots are eligible and completed filters are released from intake",
    async (mode) => {
        const server = await fixture()
        const api = await driver(mode)
        const filter = vi.fn(() => true)
        const collector = await api.open({ filter })
        server.send(wire("10"))
        expect(await collector.wait()).toEqual({ reason: "limit", messages: [projection("10")] })
        server.deliver(wire("11"))
        await turn()
        expect(filter).toHaveBeenCalledTimes(1)
        expect(api.state()).toBe("Connected")
    },
)

test.each(modes)("%s timeout returns partial replies without renewing the registration deadline", async (mode) => {
    // Sleeps wake only when the test says so, while the collector reads the manual time below
    const clock = sdkClock()
    const server = await fixture()
    const api = await driver(mode)
    let now = 0
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    const collector = await api.open({ maxMessages: 5, timeoutMs: 100 })
    now = 99
    server.deliver(wire("10"))
    await turn()
    now = 100
    server.deliver(wire("11"))
    expect(await collector.wait()).toEqual({ reason: "timeout", messages: [projection("10")] })
    const empty = await api.open({ timeoutMs: 5 })
    now += 5
    await clock.waiting(5)
    await clock.advance(5)
    expect(await empty.wait()).toEqual({ reason: "timeout", messages: [] })
})

test.each(modes)("%s rejects a filter result completed at the deadline", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    let now = 0
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    const collector = await api.open({
        timeoutMs: 100,
        filter: () => {
            now = 100
            return true
        },
    })
    server.send(wire("10"))
    expect(await collector.wait()).toEqual({ reason: "timeout", messages: [] })
})

test.each(modes)("%s idle renews only after accepting a new ID and snapshots its interval", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    let now = 0
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    const filter = vi.fn((message: Message) => message.content === "answer")
    const options = { idleMs: 100, timeoutMs: 1_000, maxMessages: 5, filter }
    const collector = await api.open(options)
    options.idleMs = 1
    now = 50
    server.deliver(wire("10", "20", "answer"))
    await turn()
    now = 149
    server.deliver(wire("10", "20", "answer"))
    server.deliver(wire("11", "20", "ignored"))
    server.deliver(wire("12", "21", "answer"))
    await turn()
    expect(filter.mock.calls.map(([message]) => message.id)).toEqual(["10", "11"])
    now = 150
    server.deliver(wire("13", "20", "answer"))
    const result = await collector.wait()
    expect(result).toEqual({ reason: "idle", messages: [projection("10", "answer")] })
    await collector.close()
    server.deliver(wire("14", "20", "answer"))
    await turn()
    expect(filter).toHaveBeenCalledTimes(2)
    expect(await collector.wait()).toBe(result)
})

test.each(modes)("%s idle timer handles empty collection and an early wakeup after renewal", async (mode) => {
    const server = await fixture()
    // The SDK clock wakes logical timers only when advanced, so no host timer decides whether the collector closed
    const clock = sdkClock()
    const api = await driver(mode)
    const empty = await api.open({ idleMs: 1 })
    await clock.advance(1)
    expect(await empty.wait()).toEqual({ reason: "idle", messages: [] })
    // Opened at 1, so the timer is armed for the original quiet deadline at 11
    const collector = await api.open({ idleMs: 10, maxMessages: 5 })
    let closed = false
    const result = collector.wait().then((value) => {
        closed = true
        return value
    })
    await clock.advance(9)
    server.deliver(wire("10"))
    await turn()
    // Accepting at 10 renews the quiet deadline to 20, so the wakeup at 11 and any time before 20 must not close
    await clock.advance(1)
    expect(closed).toBe(false)
    await clock.advance(8)
    expect(closed).toBe(false)
    await clock.advance(1)
    expect(await result).toEqual({ reason: "idle", messages: [projection("10")] })
})

test.each(modes)("%s earlier collector deadline wins overdue observations and timeout wins ties", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    let now = 0
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    for (const [idleMs, timeoutMs, reason] of [
        [50, 100, "idle"],
        [100, 50, "timeout"],
        [50, 50, "timeout"],
    ] as const) {
        const collector = await api.open({ idleMs, timeoutMs })
        now += 120
        server.deliver(wire("10"))
        expect(await collector.wait()).toEqual({ reason, messages: [] })
    }
    const collector = await api.open({ idleMs: 60, timeoutMs: 100, maxMessages: 5 })
    now += 50
    server.deliver(wire("10"))
    await turn()
    now += 49
    server.deliver(wire("11"))
    await turn()
    now += 1
    server.deliver(wire("12"))
    expect(await collector.wait()).toEqual({ reason: "timeout", messages: [projection("10"), projection("11")] })
})

test.each(modes)("%s a slow filter cannot renew an expired quiet interval", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    let now = 0
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    const collector = await api.open({
        idleMs: 50,
        filter: () => {
            now = 50
            return true
        },
    })
    server.deliver(wire("10"))
    expect(await collector.wait()).toEqual({ reason: "idle", messages: [] })
})

test.each(modes)(
    "%s stop returns partial results and preserves first completion with multiple observers",
    async (mode) => {
        const server = await fixture()
        const api = await driver(mode)
        const collector = await api.open({ maxMessages: 5 })
        const first = collector.wait()
        const second = collector.wait()
        server.deliver(wire("10"))
        await turn()
        await collector.close()
        await collector.close()
        expect(await first).toEqual({ reason: "stopped", messages: [projection("10")] })
        expect(await first).toBe(await second)
        await api.shutdown()
        expect(await collector.wait()).toBe(await first)
    },
)

test.each(modes)("%s observer cancellation leaves the collection and other waiters running", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const collector = await api.open()
    const controller = new AbortController()
    const cancelled = collector.wait(controller.signal)
    const other = collector.wait()
    controller.abort()
    const result = await cancelled
    if (mode === "default") expect(result).toMatchObject({ _tag: "CancelledError" })
    else expect(result).toBe("Interrupted")
    server.send(wire("10"))
    expect(await other).toEqual({ reason: "limit", messages: [projection("10")] })
})

test.each(modes)(
    "%s retained byte bounds include UTF-8 JSON and never return partial messages on overflow",
    async (mode) => {
        const server = await fixture()
        const api = await driver(mode)
        const bytes = Buffer.byteLength(JSON.stringify(projection("10", "é")))
        const exact = await api.open({ maxBytes: bytes })
        server.send(wire("10", "20", "é"))
        expect(await exact.wait()).toMatchObject({ reason: "limit" })
        const collector = await api.open({ maxMessages: 2, maxBytes: bytes })
        server.deliver(wire("10", "20", "é"))
        await turn()
        server.send(wire("11", "20", "é"))
        const error = await collector.wait()
        expect(error).toMatchObject({ _tag: "CollectorError", reason: "overflow", limit: "maxBytes", capacity: bytes })
        expect(error).not.toHaveProperty("messages")
        await collector.close()
        expect(await collector.wait()).toBe(error)
    },
)

test.each(modes)("%s channel admission precedes separate pending count and byte limits", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    for (const [options, limit] of [
        [{ maxPendingMessages: 1 }, "maxPendingMessages"],
        [{ maxPendingBytes: 1 }, "maxPendingBytes"],
    ] as const) {
        const filter = vi.fn(() => true)
        const collector = await api.open({ ...options, maxMessages: 10, filter })
        for (let id = 10; id < 20; id++) server.deliver(wire(String(id), "21"))
        server.deliver(wire("20"))
        server.deliver(wire("21"))
        const error = await collector.wait()
        expect(error).toMatchObject({ _tag: "CollectorError", reason: "overflow", limit, capacity: 1 })
        expect(filter).not.toHaveBeenCalled()
        expect(api.state()).toBe("Connected")
    }
})

test.each(modes)("%s filter throws and non-booleans fail only the collector without leaking details", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const thrown = new Error("filter-detail")
    for (const [filter, cause] of [
        [
            () => {
                throw thrown
            },
            thrown,
        ],
        [() => undefined, undefined],
        [() => null, undefined],
        [() => 1, undefined],
        [
            async () => {
                throw new Error("async-filter-detail")
            },
            undefined,
        ],
    ] as const) {
        const collector = await api.open({ filter: filter as any })
        server.send(wire("10", "20", "private-message-body"))
        const error = await collector.wait()
        expect(error).toMatchObject({ _tag: "CollectorError", reason: "filter" })
        // A thrown filter error is kept as the cause; message content never is
        expect((error as Error).cause).toBe(cause)
        expect(JSON.stringify(error)).not.toContain("private-message-body")
        expect(api.state()).toBe("Connected")
    }
})

test.each(
    modes.flatMap((mode) =>
        [false, true].flatMap((foreign) => [false, true].map((hostile) => ({ mode, foreign, hostile }))),
    ),
)(
    "$mode message filters contain rejected promises, foreign=$foreign, hostile=$hostile",
    async ({ mode, foreign, hostile }) => {
        const server = await fixture()
        const api = await driver(mode)
        const privateDetail = "private rejected filter detail"
        const rejections: [unknown, Promise<unknown>][] = []
        const observe = (reason: unknown, promise: Promise<unknown>) => rejections.push([reason, promise])
        process.on("unhandledRejection", observe)
        onTestFinished(() => {
            process.off("unhandledRejection", observe)
        })
        const collector = await api.open({
            filter: () => {
                const rejected = foreign
                    ? (runInNewContext("Promise.reject(reason)", {
                          reason: new Error(privateDetail),
                      }) as Promise<never>)
                    : Promise.reject(new Error(privateDetail))
                // Hostile rows make every promise method lookup throw, so containment cannot rely on calling them
                if (hostile)
                    for (const key of ["then", "catch"])
                        // oxlint-disable-next-line typescript/no-floating-promises -- defineProperty returns the rejected promise, which the filter returns below
                        Object.defineProperty(rejected, key, {
                            get() {
                                throw new Error(privateDetail)
                            },
                        })
                return rejected as never
            },
        })
        server.send(wire("10"))
        const error = await collector.wait()
        expect(error).toMatchObject({ _tag: "CollectorError", reason: "filter" })
        expect(JSON.stringify(error)).not.toContain(privateDetail)
        await turn()
        expect(rejections).toEqual([])
    },
)

test.each(modes)("%s pending bytes use the full UTF-8 source frame with exact-boundary admission", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const first = server.prepare(wire("10", "20", "é"))
    const exact = await api.open({ maxPendingBytes: first.bytes })
    first.deliver()
    expect(await exact.wait()).toMatchObject({ reason: "limit" })
    const second = server.prepare(wire("11", "20", "é"))
    const third = server.prepare(wire("12", "20", "é"))
    const overflow = await api.open({ maxMessages: 5, maxPendingBytes: second.bytes + third.bytes - 1 })
    second.deliver()
    third.deliver()
    expect(await overflow.wait()).toMatchObject({
        reason: "overflow",
        limit: "maxPendingBytes",
        capacity: second.bytes + third.bytes - 1,
    })
})

test.each(modes)("%s fails on a real connection gap even when resume succeeds", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    vi.spyOn(Math, "random").mockReturnValue(0)
    const collector = await api.open({ maxMessages: 5 })
    server.deliver(wire("10"))
    await turn()
    server.gap()
    expect(await collector.wait()).toMatchObject({ _tag: "CollectorError", reason: "connectionLost" })
    await vi.waitFor(() => expect(wsTarget.sockets).toHaveLength(2), { interval: 5 })
    await vi.waitFor(() => expect(api.state()).toBe("Connected"), { interval: 5 })
    const after = await api.open()
    server.send(wire("11"))
    expect(await after.wait()).toMatchObject({ reason: "limit" })
})

test.each(modes)("%s shutdown fails collectors and removes scheduled work before fixture teardown", async (mode) => {
    const server = await fixture()
    const resources = ownedResources()
    const api = await resources.run(() => driver(mode))
    const filter = vi.fn(() => true)
    // The default 30-second collector deadline keeps a host timer armed until shutdown releases it
    const collector = await resources.run(() => api.open({ filter }))
    expect(resources.remaining()).toContain("Timeout")
    server.deliver(wire("10"))
    await api.shutdown()
    expect(await collector.wait()).toMatchObject({ _tag: "ClientClosedError" })
    expect(filter).not.toHaveBeenCalled()
    expect(api.state()).toBe("Closed")
    await resources.released()
    expect(resources.remaining()).toEqual([])
    for (const socket of wsTarget.sockets) {
        expect(socket.readyState).toBe(3)
        expect(socket.listenerCount("message")).toBe(0)
    }
})

test("default collection-level abort removes its signal listener and does not expose partial replies", async () => {
    const server = await fixture()
    const api = await driver("default")
    const controller = new AbortController()
    const collector = await api.open({ signal: controller.signal, maxMessages: 5 })
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
    server.deliver(wire("10"))
    await turn()
    controller.abort()
    expect(await collector.wait()).toMatchObject({ _tag: "CancelledError" })
    expect(api.state()).toBe("Connected")
    // A pre-aborted signal returns a handle whose result is the cancellation
    const preAborted = await api.defaultApi!.messages.collect("20", { signal: controller.signal }).result()
    expect(preAborted.isErr() && preAborted.error).toMatchObject({ _tag: "CancelledError" })
    // Completion without an abort must release the listener itself, since only an abort removes a once listener
    const fresh = new AbortController()
    const completed = await api.open({ signal: fresh.signal })
    expect(getEventListeners(fresh.signal, "abort")).toHaveLength(1)
    server.send(wire("11"))
    const result = await completed.wait()
    expect(getEventListeners(fresh.signal, "abort")).toEqual([])
    fresh.abort()
    expect(await completed.wait()).toBe(result)
})

test("default reentrant stop and abort win over the in-flight filter result", async () => {
    const server = await fixture()
    const api = await driver("default")
    let stop = () => {}
    const collector = api.defaultApi!.messages.collect("20", {
        filter: () => {
            stop()
            return true
        },
    })
    stop = () => collector.close()
    server.send(wire("10"))
    expect(await settle(collector.result())).toEqual({ reason: "stopped", messages: [] })
    const controller = new AbortController()
    const aborted = await api.open({
        signal: controller.signal,
        filter: () => {
            controller.abort()
            return true
        },
    })
    server.send(wire("11"))
    expect(await aborted.wait()).toMatchObject({ _tag: "CancelledError" })
})

test("native registration is lazy and its own scope stops collection without closing the client", async () => {
    const server = await fixture()
    const api = await driver("native")
    const filter = vi.fn(() => true)
    const pending = api.native!.messages.collect("20", { filter, maxMessages: 5 })
    server.deliver(wire("9"))
    await turn()
    expect(filter).not.toHaveBeenCalled()
    const collector = await Effect.runPromise(pending.pipe(Scope.provide(api.collectorScope)))
    server.deliver(wire("10"))
    await turn()
    await Effect.runPromise(Scope.close(api.collectorScope, Exit.void))
    expect(await Effect.runPromise(collector.result())).toEqual({
        reason: "stopped",
        messages: [projection("10")],
    })
    server.deliver(wire("11"))
    await turn()
    expect(filter).toHaveBeenCalledTimes(1)
    expect(api.state()).toBe("Connected")
})

test.each(modes)("%s unexpected collector defects preserve the entry-point error boundary", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const original = Buffer.byteLength
    const collector = await api.open({
        filter: () => {
            vi.spyOn(Buffer, "byteLength").mockImplementation((input, encoding) => {
                if (typeof input === "string" && input.includes('"channelId":"20"')) throw new Error("private-defect")
                return original(input, encoding)
            })
            return true
        },
    })
    server.send(wire("10"))
    if (mode === "default") await expect(collector.wait()).rejects.toBeInstanceOf(SdkDefect)
    else await expect(collector.wait()).rejects.toMatchObject({ message: "Unexpected native defect" })
    expect(api.state()).toBe("Connected")
})

async function collected(weak: WeakRef<object>[]) {
    const session = new Session()
    session.connect()
    try {
        for (let attempt = 0; attempt < 10; attempt++) {
            await turn()
            await new Promise<void>((resolve, reject) =>
                session.post("HeapProfiler.collectGarbage", (error) => (error ? reject(error) : resolve())),
            )
            if (weak.every((reference) => reference.deref() === undefined)) return
        }
        expect(weak.map((reference) => reference.deref() === undefined)).toEqual(weak.map(() => true))
    } finally {
        session.disconnect()
    }
}

test("default cleanup defects retain the collector failure and the cleanup defect", async () => {
    const server = await fixture()
    const api = await driver("default")
    const controller = new AbortController()
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    vi.spyOn(controller.signal, "removeEventListener").mockImplementation((...args) => {
        remove(...args)
        throw new Error("private-cleanup-detail")
    })
    const collector = await api.open({ signal: controller.signal, maxBytes: 1 })
    server.send(wire("10"))
    try {
        await collector.wait()
        throw new Error("Expected SdkDefect")
    } catch (error) {
        expect(error).toBeInstanceOf(SdkDefect)
        expect((error as SdkDefect).reasons).toEqual([
            { kind: "Failure", failure: expect.objectContaining({ _tag: "CollectorError", reason: "overflow" }) },
            expect.objectContaining({ kind: "Defect", origin: "application" }),
        ])
        expect(error).toMatchObject({ code: "application.defect" })
        // Application errors appear in full, so the cleanup defect's own message stays readable
        expect(JSON.stringify(error)).toContain("private-cleanup-detail")
    }
    expect(api.state()).toBe("Connected")
})

test("native registration in an already closed scope cleans up immediately", async () => {
    const server = await fixture()
    const api = await driver("native")
    await Effect.runPromise(Scope.close(api.collectorScope, Exit.void))
    const filter = vi.fn(() => true)
    const exit = await Effect.runPromiseExit(
        api.native!.messages.collect("20", { filter }).pipe(Scope.provide(api.collectorScope)),
    )
    if (Exit.isSuccess(exit))
        expect(await Effect.runPromise(exit.value.result())).toEqual({ reason: "stopped", messages: [] })
    else expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    server.send(wire("10"))
    await turn()
    expect(filter).not.toHaveBeenCalled()
    expect(api.state()).toBe("Connected")
})

test.each(modes)(
    "%s releases failed snapshots and filter references while the client and handle remain alive",
    async (mode) => {
        const server = await fixture()
        const api = await driver(mode, true, false)
        const weak: WeakRef<object>[] = []
        async function tracked() {
            const filter = (message: object) => {
                weak.push(new WeakRef(message))
                return true
            }
            weak.push(new WeakRef(filter))
            return api.open({ filter, maxMessages: 5, maxBytes: Buffer.byteLength(JSON.stringify(projection("10"))) })
        }
        const collector = await tracked()
        server.deliver(wire("10"))
        await turn()
        server.deliver(wire("11"))
        expect(await collector.wait()).toMatchObject({ reason: "overflow" })
        expect(weak).toHaveLength(3)
        await collected(weak)
        expect(api.state()).toBe("Connected")
        expect(await collector.wait()).toMatchObject({ reason: "overflow" })
    },
)

test.each(modes)("%s keeps successful snapshots only while a result or completed handle is retained", async (mode) => {
    const server = await fixture()
    const api = await driver(mode, true, false)
    const weak: WeakRef<object>[] = []
    async function finish() {
        const filter = (message: object) => {
            weak.push(new WeakRef(message))
            return true
        }
        const collector = await api.open({ filter })
        server.send(wire("10"))
        expect(await collector.wait()).toMatchObject({ reason: "limit" })
        await turn()
        expect(weak[0]!.deref()).toBeDefined()
        return collector
    }
    let handle: Awaited<ReturnType<typeof finish>> | undefined = await finish()
    expect(await handle.wait()).toMatchObject({ reason: "limit" })
    handle = undefined
    await collected(weak)
    expect(api.state()).toBe("Connected")
})

test.each(modes)("%s enforces default pending-count and lifetime budgets", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const collector = await api.open({ maxMessages: 1_000 })
    for (let index = 0; index < 257; index++) server.deliver(wire(String(index)))
    expect(await collector.wait()).toMatchObject({ reason: "overflow", limit: "maxPendingMessages", capacity: 256 })
    let now = 0
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    const timed = await api.open({ maxMessages: 5 })
    now = 29_999
    server.deliver(wire("10"))
    await turn()
    now = 30_000
    server.deliver(wire("11"))
    expect(await timed.wait()).toEqual({ reason: "timeout", messages: [projection("10")] })
})

test("default collectors report a throwing caller signal listener method as an application defect", async () => {
    await fixture()
    const api = await driver("default")
    const client = api.defaultApi!
    const failure = new Error("caller signal registration failure")
    const signal = {
        aborted: false,
        addEventListener: () => {
            throw failure
        },
        removeEventListener: () => {},
    } as unknown as AbortSignal
    const register = [
        () => client.messages.collect("20", { signal }),
        () => client.messages.collectReactions({ id: "10", channelId: "20" }, { signal }),
    ]
    for (const collect of register) {
        let raised: unknown
        try {
            collect()
        } catch (error) {
            raised = error
        }
        expect(raised).toBeInstanceOf(SdkDefect)
        expect(raised).toMatchObject({
            code: "application.defect",
            cause: failure,
            reasons: [expect.objectContaining({ kind: "Defect", origin: "application", defect: failure })],
        })
    }
    expect(api.state()).toBe("Connected")
})
