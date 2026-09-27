import { Cause, Effect, Exit, Scope } from "effect"
import { err } from "neverthrow"
import { expect, onTestFinished, test } from "vitest"
import { ApplicationError } from "../../src/index.js"
import {
    createTestBot as createDefaultTestBot,
    createTestClient as createDefaultTestClient,
    type TestRequest,
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
    commands(): readonly { readonly op: number }[]
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
            commands: () => bot.commands(),
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
        commands: () => bot.commands(),
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
                      Effect.scoped(create === "bot" ? createNativeTestBot(options) : createNativeTestClient(options)),
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
