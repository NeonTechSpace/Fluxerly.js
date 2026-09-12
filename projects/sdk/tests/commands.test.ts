import { once } from "node:events"
import { createServer } from "node:http"
import { Context, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { commands, createClient, SdkDefect, type Client, type DefaultPrefixCommand } from "../src/index.js"
import { commands as nativeCommands, createClient as createNative } from "../src/effect.js"
import { WebSocketServer } from "ws"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const transport = vi.hoisted(() => ({ url: "", socket: undefined as import("ws").WebSocket | undefined }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(_url: string, options: import("ws").ClientOptions) {
                super(transport.url, options)
                transport.socket = this
            }
        },
    }
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    transport.socket = undefined
})

function value<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

async function fixture() {
    let sequence = 0
    const sockets: import("ws").WebSocket[] = []
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const packet = JSON.parse(data.toString())
            if (packet.op === 2)
                socket.send(JSON.stringify({ op: 0, s: ++sequence, t: "READY", d: { session_id: "fixture" } }))
            if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture port missing")
    transport.url = `ws://127.0.0.1:${address.port}`
    stubFetchWithHostedDiscovery((url) => {
        throw new Error(`Unexpected command fixture HTTP request ${url}`)
    })
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
        deliver(content: string, isBot = false, guildId?: string) {
            const wire = {
                id: `${sequence + 100}`,
                channel_id: "20",
                content,
                author: { id: "30", username: "fixture", bot: isBot },
                ...(guildId === undefined ? {} : { guild_id: guildId }),
            }
            transport.socket!.emit(
                "message",
                Buffer.from(JSON.stringify({ op: 0, s: ++sequence, t: "MESSAGE_CREATE", d: wire })),
                false,
            )
        },
    }
}

async function defaultClient(): Promise<Client> {
    const client = value(createClient({ token: "fixture-only-not-a-credential" }))
    onTestFinished(async () => {
        value(await client.shutdown())
    })
    value(await client.connect())
    return client
}

async function nativeClient() {
    const scope = Scope.makeUnsafe()
    const registration = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createNative({ token: "fixture-only-not-a-credential" }).pipe(Scope.provide(scope)),
    )
    onTestFinished(async () => {
        await Effect.runPromise(Scope.close(registration, Exit.void))
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    await Effect.runPromise(client.connect())
    return { client, scope, registration }
}

test("default command router uses the existing subscription for longest prefix, aliases, guards and cooldowns", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const received: { prefix: string; args: readonly string[]; rawArgs: string; signal: AbortSignal }[] = []
    const errors: unknown[] = []
    const cooldowns = value(commands.memoryCooldowns({ maxEntries: 1 }))
    let router = value(
        commands.create({
            prefix: ["!", "!!"],
            parse: ({ source }) => {
                if (source.trim() === "skip") return undefined
                const [name = "", ...args] = source.trim().split("|")
                return { name, args, rawArgs: args.join("|") }
            },
        }),
    )
    router = value(
        router.register({
            name: "ping",
            aliases: ["p"],
            cooldown: { store: cooldowns, durationMs: 60_000 },
            execute: ({ prefix, args, rawArgs, signal }) => {
                received.push({ prefix, args, rawArgs, signal: signal as AbortSignal })
            },
        }),
    )
    router = value(
        router.register({
            name: "blocked",
            guard: () => false,
            execute: () => {
                received.push({} as never)
            },
        }),
    )
    router = value(
        router.register({ name: "broken", execute: () => Promise.reject(new Error("private command failure")) }),
    )
    value(
        router.attach(client, {
            onError: (report) => {
                errors.push(report)
            },
        }),
    )

    remote.deliver("!!P|one|two")
    remote.deliver("!!PING|ignored")
    remote.deliver("!!blocked")
    remote.deliver("!!ping|bot", true)
    remote.deliver("!!skip")
    remote.deliver("!!broken")

    await vi.waitFor(() => expect(received).toHaveLength(1))
    await vi.waitFor(() => expect(errors).toEqual([{ event: "messageCreate", kind: "handler" }]))
    expect(received[0]).toMatchObject({ prefix: "!!", args: ["one", "two"], rawArgs: "one|two" })
    expect(received[0]!.signal.aborted).toBe(false)
    expect(cooldowns.size).toBe(1)
    expect(value(cooldowns.claim({ key: "another", durationMs: 1 }))._tag).toBe("CooldownCapacity")
    cooldowns.clear()
    expect(cooldowns.size).toBe(0)
})

