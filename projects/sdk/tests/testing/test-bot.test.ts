import { Cause, Effect, Exit, Scope } from "effect"
import { err } from "neverthrow"
import { expect, onTestFinished, test } from "vitest"
import { ApplicationError, ClientClosedError } from "../../src/index.js"
import {
    createTestBot as createDefaultTestBot,
    createTestClient as createDefaultTestClient,
    type TestRequest,
    type TestSayOptions,
    type WireMessage,
} from "../../src/testing.js"
import {
    createTestBot as createNativeTestBot,
    createTestClient as createNativeTestClient,
} from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"

/** The error a native Effect failed or died with, instead of the FiberFailure wrapper */
async function unwrap<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
}

/** A test bot driven through either API style with promise-returning calls */
interface Driver {
    readonly fixtures: ReturnType<typeof createDefaultTestBot>["fixtures"]
    /** Answer message sends by echoing their content, returning a wait for the next answered send */
    replies(): { next(): Promise<TestRequest> }
    ready(): Promise<void>
    emit(type: string, payload: unknown): Promise<void>
    say(content: string, options?: TestSayOptions): Promise<readonly WireMessage[]>
    requests(): readonly TestRequest[]
    commands(): readonly { readonly op: number }[]
    shutdown(): Promise<void>
}

/**
 * Open a test bot written in the runBot style of one API: A messageCreate event handler replying to "hi", a ping
 * command and a setup callback recorded in calls. A failing setup fails with the given value
 */
async function open(mode: Mode, calls: string[], setupFailure?: unknown): Promise<Driver> {
    if (mode === "default") {
        const bot = createDefaultTestBot({
            // The bot's own settings are accepted and ignored, so its options object can be shared with runBot
            token: undefined,
            processSignals: true,
            events: { messageCreate: ({ message, reply }) => (message.content === "hi" ? reply("Hello") : undefined) },
            commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong!") } } },
            setup: (client) => {
                calls.push(`setup ${client.state}`)
                return setupFailure === undefined ? undefined : err(setupFailure)
            },
        })
        onTestFinished(() => bot.shutdown())
        return {
            fixtures: bot.fixtures,
            replies: () => {
                const route = bot.rest.respond("POST /channels/:id/messages", (request) => ({
                    body: bot.fixtures.message({ content: (request.body as { content: string }).content }),
                }))
                return { next: () => route.next() }
            },
            ready: () => bot.ready(),
            emit: async (type, payload) => bot.emit(type, payload),
            say: (content, sayOptions) => bot.say(content, sayOptions),
            requests: () => bot.requests(),
            commands: () => bot.commands(),
            shutdown: () => bot.shutdown(),
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => unwrap(Scope.close(scope, Exit.void)))
    const bot = await unwrap(
        createNativeTestBot({
            token: undefined,
            processSignals: true,
            events: {
                messageCreate: ({ message, reply }) => (message.content === "hi" ? reply("Hello") : Effect.void),
            },
            commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong!") } } },
            setup: (client) =>
                Effect.sync(() => calls.push(`setup ${client.state}`)).pipe(
                    Effect.andThen(setupFailure === undefined ? Effect.void : Effect.fail(setupFailure)),
                ),
        }).pipe(Scope.provide(scope)),
    )
    return {
        fixtures: bot.fixtures,
        replies: () => {
            const route = bot.rest.respond("POST /channels/:id/messages", (request) => ({
                body: bot.fixtures.message({ content: (request.body as { content: string }).content }),
            }))
            return { next: () => unwrap(route.next()) }
        },
        ready: () => unwrap(bot.ready()),
        emit: (type, payload) => unwrap(bot.emit(type, payload)),
        say: (content, sayOptions) => unwrap(bot.say(content, sayOptions)),
        requests: () => bot.requests(),
        commands: () => bot.commands(),
        shutdown: () => unwrap(bot.shutdown()),
    }
}

test.each(modes)("%s createTestBot runs runBot events, commands and setup against the test gateway", async (mode) => {
    const calls: string[] = []
    const bot = await open(mode, calls)
    const replies = bot.replies()
    await bot.ready()
    await bot.ready()
    // Setup runs once, before the client connects
    expect(calls).toEqual(["setup Disconnected"])

    await bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content: "!ping" }))
    const command = await replies.next()
    await bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content: "hi" }))
    const event = await replies.next()
    // Both replies answer the incoming message, as the runBot contexts do
    expect([command.body, event.body]).toEqual([
        expect.objectContaining({ content: "Pong!", message_reference: expect.anything() }),
        expect.objectContaining({ content: "Hello", message_reference: expect.anything() }),
    ])
})

