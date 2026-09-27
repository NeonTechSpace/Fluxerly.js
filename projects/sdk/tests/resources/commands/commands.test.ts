import { Context, Effect, Exit, Scope } from "effect"
import { ResultAsync } from "neverthrow"
import { afterEach, expect, test, vi } from "vitest"
import {
    commands,
    ConfigurationError,
    SdkDefect,
    type DefaultPrefixCommand,
    type PrefixCommandRejection,
} from "../../../src/index.js"
import { commands as nativeCommands } from "../../../src/effect.js"
import { modes } from "../../support/both-apis.js"
import {
    act,
    attach,
    barrier,
    commandFixture,
    configurationError,
    connect,
    createRouter,
    defaultBarrier,
    nativeBarrier,
} from "./command-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

for (const api of modes) {
    test(`${api} batch validates original entry keys and ignores only inherited names`, () => {
        const entry = () => ({ arguments: {}, execute: () => (api === "native" ? Effect.void : undefined) })
        const good = Object.setPrototypeOf(
            entry(),
            Object.defineProperty({}, "name", {
                get() {
                    throw new Error("Inherited name must not be read")
                },
            }),
        )
        const bad = ["name", "privateOption", Symbol("unknown")].map((key) =>
            Object.defineProperty(entry(), key, { value: "invalid", enumerable: false }),
        )
        // Both styles register synchronously with the same batch rules, so one untyped view covers them
        const root = (
            api === "default" ? commands.create({ prefix: "!" }) : nativeCommands.create({ prefix: "!" })
        ) as {
            readonly commands: readonly unknown[]
            registerMany(batch: never): { readonly commands: readonly { readonly name: string }[] }
        }
        expect(root.registerMany({ keyed: good } as never).commands[0]?.name).toBe("keyed")
        for (const invalid of bad) configurationError(() => root.registerMany({ first: entry(), invalid } as never))
        expect(root.commands).toEqual([])
    })

    for (const storage of ["enumerable", "prototype", "nonenumerable", "getter"] as const) {
        for (const registrationMode of ["register", "registerMany"] as const) {
            test(`${api} ${registrationMode} preserves ${storage} command policies and validated field snapshots`, async () => {
                const remote = await commandFixture()
                const seen: string[] = []
                const executed: number[] = []
                const guards: string[] = []
                const claims: string[] = []
                const reads = new Map<string, number>()
                const adapt = <A>(thunk: () => A) => (api === "native" ? Effect.sync(thunk) : thunk())
                const definitions: Record<string, object> = {}
                const keys = ["guard", "arguments", "cooldown", "allowed"] as const
                for (const name of keys) {
                    const cooldown = {}
                    const cooldownFields = {
                        durationMs: 1000,
                        store: {
                            claim: () =>
                                adapt(() => {
                                    claims.push(name)
                                    return {
                                        _tag: name === "cooldown" ? "CooldownActive" : "CooldownAcquired",
                                        retryAtMs: Date.now() + 1000,
                                    }
                                }),
                        },
                        key: () => "fixture",
                    }
                    for (const [key, value] of Object.entries(cooldownFields)) {
                        Object.defineProperty(cooldown, key, {
                            enumerable: true,
                            get() {
                                const id = `${name}.cooldown.${key}`
                                const count = (reads.get(id) ?? 0) + 1
                                reads.set(id, count)
                                return count === 1 ? value : undefined
                            },
                        })
                    }
                    const fields = {
                        aliases: [`alias-${name}`],
                        description: `${name} policy`,
                        usage: "<count>",
                        arguments: { count: { type: "integer" } },
                        guard: () =>
                            adapt(() => {
                                guards.push(name)
                                return name !== "guard"
                            }),
                        cooldown,
                        onReject: (_context: unknown, rejection: { _tag: string }) =>
                            adapt(() => {
                                seen.push(`${name}:${rejection._tag}`)
                            }),
                    }
                    const definition = storage === "prototype" ? Object.create(fields) : {}
                    if (storage !== "prototype")
                        for (const [key, value] of Object.entries(fields)) {
                            Object.defineProperty(
                                definition,
                                key,
                                storage === "getter"
                                    ? {
                                          enumerable: true,
                                          get() {
                                              const id = `${name}.${key}`
                                              const count = (reads.get(id) ?? 0) + 1
                                              reads.set(id, count)
                                              return count === 1 ? value : undefined
                                          },
                                      }
                                    : { enumerable: storage === "enumerable", value },
                            )
                        }
                    // Keep execute enumerable so losing a guard cannot be masked by rejecting a missing action
                    definition.execute = ({ values }: { values: { count: number } }) =>
                        adapt(() => {
                            executed.push(values.count)
                            seen.push(name)
                        })
                    if (registrationMode === "register") definition.name = name
                    definitions[name] = definition
                }
                // Descriptor-built definitions exercise JavaScript shapes. Packed consumers own inference coverage
                if (api === "default") {
                    const { client } = await connect("default")
                    let router = commands.create({ prefix: "!" })
                    if (registrationMode === "registerMany") router = router.registerMany(definitions as never)
                    else
                        for (const definition of Object.values(definitions))
                            router = router.register(definition as never)
                    router.attach(client)
                } else {
                    const { client, registration } = await connect("native")
                    let router = nativeCommands.create({ prefix: "!" })
                    if (registrationMode === "registerMany") router = router.registerMany(definitions as never)
                    else
                        for (const definition of Object.values(definitions))
                            router = router.register(definition as never)
                    await Effect.runPromise(router.attach(client).pipe(Scope.provide(registration)))
                }
                remote.deliver("!alias-guard 2")
                remote.deliver("!alias-arguments invalid")
                remote.deliver("!alias-cooldown 2")
                remote.deliver("!alias-allowed 2")
                await vi.waitFor(() => expect(seen).toHaveLength(4))
                expect(seen).toEqual([
                    "guard:CommandGuardRejected",
                    "arguments:CommandArgumentRejected",
                    "cooldown:CommandCooldownActive",
                    "allowed",
                ])
                expect(executed).toEqual([2])
                expect(guards).toEqual(keys)
                expect(claims).toEqual(["cooldown", "allowed"])
                expect([...reads.values()].every((count) => count === 1)).toBe(true)
            })
        }
    }
}

test("default batch commands bind reply targets, Results and handler cancellation", async () => {
    const requests: Record<string, unknown>[] = []
    let requestSignal: AbortSignal | undefined
    let hold = false
    const remote = await commandFixture(async (_call, init) => {
        requests.push(JSON.parse(String(init.body)))
        requestSignal = init.signal as AbortSignal
        if (!hold)
            return Response.json(
                {
                    id: "901",
                    channel_id: "20",
                    content: "failed",
                    author: { id: "30", username: "fixture", bot: false },
                },
                { status: 400 },
            )
        return await new Promise<Response>((_resolve, reject) => {
            requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true })
        })
    })
    const { client } = await connect("default")
    const reports: unknown[] = []
    const root = commands.create({ prefix: "!" })
    const router = root.registerMany({
        ping: {
            arguments: {},
            execute: async ({ reply }) => {
                const sent = await reply({ content: "Pong" })
                if (sent.isErr()) throw sent.error
            },
        },
        raw: {
            execute: async ({ rawArgs, reply }) => {
                const sent = await reply({ content: rawArgs })
                if (sent.isErr()) throw sent.error
            },
        },
    })
    expect(root.commands).toEqual([])
    expect(router.commands.map((entry) => entry.name)).toEqual(["ping", "raw"])
    const subscription = router.attach(client, {
        onError: (report) => {
            reports.push(report)
        },
    })

    remote.deliver("!ping")
    await vi.waitFor(() =>
        expect(reports).toEqual([
            expect.objectContaining({
                event: "messageCreate",
                kind: "handler",
                command: "ping",
                message: expect.objectContaining({ channelId: "20" }),
                error: expect.anything(),
            }),
        ]),
    )
    expect(requests[0]).toMatchObject({
        content: "Pong",
        message_reference: { message_id: "101", channel_id: "20", type: 0 },
    })

    hold = true
    remote.deliver("!raw waiting")
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toMatchObject({
        content: "waiting",
        message_reference: { message_id: "102", channel_id: "20", type: 0 },
    })
    subscription.close()
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true))
})

