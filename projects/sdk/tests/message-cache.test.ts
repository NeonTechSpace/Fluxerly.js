import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { Clock, Effect, Exit, Logger, References, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import { createClient, SdkDefect, type Client, type Message, type MessageReference } from "../src/index.js"
import { createClient as createNative, fromEffectLogger, type Client as NativeClient } from "../src/effect.js"

const transport = vi.hoisted(() => ({ url: "" }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(url: string, options: import("ws").ClientOptions) {
                expect(url).toBe("wss://gateway.fluxer.app/?v=1&encoding=json")
                super(transport.url, options)
            }
        },
    }
})

const realFetch = globalThis.fetch
const target = { id: "10", channelId: "20" }

test("default cache and handler fallback logs use the same client logger without development output", async () => {
    const server = await fixture()
    const logs: unknown[] = []
    const result = createClient({
        token: "fixture-only-not-a-credential",
        logging: {
            logger: fromEffectLogger(
                Logger.make((entry) => {
                    logs.push(entry.message)
                    throw new Error("private sink")
                }),
            ),
        },
        cache: {
            messages: {
                maxAgeMs: () => {
                    throw new Error("private policy")
                },
            },
        },
    })
    const client = result._unsafeUnwrap()
    onTestFinished(async () => {
        await client.shutdown()
    })
    expect((await client.messages.fetch(target)).isOk()).toBe(true)
    expect(logs).toHaveLength(1)
    expect(client.messages.get(target)._unsafeUnwrap()).toBeUndefined()
    const sub = client
        .on("messageCreate", () => {
            throw new Error("private handler")
        })
        ._unsafeUnwrap()
    await client.connect()
    server.dispatch("MESSAGE_CREATE", wire("91", "20", "private body"))
    await vi.waitFor(() => expect(logs).toHaveLength(3))
    expect(JSON.stringify(logs)).toContain("cache policy failure")
    expect(JSON.stringify(logs)).toContain("message subscription handler failure")
    expect(JSON.stringify(logs)).not.toContain("private")
    expect(client.state).toBe("Connected")
    sub.unsubscribe()
    expect((await sub.waitForClose()).isOk()).toBe(true)
    expect((await client.shutdown()).isOk()).toBe(true)
})

const wire = (id: string, channelId: string, content = `Message ${id}`) => ({
    id,
    channel_id: channelId,
    content,
    author: { id: "30", username: "fixture" },
})

const projection = (id: string, channelId: string, content = `Message ${id}`) => ({
    id,
    channelId,
    content,
    embeds: [],
    attachments: [],
    stickers: [],
    author: { id: "30", username: "fixture", isBot: false },
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type Request = {
    readonly method: string
    readonly path: string
    readonly body: any
    readonly response: ServerResponse
}

async function fixture() {
    const requests: Request[] = []
    const sockets: import("ws").WebSocket[] = []
    const commands: any[] = []
    let sequence = 1
    let nextMessageId = 100

    const defaultResponse = (request: Request) => {
        const match = /^\/v1\/channels\/([^/]+)\/messages(?:\/([^/]+))?$/.exec(request.path)
        if (!match) throw new Error(`Unexpected fixture path: ${request.path}`)
        const channelId = match[1]
        const messageId = match[2]
        if (channelId === undefined) throw new Error(`Fixture request missing channel ID: ${request.path}`)
        if (request.method === "DELETE") {
            request.response.writeHead(204).end()
            return
        }
        if (request.method === "GET" && messageId === undefined) {
            request.response.end(JSON.stringify([wire("81", channelId), wire("80", channelId)]))
            return
        }
        if (request.method === "POST") {
            request.response.end(JSON.stringify(wire(String(nextMessageId++), channelId, request.body.content)))
            return
        }
        if (request.method === "PATCH") {
            request.response.end(JSON.stringify(wire(messageId!, channelId, request.body.content)))
            return
        }
        if (request.method === "GET") {
            request.response.end(JSON.stringify(wire(messageId!, channelId)))
            return
        }
        throw new Error(`Unexpected fixture method: ${request.method}`)
    }
    const control = {
        respond: defaultResponse as (request: Request) => void,
    }

    const server = createServer(async (incoming, response) => {
        if (incoming.url === "/v1/gateway/bot") {
            response.end(JSON.stringify({ url: "wss://gateway.fluxer.app" }))
            return
        }
        let text = ""
        for await (const chunk of incoming) text += chunk.toString()
        const request = {
            method: incoming.method!,
            path: new URL(incoming.url!, "http://fixture").pathname,
            body: text ? JSON.parse(text) : undefined,
            response,
        }
        expect(incoming.headers.authorization).toBe("Bot fixture-only-not-a-credential")
        requests.push(request)
        control.respond(request)
    })
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const command = JSON.parse(data.toString())
            commands.push(command)
            if (command.op === 2 || command.op === 6)
                socket.send(
                    JSON.stringify({
                        op: 0,
                        s: ++sequence,
                        t: command.op === 2 ? "READY" : "RESUMED",
                        d: { session_id: "fixture-session" },
                    }),
                )
            if (command.op === 1) socket.send(JSON.stringify({ op: 11 }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture port")
    transport.url = `ws://127.0.0.1:${address.port}`
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        expect(url.startsWith("https://api.fluxer.app/v1/")).toBe(true)
        expect(init.redirect).toBe("error")
        return realFetch(url.replace("https://api.fluxer.app", `http://127.0.0.1:${address.port}`), init)
    })
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
        requests,
        commands,
        control,
        dispatch(event: string, body: unknown) {
            for (const socket of sockets)
                if (socket.readyState === 1) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: event, d: body }))
        },
        closeCurrentSocket() {
            sockets.at(-1)?.close(4000)
        },
    }
}