test("default command feedback receives frozen context and cooldown retry information without executing", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const feedback: { content: string; tag: string; retryAtMs?: number | null }[] = []
    const executed: string[] = []
    const store = value(commands.memoryCooldowns({ maxEntries: 1 }))
    let router = value(commands.create({ prefix: "!" }))
    router = value(
        router.register({
            name: "blocked",
            guard: () => false,
            onReject: ({ message }, rejection) => {
                feedback.push({ content: message.content, tag: rejection._tag })
            },
            execute: () => {
                executed.push("blocked")
            },
        }),
    )
    router = value(
        router.register({
            name: "active",
            cooldown: { store, durationMs: 60_000 },
            onReject: ({ message }, rejection) => {
                const retryAtMs = rejection._tag === "CommandGuardRejected" ? undefined : rejection.retryAtMs
                feedback.push({
                    content: message.content,
                    tag: rejection._tag,
                    ...(retryAtMs === undefined ? {} : { retryAtMs }),
                })
            },
            execute: () => {
                executed.push("active")
            },
        }),
    )
    router = value(
        router.register({
            name: "capacity",
            cooldown: { store, durationMs: 60_000 },
            onReject: ({ message }, rejection) => {
                const retryAtMs = rejection._tag === "CommandGuardRejected" ? undefined : rejection.retryAtMs
                feedback.push({
                    content: message.content,
                    tag: rejection._tag,
                    ...(retryAtMs === undefined ? {} : { retryAtMs }),
                })
            },
            execute: () => {
                executed.push("capacity")
            },
        }),
    )
    value(router.attach(client))

    remote.deliver("!blocked")
    remote.deliver("!active")
    remote.deliver("!active")
    remote.deliver("!capacity")

    await vi.waitFor(() => expect(feedback).toHaveLength(3))
    expect(executed).toEqual(["active"])
    expect(feedback).toEqual([
        { content: "!blocked", tag: "CommandGuardRejected" },
        expect.objectContaining({ content: "!active", tag: "CommandCooldownActive", retryAtMs: expect.any(Number) }),
        expect.objectContaining({
            content: "!capacity",
            tag: "CommandCooldownCapacity",
            retryAtMs: expect.any(Number),
        }),
    ])
})

test("native command feedback preserves caller context and does not execute rejected handlers", async () => {
    const remote = await fixture()
    const { client, registration } = await nativeClient()
    const feedback: { content: string; tag: string; retryAtMs?: number | null }[] = []
    const executed: string[] = []
    const FeedbackService = Context.Service<{ readonly value: "native-context" }>("command-feedback")
    const store = await Effect.runPromise(nativeCommands.memoryCooldowns({ maxEntries: 1 }))
    let router = await Effect.runPromise(nativeCommands.create({ prefix: "!" }))
    router = await Effect.runPromise(
        router.register({
            name: "blocked",
            guard: () => Effect.succeed(false),
            onReject: ({ message }, rejection) =>
                Effect.service(FeedbackService).pipe(
                    Effect.tap(({ value }) =>
                        Effect.sync(() =>
                            feedback.push({ content: `${value}:${message.content}`, tag: rejection._tag }),
                        ),
                    ),
                ),
            execute: () => Effect.sync(() => executed.push("blocked")),
        }),
    )
    router = await Effect.runPromise(
        router.register({
            name: "active",
            cooldown: { store, durationMs: 60_000 },
            onReject: ({ message }, rejection) =>
                Effect.sync(() => {
                    const retryAtMs = rejection._tag === "CommandGuardRejected" ? undefined : rejection.retryAtMs
                    feedback.push({
                        content: message.content,
                        tag: rejection._tag,
                        ...(retryAtMs === undefined ? {} : { retryAtMs }),
                    })
                }),
            execute: () => Effect.sync(() => executed.push("active")),
        }),
    )
    router = await Effect.runPromise(
        router.register({
            name: "capacity",
            cooldown: { store, durationMs: 60_000 },
            onReject: ({ message }, rejection) =>
                Effect.sync(() => {
                    const retryAtMs = rejection._tag === "CommandGuardRejected" ? undefined : rejection.retryAtMs
                    feedback.push({
                        content: message.content,
                        tag: rejection._tag,
                        ...(retryAtMs === undefined ? {} : { retryAtMs }),
                    })
                }),
            execute: () => Effect.sync(() => executed.push("capacity")),
        }),
    )
    await Effect.runPromise(
        router
            .attach(client)
            .pipe(Effect.provideService(FeedbackService, { value: "native-context" }), Scope.provide(registration)),
    )
    remote.deliver("!blocked")
    remote.deliver("!active")
    remote.deliver("!active")
    remote.deliver("!capacity")
    await vi.waitFor(() => expect(feedback).toHaveLength(3))
    expect(executed).toEqual(["active"])
    expect(feedback).toEqual([
        { content: "native-context:!blocked", tag: "CommandGuardRejected" },
        expect.objectContaining({ content: "!active", tag: "CommandCooldownActive", retryAtMs: expect.any(Number) }),
        expect.objectContaining({
            content: "!capacity",
            tag: "CommandCooldownCapacity",
            retryAtMs: expect.any(Number),
        }),
    ])
})

