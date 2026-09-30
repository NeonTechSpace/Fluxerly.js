import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { LogRecord } from "../../src/index.js"
import { createTestBot as createDefaultTestBot } from "../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../src/effect-testing.js"
import { logCodes, type LogCode } from "../../src/internal/code-catalogue.js"
import { modes } from "../support/both-apis.js"

// Every observed emission must be listed at its actual level, including failures delivered to a hook at Debug
function checkLevels(records: readonly LogRecord[]) {
    for (const record of records) {
        const entry = logCodes[record.code as LogCode]
        expect(entry, record.code).toBeDefined()
        expect(entry.levels as readonly string[], record.code).toContain(record.level)
    }
}

test.each(modes)("%s handler and command report levels match the catalogue with and without onError", async (mode) => {
    for (const handled of [false, true]) {
        if (mode === "default") {
            const fail = () => {
                throw new Error("Fixture callback failure")
            }
            const bot = createDefaultTestBot({
                logging: { level: "debug" },
                ...(handled ? { onError: () => undefined } : {}),
                events: { messageCreate: ({ message }) => (message.content === "event" ? fail() : undefined) },
                commands: { prefix: "!", commands: { ping: { execute: fail } } },
            })
            onTestFinished(async () => {
                bot.failures()
                await bot.shutdown()
            })
            await bot.ready()
            for (const content of ["event", "!ping"]) {
                bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content }))
                await bot.idle()
            }
            expect(
                bot
                    .logs()
                    .filter((record) => ["events.handlerFailed", "commands.failed"].includes(record.code))
                    .map((record) => record.level),
            ).toEqual([handled ? "debug" : "error", handled ? "debug" : "error"])
            checkLevels(bot.logs())
        } else {
            const scope = Scope.makeUnsafe()
            const fail = () => Effect.fail(new Error("Fixture callback failure"))
            const bot = await Effect.runPromise(
                createNativeTestBot({
                    logging: { level: "debug" },
                    ...(handled ? { onError: () => Effect.void } : {}),
                    events: { messageCreate: ({ message }) => (message.content === "event" ? fail() : Effect.void) },
                    commands: { prefix: "!", commands: { ping: { execute: fail } } },
                }).pipe(Scope.provide(scope)),
            )
            onTestFinished(async () => {
                bot.failures()
                await Effect.runPromise(Scope.close(scope, Exit.void))
            })
            await Effect.runPromise(bot.ready())
            for (const content of ["event", "!ping"]) {
                await Effect.runPromise(bot.emit("MESSAGE_CREATE", bot.fixtures.message({ content })))
                await Effect.runPromise(bot.idle())
            }
            expect(
                bot
                    .logs()
                    .filter((record) => ["events.handlerFailed", "commands.failed"].includes(record.code))
                    .map((record) => record.level),
            ).toEqual([handled ? "debug" : "error", handled ? "debug" : "error"])
            checkLevels(bot.logs())
        }
    }
})
