import { Cause, Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { ConfigurationError } from "../../src/index.js"
import { createTestBot as createDefaultTestBot, type TestRequest } from "../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"

/** The error a native Effect failed or died with, instead of the FiberFailure wrapper */
async function unwrap<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
}

/** A runBot-style test bot with a greet command that needs a name, driven with promise-returning calls */
interface Driver {
    /** Send one message, wait until the bot has handled it, and return the message sends made so far */
    send(content: string): Promise<readonly TestRequest[]>
}

async function open(mode: Mode, commands: Record<string, unknown>): Promise<Driver> {
    const greet = { arguments: { name: { type: "text" } } }
    if (mode === "default") {
        const bot = createDefaultTestBot({
            commands: {
                prefix: "!",
                ...commands,
                commands: {
                    greet: { ...greet, execute: ({ reply }: { reply(text: string): unknown }) => reply("Hello") },
                },
            } as never,
        })
        onTestFinished(() => bot.shutdown())
        const sends = bot.rest.respond("POST /channels/:id/messages", { body: bot.fixtures.message() })
        await bot.ready()
        return {
            send: async (content) => {
                bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content }))
                await bot.idle()
                return sends.requests()
            },
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => unwrap(Scope.close(scope, Exit.void)))
    const bot = await unwrap(
        createNativeTestBot({
            commands: {
                prefix: "!",
                ...commands,
                commands: {
                    greet: { ...greet, execute: ({ reply }: { reply(text: string): unknown }) => reply("Hello") },
                },
            } as never,
        }).pipe(Scope.provide(scope)),
    )
    const sends = bot.rest.respond("POST /channels/:id/messages", { body: bot.fixtures.message() })
    await unwrap(bot.ready())
    return {
        send: async (content) => {
            await unwrap(bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content })))
            await unwrap(bot.idle())
            return sends.requests()
        },
    }
}

test.each(modes)("%s runBot replies to a rejected command by default", async (mode) => {
    const bot = await open(mode, {})
    const sends = await bot.send("!greet")
    expect(sends.map((request) => (request.body as { content?: unknown }).content)).toEqual([
        expect.stringContaining("Missing name. Usage: !greet <name>"),
    ])
})

test.each(modes)('%s onReject "silent" keeps runBot from replying to a rejected command', async (mode) => {
    const bot = await open(mode, { onReject: "silent" })
    expect(await bot.send("!greet")).toEqual([])
    // The command still runs when its argument is present
    expect(await bot.send("!greet Ada")).toHaveLength(1)
})

test.each(modes)("%s a command placed next to prefix is explained as belonging in the inner commands", async (mode) => {
    const misplaced = { prefix: "!", ping: { execute: () => undefined } }
    const error =
        mode === "default"
            ? await Promise.resolve()
                  .then(() => createDefaultTestBot({ commands: misplaced as never }))
                  .catch((thrown: unknown) => thrown)
            : await unwrap(Effect.scoped(createNativeTestBot({ commands: misplaced as never }))).catch(
                  (thrown: unknown) => thrown,
              )
    expect(error).toBeInstanceOf(ConfigurationError)
    expect(error).toMatchObject({
        field: "commands",
        hint: expect.stringContaining('commands: { prefix: "!", commands: { ping: { execute } } }'),
    })
})

test.each(modes)("%s an unknown runBot commands key lists commands among the supported keys", async (mode) => {
    const unknown = { prefixes: "!", commands: {} }
    const error =
        mode === "default"
            ? await Promise.resolve()
                  .then(() => createDefaultTestBot({ commands: unknown as never }))
                  .catch((thrown: unknown) => thrown)
            : await unwrap(Effect.scoped(createNativeTestBot({ commands: unknown as never }))).catch(
                  (thrown: unknown) => thrown,
              )
    expect(error).toMatchObject({
        field: "commands",
        hint: expect.stringMatching(/^Did you mean "prefix"\?.*commands/),
    })
})

test.each(modes)("%s a runBot commands option without a prefix says the prefix is required", async (mode) => {
    const missing = { commands: {} }
    const error =
        mode === "default"
            ? await Promise.resolve()
                  .then(() => createDefaultTestBot({ commands: missing as never }))
                  .catch((thrown: unknown) => thrown)
            : await unwrap(Effect.scoped(createNativeTestBot({ commands: missing as never }))).catch(
                  (thrown: unknown) => thrown,
              )
    expect(error).toMatchObject({ field: "prefix", message: expect.stringContaining('"prefix" is required') })
})