test("default bound replies preserve lazy and inherited send options without dispatching invalid requests", async () => {
    let dispatches = 0
    const remote = await commandFixture(async () => {
        dispatches += 1
        return Response.json({})
    })
    const { client } = await connect("default")
    const outcomes: { readonly kind: string; readonly error: unknown }[] = []
    let throwingReads = 0
    let returnedResultAsync = false
    let inheritedReads = 0
    const nonenumerable = Object.defineProperty({}, "timeoutMs", { value: 0, enumerable: false })
    const inherited = Object.create({
        get timeoutMs() {
            inheritedReads += 1
            return 0
        },
    })
    const router = commands.create({ prefix: "!" }).registerMany({
        throwing: {
            arguments: {},
            execute: async ({ reply }) => {
                const options = Object.defineProperty({}, "timeoutMs", {
                    get(): number {
                        throwingReads += 1
                        throw new Error("private timeout getter")
                    },
                })
                try {
                    const operation = reply({ content: "not sent" }, options)
                    returnedResultAsync = operation instanceof ResultAsync
                    await operation
                } catch (error) {
                    outcomes.push({ kind: "throwing", error })
                }
            },
        },
        nonenumerable: {
            arguments: {},
            execute: async ({ reply }) => {
                const result = await reply({ content: "not sent" }, nonenumerable)
                outcomes.push({ kind: "nonenumerable", error: result.isErr() ? result.error : result.value })
            },
        },
        inherited: {
            arguments: {},
            execute: async ({ reply }) => {
                const result = await reply({ content: "not sent" }, inherited)
                outcomes.push({ kind: "inherited", error: result.isErr() ? result.error : result.value })
            },
        },
        array: {
            arguments: {},
            execute: async ({ reply }) => {
                const result = await reply({ content: "not sent" }, [] as never)
                outcomes.push({ kind: "array", error: result.isErr() ? result.error : result.value })
            },
        },
    })
    router.attach(client)

    remote.deliver("!throwing")
    remote.deliver("!nonenumerable")
    remote.deliver("!inherited")
    remote.deliver("!array")
    await vi.waitFor(() => expect(outcomes).toHaveLength(4))

    expect(returnedResultAsync).toBe(true)
    expect(throwingReads).toBe(1)
    expect(outcomes.find((outcome) => outcome.kind === "throwing")?.error).toBeInstanceOf(SdkDefect)
    for (const kind of ["nonenumerable", "inherited"])
        expect(outcomes.find((outcome) => outcome.kind === kind)?.error).toMatchObject({
            inputValidation: { path: "options.timeoutMs" },
        })
    expect(inheritedReads).toBeGreaterThan(0)
    expect(outcomes.find((outcome) => outcome.kind === "array")?.error).toMatchObject({
        inputValidation: { path: "options" },
    })
    expect(dispatches).toBe(0)
})

test("native batch commands bind reply failures and interruption", async () => {
    const requests: Record<string, unknown>[] = []
    let requestSignal: AbortSignal | undefined
    let hold = false
    const remote = await commandFixture(async (_call, init) => {
        requests.push(JSON.parse(String(init.body)))
        requestSignal = init.signal as AbortSignal
        if (!hold)
            return Response.json(
                {
                    id: "902",
                    channel_id: "20",
                    content: "failed",
                    author: { id: "30", username: "fixture", bot: false },
                },
                { status: 400 },
            )
        return await new Promise<Response>((_resolve, reject) => {
            requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true })
        })
    })
    const { client, registration } = await connect("native")
    const reports: unknown[] = []
    const root = nativeCommands.create({ prefix: "!" })
    const router = root.registerMany({
        ping: {
            arguments: {},
            execute: ({ reply }) => reply({ content: "Pong" }).pipe(Effect.asVoid),
        },
        raw: {
            execute: ({ rawArgs, reply }) => reply({ content: rawArgs }).pipe(Effect.asVoid),
        },
    })
    expect(root.commands).toEqual([])
    expect(router.commands.map((entry) => entry.name)).toEqual(["ping", "raw"])
    await Effect.runPromise(
        router
            .attach(client, { onError: (report) => Effect.sync(() => reports.push(report)) })
            .pipe(Scope.provide(registration)),
    )

    remote.deliver("!ping")
    await vi.waitFor(() =>
        expect(reports).toEqual([
            expect.objectContaining({
                event: "messageCreate",
                kind: "handler",
                command: "ping",
                cause: expect.anything(),
            }),
        ]),
    )
    expect(requests[0]).toMatchObject({
        content: "Pong",
        message_reference: { message_id: "101", channel_id: "20", type: 0 },
    })

    hold = true
    remote.deliver("!raw waiting")
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toMatchObject({
        content: "waiting",
        message_reference: { message_id: "102", channel_id: "20", type: 0 },
    })
    await Effect.runPromise(Scope.close(registration, Exit.void))
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true))
})

test("default command router matches the longest prefix and aliases in any case, and applies guards, bot filtering, parser skips and cooldowns", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const received: { prefix: string; args: readonly string[]; rawArgs: string; signal: AbortSignal }[] = []
    const errors: unknown[] = []
    let router = commands.create({
        prefix: ["!", "!!"],
        parse: ({ source }) => {
            if (source.trim() === "skip") return undefined
            const [name = "", ...args] = source.trim().split("|")
            return { name, args, rawArgs: args.join("|") }
        },
    })
    router = router.register({
        name: "ping",
        aliases: ["p"],
        cooldown: { durationMs: 60_000 },
        execute: ({ prefix, args, rawArgs, signal }) => {
            received.push({ prefix, args, rawArgs, signal: signal as AbortSignal })
        },
    })
    router = router.register({
        name: "blocked",
        guard: () => false,
        execute: () => {
            received.push({} as never)
        },
    })
    router = router.register({ name: "broken", execute: () => Promise.reject(new Error("private command failure")) })
    router.attach(client, {
        onError: (report) => {
            errors.push(report)
        },
    })

    remote.deliver("!!P|one|two")
    remote.deliver("!!PING|ignored")
    remote.deliver("!!blocked")
    remote.deliver("!!ping|bot", { isBot: true })
    remote.deliver("!!skip")
    remote.deliver("!!broken")

    await vi.waitFor(() => expect(received).toHaveLength(1))
    await vi.waitFor(() =>
        expect(errors).toEqual([
            expect.objectContaining({
                event: "messageCreate",
                kind: "handler",
                command: "broken",
                error: expect.objectContaining({ message: "private command failure" }),
            }),
        ]),
    )
    // The second ping is on cooldown, and the guard, bot author and parser skip each prevent execution
    await defaultBarrier(remote, client)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ prefix: "!!", args: ["one", "two"], rawArgs: "one|two" })
    expect(received[0]!.signal.aborted).toBe(false)
})