function defaultApi(options: any = {}): Client {
    const created = createClient({ token: "fixture-only-not-a-credential", ...options })
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

function cached(client: Client, reference: MessageReference): Message | undefined {
    return value(client.messages.get(reference))
}

test("message-cache configuration validates locally in both public styles", async () => {
    const invalid = [
        { cache: null },
        { cache: { extra: true } },
        { cache: { messages: 1 } },
        { cache: { messages: { maxEntries: null } } },
        { cache: { messages: { maxEntries: 0 } } },
        { cache: { messages: { maxEntries: 1.5 } } },
        { cache: { messages: { maxBytes: null } } },
        { cache: { messages: { maxBytes: 0 } } },
        { cache: { messages: { maxAgeMs: -1 } } },
        { cache: { messages: { maxAgeMs: Infinity } } },
        { cache: { messages: { maxAgeMs: {} } } },
        { cache: { messages: { onError: "not a function" } } },
        { cache: { messages: { unknown: true } } },
    ]
    for (const options of invalid) {
        const defaultCreation = createClient({ token: "fixture-only-not-a-credential", ...options } as any)
        expect(defaultCreation.isErr()).toBe(true)
        if (defaultCreation.isErr()) expect(defaultCreation.error).toMatchObject({ _tag: "ConfigurationError" })

        const nativeCreation = await Effect.runPromise(
            Effect.scoped(Effect.exit(createNative({ token: "fixture-only-not-a-credential", ...options } as any))),
        )
        expect(Exit.isFailure(nativeCreation)).toBe(true)
    }

    const enabled = createClient({ token: "fixture-only-not-a-credential", cache: { messages: {} } })
    expect(enabled.isOk()).toBe(true)
    if (enabled.isOk()) await enabled.value.shutdown()
})

test("local get is opt-in, synchronous and typed without an automatic fetch", async () => {
    const server = await fixture()
    let disabledPolicyCalls = 0
    const disabled = defaultApi({
        cache: {
            messages: false,
        },
    })
    const disabledMiss = cached(disabled, target)
    expect(disabledMiss).toBeUndefined()
    value(await disabled.messages.fetch(target))
    expect(cached(disabled, target)).toBeUndefined()
    expect(server.requests).toHaveLength(1)

    const enabled = defaultApi({
        cache: {
            messages: {
                maxAgeMs: () => {
                    disabledPolicyCalls++
                    return null
                },
            },
        },
    })
    const fetched = value(await enabled.messages.fetch(target))
    expect(cached(enabled, target)).toEqual(fetched)
    expect(disabledPolicyCalls).toBe(1)
    expect(cached(enabled, { id: "404", channelId: "20" })).toBeUndefined()
    expect(server.requests).toHaveLength(2)

    const invalid = enabled.messages.get({ id: "not/a-message", channelId: "20" })
    expect(invalid.isErr() && invalid.error).toMatchObject({
        _tag: "MessageOperationError",
        operation: "get",
        reason: "input",
        outcome: "notDispatched",
    })
    value(await enabled.shutdown())
    const closed = enabled.messages.get(target)
    expect(closed.isErr() && closed.error).toMatchObject({ _tag: "ClientClosedError" })
})

test("native get is lazy and observes the same cached value and closed-client failure", async () => {
    const server = await fixture()
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createNative({ token: "fixture-only-not-a-credential", cache: { messages: true } }).pipe(Scope.provide(scope)),
    )
    try {
        const lookup = client.messages.get(target)
        expect(server.requests).toHaveLength(0)
        expect(await Effect.runPromise(lookup)).toBeUndefined()
        const fetched = await Effect.runPromise(client.messages.fetch(target))
        expect(await Effect.runPromise(lookup)).toEqual(fetched)
        expect(server.requests).toHaveLength(1)
    } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
    const closed = await Effect.runPromise(Effect.exit(client.messages.get(target)))
    expect(Exit.isFailure(closed)).toBe(true)
    if (Exit.isFailure(closed))
        expect(
            closed.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error._tag === "ClientClosedError"),
        ).toBe(true)
})

