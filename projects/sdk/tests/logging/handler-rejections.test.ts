import { Cause, Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { LogRecord } from "../../src/index.js"
import { createTestBot as createDefaultTestBot } from "../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"

// A rejected token or permission inside a handler is logged once: As the handler's failure when the handler fails
// with it, or as the rest.rejected Warn when the application handles the Result or passes the failure to onError

async function unwrap<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
}

/** How the messageCreate handler and the ping command treat the rejected reply */
type Handling = "return" | "ignore"

interface Driver {
    send(content: string): Promise<void>
    logs(): readonly LogRecord[]
    failures(): readonly LogRecord[]
}

async function open(mode: Mode, handling: Handling, onError?: () => unknown): Promise<Driver> {
    const rejected = { status: 403, body: { code: "MISSING_PERMISSIONS", message: "Missing Permissions" } }
    type Context = { readonly message: { readonly content: string }; reply(text: string): unknown }
    const options = (reply: (context: Context) => unknown) => ({
        ...(onError === undefined ? {} : { onError }),
        events: {
            messageCreate: (context: Context) => (context.message.content === "hello" ? reply(context) : undefined),
        },
        commands: { prefix: "!", commands: { ping: { execute: reply } } },
    })
    if (mode === "default") {
        const bot = createDefaultTestBot(
            options(async (context) => {
                const result = await context.reply("Hi")
                return handling === "return" ? result : undefined
            }) as never,
        )
        onTestFinished(() => bot.shutdown())
        bot.rest.respond("POST /channels/:id/messages", rejected)
        await bot.ready()
        return {
            send: async (content) => {
                bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content }))
                await bot.idle()
            },
            logs: () => bot.logs(),
            failures: () => bot.failures(),
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => unwrap(Scope.close(scope, Exit.void)))
    const bot = await unwrap(
        createNativeTestBot(
            options((context) => {
                const reply = context.reply("Hi") as Effect.Effect<unknown, unknown>
                return handling === "return" ? reply : Effect.ignore(reply)
            }) as never,
        ).pipe(Scope.provide(scope)),
    )
    bot.rest.respond("POST /channels/:id/messages", rejected)
    await unwrap(bot.ready())
    return {
        send: async (content) => {
            await unwrap(bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content })))
            await unwrap(bot.idle())
        },
        logs: () => bot.logs(),
        failures: () => bot.failures(),
    }
}

const problems = (driver: Driver) =>
    driver.logs().filter((record) => record.level === "warn" || record.level === "error")

test.each(modes)(
    "%s a failed reply returned by a handler or command is logged once, with a send hint",
    async (mode) => {
        const bot = await open(mode, "return")
        await bot.send("hello")
        await bot.send("!ping")
        expect(problems(bot).map((record) => record.code)).toEqual(["events.handlerFailed", "commands.failed"])
        for (const record of problems(bot)) {
            const hint = (record.error as { hint?: string }).hint
            expect(hint).toMatch(/Send Messages/)
            // Role position matters for moderation, not for a message
            expect(hint).not.toMatch(/highest role/)
        }
        expect(bot.failures()).toHaveLength(2)
    },
)

test.each(modes)("%s a failed reply the handler handles still logs one rest.rejected Warn", async (mode) => {
    const bot = await open(mode, "ignore")
    await bot.send("hello")
    await bot.send("!ping")
    // Both rejections share the route and code, so deduplication shows the first
    expect(problems(bot)).toEqual([
        expect.objectContaining({
            level: "warn",
            code: "rest.rejected",
            fields: expect.objectContaining({
                apiError: "MISSING_PERMISSIONS",
                hint: expect.stringMatching(/Send Messages/),
            }),
        }),
    ])
})

test.each(modes)("%s a failed reply passed to onError still logs the rest.rejected Warn", async (mode) => {
    let reports = 0
    const bot = await open(mode, "return", () => {
        reports += 1
        return mode === "default" ? undefined : Effect.void
    })
    await bot.send("hello")
    expect(reports).toBe(1)
    expect(problems(bot).map((record) => record.code)).toEqual(["rest.rejected"])
})