test("default command feedback receives frozen context and cooldown retry information without executing", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const feedback: { content: string; tag: string; frozen: boolean; retryAtMs?: number | null }[] = []
    const executed: string[] = []
    const store = commands.memoryCooldowns({ maxEntries: 1 })
    let router = commands.create({ prefix: "!" })
    router = router.register({
        name: "blocked",
        guard: () => false,
        onReject: (context, rejection) => {
            feedback.push({
                content: context.message.content,
                tag: rejection._tag,
                frozen: Object.isFrozen(context) && Object.isFrozen(rejection),
            })
        },
        execute: () => {
            executed.push("blocked")
        },
    })
    router = router.register({
        name: "active",
        cooldown: { store, durationMs: 60_000 },
        onReject: (context, rejection) => {
            const retryAtMs = rejection._tag === "CommandGuardRejected" ? undefined : rejection.retryAtMs
            feedback.push({
                content: context.message.content,
                tag: rejection._tag,
                frozen: Object.isFrozen(context) && Object.isFrozen(rejection),
                ...(retryAtMs === undefined ? {} : { retryAtMs }),
            })
        },
        execute: () => {
            executed.push("active")
        },
    })
    router.attach(client)

    remote.deliver("!blocked")
    remote.deliver("!active")
    remote.deliver("!active")

    await vi.waitFor(() => expect(feedback).toHaveLength(2))
    await defaultBarrier(remote, client)
    expect(executed).toEqual(["active"])
    expect(feedback).toEqual([
        { content: "!blocked", tag: "CommandGuardRejected", frozen: true },
        {
            content: "!active",
            tag: "CommandCooldownActive",
            frozen: true,
            retryAtMs: expect.any(Number),
        },
    ])
})

test("native command feedback preserves caller context and does not execute rejected handlers", async () => {
    const remote = await commandFixture()
    const { client, registration } = await connect("native")
    const feedback: { content: string; tag: string; retryAtMs?: number | null }[] = []
    const executed: string[] = []
    const FeedbackService = Context.Service<{ readonly value: "native-context" }>("command-feedback")
    const store = nativeCommands.memoryCooldowns({ maxEntries: 1 })
    let router = nativeCommands.create({ prefix: "!" })
    router = router.register({
        name: "blocked",
        guard: () => Effect.succeed(false),
        onReject: ({ message }, rejection) =>
            Effect.service(FeedbackService).pipe(
                Effect.tap(({ value }) =>
                    Effect.sync(() => feedback.push({ content: `${value}:${message.content}`, tag: rejection._tag })),
                ),
            ),
        execute: () => Effect.sync(() => executed.push("blocked")),
    })
    router = router.register({
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
    })
    await Effect.runPromise(
        router
            .attach(client)
            .pipe(Effect.provideService(FeedbackService, { value: "native-context" }), Scope.provide(registration)),
    )
    remote.deliver("!blocked")
    remote.deliver("!active")
    remote.deliver("!active")
    await vi.waitFor(() => expect(feedback).toHaveLength(2))
    expect(executed).toEqual(["active"])
    expect(feedback).toEqual([
        { content: "native-context:!blocked", tag: "CommandGuardRejected" },
        expect.objectContaining({ content: "!active", tag: "CommandCooldownActive", retryAtMs: expect.any(Number) }),
    ])
})

test("quoted parsing splits quoted and escaped arguments and rejects an unterminated quote or trailing escape", () => {
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
})

test("default unmatched feedback receives frozen outcomes after dynamic prefix matching without bot or chat noise", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
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
    const router = commands.create({
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
    })
    const registered = router.register({
        name: "ping",
        execute: () => {
            executed.push("ping")
        },
    })
    registered.attach(client)

    remote.deliver("!missing", { guildId: "40" })
    remote.deliver('!ping "unterminated', { guildId: "40" })
    remote.deliver("!ping", { isBot: true, guildId: "40" })
    remote.deliver("chat", { guildId: "40" })
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
    const botRouter = commands.create({
        prefix: "!",
        ignoreBots: false,
        onUnmatched: (_context, unmatched) => {
            botFeedback.push(unmatched._tag)
        },
    })
    botRouter.attach(client)
    remote.deliver("!missing", { isBot: true, guildId: "40" })
    await vi.waitFor(() => expect(botFeedback).toEqual(["CommandUnknownName"]))
    expect(feedback).toHaveLength(2)

    prefixes.set("40", "?")
    remote.deliver("?missing", { guildId: "40" })
    remote.deliver("?ping", { guildId: "40" })
    await vi.waitFor(() => expect(feedback).toHaveLength(3))
    await vi.waitFor(() => expect(executed).toEqual(["ping"]))
    expect(feedback[2]).toMatchObject({ content: "?missing", prefix: "?", tag: "CommandUnknownName", name: "missing" })
})

test("native unmatched feedback preserves caller context across dynamic prefixes without bot or chat noise", async () => {
    const remote = await commandFixture()
    const { client, registration } = await connect("native")
    const PrefixService = Context.Service<{ readonly value: "native-unmatched" }>("native-unmatched")
    const prefixes = new Map([["40", "!"]])
    const feedback: {
        readonly content: string
        readonly prefix: string
        readonly tag: string
        readonly value: string
        readonly frozen: boolean
    }[] = []
    const executed: string[] = []
    const router = nativeCommands.create({
        prefix: (message) => prefixes.get(message.guildId ?? ""),
        parse: nativeCommands.parseQuoted,
        onUnmatched: (context, unmatched) =>
            Effect.service(PrefixService).pipe(
                Effect.tap(({ value }) =>
                    Effect.sync(() => {
                        feedback.push({
                            content: context.message.content,
                            prefix: context.prefix,
                            tag: unmatched._tag,
                            value,
                            frozen: Object.isFrozen(context) && Object.isFrozen(unmatched),
                        })
                    }),
                ),
            ),
    })
    const registered = router.register({ name: "ping", execute: () => Effect.sync(() => executed.push("ping")) })
    await Effect.runPromise(
        registered
            .attach(client)
            .pipe(Effect.provideService(PrefixService, { value: "native-unmatched" }), Scope.provide(registration)),
    )

    remote.deliver("!missing", { guildId: "40" })
    remote.deliver('!ping "unterminated', { guildId: "40" })
    remote.deliver("!ping", { isBot: true, guildId: "40" })
    remote.deliver("chat", { guildId: "40" })
    await vi.waitFor(() => expect(feedback).toHaveLength(2))
    expect(feedback).toEqual([
        { content: "!missing", prefix: "!", tag: "CommandUnknownName", value: "native-unmatched", frozen: true },
        {
            content: '!ping "unterminated',
            prefix: "!",
            tag: "CommandParserRejected",
            value: "native-unmatched",
            frozen: true,
        },
    ])
    expect(executed).toEqual([])

    prefixes.set("40", "?")
    remote.deliver("?missing", { guildId: "40" })
    remote.deliver("?ping", { guildId: "40" })
    await vi.waitFor(() => expect(feedback).toHaveLength(3))
    await vi.waitFor(() => expect(executed).toEqual(["ping"]))
    expect(feedback[2]).toEqual({
        content: "?missing",
        prefix: "?",
        tag: "CommandUnknownName",
        value: "native-unmatched",
        frozen: true,
    })
})

test("default unmatched callback failure reports safely and its signal stays cooperative after cancellation", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const errors: unknown[] = []
    const feedback: string[] = []
    let slowSignal: AbortSignal | undefined
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
        release = resolve
    })
    const router = commands.create({
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
    })
    const subscription = router.attach(client, {
        onError: (report) => {
            errors.push(report)
        },
    })
    remote.deliver("!broken")
    remote.deliver("!missing")
    await vi.waitFor(() =>
        expect(errors).toEqual([
            expect.objectContaining({
                event: "messageCreate",
                kind: "handler",
                error: expect.objectContaining({ message: "private unmatched feedback failure" }),
            }),
        ]),
    )
    await vi.waitFor(() => expect(feedback).toEqual(["CommandUnknownName"]))
    remote.deliver("!slow")
    await vi.waitFor(() => expect(slowSignal).toBeDefined())
    subscription.close()
    expect(slowSignal!.aborted).toBe(true)
    release!()
})