test.each(modes)("%s say returns the messages the bot sent in response, or nothing", async (mode) => {
    const bot = await open(mode, [])
    await bot.ready()
    // No rest.respond fixture: The test transport answers each reply with an echoed message
    const [pong, ...rest] = await bot.say("!ping")
    expect(rest).toEqual([])
    expect(pong).toMatchObject({ content: "Pong!", channel_id: bot.fixtures.ids.channel, author: { bot: true } })
    expect(await bot.say("hi")).toEqual([expect.objectContaining({ content: "Hello" })])
    expect(await bot.say("unrelated")).toEqual([])
    // The bot ignores bot-authored messages by default, and the overrides change the delivered message
    expect(await bot.say("hi", { message: { author: bot.fixtures.botUser() } })).toEqual([])
    expect(bot.requests()).toHaveLength(2)
})

test.each(modes)("%s say reports what the bot sent even when a registered response answers", async (mode) => {
    const bot = await open(mode, [])
    const replies = bot.replies()
    await bot.ready()
    expect(await bot.say("!ping")).toEqual([expect.objectContaining({ content: "Pong!" })])
    expect((await replies.next()).body).toMatchObject({ content: "Pong!" })
})

test.each(modes)("%s say rejects misuse and use before ready", async (mode) => {
    const bot = await open(mode, [])
    const failure = (run: () => Promise<unknown>) =>
        Promise.resolve()
            .then(run)
            .then(
                () => expect.fail("say should fail"),
                (error: unknown) => error,
            )
    expect(await failure(() => bot.say("!ping"))).toMatchObject({ _tag: "ConfigurationError" })
    await bot.ready()
    expect(await failure(() => bot.say(42 as never))).toMatchObject({ _tag: "ConfigurationError" })
    expect(await failure(() => bot.say("!ping", { timeoutMs: 0 }))).toMatchObject({ _tag: "ConfigurationError" })
    expect(await failure(() => bot.say("!ping", { message: "x" as never }))).toMatchObject({
        _tag: "ConfigurationError",
    })
    // Rejected calls delivered nothing
    expect(bot.requests()).toEqual([])
    await bot.shutdown()
    expect(await failure(() => bot.say("!ping"))).toBeInstanceOf(ClientClosedError)
})

test.each(modes)("%s a failed test bot setup rejects ready before connecting", async (mode) => {
    const failure = new Error("setup failed")
    const bot = await open(mode, [], failure)
    const rejected = await bot.ready().then(
        () => expect.fail("ready should reject"),
        (error: unknown) => error,
    )
    expect(rejected).toBeInstanceOf(ApplicationError)
    expect(rejected).toMatchObject({ source: "runBot setup", cause: failure })
    // No gateway command was sent, so the bot never identified
    expect(bot.commands()).toEqual([])
})

test.each(modes)("%s createTestBot rejects misuse like runBot before registering anything", async (mode) => {
    const events = { messageCreated: () => undefined } as never
    const misuse =
        mode === "default"
            ? await Promise.resolve()
                  .then(() => createDefaultTestBot({ events }))
                  .catch((error: unknown) => error)
            : await unwrap(Effect.scoped(createNativeTestBot({ events }))).catch((error: unknown) => error)
    expect(misuse).toMatchObject({ _tag: "ConfigurationError" })
    // The suggestion names the event the bot meant, as runBot's check does
    expect(String((misuse as Error).message) + String((misuse as { hint?: string }).hint)).toContain("messageCreate")
})