test("quoted parsing, metadata snapshots and application-owned prefix lookups remain independent", async () => {
    const parsed = commands.parseQuoted({
        message: {} as never,
        prefix: "!",
        source: 'run one "two words" \'three words\' four\\ five ""',
    })
    expect(parsed).toEqual({
        name: "run",
        rawArgs: 'one "two words" \'three words\' four\\ five ""',
        args: ["one", "two words", "three words", "four five", ""],
    })
    expect(commands.parseQuoted({ message: {} as never, prefix: "!", source: 'run "unterminated' })).toBeUndefined()
    expect(commands.parseQuoted({ message: {} as never, prefix: "!", source: "run trailing\\" })).toBeUndefined()

    const aliases = ["p"]
    const router = value(commands.create({ prefix: "!" }))
    const registered = value(
        router.register({
            name: "ping",
            aliases,
            description: "Checks reachability",
            usage: "[target]",
            execute: () => undefined,
        }),
    )
    aliases.push("later")
    expect(registered.commands).toEqual([
        { name: "ping", aliases: ["p"], description: "Checks reachability", usage: "[target]" },
    ])
    expect(Object.isFrozen(registered.commands)).toBe(true)
    expect(Object.isFrozen(registered.commands[0]!)).toBe(true)

    const remote = await fixture()
    const client = await defaultClient()
    const prefixes = new Map([["40", "!"]])
    const received: string[] = []
    const dynamic = value(commands.create({ prefix: (message) => prefixes.get(message.guildId ?? "") }))
    const attached = value(
        dynamic.register({
            name: "ping",
            execute: ({ prefix }) => {
                received.push(prefix)
            },
        }),
    )
    value(attached.attach(client))
    remote.deliver("!ping", false, "40")
    await vi.waitFor(() => expect(received).toEqual(["!"]))
    prefixes.set("40", "?")
    remote.deliver("?ping", false, "40")
    await vi.waitFor(() => expect(received).toEqual(["!", "?"]))
})

test("default unmatched feedback receives frozen outcomes after dynamic prefix matching without bot or chat noise", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const prefixes = new Map([["40", "!"]])
    const feedback: {
        readonly content: string
        readonly prefix: string
        readonly tag: string
        readonly name?: string
        readonly frozenContext: boolean
        readonly frozenOutcome: boolean
        readonly signal: AbortSignal
    }[] = []
    const executed: string[] = []
    const router = value(
        commands.create({
            prefix: (message) => prefixes.get(message.guildId ?? ""),
            parse: commands.parseQuoted,
            onUnmatched: (context, unmatched) => {
                feedback.push({
                    content: context.message.content,
                    prefix: context.prefix,
                    tag: unmatched._tag,
                    ...(unmatched._tag === "CommandUnknownName" ? { name: unmatched.name } : {}),
                    frozenContext: Object.isFrozen(context),
                    frozenOutcome: Object.isFrozen(unmatched),
                    signal: context.signal as AbortSignal,
                })
            },
        }),
    )
    const registered = value(
        router.register({
            name: "ping",
            execute: () => {
                executed.push("ping")
            },
        }),
    )
    value(registered.attach(client))

    remote.deliver("!missing", false, "40")
    remote.deliver('!ping "unterminated', false, "40")
    remote.deliver("!ping", true, "40")
    remote.deliver("chat", false, "40")
    await vi.waitFor(() => expect(feedback).toHaveLength(2))
    expect(feedback).toEqual([
        expect.objectContaining({
            content: "!missing",
            prefix: "!",
            tag: "CommandUnknownName",
            name: "missing",
            frozenContext: true,
            frozenOutcome: true,
        }),
        expect.objectContaining({
            content: '!ping "unterminated',
            prefix: "!",
            tag: "CommandParserRejected",
            frozenContext: true,
            frozenOutcome: true,
        }),
    ])
    expect(feedback.every((entry) => entry.signal.aborted === false)).toBe(true)
    expect(executed).toEqual([])

    const botFeedback: string[] = []
    const botRouter = value(
        commands.create({
            prefix: "!",
            ignoreBots: false,
            onUnmatched: (_context, unmatched) => {
                botFeedback.push(unmatched._tag)
            },
        }),
    )
    value(botRouter.attach(client))
    remote.deliver("!missing", true, "40")
    await vi.waitFor(() => expect(botFeedback).toEqual(["CommandUnknownName"]))
    expect(feedback).toHaveLength(2)

    prefixes.set("40", "?")
    remote.deliver("?missing", false, "40")
    remote.deliver("?ping", false, "40")
    await vi.waitFor(() => expect(feedback).toHaveLength(3))
    await vi.waitFor(() => expect(executed).toEqual(["ping"]))
    expect(feedback[2]).toMatchObject({ content: "?missing", prefix: "?", tag: "CommandUnknownName", name: "missing" })
})

test("native unmatched feedback preserves caller context across dynamic prefixes without bot or chat noise", async () => {
    const remote = await fixture()
    const { client, registration } = await nativeClient()
    const PrefixService = Context.Service<{ readonly value: "native-unmatched" }>("native-unmatched")
    const prefixes = new Map([["40", "!"]])
    const feedback: {
        readonly content: string
        readonly prefix: string
        readonly tag: string
        readonly value: string
    }[] = []
    const executed: string[] = []
    const router = await Effect.runPromise(
        nativeCommands.create({
            prefix: (message) => prefixes.get(message.guildId ?? ""),
            parse: nativeCommands.parseQuoted,
            onUnmatched: (context, unmatched) =>
                Effect.service(PrefixService).pipe(
                    Effect.tap(({ value }) =>
                        Effect.sync(() => {
                            expect(Object.isFrozen(context)).toBe(true)
                            expect(Object.isFrozen(unmatched)).toBe(true)
                            feedback.push({
                                content: context.message.content,
                                prefix: context.prefix,
                                tag: unmatched._tag,
                                value,
                            })
                        }),
                    ),
                ),
        }),
    )
    const registered = await Effect.runPromise(
        router.register({ name: "ping", execute: () => Effect.sync(() => executed.push("ping")) }),
    )
    await Effect.runPromise(
        registered
            .attach(client)
            .pipe(Effect.provideService(PrefixService, { value: "native-unmatched" }), Scope.provide(registration)),
    )

    remote.deliver("!missing", false, "40")
    remote.deliver('!ping "unterminated', false, "40")
    remote.deliver("!ping", true, "40")
    remote.deliver("chat", false, "40")
    await vi.waitFor(() => expect(feedback).toHaveLength(2))
    expect(feedback).toEqual([
        { content: "!missing", prefix: "!", tag: "CommandUnknownName", value: "native-unmatched" },
        { content: '!ping "unterminated', prefix: "!", tag: "CommandParserRejected", value: "native-unmatched" },
    ])
    expect(executed).toEqual([])

    prefixes.set("40", "?")
    remote.deliver("?missing", false, "40")
    remote.deliver("?ping", false, "40")
    await vi.waitFor(() => expect(feedback).toHaveLength(3))
    await vi.waitFor(() => expect(executed).toEqual(["ping"]))
    expect(feedback[2]).toEqual({
        content: "?missing",
        prefix: "?",
        tag: "CommandUnknownName",
        value: "native-unmatched",
    })
})

