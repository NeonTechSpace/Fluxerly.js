import type { ServerResponse } from "node:http"
import { setImmediate as turn } from "node:timers/promises"
import { runInNewContext } from "node:vm"
import { Clock, Effect, Exit, References, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    ConfigurationError,
    createClient,
    SdkDefect,
    type Client,
    type FailureReport,
    type LogRecord,
    type Message,
    type MessageReference,
} from "../../../src/index.js"
import {
    createClient as createNative,
    type Client as NativeClient,
    type FailureReport as NativeFailureReport,
} from "../../../src/effect.js"
import type { CacheChange } from "../../../src/cache.js"
import { defaultApi, modes, nativeApi } from "../../support/both-apis.js"
import { waitUntil } from "../../support/clock.js"
import { sdkClock, type SdkClock } from "../../support/client-clock.js"
import { startGatewayServer } from "../../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { sendJson, startRestServer } from "../../support/rest-server.js"
import { expectDefect, expectThrown } from "../defects.js"

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

// The fixture asserts this exact Authorization credential, so clients receive it explicitly
const token = "fixture-only-not-a-credential"
const realFetch = globalThis.fetch
const target = { id: "10", channelId: "20" }

test("default cache policy failures reach the client log with the application error", async () => {
    await fixture()
    const logs: LogRecord[] = []
    const policyError = new Error("policy broke")
    const client = defaultApi({
        token,
        logging: { sink: (record) => logs.push(record) },
        cache: {
            messages: {
                maxAgeMs: () => {
                    throw policyError
                },
            },
        },
    })
    expect((await client.messages.fetch(target)).isOk()).toBe(true)
    expect(logs.filter((record) => record.level === "error")).toEqual([
        expect.objectContaining({
            code: "cache.policyFailed",
            category: "cache",
            fields: expect.objectContaining({ messageId: "10", channelId: "20" }),
            error: expect.objectContaining({ origin: "application", message: "policy broke" }),
        }),
    ])
    expect(client.messages.get(target)).toBeUndefined()
})

const wire = (id: string, channelId: string, content = `Message ${id}`) => ({
    id,
    channel_id: channelId,
    content,
    author: { id: "30", username: "fixture" },
})
const metadataWire = (id: string, channelId: string, content = `Message ${id}`) => ({
    ...wire(id, channelId, content),
    timestamp: "2026-09-09T12:00:00.000Z",
    edited_timestamp: null,
    type: 19,
    flags: 4,
    guild_id: "40",
    mentions: [{ id: "31", username: "mentioned" }],
    mention_roles: ["50"],
    reactions: [{ emoji: { id: null, name: "👍" }, count: 2, me: false }],
    message_reference: { message_id: "70", channel_id: "71", type: 1 },
    referenced_message: {
        id: "70",
        channel_id: "71",
        content: "reply context",
        author: { id: "32", username: "reply-author" },
    },
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

    const rest = await startRestServer({
        routes: {
            "GET /v1/gateway/bot": (_request, response) => sendJson(response, { url: "wss://gateway.fluxer.app" }),
        },
        fallback: (incoming, response) => {
            const request = { method: incoming.method, path: incoming.path, body: incoming.body, response }
            expect(incoming.headers.authorization).toBe(`Bot ${token}`)
            requests.push(request)
            control.respond(request)
        },
    })
    // The hoisted ws mock asserts the SDK's requested gateway address before redirecting to this fixture
    const gateway = await startGatewayServer({ server: rest.server, redirect: false, sessionId: "fixture-session" })
    transport.url = gateway.url
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => {
        expect(url.startsWith("https://api.fluxer.app/v1/")).toBe(true)
        expect(init.redirect).toBe("error")
        return realFetch(url.replace("https://api.fluxer.app", rest.origin), init)
    })
    return {
        requests,
        commands: gateway.commands,
        control,
        dispatch: (event: string, body: unknown) => gateway.dispatch(event, body),
        closeCurrentSocket: () => gateway.closeCurrent(4000),
    }
}

function value<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

function cached(client: Client, reference: MessageReference): Message | undefined {
    return client.messages.get(reference)
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
        { cache: { messages: { onError: () => undefined } } },
        { onError: "not a function" },
        { cache: { messages: { unknown: true } } },
    ]
    for (const options of invalid) {
        expect(() => createClient({ token, ...options } as any)).toThrow(ConfigurationError)
        expect(await expectDefect(Effect.scoped(createNative({ token, ...options } as any)))).toBeInstanceOf(
            ConfigurationError,
        )
    }

    const enabled = createClient({ token, cache: { messages: {} } })
    value(await enabled.shutdown())
})