test("native unmatched callback failure reports safely and registration-scope cancellation stops later feedback", async () => {
    const remote = await commandFixture()
    const { client, registration } = await connect("native")
    const errors: string[] = []
    const feedback: string[] = []
    const router = nativeCommands.create({
        prefix: "!",
        onUnmatched: (_context, unmatched) =>
            unmatched._tag === "CommandUnknownName" && unmatched.name === "broken"
                ? Effect.die("private unmatched feedback failure")
                : Effect.sync(() => feedback.push(unmatched._tag)),
    })
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
    await nativeBarrier(remote, client)
    expect(feedback).toEqual(["CommandUnknownName"])
})

test("default rejection callback defects use subscription reporting without handler execution", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const errors: unknown[] = []
    const executed: string[] = []
    let router = commands.create({ prefix: "!" })
    router = router.register({
        name: "broken-feedback",
        guard: () => false,
        onReject: () => Promise.reject(new Error("private feedback failure")),
        execute: () => {
            executed.push("handler")
        },
    })
    router.attach(client, {
        onError: (report) => {
            errors.push(report)
        },
    })
    remote.deliver("!broken-feedback")
    await vi.waitFor(() =>
        expect(errors).toEqual([
            expect.objectContaining({
                event: "messageCreate",
                kind: "handler",
                command: "broken-feedback",
                error: expect.objectContaining({ message: "private feedback failure" }),
            }),
        ]),
    )
    expect(executed).toEqual([])
})

test("native rejection callback defects use subscription reporting without handler execution", async () => {
    const remote = await commandFixture()
    const { client, registration } = await connect("native")
    const errors: string[] = []
    const executed: string[] = []
    let router = nativeCommands.create({ prefix: "!" })
    router = router.register({
        name: "broken-feedback",
        guard: () => Effect.succeed(false),
        onReject: () => Effect.die("private feedback failure"),
        execute: () => Effect.sync(() => executed.push("handler")),
    })
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

test("command configuration rejects empty prefixes, empty cooldown keys and malformed store options, and option getter failures become SdkDefect or a native defect", async () => {
    expect(configurationError(() => commands.create({ prefix: "" })).field).toBe("prefix")
    expect(configurationError(() => nativeCommands.create({ prefix: "" })).field).toBe("prefix")
    const store = commands.memoryCooldowns({ maxEntries: 1 })
    expect(configurationError(() => store.claim({ key: "", durationMs: 60_000 })).field).toBe("cooldown")
    expect(configurationError(() => commands.memoryCooldowns({ maxEntries: null } as never)).field).toBe("maxEntries")
    const getterFailure = new Error("private cooldown getter")
    const getterInput = {
        get key(): string {
            throw getterFailure
        },
        durationMs: 1,
    }
    let defect: unknown
    try {
        store.claim(getterInput as never)
    } catch (error) {
        defect = error
    }
    expect(defect).toBeInstanceOf(SdkDefect)
    // A throwing getter is application code, so the defect keeps it as the cause with origin application
    expect(defect).toMatchObject({
        code: "application.defect",
        operation: "commands",
        reasons: [{ kind: "Defect", origin: "application", defect: getterFailure }],
    })
    expect((defect as SdkDefect).cause).toBe(getterFailure)
    expect(configurationError(() => nativeCommands.memoryCooldowns({ maxEntries: 0 })).field).toBe("maxEntries")
    const nativeStore = nativeCommands.memoryCooldowns({ maxEntries: 1 })
    // Malformed native claims are misuse, so they die with the ConfigurationError instead of failing
    const malformed = await Effect.runPromiseExit(nativeStore.claim({ key: "", durationMs: 60_000 }))
    expect(Exit.isFailure(malformed)).toBe(true)
    if (Exit.isFailure(malformed))
        expect(
            malformed.cause.reasons.some(
                (reason) => reason._tag === "Die" && reason.defect instanceof ConfigurationError,
            ),
        ).toBe(true)
})

test("default registration leaves the original router and its existing attachment unchanged", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const received: string[] = []
    const original = commands.create({ prefix: "!" })
    expect(Object.isFrozen(original)).toBe(true)
    expect(Reflect.ownKeys(original)).toEqual([])
    original.attach(client)
    const extended = original.register({
        name: "ping",
        execute: () => {
            received.push("extended")
        },
    })
    expect(Object.isFrozen(extended)).toBe(true)
    extended.attach(client)

    remote.deliver("!ping")
    await vi.waitFor(() => expect(received).toEqual(["extended"]))
    // The original attachment has no ping command, so the command ran only once
    await defaultBarrier(remote, client)
    expect(received).toEqual(["extended"])
    expect(original.commands).toEqual([])
})

test("native registration leaves the original router and its existing attachment unchanged", async () => {
    const remote = await commandFixture()
    const { client, registration } = await connect("native")
    const received: string[] = []
    const original = nativeCommands.create({ prefix: "!" })
    expect(Object.isFrozen(original)).toBe(true)
    expect(Reflect.ownKeys(original)).toEqual([])
    await Effect.runPromise(original.attach(client).pipe(Scope.provide(registration)))
    const extended = original.register({ name: "ping", execute: () => Effect.sync(() => received.push("extended")) })
    expect(Object.isFrozen(extended)).toBe(true)
    await Effect.runPromise(extended.attach(client).pipe(Scope.provide(registration)))

    remote.deliver("!ping")
    await vi.waitFor(() => expect(received).toEqual(["extended"]))
    await nativeBarrier(remote, client)
    expect(received).toEqual(["extended"])
    expect(original.commands).toEqual([])
})

test("command registration snapshots the name, aliases and callback, so later definition changes do not affect routing", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const received: string[] = []
    const aliases = ["p"]
    const definition = {
        name: "ping",
        aliases,
        execute: () => {
            received.push("initial")
        },
    } satisfies DefaultPrefixCommand
    const router = commands.create({ prefix: "!" })
    const registered = router.register(definition)
    definition.name = "changed"
    aliases.push("later")
    definition.execute = () => {
        received.push("changed")
    }
    registered.attach(client)

    remote.deliver("!p")
    remote.deliver("!later")
    remote.deliver("!changed")
    await defaultBarrier(remote, client)
    expect(received).toEqual(["initial"])
    expect(registered.commands).toEqual([{ name: "ping", aliases: ["p"] }])
})

test.each(modes)(
    "%s registration snapshots its argument schema, so later candidate changes affect neither routing nor metadata",
    async (mode) => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const selected: string[] = []
        const rejected: string[] = []
        const candidates = [{ id: "1", username: "initial" }]
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "target",
            arguments: { target: { type: "userChoice", candidates } },
            onReject: (_context: unknown, rejection: PrefixCommandRejection) =>
                act(
                    mode,
                    () => void rejected.push(rejection._tag === "CommandArgumentRejected" ? rejection.reason : ""),
                ),
            execute: ({ values }: { values: { target: { id: string } } }) =>
                act(mode, () => void selected.push(values.target.id)),
        })
        candidates[0]!.username = "changed"
        candidates.push({ id: "2", username: "later" })
        await attach(connected, router, { concurrency: 1 })

        remote.deliver("!target initial")
        remote.deliver("!target changed")
        remote.deliver("!target later")
        await vi.waitFor(() => expect(selected.length + rejected.length).toBe(3))
        expect(selected).toEqual(["1"])
        expect(rejected).toEqual(["Invalid", "Invalid"])
        expect(router.commands).toEqual([
            { name: "target", arguments: [{ name: "target", type: "userChoice", optional: false, rest: false }] },
        ])
        expect(Object.isFrozen(router.commands)).toBe(true)
        expect(Object.isFrozen(router.commands[0])).toBe(true)
    },
)