test("default unmatched callback failure reports safely and its signal stays cooperative after cancellation", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const errors: unknown[] = []
    const feedback: string[] = []
    let slowSignal: AbortSignal | undefined
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
        release = resolve
    })
    const router = value(
        commands.create({
            prefix: "!",
            onUnmatched: (context, unmatched) => {
                if (unmatched._tag === "CommandUnknownName" && unmatched.name === "broken")
                    return Promise.reject(new Error("private unmatched feedback failure"))
                if (unmatched._tag === "CommandUnknownName" && unmatched.name === "slow") {
                    slowSignal = context.signal as AbortSignal
                    return pending
                }
                feedback.push(unmatched._tag)
            },
        }),
    )
    const subscription = value(
        router.attach(client, {
            onError: (report) => {
                errors.push(report)
            },
        }),
    )
    remote.deliver("!broken")
    remote.deliver("!missing")
    await vi.waitFor(() => expect(errors).toEqual([{ event: "messageCreate", kind: "handler" }]))
    await vi.waitFor(() => expect(feedback).toEqual(["CommandUnknownName"]))
    remote.deliver("!slow")
    await vi.waitFor(() => expect(slowSignal).toBeDefined())
    subscription.unsubscribe()
    expect(slowSignal!.aborted).toBe(true)
    release!()
})

test("native unmatched callback failure reports safely and registration-scope cancellation stops later feedback", async () => {
    const remote = await fixture()
    const { client, registration } = await nativeClient()
    const errors: string[] = []
    const feedback: string[] = []
    const router = await Effect.runPromise(
        nativeCommands.create({
            prefix: "!",
            onUnmatched: (_context, unmatched) =>
                unmatched._tag === "CommandUnknownName" && unmatched.name === "broken"
                    ? Effect.die("private unmatched feedback failure")
                    : Effect.sync(() => feedback.push(unmatched._tag)),
        }),
    )
    await Effect.runPromise(
        router
            .attach(client, {
                onError: () =>
                    Effect.sync(() => {
                        errors.push("handler")
                    }),
            })
            .pipe(Scope.provide(registration)),
    )
    remote.deliver("!broken")
    remote.deliver("!missing")
    await vi.waitFor(() => expect(errors).toEqual(["handler"]))
    await vi.waitFor(() => expect(feedback).toEqual(["CommandUnknownName"]))
    await Effect.runPromise(Scope.close(registration, Exit.void))
    remote.deliver("!missing")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(feedback).toEqual(["CommandUnknownName"])
})

test("default rejection callback defects use subscription reporting without handler execution", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const errors: unknown[] = []
    const executed: string[] = []
    let router = value(commands.create({ prefix: "!" }))
    router = value(
        router.register({
            name: "broken-feedback",
            guard: () => false,
            onReject: () => Promise.reject(new Error("private feedback failure")),
            execute: () => {
                executed.push("handler")
            },
        }),
    )
    value(
        router.attach(client, {
            onError: (report) => {
                errors.push(report)
            },
        }),
    )
    remote.deliver("!broken-feedback")
    await vi.waitFor(() => expect(errors).toEqual([{ event: "messageCreate", kind: "handler" }]))
    expect(executed).toEqual([])
})

test("native rejection callback defects use subscription reporting without handler execution", async () => {
    const remote = await fixture()
    const { client, registration } = await nativeClient()
    const errors: string[] = []
    const executed: string[] = []
    let router = await Effect.runPromise(nativeCommands.create({ prefix: "!" }))
    router = await Effect.runPromise(
        router.register({
            name: "broken-feedback",
            guard: () => Effect.succeed(false),
            onReject: () => Effect.die("private feedback failure"),
            execute: () => Effect.sync(() => executed.push("handler")),
        }),
    )
    await Effect.runPromise(
        router
            .attach(client, {
                onError: () =>
                    Effect.sync(() => {
                        errors.push("handler")
                    }),
            })
            .pipe(Scope.provide(registration)),
    )
    remote.deliver("!broken-feedback")
    await vi.waitFor(() => expect(errors).toEqual(["handler"]))
    expect(executed).toEqual([])
})