test("local get is opt-in, synchronous and typed without an automatic fetch", async () => {
    const server = await fixture()
    let disabledPolicyCalls = 0
    const disabled = defaultApi({
        token,
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
        token,
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

    expect(expectThrown(() => enabled.messages.get({ id: "not/a-message", channelId: "20" }))).toMatchObject({
        _tag: "MessageOperationError",
        operation: "messages.get",
        reason: "input",
        outcome: "notDispatched",
    })
    value(await enabled.shutdown())
    expect(enabled.messages.get(target)).toBeUndefined()
})

test("native get is lazy, observes the same cached value and reads undefined after closure", async () => {
    const server = await fixture()
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createNative({ token, cache: { messages: true } }).pipe(Scope.provide(scope)),
    )
    try {
        const lookup = client.messages.get(target)
        expect(server.requests).toHaveLength(0)
        expect(await Effect.runPromise(lookup)).toBeUndefined()
        const fetched = await Effect.runPromise(client.messages.fetch(target))
        expect(await Effect.runPromise(lookup)).toEqual(fetched)
        expect(server.requests).toHaveLength(1)
        expect(await expectDefect(client.messages.get({ id: "not/a-message", channelId: "20" }))).toMatchObject({
            _tag: "MessageOperationError",
            operation: "messages.get",
            reason: "input",
        })
    } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
    expect(await Effect.runPromise(client.messages.get(target))).toBeUndefined()
})

test("cache intake retains received message metadata as one frozen, byte-accounted snapshot", async () => {
    const server = await fixture()
    const client = defaultApi({ token, cache: { messages: true } })
    server.control.respond = (request) => {
        expect(request.method).toBe("GET")
        expect(request.path).toBe("/v1/channels/20/messages/10")
        request.response.end(JSON.stringify(metadataWire("10", "20")))
    }
    const fetched = value(await client.messages.fetch(target))
    expect(cached(client, target)).toEqual(fetched)
    expect(Object.isFrozen(fetched.reactions) && Object.isFrozen(fetched.reactions?.[0]?.emoji)).toBe(true)

    value(await client.connect())
    server.dispatch("MESSAGE_UPDATE", { ...metadataWire("10", "20"), flags: 8 })
    await vi.waitFor(() => expect(cached(client, target)?.flags).toBe(8))
    expect(cached(client, target)?.reactions?.[0]).toMatchObject({ emoji: { id: null, name: "👍" }, count: 2 })
    expect(server.requests).toHaveLength(1)
})

test("successful REST operations and history populate cache without changing their remote results", async () => {
    const server = await fixture()
    const client = defaultApi({ token, cache: { messages: true } })
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
    const client = defaultApi({ token, cache: { messages: true } })
    const callbackHits: Array<Message | undefined> = []
    client.on("messageUpdate", (message) => {
        callbackHits.push(cached(client, message))
    })
    const overflowing = client.subscribe("messageCreate", { maxPendingMessages: 1 })
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
    const lru = defaultApi({ token, cache: { messages: { maxEntries: 2, maxBytes: 100_000 } } })
    const first = value(await lru.messages.fetch({ id: "11", channelId: "20" }))
    const second = value(await lru.messages.fetch({ id: "12", channelId: "21" }))
    expect(cached(lru, first)).toEqual(first)
    const third = value(await lru.messages.fetch({ id: "13", channelId: "22" }))
    expect(cached(lru, second)).toBeUndefined()
    expect(cached(lru, first)).toEqual(first)
    expect(cached(lru, third)).toEqual(third)

    const historyBounded = defaultApi({ token, cache: { messages: { maxEntries: 1, maxBytes: 100_000 } } })
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
    const bytes = defaultApi({ token, cache: { messages: { maxEntries: 10, maxBytes: smallBytes } } })
    const byteFirst = value(await bytes.messages.fetch({ id: "30", channelId: "20" }))
    const byteSecond = value(await bytes.messages.fetch({ id: "31", channelId: "21" }))
    expect(cached(bytes, byteFirst)).toBeUndefined()
    expect(cached(bytes, byteSecond)).toEqual(byteSecond)

    const oversized = defaultApi({ token, cache: { messages: { maxEntries: 10, maxBytes: smallBytes * 2 } } })
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
    let monotonicNanos = 1_000_000_000n
    // Control retention age without replacing real network or cleanup timers
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => monotonicNanos)
    const client = defaultApi({ token, cache: { messages: { maxAgeMs: 70 } } })
    const first = value(await client.messages.fetch(target))
    monotonicNanos += 45_000_000n
    const second = value(await client.messages.fetch(target))
    expect(second).toEqual(first)
    expect(
        server.requests.filter((request) => request.method === "GET" && request.path === "/v1/channels/20/messages/10"),
    ).toHaveLength(2)
    monotonicNanos += 45_000_000n
    expect(cached(client, target)).toEqual(second)
    monotonicNanos += 25_000_000n
    expect(cached(client, target)).toBeUndefined()

    const policy = defaultApi({
        token,
        cache: {
            messages: {
                maxAgeMs: (message: Message) => (message.content === "forget" ? 0 : null),
            },
        },
    })
    const retained = value(await policy.messages.fetch({ id: "50", channelId: "20" }))
    expect(cached(policy, retained)).toEqual(retained)
    monotonicNanos += 1_000_000_000n
    expect(cached(policy, retained)).toEqual(retained)
    server.control.respond = (request) => {
        if (request.method === "GET" && request.path === "/v1/channels/20/messages/50")
            request.response.end(JSON.stringify(wire("50", "20", "forget")))
        else throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`)
    }
    const removed = value(await policy.messages.fetch({ id: "50", channelId: "20" }))
    expect(removed.content).toBe("forget")
    expect(cached(policy, retained)).toBeUndefined()
    monotonicNanos += 90_000_000n
    expect(cached(policy, { id: "50", channelId: "20" })).toBeUndefined()
})

test("native local reads respect exact monotonic-age boundaries without renewing age and keep ages past the host timer limit", async () => {
    await fixture()
    const warnings: string[] = []
    const observe = (warning: Error) => warnings.push(warning.name)
    process.on("warning", observe)
    onTestFinished(() => {
        process.off("warning", observe)
    })
    const baseClock = Effect.runSync(Clock.Clock)
    let monotonicNanos = 1_000_000_000n
    // Keep the prototype so span timing can still read wall-clock time
    const clock = Object.assign(Object.create(baseClock) as Clock.Clock, {
        sleep: baseClock.sleep.bind(baseClock),
        monotonicTimeNanosUnsafe: () => monotonicNanos,
    })
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const exact = yield* createNative({
                    token,
                    cache: { messages: { maxAgeMs: 10 } },
                })
                const snapshot = yield* exact.messages.fetch(target)
                monotonicNanos += 9_000_000n
                expect(yield* exact.messages.get(target)).toEqual(snapshot)
                monotonicNanos += 1_000_000n
                expect(yield* exact.messages.get(target)).toBeUndefined()
                yield* exact.shutdown()

                const long = yield* createNative({
                    token,
                    cache: { messages: { maxAgeMs: 2_147_483_648 } },
                })
                const retained = yield* long.messages.fetch({ id: "11", channelId: "20" })
                // An uncapped host timer overflows to about 1 ms, so a later 5 ms timer runs after it would have fired
                yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
                expect(yield* long.messages.get({ id: "11", channelId: "20" })).toEqual(retained)
                yield* long.shutdown()
            }),
        ).pipe(Effect.provideService(Clock.Clock, clock)),
    )
    expect(warnings).not.toContain("TimeoutOverflowWarning")
})

test("default policy failures reach onError in order with their errors and do not change successful remote results", async () => {
    await fixture()
    const reports: FailureReport[] = []
    let release!: () => void
    const busy = new Promise<void>((resolve) => {
        release = resolve
    })
    const policyError = new Error("policy detail")
    const client = defaultApi({
        token,
        cache: {
            messages: {
                maxAgeMs: (message: Message) => {
                    if (message.id === "60") throw policyError
                    if (message.id === "61") return Promise.reject(new Error("rejected policy")) as never
                    return undefined as never
                },
            },
        },
        onError: (report: FailureReport) => {
            reports.push(report)
            return busy
        },
    })
    const thrown = value(await client.messages.fetch({ id: "60", channelId: "20" }))
    expect(thrown.id).toBe("60")
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toMatchObject({ kind: "cache", error: policyError })
    expect(cached(client, thrown)).toBeUndefined()

    const invalid = value(await client.messages.fetch({ id: "61", channelId: "20" }))
    expect(invalid.id).toBe("61")
    const whileHeld = value(await client.messages.fetch({ id: "62", channelId: "20" }))
    expect(whileHeld.id).toBe("62")
    // Two completed fetches queued two more reports, and the busy hook still holds them in order
    expect(reports).toHaveLength(1)
    expect(cached(client, invalid)).toBeUndefined()
    release()
    await vi.waitFor(() => expect(reports).toHaveLength(3))
    expect(reports.map((report) => [report.kind, report.message?.id])).toEqual([
        ["cache", "60"],
        ["cache", "61"],
        ["cache", "62"],
    ])
    expect(reports[1]!.error).toBeInstanceOf(TypeError)
    expect(cached(client, whileHeld)).toBeUndefined()
    expect(client.diagnostics().counters.reportsDropped).toBe(0)
    await client.shutdown()
})

test.each(modes)(
    "%s cache policies contain rejected promises across realms and hostile properties without changing REST or events",
    async (mode) => {
        const server = await fixture()
        const reports: unknown[] = []
        const delivered: string[] = []
        const rejections: unknown[] = []
        const observe = (reason: unknown) => rejections.push(reason)
        process.on("unhandledRejection", observe)
        onTestFinished(() => {
            process.off("unhandledRejection", observe)
        })
        let foreign = false
        let hostile = false
        const policy = () => {
            const reason = new Error("private rejected policy")
            const rejected = foreign
                ? (runInNewContext("Promise.reject(reason)", { reason }) as Promise<never>)
                : Promise.reject(reason)
            if (hostile)
                for (const key of ["then", "catch"])
                    // oxlint-disable-next-line typescript/no-floating-promises -- defineProperty returns the rejected promise, which the policy returns below
                    Object.defineProperty(rejected, key, {
                        get() {
                            throw new Error("private policy property")
                        },
                    })
            return rejected as never
        }
        const scope = Scope.makeUnsafe()
        const options = { token, cache: { messages: { maxAgeMs: policy } } }
        const client =
            mode === "default"
                ? defaultApi({
                      ...options,
                      onError: (report: FailureReport) => {
                          reports.push(report)
                      },
                  })
                : await Effect.runPromise(
                      createNative({
                          ...options,
                          onError: (report) =>
                              Effect.sync(() => {
                                  reports.push(report)
                              }),
                      }).pipe(Scope.provide(scope)),
                  )
        onTestFinished(async () => {
            if (mode === "native") {
                await Effect.runPromise((client as NativeClient).shutdown())
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        })
        if (mode === "default") {
            ;(client as Client).on("messageCreate", (message) => {
                delivered.push(message.id)
            })
            value(await (client as Client).connect())
        } else {
            await Effect.runPromise(
                (client as NativeClient)
                    .on("messageCreate", (message) =>
                        Effect.sync(() => {
                            delivered.push(message.id)
                        }),
                    )
                    .pipe(Scope.provide(scope)),
            )
            await Effect.runPromise((client as NativeClient).connect())
        }
        let id = 100
        for (foreign of [false, true])
            for (hostile of [false, true]) {
                const reference = { id: String(id++), channelId: "20" }
                const result =
                    mode === "default"
                        ? value(await (client as Client).messages.fetch(reference))
                        : await Effect.runPromise((client as NativeClient).messages.fetch(reference))
                expect(result.id).toBe(reference.id)
                const retained =
                    mode === "default"
                        ? cached(client as Client, reference)
                        : await Effect.runPromise((client as NativeClient).messages.get(reference))
                expect(retained).toBeUndefined()
                await vi.waitFor(() => expect(reports).toHaveLength((id - 100) * 2 - 1))
                server.dispatch("MESSAGE_CREATE", wire(reference.id, "20"))
                await vi.waitFor(() => {
                    expect(delivered).toContain(reference.id)
                    expect(reports).toHaveLength((id - 100) * 2)
                })
                await turn()
                expect(rejections).toEqual([])
            }
        // Each report names the REST or gateway message whose duration callback failed
        expect(reports).toEqual(
            Array.from({ length: 8 }, (_, index) =>
                expect.objectContaining({
                    kind: "cache",
                    error: expect.any(TypeError),
                    message: { id: String(100 + Math.floor(index / 2)), channelId: "20" },
                }),
            ),
        )
        expect((client as Client | NativeClient).state).toBe("Connected")
    },
)

test("native onError captures creation context, queues reports in order and is interrupted before shutdown returns", async () => {
    const server = await fixture()
    const reports: NativeFailureReport[] = []
    const annotations: unknown[] = []
    const logs: LogRecord[] = []
    let cleaned = false
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token,
                    logging: { level: "error", sink: (record) => logs.push(record) },
                    cache: {
                        messages: {
                            maxAgeMs: () => {
                                throw new Error("native policy detail")
                            },
                        },
                    },
                    onError: (report) =>
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
                }).pipe(Effect.annotateLogs("cacheCreation", "creation"))
                // Cache intake precedes event delivery, so a callback that sees 71 proves its report was already queued
                const delivered: string[] = []
                yield* client.on("messageCreate", (message) =>
                    Effect.sync(() => {
                        delivered.push(message.id)
                    }),
                )
                yield* client.connect().pipe(Effect.annotateLogs("cacheCreation", "connection"))
                server.dispatch("MESSAGE_CREATE", wire("70", "20", "private first"))
                yield* Effect.promise(() => vi.waitFor(() => expect(reports).toHaveLength(1)))
                server.dispatch("MESSAGE_CREATE", wire("71", "20", "private second"))
                yield* Effect.promise(() => waitUntil(() => delivered.includes("71")))
                expect(reports).toHaveLength(1)
                expect(reports[0]).toMatchObject({ kind: "cache", error: { message: "native policy detail" } })
                expect(reports[0]!.cause.reasons).toHaveLength(1)
                expect(annotations).toEqual(["creation"])
                expect(yield* client.messages.get({ id: "70", channelId: "20" })).toBeUndefined()
                yield* client.shutdown()
            }),
        ),
    )
    expect(cleaned).toBe(true)
    // Shutdown logs both the report whose hook it interrupted and the queued second report, dropping neither
    expect(
        logs
            .filter((record) => record.code === "cache.policyFailed")
            .map((record) => [record.level, record.fields?.messageId, record.fields?.reportOutcome]),
    ).toEqual([
        ["error", "70", "interrupted"],
        ["error", "71", "clientClosed"],
    ])
    expect(JSON.stringify(logs)).not.toContain("private second")
})

test("native onError shutdown does not wait on its own report fiber", async () => {
    const server = await fixture()
    let entered = false
    let cleaned = false
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let client!: NativeClient
                client = yield* createNative({
                    token,
                    cache: {
                        messages: {
                            maxAgeMs: () => {
                                throw new Error("self-shutdown policy detail")
                            },
                        },
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
    const client = defaultApi({ token, cache: { messages: true } })
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
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 6)).toBe(true))
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
    const client = defaultApi({ token, cache: { messages: true } })
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
    // Four held reads fill every REST slot, so the fifth waits for local admission; a dispatch ends the wait early
    await waitUntil(() => client.diagnostics().rest.queuedRequests === 1 || server.requests.length > 4)
    expect(server.requests).toHaveLength(4)
    server.closeCurrentSocket()
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 6)).toBe(true))
    // The fetch is still waiting for admission after the gap, because every slot is still held
    expect(server.requests).toHaveLength(4)
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
        const clock = sdkClock()
        const server = await fixture()
        const client = defaultApi({ token, cache: { messages: true } })
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
        await clock.waiting(1_200)
        server.closeCurrentSocket()
        await resumeInsideRetryWait(clock, server)
        const result = value(await waiting)
        expect(result.content).toBe("after rate wait")
        expect(attempts).toBe(2)
        expect(cached(client, target)).toBeUndefined()
    },
)

/**
 * Move SDK time through the gateway gap while a 1.2 s Retry-After wait is pending. The pinned jitter makes the first
 * recovery wait 500 ms, so the Resume starts inside the retry wait and the retry is released only afterwards
 */
async function resumeInsideRetryWait(clock: SdkClock, server: Awaited<ReturnType<typeof fixture>>) {
    await clock.waiting(500)
    await clock.advance(500)
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 6)).toBe(true))
    expect(server.requests).toHaveLength(1)
    await clock.advance(700)
}

test("native read retries retain the pre-gap cache generation", async () => {
    const clock = sdkClock()
    const server = await fixture()
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token,
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
                yield* Effect.promise(() => clock.waiting(1_200))
                server.closeCurrentSocket()
                yield* Effect.promise(() => resumeInsideRetryWait(clock, server))
                expect((yield* Effect.promise(() => waiting)).content).toBe("after retry")
                expect(attempts).toBe(2)
                expect(yield* client.messages.get(target)).toBeUndefined()
            }),
        ),
    )
})

test("only a dispatched uncertain edit evicts a retained target", async () => {
    const server = await fixture()
    const client = defaultApi({ token, cache: { messages: true } })
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
    const client = defaultApi({ token, cache: { messages: true } })
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
    const client = defaultApi({ token, cache: { messages: true } })
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
    expect(error).toMatchObject({ reasons: [expect.objectContaining({ kind: "Defect" })] })
    expect(JSON.stringify(error)).toContain("private cache accounting defect")
    expect(cached(client, target)).toBeUndefined()
})

test.each(modes)("%s cache conflicts include embeds, attachments, pin state and webhook identity", async (mode) => {
    const server = await fixture()
    const regular = mode === "default" ? defaultApi({ token, cache: { messages: true } }) : undefined
    const native = mode === "native" ? await nativeApi({ token, cache: { messages: true } }) : undefined
    const get = async () => (regular ? regular.messages.get(target) : Effect.runPromise(native!.messages.get(target)))
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
})

test("overlapping writes preserve only an identical observed snapshot and leave other channels untouched", async () => {
    const server = await fixture()
    const client = defaultApi({ token, cache: { messages: true } })
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
    const client = defaultApi({ token, cache: { messages: true } })
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

test.each(modes)("%s send keeps its gateway echo when the HTTP response omits only the guild ID", async (mode) => {
    const server = await fixture()
    const regular = mode === "default" ? defaultApi({ token, cache: { messages: true } }) : undefined
    const native = mode === "native" ? await nativeApi({ token, cache: { messages: true } }) : undefined
    const get = async (reference: MessageReference) =>
        regular ? regular.messages.get(reference) : Effect.runPromise(native!.messages.get(reference))
    const send = (content: string) =>
        regular
            ? Promise.resolve(regular.messages.send("20", { content })).then(value)
            : Effect.runPromise(native!.messages.send("20", { content }))
    if (regular) value(await regular.connect())
    else await Effect.runPromise(native!.connect())

    // Fluxer's message HTTP responses omit guild_id, while the gateway echo can arrive first and include it
    for (const [id, gatewayContent, expected] of [
        ["93", "echoed", "echoed"],
        ["94", "changed by gateway", undefined],
    ] as const) {
        let reply!: () => void
        server.control.respond = (request) => {
            reply = () => request.response.end(JSON.stringify(wire(id, "20", "echoed")))
        }
        const before = server.requests.length
        const pending = send("echoed")
        await vi.waitFor(() => expect(server.requests).toHaveLength(before + 1))
        server.dispatch("MESSAGE_CREATE", { ...wire(id, "20", gatewayContent), guild_id: "40" })
        await vi.waitFor(async () => expect(await get({ id, channelId: "20" })).toBeDefined())
        reply()
        expect((await pending).guildId).toBeUndefined()
        const retained = await get({ id, channelId: "20" })
        if (expected === undefined) expect(retained).toBeUndefined()
        else expect(retained).toMatchObject({ id, content: expected, guildId: "40" })
    }
})

test.each(modes)(
    "%s cache.onChange reports message snapshots written by REST results and gateway events",
    async (mode) => {
        const server = await fixture()
        const changes: CacheChange[] = []
        if (mode === "default") {
            const client = defaultApi({ token, cache: { messages: true } })
            client.cache.onChange((change) => void changes.push(change))
            value(await client.messages.fetch(target))
            value(await client.connect())
        } else {
            const client = await nativeApi({ token, cache: { messages: true } })
            const scope = Scope.makeUnsafe()
            onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
            await Effect.runPromise(
                Effect.gen(function* () {
                    yield* client.cache.onChange((change) => Effect.sync(() => void changes.push(change)))
                    yield* client.messages.fetch(target)
                    yield* client.connect()
                }).pipe(Scope.provide(scope)),
            )
        }
        server.dispatch("MESSAGE_CREATE", wire("11", "20"))
        server.dispatch("MESSAGE_DELETE", { id: "10", channel_id: "20" })
        await vi.waitFor(() =>
            expect(changes).toEqual([
                { kind: "messages", op: "set", key: "20:10" },
                { kind: "messages", op: "set", key: "20:11" },
                { kind: "messages", op: "delete", key: "20:10" },
            ]),
        )
    },
)
