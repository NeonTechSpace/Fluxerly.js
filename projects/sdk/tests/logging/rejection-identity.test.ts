import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createTestBot as createDefaultTestBot } from "../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"

afterEach(() => vi.useRealTimers())

type Handling = "return" | "two" | "wrap" | "late"

async function open(mode: Mode, handling: Handling, providerCode = "MISSING_PERMISSIONS") {
    const rejected = { status: 403, body: { code: providerCode } }
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pause = async () => {
        reached.resolve()
        await release.promise
    }
    if (mode === "default") {
        const bot = createDefaultTestBot({
            logging: { dedupe: false },
            events: {
                messageCreate: async ({ reply }) => {
                    if (handling === "two") await reply("Handled first request")
                    const result = await reply("Returned request")
                    if (handling === "late") await pause()
                    if (handling === "wrap" && result.isErr())
                        throw new Error("Wrapped rejection", { cause: result.error })
                    return result
                },
            },
        })
        onTestFinished(async () => {
            bot.failures()
            await bot.shutdown()
        })
        bot.rest.respond("POST /channels/:id/messages", rejected)
        await bot.ready()
        return {
            emit: () => bot.emit("MESSAGE_CREATE", bot.fixtures.message()),
            idle: () => bot.idle(),
            logs: () => bot.logs(),
            reached: reached.promise,
            release: release.resolve,
        }
    }
    const scope = Scope.makeUnsafe()
    const bot = await Effect.runPromise(
        createNativeTestBot({
            logging: { dedupe: false },
            events: {
                messageCreate: ({ reply }) =>
                    Effect.gen(function* () {
                        if (handling === "two") yield* Effect.ignore(reply("Handled first request"))
                        const result = yield* Effect.exit(reply("Returned request"))
                        if (handling === "late") yield* Effect.promise(pause)
                        if (Exit.isFailure(result)) {
                            if (handling === "wrap") {
                                const reason = result.cause.reasons.find((reason) => reason._tag === "Fail")
                                return yield* Effect.fail(
                                    new Error("Wrapped rejection", {
                                        cause: reason?._tag === "Fail" ? reason.error : undefined,
                                    }),
                                )
                            }
                            return yield* Effect.failCause(result.cause)
                        }
                        return result.value
                    }),
            },
        }).pipe(Scope.provide(scope)),
    )
    onTestFinished(async () => {
        bot.failures()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    bot.rest.respond("POST /channels/:id/messages", rejected)
    await Effect.runPromise(bot.ready())
    return {
        emit: () => Effect.runPromise(bot.emit("MESSAGE_CREATE", bot.fixtures.message())),
        idle: () => Effect.runPromise(bot.idle()),
        logs: () => bot.logs(),
        reached: reached.promise,
        release: release.resolve,
    }
}

test.each(modes)("%s an unknown provider code returned by a handler logs only the handler failure", async (mode) => {
    const bot = await open(mode, "return", "NEW_PERMISSION_RULE")
    await bot.emit()
    await bot.idle()
    const problems = bot.logs().filter((record) => record.level === "warn" || record.level === "error")
    expect(problems.map((record) => record.code)).toEqual(["events.handlerFailed"])
    expect(problems[0]?.error?.details).toMatchObject({ providerCode: "NEW_PERMISSION_RULE" })
})

test.each(modes)(
    "%s a handled rejection is not claimed by a later rejection with the same status and code",
    async (mode) => {
        const bot = await open(mode, "two")
        await bot.emit()
        await bot.idle()
        const problems = bot.logs().filter((record) => record.level === "warn" || record.level === "error")
        expect(problems.map((record) => record.code)).toEqual(["events.handlerFailed", "rest.rejected"])
    },
)

test.each(modes)("%s a handler failure claims the rejection in its cause chain", async (mode) => {
    const bot = await open(mode, "wrap")
    await bot.emit()
    await bot.idle()
    expect(
        bot
            .logs()
            .filter((record) => record.level === "warn" || record.level === "error")
            .map((record) => record.code),
    ).toEqual(["events.handlerFailed"])
})

test.each(modes)("%s a rejection flushes after one second even when the handler has not failed yet", async (mode) => {
    const bot = await open(mode, "late")
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    await bot.emit()
    await bot.reached
    expect(bot.logs().filter((record) => record.code === "rest.rejected")).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(bot.logs().filter((record) => record.code === "rest.rejected")).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(bot.logs().filter((record) => record.code === "rest.rejected")).toHaveLength(1)
    bot.release()
    await bot.idle()
    expect(
        bot
            .logs()
            .filter((record) => record.level === "warn" || record.level === "error")
            .map((record) => record.code),
    ).toEqual(["rest.rejected", "events.handlerFailed"])
})