test("native command router preserves the registration scope and executes handler Effects without a detached runtime", async () => {
    const remote = await fixture()
    const { client, registration } = await nativeClient()
    const received: string[] = []
    const prefixes = new Map([["40", "!"]])
    let router = await Effect.runPromise(
        nativeCommands.create({ prefix: (message) => prefixes.get(message.guildId ?? ""), ignoreBots: false }),
    )
    router = await Effect.runPromise(
        router.register({
            name: "ping",
            execute: ({ name, rawArgs }) => Effect.sync(() => received.push(`${name}:${rawArgs}`)),
        }),
    )
    await Effect.runPromise(router.attach(client).pipe(Scope.provide(registration)))

    remote.deliver("!PING first second", false, "40")
    await vi.waitFor(() => expect(received).toEqual(["ping:first second"]))
    prefixes.set("40", "?")
    remote.deliver("?ping second", false, "40")
    await vi.waitFor(() => expect(received).toEqual(["ping:first second", "ping:second"]))
    await Effect.runPromise(Scope.close(registration, Exit.void))
    remote.deliver("?ping after-close", false, "40")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received).toEqual(["ping:first second", "ping:second"])
})

test("command configuration and local cooldown limits fail without retaining arbitrary prefix or message data", async () => {
    const invalid = commands.create({ prefix: "" })
    expect(invalid.isErr() && invalid.error.field).toBe("prefix")
    const store = value(commands.memoryCooldowns({ maxEntries: 1 }))
    const first = value(store.claim({ key: "only", durationMs: 60_000 }))
    expect(first._tag).toBe("CooldownAcquired")
    expect(value(store.claim({ key: "only", durationMs: 60_000 }))._tag).toBe("CooldownActive")
    expect(value(store.claim({ key: "other", durationMs: 60_000 }))._tag).toBe("CooldownCapacity")
    const malformed = store.claim({ key: "", durationMs: 60_000 })
    expect(malformed.isErr() && malformed.error.field).toBe("cooldown")
    const nullCapacity = commands.memoryCooldowns({ maxEntries: null } as never)
    expect(nullCapacity.isErr() && nullCapacity.error.field).toBe("maxEntries")
    const getterInput = {
        get key(): string {
            throw new Error("private cooldown getter")
        },
        durationMs: 1,
    }
    expect(() => store.claim(getterInput as never)).toThrow(SdkDefect)
    try {
        store.claim(getterInput as never)
    } catch (error) {
        expect(error).toMatchObject({ operation: "commands", reasons: [{ kind: "Defect" }] })
        expect((error as Error).message).not.toContain("private cooldown getter")
    }
    store.clear()
    const nativeInvalid = await Effect.runPromise(Effect.result(nativeCommands.memoryCooldowns({ maxEntries: 0 })))
    expect(nativeInvalid._tag).toBe("Failure")
})

test("default registration leaves the original alias and its existing attachment unchanged", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const received: string[] = []
    const original = value(commands.create({ prefix: "!" }))
    const originalAlias = original
    expect(Object.isFrozen(original)).toBe(true)
    expect(Reflect.ownKeys(original)).toEqual([])
    value(original.attach(client))
    const extended = value(
        original.register({
            name: "ping",
            execute: () => {
                received.push("extended")
            },
        }),
    )
    expect(Object.isFrozen(extended)).toBe(true)
    value(extended.attach(client))

    remote.deliver("!ping")
    await vi.waitFor(() => expect(received).toEqual(["extended"]))
    expect(originalAlias).toBe(original)
})

test("native registration keeps earlier router attachments and environments independent", async () => {
    const remote = await fixture()
    const { client, registration } = await nativeClient()
    const received: string[] = []
    const original = await Effect.runPromise(nativeCommands.create({ prefix: "!" }))
    expect(Object.isFrozen(original)).toBe(true)
    expect(Reflect.ownKeys(original)).toEqual([])
    await Effect.runPromise(original.attach(client).pipe(Scope.provide(registration)))
    const extended = await Effect.runPromise(
        original.register({ name: "ping", execute: () => Effect.sync(() => received.push("extended")) }),
    )
    expect(Object.isFrozen(extended)).toBe(true)
    await Effect.runPromise(extended.attach(client).pipe(Scope.provide(registration)))

    remote.deliver("!ping")
    await vi.waitFor(() => expect(received).toEqual(["extended"]))
})

test("command snapshots copy metadata while retaining only registered callback and store references", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const received: string[] = []
    const aliases = ["p"]
    const definition = {
        name: "ping",
        aliases,
        execute: () => {
            received.push("initial")
        },
    } satisfies DefaultPrefixCommand
    const router = value(commands.create({ prefix: "!" }))
    const registered = value(router.register(definition))
    definition.name = "changed"
    aliases.push("later")
    definition.execute = () => {
        received.push("changed")
    }
    value(registered.attach(client))

    remote.deliver("!p")
    remote.deliver("!later")
    await vi.waitFor(() => expect(received).toEqual(["initial"]))
})