test("successful REST operations and history populate cache without changing their remote results", async () => {
    const server = await fixture()
    const client = defaultApi({ cache: { messages: true } })
    const fetched = value(await client.messages.fetch(target))
    const sent = value(await client.messages.send("20", { content: "sent" }))
    const replied = value(await client.messages.reply(sent, { content: "reply" }))
    const edited = value(await client.messages.edit(fetched, { content: "edited" }))
    const history = value(await client.messages.fetchHistory("20"))

    expect(cached(client, fetched)).toEqual(edited)
    for (const message of [sent, replied, ...history]) expect(cached(client, message)).toEqual(message)
    expect(server.requests.map((request) => request.method)).toEqual(["GET", "POST", "POST", "PATCH", "GET"])
    expect(cached(client, { id: "999", channelId: "20" })).toBeUndefined()
    expect(server.requests).toHaveLength(5)
})

test("gateway cache intake precedes callbacks and remains independent of subscription overflow", async () => {
    const server = await fixture()
    const client = defaultApi({ cache: { messages: true } })
    const callbackHits: Array<Message | undefined> = []
    value(
        client.on("messageUpdate", (message) => {
            callbackHits.push(cached(client, message))
        }),
    )
    const overflowing = value(client.events("messageCreate", { maxPendingMessages: 1 }))
    value(await client.connect())
    server.dispatch("MESSAGE_CREATE", wire("40", "20", "created"))
    server.dispatch("MESSAGE_CREATE", wire("41", "20", "overflow one"))
    server.dispatch("MESSAGE_CREATE", wire("42", "20", "overflow two"))
    const overflow = await overflowing.waitForClose()
    expect(overflow.isErr() && overflow.error).toMatchObject({ _tag: "EventOverflowError" })
    expect(cached(client, { id: "42", channelId: "20" })?.content).toBe("overflow two")

    server.dispatch("MESSAGE_UPDATE", wire("40", "20", "updated"))
    await vi.waitFor(() => expect(callbackHits).toHaveLength(1))
    expect(callbackHits[0]?.content).toBe("updated")
    expect(cached(client, { id: "40", channelId: "20" })?.content).toBe("updated")

    server.dispatch("MESSAGE_DELETE", { id: "40", channel_id: "20" })
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["41", "42"] })
    await vi.waitFor(() => {
        expect(cached(client, { id: "40", channelId: "20" })).toBeUndefined()
        expect(cached(client, { id: "41", channelId: "20" })).toBeUndefined()
        expect(cached(client, { id: "42", channelId: "20" })).toBeUndefined()
    })
})