test.each(modes)("%s registration still validates resource candidate shape and bounds", (mode) => {
    const sparse = Array<{ id: string; username: string }>(2)
    sparse[1] = { id: "1", username: "name" }
    const invalidCandidates = [
        [],
        sparse,
        [{ id: "01", username: "name" }],
        [{ id: "1", username: "" }],
        Array.from({ length: 101 }, (_, index) => ({ id: `${index}`, username: "name" })),
    ]
    for (const candidates of invalidCandidates) {
        const argumentsSchema = { target: { type: "userChoice" as const, candidates } }
        if (mode === "default") {
            const router = commands.create({ prefix: "!" })
            expect(
                configurationError(() =>
                    router.register({ name: "target", arguments: argumentsSchema, execute: () => undefined }),
                ).field,
            ).toBe("command")
            expect(router.commands).toEqual([])
        } else {
            const router = nativeCommands.create({ prefix: "!" })
            expect(
                configurationError(() =>
                    router.register({ name: "target", arguments: argumentsSchema, execute: () => Effect.void }),
                ).field,
            ).toBe("command")
            expect(router.commands).toEqual([])
        }
    }
})

test("sparse command arrays reject configuration and the default parser ignores unknown or invalid command-shaped chat", async () => {
    const sparsePrefix: string[] = []
    sparsePrefix[1] = "!"
    expect(configurationError(() => commands.create({ prefix: sparsePrefix })).field).toBe("prefix")

    const router = commands.create({ prefix: "!" })
    const sparseAliases: string[] = []
    sparseAliases[1] = "p"
    expect(
        configurationError(() => router.register({ name: "ping", aliases: sparseAliases, execute: () => undefined }))
            .field,
    ).toBe("aliases")

    const remote = await commandFixture()
    const { client } = await connect("default")
    const received: string[] = []
    const errors: unknown[] = []
    const registered = router.register({
        name: "ping",
        execute: () => {
            received.push("ping")
        },
    })
    registered.attach(client, {
        onError: (report) => {
            errors.push(report)
        },
    })
    remote.deliver("!missing")
    remote.deliver("!💥")
    await defaultBarrier(remote, client)
    expect(received).toEqual([])
    expect(errors).toEqual([])
})

test("a custom parser returning sparse arguments is reported as a failure without execution", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const errors: { readonly kind: string; readonly command?: string; readonly error: unknown }[] = []
    const executed: string[] = []
    const sparseArgs: string[] = []
    sparseArgs[1] = "later"
    const router = commands
        .create({ prefix: "!", parse: () => ({ name: "parse", args: sparseArgs, rawArgs: "later" }) })
        .register({
            name: "parse",
            execute: () => {
                executed.push("parse")
            },
        })
    router.attach(client, {
        onError: (report) => {
            errors.push(report)
        },
    })
    remote.deliver("!parse")
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toMatchObject({ kind: "handler" })
    expect(errors[0]!.command).toBeUndefined()
    expect(errors[0]!.error).toBeInstanceOf(ConfigurationError)
    await defaultBarrier(remote, client)
    expect(executed).toEqual([])
})

test("default cancellation during a guard prevents late rejection feedback", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const feedback: string[] = []
    let entered = false
    let release: ((allowed: boolean) => void) | undefined
    const gate = new Promise<boolean>((resolve) => {
        release = resolve
    })
    let router = commands.create({ prefix: "!" })
    router = router.register({
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
    })
    const subscription = router.attach(client)
    remote.deliver("!blocked")
    await vi.waitFor(() => expect(entered).toBe(true))
    subscription.close()
    release!(false)
    await defaultBarrier(remote, client)
    expect(feedback).toEqual([])
})

test("default cancellation during cooldown admission prevents execution after the claim settles", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const executed: string[] = []
    let release: ((claim: { _tag: "CooldownAcquired"; retryAtMs: number }) => void) | undefined
    const claim = new Promise<{ _tag: "CooldownAcquired"; retryAtMs: number }>((resolve) => {
        release = resolve
    })
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
        enter = resolve
    })
    const store = {
        claim: () => {
            enter()
            return claim
        },
    }
    let router = commands.create({ prefix: "!" })
    router = router.register({
        name: "ping",
        cooldown: { store, durationMs: 1_000 },
        execute: () => {
            executed.push("execute")
        },
    })
    const subscription = router.attach(client)
    remote.deliver("!ping")
    await entered
    subscription.close()
    release!({ _tag: "CooldownAcquired", retryAtMs: Date.now() + 1_000 })
    await defaultBarrier(remote, client)
    expect(executed).toEqual([])
})

test("native configuration reports getter defects as an application SdkDefect for commands", () => {
    const getterFailure = new Error("private fixture defect")
    const options = {
        get prefix(): string {
            throw getterFailure
        },
    }
    try {
        nativeCommands.create(options as never)
        throw new Error("Expected native creation to throw")
    } catch (error) {
        expect(error).toBeInstanceOf(SdkDefect)
        expect(error).toMatchObject({
            code: "application.defect",
            operation: "commands",
            reasons: [{ kind: "Defect", origin: "application", defect: getterFailure }],
        })
        expect((error as SdkDefect).cause).toBe(getterFailure)
    }
})

test("default configuration reports getter defects as an application SdkDefect for commands", () => {
    const getterFailure = new Error("private fixture defect")
    const options = {
        get prefix(): string {
            throw getterFailure
        },
    }
    try {
        commands.create(options as never)
        throw new Error("Expected default creation to throw")
    } catch (error) {
        expect(error).toBeInstanceOf(SdkDefect)
        expect(error).toMatchObject({
            code: "application.defect",
            operation: "commands",
            reasons: [{ kind: "Defect", origin: "application", defect: getterFailure }],
        })
        expect((error as SdkDefect).cause).toBe(getterFailure)
        expect((error as Error).message).toContain("private fixture defect")
    }
})

test("default typed arguments convert after one guard and before cooldown without changing raw arguments", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
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
    let router = commands.create({ prefix: "!" })
    router = router.register({
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
    })
    router.attach(client)

    remote.deliver("!typed hello -2 1.25 true 9007199254740993123 fast note this is the tail")
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received).toEqual([
        {
            args: ["hello", "-2", "1.25", "true", "9007199254740993123", "fast", "note", "this", "is", "the", "tail"],
            rawArgs: "hello -2 1.25 true 9007199254740993123 fast note this is the tail",
            values: {
                word: "hello",
                count: -2,
                ratio: 1.25,
                enabled: true,
                id: "9007199254740993123",
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
    const remote = await commandFixture()
    const { client } = await connect("default")
    const rejects: unknown[] = []
    let guards = 0
    let cooldowns = 0
    let executed = 0
    let router = commands.create({ prefix: "!" })
    router = router.register({
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
    })
    router.attach(client)

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
    const remote = await commandFixture()
    const { client } = await connect("default")
    const candidates = [
        { id: "1", username: "same" },
        { id: "2", username: "same" },
        { id: "3", username: "unique", privateLabel: "not retained" },
    ]
    const selected: string[] = []
    const rejected: unknown[] = []
    let router = commands.create({ prefix: "!" })
    router = router.register({
        name: "user",
        arguments: { target: { type: "userChoice", candidates } },
        onReject: (_context, rejection) => {
            rejected.push(rejection)
        },
        execute: ({ values }) => {
            // @ts-expect-error Explicit candidates are projected to stable public fields
            void values.target.privateLabel
            selected.push(values.target.id)
        },
    })
    candidates[2]!.username = "changed"
    router.attach(client)

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
            arguments: [{ name: "target", type: "userChoice", optional: false, rest: false }],
        },
    ])
})