test("sparse command arrays reject configuration and the default parser ignores unknown or invalid command-shaped chat", async () => {
    const sparsePrefix: string[] = []
    sparsePrefix[1] = "!"
    const invalidPrefix = commands.create({ prefix: sparsePrefix })
    expect(invalidPrefix.isErr() && invalidPrefix.error.field).toBe("prefix")

    const router = value(commands.create({ prefix: "!" }))
    const sparseAliases: string[] = []
    sparseAliases[1] = "p"
    const invalidAliases = router.register({ name: "ping", aliases: sparseAliases, execute: () => undefined })
    expect(invalidAliases.isErr() && invalidAliases.error.field).toBe("aliases")

    const remote = await fixture()
    const client = await defaultClient()
    const received: string[] = []
    const errors: unknown[] = []
    const registered = value(
        router.register({
            name: "ping",
            execute: () => {
                received.push("ping")
            },
        }),
    )
    value(
        registered.attach(client, {
            onError: (report) => {
                errors.push(report)
            },
        }),
    )
    remote.deliver("!missing")
    remote.deliver("!💥")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received).toEqual([])
    expect(errors).toEqual([])
})

test("custom parser sparse arguments and nonboolean guards report safely without execution", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const errors: unknown[] = []
    const executed: string[] = []
    const sparseArgs: string[] = []
    sparseArgs[1] = "later"
    let router = value(
        commands.create({
            prefix: "!",
            parse: ({ source }) =>
                source.trim() === "parse"
                    ? { name: "parse", args: sparseArgs, rawArgs: "later" }
                    : { name: "guard", args: [], rawArgs: "" },
        }),
    )
    router = value(
        router.register({
            name: "parse",
            execute: () => {
                executed.push("parse")
            },
        }),
    )
    router = value(
        router.register({
            name: "guard",
            guard: () => 1 as never,
            execute: () => {
                executed.push("guard")
            },
        }),
    )
    value(
        router.attach(client, {
            onError: (report) => {
                errors.push(report)
            },
        }),
    )
    remote.deliver("!parse")
    remote.deliver("!guard")
    await vi.waitFor(() => expect(errors).toHaveLength(2))
    expect(executed).toEqual([])
})

test("default cancellation during a guard prevents execution after the guard settles", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const executed: string[] = []
    let release: ((allowed: boolean) => void) | undefined
    const gate = new Promise<boolean>((resolve) => {
        release = resolve
    })
    let router = value(commands.create({ prefix: "!" }))
    router = value(
        router.register({
            name: "ping",
            guard: () => gate,
            execute: () => {
                executed.push("execute")
            },
        }),
    )
    const subscription = value(router.attach(client))
    remote.deliver("!ping")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    subscription.unsubscribe()
    release!(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(executed).toEqual([])
})

test("default cancellation during a guard prevents late rejection feedback", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const feedback: string[] = []
    let entered = false
    let release: ((allowed: boolean) => void) | undefined
    const gate = new Promise<boolean>((resolve) => {
        release = resolve
    })
    let router = value(commands.create({ prefix: "!" }))
    router = value(
        router.register({
            name: "blocked",
            guard: () => {
                entered = true
                return gate
            },
            onReject: () => {
                feedback.push("feedback")
            },
            execute: () => {
                throw new Error("blocked handler executed")
            },
        }),
    )
    const subscription = value(router.attach(client))
    remote.deliver("!blocked")
    await vi.waitFor(() => expect(entered).toBe(true))
    subscription.unsubscribe()
    release!(false)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(feedback).toEqual([])
})

test("default cancellation during cooldown admission prevents execution after the claim settles", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const executed: string[] = []
    let release: ((claim: { _tag: "CooldownAcquired"; retryAtMs: number }) => void) | undefined
    const claim = new Promise<{ _tag: "CooldownAcquired"; retryAtMs: number }>((resolve) => {
        release = resolve
    })
    const store = { claim: () => claim }
    let router = value(commands.create({ prefix: "!" }))
    router = value(
        router.register({
            name: "ping",
            cooldown: { store, durationMs: 1_000 },
            execute: () => {
                executed.push("execute")
            },
        }),
    )
    const subscription = value(router.attach(client))
    remote.deliver("!ping")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    subscription.unsubscribe()
    release!({ _tag: "CooldownAcquired", retryAtMs: Date.now() + 1_000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(executed).toEqual([])
})

test("native configuration keeps unexpected construction defects in the Effect cause", async () => {
    const options = {
        get prefix(): string {
            throw new Error("private fixture defect")
        },
    }
    const exit = await Effect.runPromiseExit(nativeCommands.create(options as never))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
})

test("default configuration hides unexpected getter defects behind SdkDefect commands", () => {
    const options = {
        get prefix(): string {
            throw new Error("private fixture defect")
        },
    }
    try {
        commands.create(options as never)
        throw new Error("Expected default creation to throw")
    } catch (error) {
        expect(error).toBeInstanceOf(SdkDefect)
        expect(error).toMatchObject({ operation: "commands", reasons: [{ kind: "Defect" }] })
        expect((error as Error).message).not.toContain("private fixture defect")
    }
})

test("default typed arguments convert after one guard and before cooldown without changing raw arguments", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const received: unknown[] = []
    const rejected: unknown[] = []
    let guardCalls = 0
    let cooldownCalls = 0
    const cooldown = {
        claim: () => {
            cooldownCalls += 1
            return { _tag: "CooldownAcquired" as const, retryAtMs: Date.now() + 1_000 }
        },
    }
    let router = value(commands.create({ prefix: "!" }))
    router = value(
        router.register({
            name: "typed",
            arguments: {
                word: { type: "text" },
                count: { type: "integer" },
                ratio: { type: "number" },
                enabled: { type: "boolean" },
                id: { type: "id" },
                mode: { type: "choice", choices: ["fast", "safe"] },
                note: { type: "text", optional: true },
                tail: { type: "text", rest: true, optional: true },
            } as const,
            guard: ({ args }) => {
                guardCalls += 1
                return args[1] === "-2"
            },
            cooldown: { store: cooldown, durationMs: 1_000 },
            onReject: (context, rejection) => {
                rejected.push({ context, rejection })
            },
            execute: ({ args, rawArgs, values }) => {
                const count: number = values.count
                const mode: "fast" | "safe" = values.mode
                received.push({ args, rawArgs, values: { ...values, count, mode }, frozen: Object.isFrozen(values) })
            },
        }),
    )
    value(router.attach(client))

    remote.deliver("!typed hello -2 1.25 true 900719925474099312345 fast note this is the tail")
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received).toEqual([
        {
            args: ["hello", "-2", "1.25", "true", "900719925474099312345", "fast", "note", "this", "is", "the", "tail"],
            rawArgs: "hello -2 1.25 true 900719925474099312345 fast note this is the tail",
            values: {
                word: "hello",
                count: -2,
                ratio: 1.25,
                enabled: true,
                id: "900719925474099312345",
                mode: "fast",
                note: "note",
                tail: "this is the tail",
            },
            frozen: true,
        },
    ])
    expect(guardCalls).toBe(1)
    expect(cooldownCalls).toBe(1)
    expect(rejected).toEqual([])
})