test("count and UTF-8 JSON bounds are global, LRU reads retain recency, and oversized candidates preserve unrelated entries", async () => {
    const server = await fixture()
    const lru = defaultApi({ cache: { messages: { maxEntries: 2, maxBytes: 100_000 } } })
    const first = value(await lru.messages.fetch({ id: "11", channelId: "20" }))
    const second = value(await lru.messages.fetch({ id: "12", channelId: "21" }))
    expect(cached(lru, first)).toEqual(first)
    const third = value(await lru.messages.fetch({ id: "13", channelId: "22" }))
    expect(cached(lru, second)).toBeUndefined()
    expect(cached(lru, first)).toEqual(first)
    expect(cached(lru, third)).toEqual(third)

    const historyBounded = defaultApi({ cache: { messages: { maxEntries: 1, maxBytes: 100_000 } } })
    const history = value(await historyBounded.messages.fetchHistory("20"))
    expect(history.map((message) => message.id)).toEqual(["81", "80"])
    expect(cached(historyBounded, history[0]!)).toEqual(history[0])
    expect(cached(historyBounded, history[1]!)).toBeUndefined()

    const small = projection("30", "20", "é")
    const smallBytes = Buffer.byteLength(JSON.stringify(small), "utf8")
    server.control.respond = (request) => {
        if (request.method === "GET" && /^\/v1\/channels\/(20|21)\/messages\/(30|31)$/.test(request.path)) {
            const match = /^\/v1\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(request.path)
            if (!match || match[1] === undefined || match[2] === undefined)
                throw new Error(`Fixture request missing message fields: ${request.path}`)
            const [, channelId, messageId] = match
            request.response.end(JSON.stringify(wire(messageId, channelId, "é")))
            return
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const bytes = defaultApi({ cache: { messages: { maxEntries: 10, maxBytes: smallBytes } } })
    const byteFirst = value(await bytes.messages.fetch({ id: "30", channelId: "20" }))
    const byteSecond = value(await bytes.messages.fetch({ id: "31", channelId: "21" }))
    expect(cached(bytes, byteFirst)).toBeUndefined()
    expect(cached(bytes, byteSecond)).toEqual(byteSecond)

    const oversized = defaultApi({ cache: { messages: { maxEntries: 10, maxBytes: smallBytes * 2 } } })
    const retained = value(await oversized.messages.fetch({ id: "30", channelId: "20" }))
    const unrelated = value(await oversized.messages.fetch({ id: "31", channelId: "21" }))
    server.control.respond = (request) => {
        if (request.method === "GET" && request.path === "/v1/channels/20/messages/30")
            request.response.end(JSON.stringify(wire("30", "20", "é".repeat(100))))
        else throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const tooLarge = value(await oversized.messages.fetch({ id: "30", channelId: "20" }))
    expect(tooLarge.content).toHaveLength(100)
    expect(cached(oversized, retained)).toBeUndefined()
    expect(cached(oversized, unrelated)).toEqual(unrelated)
    expect(cached(oversized, tooLarge)).toBeUndefined()
})

test("retention age resets only for accepted snapshots, while zero removes and null does not expire", async () => {
    const server = await fixture()
    const client = defaultApi({ cache: { messages: { maxAgeMs: 70 } } })
    const first = value(await client.messages.fetch(target))
    await new Promise((resolve) => setTimeout(resolve, 45))
    const second = value(await client.messages.fetch(target))
    expect(second).toEqual(first)
    await new Promise((resolve) => setTimeout(resolve, 45))
    expect(cached(client, target)).toEqual(second)
    await vi.waitFor(() => expect(cached(client, target)).toBeUndefined(), { timeout: 200 })

    const policy = defaultApi({
        cache: {
            messages: {
                maxAgeMs: (message: Message) => (message.content === "forget" ? 0 : null),
            },
        },
    })
    const retained = value(await policy.messages.fetch({ id: "50", channelId: "20" }))
    expect(cached(policy, retained)).toEqual(retained)
    server.control.respond = (request) => {
        if (request.method === "GET" && request.path === "/v1/channels/20/messages/50")
            request.response.end(JSON.stringify(wire("50", "20", "forget")))
        else throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const removed = value(await policy.messages.fetch({ id: "50", channelId: "20" }))
    expect(removed.content).toBe("forget")
    expect(cached(policy, retained)).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(cached(policy, { id: "50", channelId: "20" })).toBeUndefined()

    server.control.respond = (request) => {
        if (request.method === "GET" && request.path === "/v1/channels/20/messages/51")
            request.response.end(JSON.stringify(wire("51", "20")))
        else throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const shutdownCache = defaultApi({ cache: { messages: { maxAgeMs: 10_000 } } })
    value(await shutdownCache.messages.fetch({ id: "51", channelId: "20" }))
    const cancelledTimer = vi.spyOn(globalThis, "clearTimeout")
    value(await shutdownCache.shutdown())
    expect(cancelledTimer).toHaveBeenCalled()
})

test("native local reads respect exact monotonic-age boundaries without renewing age and cap long cleanup timers", async () => {
    await fixture()
    const baseClock = Effect.runSync(Clock.Clock)
    let monotonicNanos = 1_000_000_000n
    const clock = {
        ...baseClock,
        sleep: baseClock.sleep.bind(baseClock),
        monotonicTimeNanosUnsafe: () => monotonicNanos,
    }
    const scheduled = vi.spyOn(globalThis, "setTimeout")
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const exact = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    cache: { messages: { maxAgeMs: 10 } },
                })
                const snapshot = yield* exact.messages.fetch(target)
                monotonicNanos += 9_000_000n
                expect(yield* exact.messages.get(target)).toEqual(snapshot)
                monotonicNanos += 1_000_000n
                expect(yield* exact.messages.get(target)).toBeUndefined()
                yield* exact.shutdown()

                const long = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    cache: { messages: { maxAgeMs: 2_147_483_648 } },
                })
                yield* long.messages.fetch({ id: "11", channelId: "20" })
                expect(scheduled.mock.calls.some(([, delay]) => delay === 2_147_483_647)).toBe(true)
                yield* long.shutdown()
            }),
        ).pipe(Effect.provideService(Clock.Clock, clock)),
    )
})