test("typed channel and role arguments accept anchored mentions and reject unmatched names", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const selected: string[] = []
    const rejected: unknown[] = []
    let router = commands.create({ prefix: "!" })
    router = router.register({
        name: "move",
        arguments: {
            channel: { type: "channelChoice", candidates: [{ id: "10", name: "general" }] },
            role: { type: "roleChoice", candidates: [{ id: "20", name: "moderator" }] },
        } as const,
        onReject: (_context, rejection) => {
            rejected.push(rejection)
        },
        execute: ({ values }) => {
            selected.push(`${values.channel.id}:${values.role.id}`)
        },
    })
    router.attach(client)

    remote.deliver("!move <#10> <@&20>")
    remote.deliver("!move 10 20")
    remote.deliver("!move missing moderator")
    await vi.waitFor(() => expect(selected.length + rejected.length).toBe(3))
    expect(selected).toEqual(["10:20", "10:20"])
    expect(rejected).toEqual([{ _tag: "CommandArgumentRejected", argument: "channel", reason: "Invalid" }])
})

test.each(modes)(
    "%s registration rejects the plain user, channel and role types and names the forms that exist",
    (mode) => {
        for (const type of ["user", "channel", "role"]) {
            const command = { name: "pick", arguments: { target: { type } }, execute: () => undefined } as never
            const error = configurationError(() =>
                mode === "default"
                    ? commands.create({ prefix: "!" }).register(command)
                    : nativeCommands.create({ prefix: "!" }).register(command),
            )
            expect(error.field).toBe("command")
            // The hint names the ID form for any value and the fixed-list form, so the fix is visible without the docs
            expect(error.hint).toContain(`mention: "${type}"`)
            expect(error.hint).toContain(`${type}Choice`)
        }
    },
)

// The conversion tests cover the full ID-precedence table. This checks that native routing uses it
test("native resource arguments select a candidate by ID and reject an ambiguous name", async () => {
    const remote = await commandFixture()
    const { client, registration } = await connect("native")
    const selected: string[] = []
    const rejected: unknown[] = []
    const candidates = [
        { id: "10", username: "identified" },
        { id: "3", username: "30" },
        { id: "4", username: "30" },
    ]
    const router = nativeCommands.create({ prefix: "!" }).register({
        name: "user",
        arguments: { target: { type: "userChoice", candidates } },
        execute: ({ values }) =>
            Effect.sync(() => {
                selected.push(values.target.id)
            }),
        onReject: (_context, rejection) =>
            Effect.sync(() => {
                rejected.push(rejection)
            }),
    })
    await Effect.runPromise(router.attach(client, { concurrency: 1 }).pipe(Scope.provide(registration)))
    remote.deliver("!user 10")
    remote.deliver("!user 30")
    await vi.waitFor(() => expect(selected.length + rejected.length).toBe(2))
    expect(selected).toEqual(["10"])
    expect(rejected).toEqual([{ _tag: "CommandArgumentRejected", argument: "target", reason: "Ambiguous" }])
})

test("typed arguments distinguish an omitted optional token from a supplied empty token", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const values: unknown[] = []
    const rejected: unknown[] = []
    let router = commands.create({
        prefix: "!",
        parse: ({ source }) => {
            const command = source.trim()
            return command === "empty"
                ? { name: command, args: [""], rawArgs: '""' }
                : command === "omitted"
                  ? { name: "empty", args: [], rawArgs: "" }
                  : { name: command, args: [], rawArgs: "" }
        },
    })
    router = router.register({
        name: "empty",
        arguments: { value: { type: "text", optional: true } } as const,
        onReject: (_context, rejection) => {
            rejected.push(rejection)
        },
        execute: ({ values: converted }) => {
            values.push(converted.value)
        },
    })
    router.attach(client)

    remote.deliver("!empty")
    remote.deliver("!omitted")
    await vi.waitFor(() => expect(values.length + rejected.length).toBe(2))
    expect(values).toEqual([undefined])
    expect(rejected).toEqual([{ _tag: "CommandArgumentRejected", argument: "value", reason: "Invalid" }])
})

test("default registration rejects hidden schema keys and empty or oversized choice lists", () => {
    const router = commands.create({ prefix: "!" })
    const hidden = Object.defineProperty({ choice: { type: "text" as const } }, "hidden", {
        enumerable: false,
        value: { type: "text" },
    })
    const invalid = [
        () => router.register({ name: "hidden", arguments: hidden, execute: () => undefined }),
        () =>
            router.register({
                name: "empty",
                arguments: { choice: { type: "choice", choices: [] } },
                execute: () => undefined,
            }),
        () =>
            router.register({
                name: "oversized",
                arguments: {
                    choice: { type: "choice", choices: Array.from({ length: 101 }, (_, index) => `${index}`) },
                },
                execute: () => undefined,
            }),
    ]
    for (const run of invalid) expect(configurationError(run).field).toBe("command")
})

test("native typed arguments reject supplied empty text but execute an omitted optional value", async () => {
    const remote = await commandFixture()
    const { client, registration } = await connect("native")
    const values: unknown[] = []
    const rejected: unknown[] = []
    let router = nativeCommands.create({
        prefix: "!",
        parse: ({ source }) => {
            const command = source.trim()
            return command === "empty"
                ? { name: command, args: [""], rawArgs: '""' }
                : command === "omitted"
                  ? { name: "empty", args: [], rawArgs: "" }
                  : undefined
        },
    })
    router = router.register({
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
    })
    await Effect.runPromise(router.attach(client).pipe(Scope.provide(registration)))

    remote.deliver("!empty")
    remote.deliver("!omitted")
    await vi.waitFor(() => expect(values.length + rejected.length).toBe(2))
    expect(values).toEqual([undefined])
    expect(rejected).toEqual([{ _tag: "CommandArgumentRejected", argument: "value", reason: "Invalid" }])
})

test("native typed arguments preserve native execution and reject malformed input before cooldown", async () => {
    const remote = await commandFixture()
    const { client, registration } = await connect("native")
    const values: number[] = []
    const rejected: unknown[] = []
    let cooldowns = 0
    let router = nativeCommands.create({ prefix: "!" })
    router = router.register({
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
    })
    await Effect.runPromise(router.attach(client).pipe(Scope.provide(registration)))

    remote.deliver("!native-typed no")
    remote.deliver("!native-typed 4 trailing words")
    await vi.waitFor(() => expect(values).toEqual([4]))
    expect(rejected).toEqual([{ _tag: "CommandArgumentRejected", argument: "count", reason: "Invalid" }])
    expect(cooldowns).toBe(1)
})