test("default typed argument rejection has safe details and never consumes a cooldown", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const rejects: unknown[] = []
    let guards = 0
    let cooldowns = 0
    let executed = 0
    let router = value(commands.create({ prefix: "!" }))
    router = value(
        router.register({
            name: "amount",
            arguments: { amount: { type: "integer" } } as const,
            guard: () => {
                guards += 1
                return true
            },
            cooldown: {
                store: {
                    claim: () => {
                        cooldowns += 1
                        return { _tag: "CooldownAcquired" as const, retryAtMs: Date.now() + 1_000 }
                    },
                },
                durationMs: 1_000,
            },
            onReject: (context, rejection) => {
                rejects.push({ args: context.args, hasValues: "values" in context, rejection })
            },
            execute: () => {
                executed += 1
            },
        }),
    )
    value(router.attach(client))

    remote.deliver("!amount private-not-a-number")
    await vi.waitFor(() => expect(rejects).toHaveLength(1))
    expect(rejects).toEqual([
        {
            args: ["private-not-a-number"],
            hasValues: false,
            rejection: { _tag: "CommandArgumentRejected", argument: "amount", reason: "Invalid" },
        },
    ])
    expect(guards).toBe(1)
    expect(cooldowns).toBe(0)
    expect(executed).toBe(0)
})

test("typed resource arguments use only explicit candidates, reject ambiguity and snapshot command metadata", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const candidates = [
        { id: "1", username: "same" },
        { id: "2", username: "same" },
        { id: "3", username: "unique", privateLabel: "not retained" },
    ]
    const selected: string[] = []
    const rejected: unknown[] = []
    let router = value(commands.create({ prefix: "!" }))
    router = value(
        router.register({
            name: "user",
            arguments: { target: { type: "user", candidates } },
            onReject: (_context, rejection) => {
                rejected.push(rejection)
            },
            execute: ({ values }) => {
                // @ts-expect-error Explicit candidates are projected to stable public fields
                void values.target.privateLabel
                selected.push(values.target.id)
            },
        }),
    )
    candidates[2]!.username = "changed"
    value(router.attach(client))

    remote.deliver("!user same")
    remote.deliver("!user <@3>")
    remote.deliver("!user 3")
    remote.deliver("!user changed")
    await vi.waitFor(() => expect(rejected).toHaveLength(2))
    expect(selected).toEqual(["3", "3"])
    expect(rejected).toEqual([
        { _tag: "CommandArgumentRejected", argument: "target", reason: "Ambiguous" },
        { _tag: "CommandArgumentRejected", argument: "target", reason: "Invalid" },
    ])
    expect(router.commands).toEqual([
        {
            name: "user",
            arguments: [{ name: "target", type: "user", optional: false, rest: false }],
        },
    ])
})

test("typed channel and role arguments accept anchored mentions and reject unmatched names", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const selected: string[] = []
    const rejected: unknown[] = []
    let router = value(commands.create({ prefix: "!" }))
    router = value(
        router.register({
            name: "move",
            arguments: {
                channel: { type: "channel", candidates: [{ id: "10", name: "general" }] },
                role: { type: "role", candidates: [{ id: "20", name: "moderator" }] },
            } as const,
            onReject: (_context, rejection) => {
                rejected.push(rejection)
            },
            execute: ({ values }) => {
                selected.push(`${values.channel.id}:${values.role.id}`)
            },
        }),
    )
    value(router.attach(client))

    remote.deliver("!move <#10> <@&20>")
    remote.deliver("!move 10 20")
    remote.deliver("!move missing moderator")
    await vi.waitFor(() => expect(rejected).toHaveLength(1))
    expect(selected).toEqual(["10:20", "10:20"])
    expect(rejected).toEqual([{ _tag: "CommandArgumentRejected", argument: "channel", reason: "Invalid" }])
})