test("default policy failures are private, bounded and do not change successful remote results", async () => {
    await fixture()
    const reports: unknown[] = []
    let release!: () => void
    const busy = new Promise<void>((resolve) => {
        release = resolve
    })
    const client = defaultApi({
        cache: {
            messages: {
                maxAgeMs: (message: Message) => {
                    if (message.id === "60") throw new Error("private policy detail")
                    if (message.id === "61") return Promise.reject(new Error("private rejected policy")) as never
                    return undefined as never
                },
                onError: (report: unknown) => {
                    reports.push(report)
                    return busy
                },
            },
        },
    })
    const thrown = value(await client.messages.fetch({ id: "60", channelId: "20" }))
    expect(thrown.id).toBe("60")
    await vi.waitFor(() => expect(reports).toEqual([{ reason: "threw" }]))
    expect(JSON.stringify(reports)).not.toContain("private")
    expect(cached(client, thrown)).toBeUndefined()

    const invalid = value(await client.messages.fetch({ id: "61", channelId: "20" }))
    expect(invalid.id).toBe("61")
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(reports).toHaveLength(1)
    expect(cached(client, invalid)).toBeUndefined()
    release()
    const afterRelease = value(await client.messages.fetch({ id: "62", channelId: "20" }))
    await vi.waitFor(() => expect(reports).toEqual([{ reason: "threw" }, { reason: "invalidReturn" }]))
    expect(cached(client, afterRelease)).toBeUndefined()
    await client.shutdown()
})

test("native reporter captures creation context, logs bounded overflow and is interrupted before shutdown returns", async () => {
    const server = await fixture()
    const reports: unknown[] = []
    const annotations: unknown[] = []
    const logs: unknown[] = []
    let cleaned = false
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    cache: {
                        messages: {
                            maxAgeMs: () => {
                                throw new Error("private native policy detail")
                            },
                            onError: (report: unknown) =>
                                Effect.gen(function* () {
                                    reports.push(report)
                                    annotations.push((yield* References.CurrentLogAnnotations).cacheCreation)
                                    yield* Effect.never
                                }).pipe(
                                    Effect.ensuring(
                                        Effect.sync(() => {
                                            cleaned = true
                                        }),
                                    ),
                                ),
                        },
                    },
                }).pipe(Effect.annotateLogs("cacheCreation", "creation"))
                yield* client.connect().pipe(Effect.annotateLogs("cacheCreation", "connection"))
                server.dispatch("MESSAGE_CREATE", wire("70", "20", "private first"))
                yield* Effect.promise(() => vi.waitFor(() => expect(reports).toHaveLength(1)))
                server.dispatch("MESSAGE_CREATE", wire("71", "20", "private second"))
                yield* Effect.promise(() => vi.waitFor(() => expect(logs).toHaveLength(1)))
                expect(reports).toEqual([{ reason: "threw" }])
                expect(annotations).toEqual(["creation"])
                expect(JSON.stringify(logs)).not.toContain("private")
                expect(yield* client.messages.get({ id: "70", channelId: "20" })).toBeUndefined()
                yield* client.shutdown()
                expect(cleaned).toBe(true)
            }),
        ).pipe(
            Effect.withLogger(
                Logger.make((entry) => {
                    logs.push(entry.message)
                }),
            ),
        ),
    )
})

test("native reporter shutdown does not wait on its own report fiber", async () => {
    const server = await fixture()
    let entered = false
    let cleaned = false
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let client!: NativeClient
                client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    cache: {
                        messages: {
                            maxAgeMs: () => {
                                throw new Error("private self-shutdown policy detail")
                            },
                            onError: () =>
                                Effect.sync(() => {
                                    entered = true
                                }).pipe(
                                    Effect.andThen(client.shutdown()),
                                    Effect.ensuring(
                                        Effect.sync(() => {
                                            cleaned = true
                                        }),
                                    ),
                                ),
                        },
                    },
                })
                yield* client.connect()
                server.dispatch("MESSAGE_CREATE", wire("72", "20", "private self-shutdown"))
                yield* client.waitForClose()
                expect(entered).toBe(true)
                expect(cleaned).toBe(true)
                expect(client.state).toBe("Closed")
            }),
        ),
    )
})