test("group aliases route exact quoted leaf suffixes while earlier attachments and flat metadata remain unchanged", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const parsed: unknown[] = []
    const executed: unknown[] = []
    const unmatched: unknown[] = []
    const root = commands.create({
        prefix: "!",
        parse: (input) => {
            parsed.push({
                source: input.source,
                ...(input.path === undefined ? {} : { path: input.path }),
                frozen: Object.isFrozen(input.path),
            })
            return commands.parseQuoted(input)
        },
        onUnmatched: (_context, outcome) => {
            unmatched.push(outcome)
        },
    })
    const grouped = root
        .registerGroup({ name: "admin", aliases: ["a"] })
        .registerGroup({ name: "users", aliases: ["u"] }, { group: ["admin"] })
    grouped.attach(client)
    const registered = grouped.register(
        {
            name: "inspect",
            aliases: ["i"],
            arguments: { word: { type: "text" }, count: { type: "integer" } },
            execute: ({ name, path, args, rawArgs, values }) => {
                executed.push({ name, path, args, rawArgs, values, frozen: Object.isFrozen(path) })
            },
        },
        { group: ["admin", "users"] },
    )
    const flat = registered.register({
        name: "ping",
        execute: (context) => {
            executed.push({ name: context.name, hasPath: Object.hasOwn(context, "path") })
        },
    })
    flat.attach(client)
    remote.deliver('!A\tU   I "two words" 2  ')
    await vi.waitFor(() => expect(executed).toHaveLength(1))
    expect(executed[0]).toEqual({
        name: "inspect",
        path: ["admin", "users", "inspect"],
        args: ["two words", "2"],
        rawArgs: '"two words" 2  ',
        values: { word: "two words", count: 2 },
        frozen: true,
    })
    expect(parsed).toEqual([
        { source: 'I "two words" 2  ', path: ["admin", "users"], frozen: true },
        { source: 'I "two words" 2  ', path: ["admin", "users"], frozen: true },
    ])
    expect(unmatched).toEqual([{ _tag: "CommandUnknownName", name: "I", path: ["admin", "users"] }])
    remote.deliver("!ping")
    await vi.waitFor(() => expect(executed).toHaveLength(2))
    expect(executed[1]).toEqual({ name: "ping", hasPath: false })
    expect(flat.commands[1]).toEqual({ name: "ping" })
    expect(grouped.commands).toEqual([])
    expect(root.groups).toEqual([])
})

test("custom parsers retain flat grammar and receive grouped leaf grammar once without owning group separators", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const inputs: unknown[] = []
    const executed: unknown[] = []
    const unmatched: unknown[] = []
    let router = commands.create({
        prefix: "!",
        parse: (input) => {
            inputs.push({ source: input.source, ...(input.path === undefined ? {} : { path: input.path }) })
            const [name = "", ...args] = input.source.trimStart().split("|")
            return { name, args, rawArgs: args.join("|") }
        },
        onUnmatched: (_context, outcome) => {
            unmatched.push(outcome)
        },
    })
    router = router.registerGroup({ name: "admin", aliases: ["a"] })
    router = router.register(
        {
            name: "inspect",
            execute: ({ args, rawArgs, path }) => {
                executed.push({ args, rawArgs, path })
            },
        },
        { group: ["admin"] },
    )
    router = router.register({
        name: "flat",
        execute: ({ args, rawArgs }) => {
            executed.push({ args, rawArgs })
        },
    })
    router.attach(client, { onError: () => undefined })
    remote.deliver("!a inspect|123|two words")
    remote.deliver("!flat|123|two words")
    remote.deliver("!a")
    remote.deliver("!admin|inspect|123")
    await vi.waitFor(() => expect(executed).toHaveLength(2))
    await vi.waitFor(() => expect(unmatched).toHaveLength(2))
    expect(inputs).toEqual([
        { source: "inspect|123|two words", path: ["admin"] },
        { source: "flat|123|two words" },
        { source: "admin|inspect|123" },
    ])
    expect(executed).toEqual([
        { args: ["123", "two words"], rawArgs: "123|two words", path: ["admin", "inspect"] },
        { args: ["123", "two words"], rawArgs: "123|two words" },
    ])
    expect(unmatched).toEqual([
        { _tag: "CommandMissingSubcommand", path: ["admin"] },
        // The parser returned a group name, which is not an executable command, so the group is the closest name
        { _tag: "CommandUnknownName", name: "admin", suggestion: "admin" },
    ])
})

test("case-sensitive group lookup respects each segment and child aliases without changing canonical paths", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const executed: unknown[] = []
    const unmatched: unknown[] = []
    const router = commands
        .create({
            prefix: "!",
            caseSensitive: true,
            onUnmatched: (_context, outcome) => {
                unmatched.push(outcome)
            },
        })
        .registerGroup({ name: "Admin", aliases: ["A"] })
        .register(
            {
                name: "Inspect",
                aliases: ["i"],
                execute: ({ path }) => {
                    executed.push(path)
                },
            },
            { group: ["Admin"] },
        )
    router.attach(client)
    remote.deliver("!A i")
    remote.deliver("!a i")
    remote.deliver("!Admin inspect")
    remote.deliver("!Admin Inspect")
    await vi.waitFor(() => expect(executed).toHaveLength(2))
    await vi.waitFor(() => expect(unmatched).toHaveLength(2))
    expect(executed).toEqual([
        ["Admin", "Inspect"],
        ["Admin", "Inspect"],
    ])
    expect(unmatched).toEqual([
        { _tag: "CommandUnknownName", name: "a", suggestion: "Admin" },
        { _tag: "CommandUnknownName", name: "inspect", path: ["Admin"], suggestion: "Inspect" },
    ])
})

test("default grouped cancellation prevents admission and late callbacks after a leaf guard settles", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const store = commands.memoryCooldowns()
    const callbacks: string[] = []
    let entered = false
    let signal: { readonly aborted: boolean } | undefined
    let release!: (allowed: boolean) => void
    const gate = new Promise<boolean>((resolve) => {
        release = resolve
    })
    const router = commands
        .create({ prefix: "!" })
        .registerGroup({ name: "admin" })
        .register(
            {
                name: "inspect",
                guard: (context) => {
                    signal = context.signal
                    entered = true
                    return gate
                },
                cooldown: { store, durationMs: 60_000 },
                onReject: () => {
                    callbacks.push("reject")
                },
                execute: () => {
                    callbacks.push("execute")
                },
            },
            { group: ["admin"] },
        )
    const subscription = router.attach(client)
    remote.deliver("!admin inspect")
    await vi.waitFor(() => expect(entered).toBe(true))
    subscription.close()
    expect(signal?.aborted).toBe(true)
    release(true)
    await defaultBarrier(remote, client)
    expect(store.size).toBe(0)
    expect(callbacks).toEqual([])
})

test("grouped leaves own guards and cooldowns with safe missing-child feedback and invalid-input recovery", async () => {
    const remote = await commandFixture()
    const { client } = await connect("default")
    const executed: unknown[] = []
    const rejected: unknown[] = []
    const unmatched: unknown[] = []
    const store = commands.memoryCooldowns({ maxEntries: 2 })
    let router = commands.create({
        prefix: "!",
        onUnmatched: (_context, outcome) => {
            unmatched.push(outcome)
        },
    })
    router = router.registerGroup({ name: "admin", aliases: ["a"] })
    router = router.registerGroup({ name: "users" }, { group: ["admin"] })
    router = router.registerGroup({ name: "public" })
    for (const group of ["admin", "public"])
        router = router.register(
            {
                name: "inspect",
                aliases: ["i"],
                arguments: { count: { type: "integer" } },
                cooldown: { store, durationMs: 60_000 },
                onReject: ({ path }, outcome) => {
                    rejected.push({ path, outcome })
                },
                execute: ({ path, values }) => {
                    const count: number = values.count
                    executed.push({ path, count })
                },
            },
            { group: [group] },
        )
    router = router.register(
        {
            name: "blocked",
            guard: () => false,
            cooldown: { store, durationMs: 60_000 },
            onReject: ({ path }, outcome) => {
                rejected.push({ path, outcome })
            },
            execute: () => {
                executed.push("blocked")
            },
        },
        { group: ["admin"] },
    )
    // One command at a time keeps the feedback order this test inspects
    router.attach(client, { concurrency: 1 })
    remote.deliver("!a users \t")
    remote.deliver("!admin users unknown")
    remote.deliver("!admin invalid!")
    remote.deliver("!admin blocked")
    remote.deliver("!admin inspect no")
    await vi.waitFor(() => expect(unmatched).toHaveLength(3))
    await vi.waitFor(() => expect(rejected).toHaveLength(2))
    expect(store.size).toBe(0)
    expect(executed).toEqual([])
    expect(unmatched).toEqual([
        { _tag: "CommandMissingSubcommand", path: ["admin", "users"] },
        { _tag: "CommandUnknownName", name: "unknown", path: ["admin", "users"] },
        { _tag: "CommandParserRejected", path: ["admin"] },
    ])
    for (const outcome of unmatched) expect(Object.isFrozen(outcome)).toBe(true)
    remote.deliver("!admin i 1")
    remote.deliver("!a inspect 2")
    remote.deliver("!public inspect 3")
    await vi.waitFor(() => expect(executed).toHaveLength(2))
    await vi.waitFor(() => expect(rejected).toHaveLength(3))
    expect(executed).toEqual([
        { path: ["admin", "inspect"], count: 1 },
        { path: ["public", "inspect"], count: 3 },
    ])
    expect(rejected[0]).toEqual({ path: ["admin", "blocked"], outcome: { _tag: "CommandGuardRejected" } })
    expect(rejected[1]).toEqual({
        path: ["admin", "inspect"],
        outcome: { _tag: "CommandArgumentRejected", argument: "count", reason: "Invalid" },
    })
    expect(rejected[2]).toMatchObject({ path: ["admin", "inspect"], outcome: { _tag: "CommandCooldownActive" } })
    expect(store.size).toBe(2)
})