test.each(modes)(
    "%s test clients suggest the key a misspelled option meant, among the keys they accept",
    async (mode) => {
        const misuse = async (create: "bot" | "client", options: object) =>
            mode === "default"
                ? await Promise.resolve()
                      .then(() => (create === "bot" ? createDefaultTestBot(options) : createDefaultTestClient(options)))
                      .catch((error: unknown) => error)
                : await unwrap(
                      Effect.scoped<unknown, unknown, Scope.Scope>(
                          create === "bot" ? createNativeTestBot(options) : createNativeTestClient(options),
                      ),
                  ).catch((error: unknown) => error)
        const bot = await misuse("bot", { comands: {} })
        expect(bot).toMatchObject({
            _tag: "ConfigurationError",
            hint: expect.stringContaining('Did you mean "commands"?'),
        })
        const client = await misuse("client", { heartbeatIntervalMS: 5 })
        expect(client).toMatchObject({ hint: expect.stringContaining('Did you mean "heartbeatIntervalMs"?') })
        // The list offers only keys a test client accepts, never the transport and instance it owns
        for (const error of [bot, client])
            expect((error as { hint: string }).hint).not.toMatch(/\b(transport|instance)\b/)
        expect((client as { hint: string }).hint).not.toContain("commands")
    },
)

test.each(modes)("%s runBot handlers skip bot-authored messages unless ignoreBots is false", async (mode) => {
    for (const ignoreBots of [undefined, false] as const) {
        const seen: string[] = []
        const settings = ignoreBots === undefined ? {} : { ignoreBots }
        let driver: {
            readonly fixtures: ReturnType<typeof createDefaultTestBot>["fixtures"]
            emit(type: string, payload: unknown): Promise<void>
            idle(): Promise<void>
        }
        if (mode === "default") {
            const bot = createDefaultTestBot({
                ...settings,
                events: {
                    messageCreate: ({ message }) => void seen.push(`create ${message.content}`),
                    messageUpdate: ({ event }) => void seen.push(`update ${event.content}`),
                },
            })
            onTestFinished(() => bot.shutdown())
            await bot.ready()
            driver = { fixtures: bot.fixtures, emit: async (type, payload) => bot.emit(type, payload), idle: bot.idle }
        } else {
            const scope = Scope.makeUnsafe()
            onTestFinished(() => unwrap(Scope.close(scope, Exit.void)))
            const bot = await unwrap(
                createNativeTestBot({
                    ...settings,
                    events: {
                        messageCreate: ({ message }) => Effect.sync(() => seen.push(`create ${message.content}`)),
                        messageUpdate: ({ event }) => Effect.sync(() => seen.push(`update ${event.content}`)),
                    },
                }).pipe(Scope.provide(scope)),
            )
            await unwrap(bot.ready())
            driver = {
                fixtures: bot.fixtures,
                emit: (type, payload) => unwrap(bot.emit(type, payload)),
                idle: () => unwrap(bot.idle()),
            }
        }
        const { fixtures } = driver
        const otherBot = fixtures.user({ id: fixtures.nextId(), username: "other-bot", bot: true })
        for (const type of ["MESSAGE_CREATE", "MESSAGE_UPDATE"]) {
            // The bot's own message, another bot's message and a person's message
            await driver.emit(
                type,
                fixtures.message({ id: fixtures.nextId(), content: "own", author: fixtures.botUser() }),
            )
            await driver.emit(type, fixtures.message({ id: fixtures.nextId(), content: "other bot", author: otherBot }))
            await driver.emit(type, fixtures.message({ id: fixtures.nextId(), content: "person" }))
        }
        await driver.idle()
        const expected =
            ignoreBots === false
                ? ["create other bot", "create own", "create person", "update other bot", "update own", "update person"]
                : ["create person", "update person"]
        expect(seen.toSorted()).toEqual(expected)
    }
})