test("a late REST response crossing a resumed connection gap cannot repopulate the cleared cache", async () => {
    const server = await fixture()
    const client = defaultApi({ cache: { messages: true } })
    const original = value(await client.messages.fetch(target))
    expect(cached(client, target)).toEqual(original)
    value(await client.connect())
    let reply!: () => void
    server.control.respond = (request) => {
        if (request.method === "GET" && request.path === "/v1/channels/20/messages/10") {
            reply = () => request.response.end(JSON.stringify(wire("10", "20", "late")))
            return
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const late = client.messages.fetch(target)
    await vi.waitFor(() => expect(server.requests).toHaveLength(2))
    server.closeCurrentSocket()
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 6)).toBe(true), { timeout: 2_000 })
    reply()
    expect(value(await late).content).toBe("late")
    await vi.waitFor(() => expect(client.state).toBe("Connected"))
    expect(cached(client, target)).toBeUndefined()

    server.control.respond = (request) => request.response.end(JSON.stringify(wire("10", "20", "fresh")))
    const fresh = value(await client.messages.fetch(target))
    expect(cached(client, fresh)).toEqual(fresh)
})

test("a fetch queued before a gateway gap cannot populate after its delayed admission", async () => {
    const server = await fixture()
    const client = defaultApi({ cache: { messages: true } })
    value(await client.connect())
    const held: Array<() => void> = []
    const activeIds = new Set(["100", "101", "102", "103"])
    server.control.respond = (request) => {
        const id = request.path.split("/").at(-1)
        if (request.method === "GET" && id && activeIds.has(id)) {
            held.push(() => request.response.end(JSON.stringify(wire(id, "21"))))
            return
        }
        if (request.method === "GET" && request.path === "/v1/channels/20/messages/10") {
            request.response.end(JSON.stringify(wire("10", "20", "queued before gap")))
            return
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const active = [...activeIds].map((id) => client.messages.fetch({ id, channelId: "21" }))
    await vi.waitFor(() => expect(server.requests).toHaveLength(4))
    const queued = client.messages.fetch(target)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(server.requests).toHaveLength(4)
    server.closeCurrentSocket()
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 6)).toBe(true), { timeout: 2_000 })
    for (const reply of held) reply()
    expect(value(await queued).content).toBe("queued before gap")
    for (const request of active) value(await request)
    expect(cached(client, target)).toBeUndefined()

    const fresh = value(await client.messages.fetch(target))
    expect(cached(client, fresh)).toEqual(fresh)
})

test.each([429, 503])(
    "a %s retry delayed across a gateway gap returns normally without populating cache",
    async (status) => {
        const server = await fixture()
        const client = defaultApi({ cache: { messages: true } })
        value(await client.connect())
        let attempts = 0
        server.control.respond = (request) => {
            if (request.method !== "GET" || request.path !== "/v1/channels/20/messages/10")
                throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
            attempts++
            if (attempts === 1) {
                request.response.writeHead(status, { "Content-Type": "application/json", "Retry-After": "1.2" })
                request.response.end(JSON.stringify({ retry_after: 1.2 }))
                return
            }
            request.response.end(JSON.stringify(wire("10", "20", "after rate wait")))
        }
        const waiting = client.messages.fetch(target)
        await vi.waitFor(() => expect(server.requests).toHaveLength(1))
        server.closeCurrentSocket()
        await vi.waitFor(() => expect(server.commands.some((command) => command.op === 6)).toBe(true), {
            timeout: 2_000,
        })
        const result = value(await waiting)
        expect(result.content).toBe("after rate wait")
        expect(attempts).toBe(2)
        expect(cached(client, target)).toBeUndefined()
    },
)

test("native read retries retain the pre-gap cache generation", async () => {
    const server = await fixture()
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    cache: { messages: true },
                })
                yield* client.connect()
                let attempts = 0
                server.control.respond = (request) => {
                    attempts++
                    if (attempts === 1) request.response.writeHead(503, { "Retry-After": "1.2" }).end()
                    else request.response.end(JSON.stringify(wire("10", "20", "after retry")))
                }
                const waiting = Effect.runPromise(client.messages.fetch(target))
                yield* Effect.promise(() => vi.waitFor(() => expect(attempts).toBe(1)))
                server.closeCurrentSocket()
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(server.commands.some((command) => command.op === 6)).toBe(true), {
                        timeout: 2_000,
                    }),
                )
                expect((yield* Effect.promise(() => waiting)).content).toBe("after retry")
                expect(attempts).toBe(2)
                expect(yield* client.messages.get(target)).toBeUndefined()
            }),
        ),
    )
})

