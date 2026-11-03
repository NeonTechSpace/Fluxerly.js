import { Cause, Effect, Exit, Logger, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { describeError, type ErrorInfo, type LogRecord } from "../../src/index.js"
import { ConfigurationError } from "../../src/errors.js"
import * as native from "../../src/effect.js"
import { createTestBot as createDefaultTestBot } from "../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../src/effect-testing.js"
import { loggingConfiguration } from "../../src/internal/logging.js"
import type { LogCode } from "../../src/internal/code-catalogue.js"
import { modes } from "../support/both-apis.js"

// Catches: Logs and describeError showed only "All promises were rejected" for an AggregateError, without the reason of
// any attempt, and a credential in a member was never masked because it was never printed
const rejection = () =>
    Promise.any([
        Promise.reject(new Error("primary down")),
        Promise.reject(new Error("backup token=synthetic123")),
    ]).catch((error: unknown) => error)

test.each(modes)("%s handler records and describeError show the members of an AggregateError", async (mode) => {
    const failure = await rejection()
    const records: LogRecord[] = []
    const logging = { dedupe: false as const, sink: (record: LogRecord) => void records.push(record) }
    if (mode === "default") {
        const bot = createDefaultTestBot({
            logging,
            events: {
                messageCreate: () => {
                    throw failure
                },
            },
        })
        onTestFinished(async () => {
            bot.failures()
            await bot.shutdown()
        })
        await bot.ready()
        bot.emit("MESSAGE_CREATE", bot.fixtures.message())
        await bot.idle()
    } else {
        const scope = Scope.makeUnsafe()
        const bot = await Effect.runPromise(
            createNativeTestBot({ logging, events: { messageCreate: () => Effect.fail(failure) } }).pipe(
                Scope.provide(scope),
            ),
        )
        onTestFinished(async () => {
            bot.failures()
            await Effect.runPromise(Scope.close(scope, Exit.void))
        })
        await Effect.runPromise(bot.ready())
        await Effect.runPromise(bot.emit("MESSAGE_CREATE", bot.fixtures.message()))
        await Effect.runPromise(bot.idle())
    }
    const [record] = records.filter((item) => item.code === "events.handlerFailed")
    const members = (record?.error?.errors ?? []).map((member: ErrorInfo) => member.message)
    expect(members).toEqual(["primary down", "backup token=[redacted]"])
    const described = (mode === "default" ? describeError : native.describeError)(failure)
    expect(described).toContain("primary down")
    expect(described).toContain("token=[redacted]")
    expect(described).not.toContain("synthetic123")
})

test("two AggregateErrors with different members are not counted as repeats", async () => {
    const failures = [
        new AggregateError([new Error("primary down")], "All promises were rejected"),
        new AggregateError([new Error("backup down")], "All promises were rejected"),
    ]
    const records: LogRecord[] = []
    let next = 0
    const bot = createDefaultTestBot({
        logging: { sink: (record: LogRecord) => void records.push(record) },
        events: {
            messageCreate: () => {
                throw failures[next++]
            },
        },
    })
    onTestFinished(async () => {
        bot.failures()
        await bot.shutdown()
    })
    await bot.ready()
    for (const _ of failures) bot.emit("MESSAGE_CREATE", bot.fixtures.message())
    await bot.idle()
    expect(records.filter((record) => record.code === "events.handlerFailed")).toHaveLength(2)
})

// Catches: Native records kept the members structurally, but Effect's default console output prints a cause with
// Cause.pretty, which shows only the stack and cause, so the printed line still lacked the reason of every attempt
test("the native default console output prints the masked members of an AggregateError", async () => {
    const failure = await rejection()
    const logging = loggingConfiguration({}, true)
    if (logging instanceof ConfigurationError) throw logging
    const printed: string[] = []
    const capture = Logger.make((entry) => void printed.push(Cause.pretty(entry.cause)))
    const input = {
        level: "error",
        category: "events",
        code: "events.handlerFailed" as LogCode,
        message: "handler failed",
        error: failure,
    } as const
    await Effect.runPromise(logging.logEffect(input).pipe(Effect.withLogger(capture)))
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain("primary down")
    expect(printed[0]).toContain("token=[redacted]")
    expect(printed[0]).not.toContain("synthetic123")
})

// Catches: The native default output printed each member as a bare "TypeError: fetch failed" line, without the cause that
// says why, such as ECONNREFUSED, while sinks and the readable description kept it
test("the native default console output prints each member's cause and nested members", async () => {
    const refused = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" })
    const missing = Object.assign(new Error("host not found"), { code: "ENOTFOUND" })
    const failure = new AggregateError(
        [
            new TypeError("fetch failed", { cause: refused }),
            new TypeError("fetch failed", { cause: missing }),
            new AggregateError([new Error("inner attempt failed")], "Nested attempts failed"),
        ],
        "All attempts failed",
    )
    const logging = loggingConfiguration({}, true)
    if (logging instanceof ConfigurationError) throw logging
    const printed: string[] = []
    const capture = Logger.make((entry) => void printed.push(Cause.pretty(entry.cause)))
    await Effect.runPromise(
        logging
            .logEffect({
                level: "error",
                category: "events",
                code: "events.handlerFailed" as LogCode,
                message: "handler failed",
                error: failure,
            })
            .pipe(Effect.withLogger(capture)),
    )
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain("ECONNREFUSED")
    expect(printed[0]).toContain("ENOTFOUND")
    expect(printed[0]).toContain("inner attempt failed")
})
