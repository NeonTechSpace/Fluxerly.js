import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { LogRecord } from "../../src/index.js"
import { createTestBot as createDefaultTestBot } from "../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../src/effect-testing.js"
import {
    errorCodes,
    logCodes,
    operationReasonMeanings,
    type ErrorCodeEntry,
    type LogCode,
    type LogCodeEntry,
} from "../../src/internal/code-catalogue.js"
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

// An operator looks a code up by its text, so an error code that equals a log code must either be the failure that
// record reports or be pointed out in the record's meaning
test("an error code that equals a log code has the same meaning or is pointed out", () => {
    const sameFailure = new Set(["rest.busy", "rest.rejected", "supervisor.startupTimeout"])
    for (const [family, entry] of Object.entries(errorCodes) as [string, ErrorCodeEntry][]) {
        for (const value of entry.values ?? []) {
            const code = family.replace(/<[^>]+>/, value)
            if (Object.hasOwn(logCodes, code) && !sameFailure.has(code))
                expect(logCodes[code as LogCode].meaning, code).toContain(family)
        }
    }
})

// A level is a threshold, so only one above the code's own level hides it. Advice in any other form can point the wrong way
test("a code's advice to quiet it through a category level names a level that hides it", () => {
    const rank = ["trace", "debug", "info", "warn", "error", "fatal", "silent"]
    for (const [code, entry] of Object.entries(logCodes) as [string, LogCodeEntry][]) {
        const action = entry.action ?? ""
        if (!/category level/.test(action)) continue
        const advice = /set the \w+ category level to (\w+)/.exec(action)
        expect(advice, `${code}: advice names no level`).not.toBeNull()
        for (const level of entry.levels) expect(rank.indexOf(advice![1]!), code).toBeGreaterThan(rank.indexOf(level))
    }
})

// members.search refuses join-source filters locally with reason rejected, so the meaning must not say only Fluxer refuses
test("the rejected reason's meaning covers the local refusal that is never sent", () => {
    expect(operationReasonMeanings.rejected).toContain("notDispatched")
})