test("only a dispatched uncertain edit evicts a retained target", async () => {
    const server = await fixture()
    const client = defaultApi({ cache: { messages: true } })
    const retained = value(await client.messages.fetch(target))
    const invalid = await client.messages.edit(target, {} as never)
    expect(invalid.isErr() && invalid.error).toMatchObject({
        _tag: "MessageOperationError",
        operation: "edit",
        reason: "input",
        outcome: "notDispatched",
    })
    expect(cached(client, target)).toEqual(retained)

    const beforeDispatch = new AbortController()
    beforeDispatch.abort()
    const cancelledBeforeDispatch = await client.messages.edit(
        target,
        { content: "cancelled before dispatch" },
        {
            signal: beforeDispatch.signal,
        },
    )
    expect(cancelledBeforeDispatch.isErr() && cancelledBeforeDispatch.error).toMatchObject({ _tag: "CancelledError" })
    expect(server.requests).toHaveLength(1)
    expect(cached(client, target)).toEqual(retained)

    server.control.respond = (request) => {
        if (request.method === "PATCH" && request.path === "/v1/channels/20/messages/10") return
        throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const dispatched = new AbortController()
    const cancelledAfterDispatch = client.messages.edit(
        target,
        { content: "cancelled after dispatch" },
        {
            signal: dispatched.signal,
        },
    )
    await vi.waitFor(() => expect(server.requests).toHaveLength(2))
    dispatched.abort()
    const result = await cancelledAfterDispatch
    expect(result.isErr() && result.error).toMatchObject({ _tag: "CancelledError" })
    expect(cached(client, target)).toBeUndefined()
})

test("a late read overlapping a dispatched delete cannot restore the deleted cache target", async () => {
    const server = await fixture()
    const client = defaultApi({ cache: { messages: true } })
    value(await client.messages.fetch(target))
    let replyRead!: () => void
    server.control.respond = (request) => {
        if (request.method === "GET" && request.path === "/v1/channels/20/messages/10") {
            replyRead = () => request.response.end(JSON.stringify(wire("10", "20", "late read")))
            return
        }
        if (request.method === "DELETE" && request.path === "/v1/channels/20/messages/10") {
            request.response.writeHead(204).end()
            return
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const reading = client.messages.fetch(target)
    await vi.waitFor(() => expect(server.requests).toHaveLength(2))
    value(await client.messages.delete(target))
    replyRead()
    expect(value(await reading).content).toBe("late read")
    expect(cached(client, target)).toBeUndefined()
})

test("an unexpected accounting defect stays outside default typed message failures", async () => {
    await fixture()
    const client = defaultApi({ cache: { messages: true } })
    const accountingDefect = new Error("private cache accounting defect")
    const byteLength = Buffer.byteLength
    vi.spyOn(Buffer, "byteLength").mockImplementation(((value: unknown, encoding?: BufferEncoding) => {
        if (typeof value === "string" && value.includes('"channelId":"20"')) throw accountingDefect
        return byteLength(value as never, encoding as never)
    }) as never)
    let error: unknown
    try {
        await client.messages.fetch(target)
    } catch (caught) {
        error = caught
    }
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({ reasons: [{ kind: "Defect" }] })
    expect(JSON.stringify(error)).not.toContain("private cache accounting defect")
    expect(cached(client, target)).toBeUndefined()
})

test.each(["default", "native"] as const)(
    "%s cache conflicts include embeds, attachments, pin state and webhook identity",
    async (mode) => {
        const server = await fixture()
        const scope = Scope.makeUnsafe()
        const regular = mode === "default" ? defaultApi({ cache: { messages: true } }) : undefined
        const native =
            mode === "native"
                ? await Effect.runPromise(
                      createNative({
                          token: "fixture-only-not-a-credential",
                          cache: { messages: true },
                      }).pipe(Scope.provide(scope)),
                  )
                : undefined
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const get = async () =>
            regular ? value(regular.messages.get(target)) : Effect.runPromise(native!.messages.get(target))
        if (regular) value(await regular.connect())
        else await Effect.runPromise(native!.connect())
        for (const extra of [
            { embeds: [{ type: "rich", description: "different embed" }] },
            { attachments: [{ id: "40", filename: "different.txt", size: 1, flags: 0 }] },
            { pinned: true },
            { webhook_id: "99" },
        ]) {
            let reply!: () => void
            server.control.respond = (request) => {
                reply = () => request.response.end(JSON.stringify(wire("10", "20", "same text")))
            }
            const before = server.requests.length
            const pending = regular
                ? Promise.resolve(regular.messages.edit(target, { content: "same text" })).then(value)
                : Effect.runPromise(native!.messages.edit(target, { content: "same text" }))
            await vi.waitFor(() => expect(server.requests).toHaveLength(before + 1))
            server.dispatch("MESSAGE_UPDATE", { ...wire("10", "20", "same text"), ...extra })
            await vi.waitFor(async () => expect(await get()).toBeDefined())
            if ("webhook_id" in extra) expect((await get())?.webhookId).toBe("99")
            reply()
            expect((await pending).content).toBe("same text")
            expect(await get()).toBeUndefined()
        }
    },
)

test("overlapping writes preserve only an identical observed snapshot and leave other channels untouched", async () => {
    const server = await fixture()
    const client = defaultApi({ cache: { messages: true } })
    value(await client.messages.fetch(target))
    const unrelated = value(await client.messages.fetch({ id: "12", channelId: "21" }))
    value(await client.connect())

    let reply!: () => void
    server.control.respond = (request) => {
        if (request.method === "PATCH" && request.path === "/v1/channels/20/messages/10") {
            reply = () => request.response.end(JSON.stringify(wire("10", "20", "REST conflict")))
            return
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const conflicting = client.messages.edit(target, { content: "REST conflict" })
    await vi.waitFor(() => expect(server.requests).toHaveLength(3))
    server.dispatch("MESSAGE_UPDATE", wire("10", "20", "gateway current"))
    await vi.waitFor(() => expect(cached(client, target)?.content).toBe("gateway current"))
    reply()
    expect(value(await conflicting).content).toBe("REST conflict")
    expect(cached(client, target)).toBeUndefined()
    expect(cached(client, unrelated)).toEqual(unrelated)

    server.control.respond = (request) => {
        if (request.method === "GET" && request.path === "/v1/channels/20/messages/11") {
            request.response.end(JSON.stringify(wire("11", "20", "before")))
            return
        }
        if (request.method === "PATCH" && request.path === "/v1/channels/20/messages/11") {
            reply = () => request.response.end(JSON.stringify(wire("11", "20", "same")))
            return
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const sameTarget = { id: "11", channelId: "20" }
    value(await client.messages.fetch(sameTarget))
    const identical = client.messages.edit(sameTarget, { content: "same" })
    await vi.waitFor(() => expect(server.requests).toHaveLength(5))
    server.dispatch("MESSAGE_UPDATE", wire("11", "20", "same"))
    await vi.waitFor(() => expect(cached(client, sameTarget)?.content).toBe("same"))
    reply()
    expect(value(await identical).content).toBe("same")
    expect(cached(client, sameTarget)?.content).toBe("same")
})

test("send and history responses are channel-scoped around concurrent observations, while confirmed and uncertain mutations evict", async () => {
    const server = await fixture()
    const client = defaultApi({ cache: { messages: true } })
    const fetched = value(await client.messages.fetch(target))
    const otherChannel = value(await client.messages.fetch({ id: "12", channelId: "21" }))
    value(await client.connect())

    let reply!: () => void
    server.control.respond = (request) => {
        if (request.method === "POST" && request.path === "/v1/channels/20/messages") {
            reply = () => request.response.end(JSON.stringify(wire("90", "20", "late send")))
            return
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const sent = client.messages.send("20", { content: "late send" })
    await vi.waitFor(() => expect(server.requests).toHaveLength(3))
    server.dispatch("MESSAGE_CREATE", wire("91", "20", "concurrent"))
    reply()
    const sentResult = value(await sent)
    expect(cached(client, sentResult)).toBeUndefined()
    expect(cached(client, otherChannel)).toEqual(otherChannel)

    server.control.respond = (request) => {
        if (request.method === "GET" && request.path === "/v1/channels/20/messages") {
            reply = () => request.response.end(JSON.stringify([wire("92", "20", "late history")]))
            return
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const history = client.messages.fetchHistory("20")
    await vi.waitFor(() => expect(server.requests).toHaveLength(4))
    server.dispatch("MESSAGE_UPDATE", wire("91", "20", "changed concurrently"))
    reply()
    const historyResult = value(await history)
    expect(historyResult).toHaveLength(1)
    expect(cached(client, historyResult[0]!)).toBeUndefined()
    expect(cached(client, otherChannel)).toEqual(otherChannel)

    server.control.respond = (request) => {
        if (request.method === "PATCH" && request.path === "/v1/channels/20/messages/10") {
            request.response.destroy()
            return
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const uncertain = await client.messages.edit(fetched, { content: "unknown" })
    expect(uncertain.isErr()).toBe(true)
    expect(cached(client, fetched)).toBeUndefined()

    server.control.respond = (request) => {
        if (request.method === "GET" && request.path === "/v1/channels/20/messages/10") {
            request.response.end(JSON.stringify(wire("10", "20", "again")))
            return
        }
        if (request.method === "DELETE" && request.path === "/v1/channels/20/messages/10") {
            request.response.writeHead(204).end()
            return
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const restored = value(await client.messages.fetch(target))
    expect(cached(client, restored)).toEqual(restored)
    value(await client.messages.delete(restored))
    expect(cached(client, restored)).toBeUndefined()
})