test.each(modes)(
    "%s runBot commands follow the runBot ignoreBots setting unless the router sets its own",
    async (mode) => {
        const cases = [
            { bot: undefined, router: undefined, expected: ["person"] },
            { bot: false, router: undefined, expected: ["other-bot", "person"] },
            { bot: false, router: true, expected: ["person"] },
            { bot: undefined, router: false, expected: ["other-bot", "person"] },
        ] as const
        for (const { bot: botSetting, router, expected } of cases) {
            const seen: string[] = []
            const settings = botSetting === undefined ? {} : { ignoreBots: botSetting }
            const routerSettings = router === undefined ? {} : { ignoreBots: router }
            let driver: {
                readonly fixtures: ReturnType<typeof createDefaultTestBot>["fixtures"]
                emit(type: string, payload: unknown): Promise<void>
                idle(): Promise<void>
            }
            if (mode === "default") {
                const bot = createDefaultTestBot({
                    ...settings,
                    commands: {
                        prefix: "!",
                        ...routerSettings,
                        commands: { who: { execute: ({ message }) => void seen.push(message.author.username) } },
                    },
                })
                onTestFinished(() => bot.shutdown())
                await bot.ready()
                driver = {
                    fixtures: bot.fixtures,
                    emit: async (type, payload) => bot.emit(type, payload),
                    idle: bot.idle,
                }
            } else {
                const scope = Scope.makeUnsafe()
                onTestFinished(() => unwrap(Scope.close(scope, Exit.void)))
                const bot = await unwrap(
                    createNativeTestBot({
                        ...settings,
                        commands: {
                            prefix: "!",
                            ...routerSettings,
                            commands: {
                                who: {
                                    execute: ({ message }) => Effect.sync(() => seen.push(message.author.username)),
                                },
                            },
                        },
                    }).pipe(Scope.provide(scope)),
                )
                await unwrap(bot.ready())
                driver = {
                    fixtures: bot.fixtures,
                    emit: (type, payload) => unwrap(bot.emit(type, payload)),
                    idle: () => unwrap(bot.idle()),
                }
            }
            const { fixtures } = driver
            const otherBot = fixtures.user({ id: fixtures.nextId(), username: "other-bot", bot: true })
            const person = fixtures.user({ id: fixtures.nextId(), username: "person" })
            for (const author of [otherBot, person])
                await driver.emit(
                    "MESSAGE_CREATE",
                    fixtures.message({ id: fixtures.nextId(), content: "!who", author }),
                )
            await driver.idle()
            expect(seen.toSorted()).toEqual(expected)
        }
    },
)

test.each(modes)("%s createTestBot rejects an ignoreBots value other than a boolean as misuse", async (mode) => {
    const options = { ignoreBots: "no" } as never
    const misuse =
        mode === "default"
            ? await Promise.resolve()
                  .then(() => createDefaultTestBot(options))
                  .catch((error: unknown) => error)
            : await unwrap(Effect.scoped(createNativeTestBot(options))).catch((error: unknown) => error)
    expect(misuse).toMatchObject({ _tag: "ConfigurationError", message: expect.stringContaining("ignoreBots") })
})

test("default createTestBot setup receives a signal that aborts when the test bot starts shutting down", async () => {
    let setupSignal: AbortSignal | undefined
    const statesAtAbort: string[] = []
    const bot = createDefaultTestBot({
        setup: (client, { signal }) => {
            setupSignal = signal
            signal.addEventListener("abort", () => statesAtAbort.push(client.state))
        },
    })
    onTestFinished(() => bot.shutdown())
    await bot.ready()
    expect(setupSignal?.aborted).toBe(false)
    await bot.shutdown()
    expect(setupSignal?.aborted).toBe(true)
    // The signal aborts before the client stops, so setup work can end with the bot
    expect(statesAtAbort).toEqual(["Connected"])
})