test("native nested routing preserves handler and feedback services and stops callbacks after scope closure", async () => {
    const remote = await commandFixture()
    const { client, registration } = await connect("native")
    const Service = Context.Service<{ readonly label: string }>("group-command-service")
    const executed: unknown[] = []
    const feedback: unknown[] = []
    const store = nativeCommands.memoryCooldowns()
    const root = nativeCommands.create({
        prefix: "!",
        parse: nativeCommands.parseQuoted,
        onUnmatched: (_context, outcome) =>
            Effect.service(Service).pipe(
                Effect.flatMap((service) =>
                    Effect.sync(() => {
                        feedback.push({ label: service.label, outcome })
                    }),
                ),
            ),
    })
    const admin = root.registerGroup({ name: "admin", aliases: ["a"] })
    const users = admin.registerGroup({ name: "users", aliases: ["u"] }, { group: ["admin"] })
    const router = users.register(
        {
            name: "inspect",
            aliases: ["i"],
            arguments: { count: { type: "integer" } },
            guard: () => Effect.service(Service).pipe(Effect.map((service) => service.label === "enabled")),
            cooldown: { store, durationMs: 60_000 },
            onReject: ({ path }, outcome) =>
                Effect.service(Service).pipe(
                    Effect.flatMap((service) =>
                        Effect.sync(() => {
                            feedback.push({ label: service.label, path, outcome })
                        }),
                    ),
                ),
            execute: ({ path, values, rawArgs }) =>
                Effect.service(Service).pipe(
                    Effect.flatMap((service) =>
                        Effect.sync(() => {
                            const count: number = values.count
                            executed.push({ label: service.label, path, count, rawArgs })
                        }),
                    ),
                ),
        },
        { group: ["admin", "users"] },
    )
    await Effect.runPromise(
        router.attach(client).pipe(Effect.provideService(Service, { label: "enabled" }), Scope.provide(registration)),
    )
    remote.deliver("!A U")
    remote.deliver("!A U inspect no")
    await vi.waitFor(() => expect(feedback).toHaveLength(2))
    expect(store.size).toBe(0)
    remote.deliver("!A U I 4  ")
    await vi.waitFor(() => expect(executed).toHaveLength(1))
    remote.deliver("!admin users inspect 5")
    await vi.waitFor(() => expect(feedback).toHaveLength(3))
    expect(executed).toEqual([{ label: "enabled", path: ["admin", "users", "inspect"], count: 4, rawArgs: "4  " }])
    expect(feedback[0]).toEqual({
        label: "enabled",
        outcome: { _tag: "CommandMissingSubcommand", path: ["admin", "users"] },
    })
    expect(feedback[1]).toMatchObject({ label: "enabled", outcome: { _tag: "CommandArgumentRejected" } })
    expect(feedback[2]).toMatchObject({ label: "enabled", outcome: { _tag: "CommandCooldownActive" } })
    await Effect.runPromise(Scope.close(registration, Exit.void))
    remote.deliver("!admin users")
    remote.deliver("!admin users inspect 6")
    await nativeBarrier(remote, client)
    expect(feedback).toHaveLength(3)
    expect(executed).toHaveLength(1)
})

test.each(modes)(
    "%s router failures reach its onError through one sequential queue, and an explicit undefined keeps router defaults",
    async (mode) => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        let entered = 0
        let active = 0
        let maxActive = 0
        const failed: string[] = []
        const reports: string[] = []
        let started = 0
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        let releaseHook!: () => void
        const hookGate = new Promise<void>((resolve) => {
            releaseHook = resolve
        })
        // The hook holds the first report until the test releases it. A second call during that time would overlap
        const record = async (report: { readonly command?: string; readonly error: unknown }) => {
            entered++
            active++
            maxActive = Math.max(maxActive, active)
            await hookGate
            reports.push(`${report.command ?? "unmatched"}:${(report.error as Error).message}`)
            active--
        }
        // Explicit undefined values must not replace the router's concurrency of eight or its overflow policy
        const settings: object = { concurrency: undefined, overflow: undefined }
        if (connected.mode === "default") {
            const router = commands
                .create({
                    prefix: "!",
                    onUnmatched: () => {
                        failed.push("unmatched")
                        throw new Error("unmatched feedback")
                    },
                })
                .registerMany({
                    slow: {
                        arguments: {},
                        execute: () => {
                            started++
                            return gate
                        },
                    },
                    fail: {
                        arguments: {},
                        execute: () => {
                            failed.push("fail")
                            throw new Error("fail a")
                        },
                    },
                    explode: {
                        arguments: {},
                        execute: () => {
                            failed.push("explode")
                            return Promise.reject(new Error("fail b"))
                        },
                    },
                } as never)
            router.attach(connected.client, { ...settings, onError: record })
        } else {
            const fail = (name: string, message: string) =>
                Effect.sync(() => failed.push(name)).pipe(Effect.andThen(Effect.fail(new Error(message))))
            const root = nativeCommands.create({
                prefix: "!",
                onUnmatched: () => fail("unmatched", "unmatched feedback").pipe(Effect.orDie),
            })
            const router = root.registerMany({
                slow: {
                    arguments: {},
                    execute: () => Effect.sync(() => started++).pipe(Effect.andThen(Effect.promise(() => gate))),
                },
                fail: { arguments: {}, execute: () => fail("fail", "fail a") },
                explode: { arguments: {}, execute: () => fail("explode", "fail b").pipe(Effect.orDie) },
            } as never)
            await Effect.runPromise(
                router
                    .attach(connected.client, {
                        ...settings,
                        onError: (report) => Effect.promise(() => record(report)),
                    })
                    .pipe(Scope.provide(connected.registration)),
            )
        }
        try {
            remote.deliver("!slow")
            remote.deliver("!slow")
            await vi.waitFor(() => expect(started).toBe(2))
            remote.deliver("!fail")
            remote.deliver("!explode")
            remote.deliver("!missing")
            await vi.waitFor(() => expect(failed).toHaveLength(3))
            await vi.waitFor(() => expect(entered).toBe(1))
            // Every failure has happened, and the barrier lets their reports reach the queue while the first is held
            await barrier(remote, connected)
            expect(entered).toBe(1)
            expect(reports).toEqual([])
        } finally {
            releaseHook()
        }
        await vi.waitFor(() => expect(reports).toHaveLength(3))
        expect(maxActive).toBe(1)
        expect([...reports].sort()).toEqual(["explode:fail b", "fail:fail a", "unmatched:unmatched feedback"])
        release()
    },
)