test("typed arguments distinguish an omitted optional token from a supplied empty token", async () => {
    const remote = await fixture()
    const client = await defaultClient()
    const values: unknown[] = []
    const rejected: unknown[] = []
    let router = value(
        commands.create({
            prefix: "!",
            parse: ({ source }) => {
                const command = source.trim()
                return command === "empty"
                    ? { name: command, args: [""], rawArgs: '""' }
                    : command === "omitted"
                      ? { name: "empty", args: [], rawArgs: "" }
                      : { name: command, args: [], rawArgs: "" }
            },
        }),
    )
    router = value(
        router.register({
            name: "empty",
            arguments: { value: { type: "text", optional: true } } as const,
            onReject: (_context, rejection) => {
                rejected.push(rejection)
            },
            execute: ({ values: converted }) => {
                values.push(converted.value)
            },
        }),
    )
    value(router.attach(client))

    remote.deliver("!empty")
    remote.deliver("!omitted")
    await vi.waitFor(() => expect(rejected).toHaveLength(1))
    expect(values).toEqual([undefined])
    expect(rejected).toEqual([{ _tag: "CommandArgumentRejected", argument: "value", reason: "Invalid" }])
})

test("default registration rejects hidden schema keys and empty or oversized choice lists", () => {
    const router = value(commands.create({ prefix: "!" }))
    const hidden = Object.defineProperty({ choice: { type: "text" as const } }, "hidden", {
        enumerable: false,
        value: { type: "text" },
    })
    const hiddenResult = router.register({ name: "hidden", arguments: hidden, execute: () => undefined })
    const emptyResult = router.register({
        name: "empty",
        arguments: { choice: { type: "choice", choices: [] } },
        execute: () => undefined,
    })
    const oversizedResult = router.register({
        name: "oversized",
        arguments: { choice: { type: "choice", choices: Array.from({ length: 101 }, (_, index) => `${index}`) } },
        execute: () => undefined,
    })
    expect(hiddenResult.isErr() && hiddenResult.error.field).toBe("command")
    expect(emptyResult.isErr() && emptyResult.error.field).toBe("command")
    expect(oversizedResult.isErr() && oversizedResult.error.field).toBe("command")
})

test("native typed arguments reject supplied empty text but execute an omitted optional value", async () => {
    const remote = await fixture()
    const { client, registration } = await nativeClient()
    const values: unknown[] = []
    const rejected: unknown[] = []
    let router = await Effect.runPromise(
        nativeCommands.create({
            prefix: "!",
            parse: ({ source }) => {
                const command = source.trim()
                return command === "empty"
                    ? { name: command, args: [""], rawArgs: '""' }
                    : command === "omitted"
                      ? { name: "empty", args: [], rawArgs: "" }
                      : undefined
            },
        }),
    )
    router = await Effect.runPromise(
        router.register({
            name: "empty",
            arguments: { value: { type: "text", optional: true } } as const,
            onReject: (_context, rejection) =>
                Effect.sync(() => {
                    rejected.push(rejection)
                }),
            execute: ({ values: converted }) =>
                Effect.sync(() => {
                    values.push(converted.value)
                }),
        }),
    )
    await Effect.runPromise(router.attach(client).pipe(Scope.provide(registration)))

    remote.deliver("!empty")
    remote.deliver("!omitted")
    await vi.waitFor(() => expect(rejected).toHaveLength(1))
    expect(values).toEqual([undefined])
    expect(rejected).toEqual([{ _tag: "CommandArgumentRejected", argument: "value", reason: "Invalid" }])
})

test("native typed arguments preserve native execution and reject malformed input before cooldown", async () => {
    const remote = await fixture()
    const { client, registration } = await nativeClient()
    const values: number[] = []
    const rejected: unknown[] = []
    let cooldowns = 0
    let router = await Effect.runPromise(nativeCommands.create({ prefix: "!" }))
    router = await Effect.runPromise(
        router.register({
            name: "native-typed",
            arguments: { count: { type: "integer" }, rest: { type: "text", rest: true, optional: true } } as const,
            cooldown: {
                store: {
                    claim: () =>
                        Effect.sync(() => {
                            cooldowns += 1
                            return { _tag: "CooldownAcquired" as const, retryAtMs: Date.now() + 1_000 }
                        }),
                },
                durationMs: 1_000,
            },
            onReject: (_context, rejection) =>
                Effect.sync(() => {
                    rejected.push(rejection)
                }),
            execute: ({ values: converted }) =>
                Effect.sync(() => {
                    const count: number = converted.count
                    values.push(count)
                }),
        }),
    )
    await Effect.runPromise(router.attach(client).pipe(Scope.provide(registration)))

    remote.deliver("!native-typed no")
    remote.deliver("!native-typed 4 trailing words")
    await vi.waitFor(() => expect(values).toEqual([4]))
    expect(rejected).toEqual([{ _tag: "CommandArgumentRejected", argument: "count", reason: "Invalid" }])
    expect(cooldowns).toBe(1)
})
