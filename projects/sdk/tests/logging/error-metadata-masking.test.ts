import { inspect } from "node:util"
import { Effect, Exit, Logger, References, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { ApplicationError, describeError } from "../../src/index.js"
import * as native from "../../src/effect.js"
import { createTestBot as createDefaultTestBot } from "../../src/testing.js"
import { createTestBot as createNativeTestBot } from "../../src/effect-testing.js"
import { modes, fixtureToken } from "../support/both-apis.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const patternToken = "123456789012345678.abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF"

function metadataError(token = patternToken) {
    const error = Object.assign(new Error("Application failure"), { name: `Bearer ${token}`, code: `Bot ${token}` })
    // The stack is independent of name and code, so masking the stack alone cannot make this check pass
    error.stack = "Error: Application failure\n    at application.ts:1:1"
    return error
}

test.each(modes)("%s describeError and SDK error JSON mask application error names and codes", (mode) => {
    const error = metadataError()
    const describe = mode === "default" ? describeError : native.describeError
    const ErrorType = mode === "default" ? ApplicationError : native.ApplicationError
    expect.soft(describe(error)).not.toContain(patternToken)
    expect.soft(describe(new Error("Outer", { cause: error }))).not.toContain(patternToken)
    const serialized = JSON.stringify(new ErrorType("callback", error))
    expect.soft(serialized).not.toContain(patternToken)
    expect(serialized).toContain("[redacted]")
})

test.each(modes)(
    "%s failure logs and report descriptions mask application metadata and client credentials",
    async (mode) => {
        const error = metadataError(fixtureToken)
        const descriptions: string[] = []
        if (mode === "default") {
            const bot = createDefaultTestBot({
                events: {
                    messageCreate: () => {
                        throw error
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
            const failure = bot.failures()[0]!
            expect(failure.error).toMatchObject({ name: "Bearer [redacted]", code: "Bot [redacted]" })
            expect(JSON.stringify(failure)).not.toContain(fixtureToken)
            const reported = createDefaultTestBot({
                onError: (report) => {
                    descriptions.push(report.describe())
                },
                events: {
                    messageCreate: () => {
                        throw error
                    },
                },
            })
            onTestFinished(() => reported.shutdown())
            await reported.ready()
            reported.emit("MESSAGE_CREATE", reported.fixtures.message())
            await reported.idle()
        } else {
            const scope = Scope.makeUnsafe()
            const bot = await Effect.runPromise(
                createNativeTestBot({ events: { messageCreate: () => Effect.fail(error) } }).pipe(Scope.provide(scope)),
            )
            onTestFinished(async () => {
                bot.failures()
                await Effect.runPromise(Scope.close(scope, Exit.void))
            })
            await Effect.runPromise(bot.ready())
            await Effect.runPromise(bot.emit("MESSAGE_CREATE", bot.fixtures.message()))
            await Effect.runPromise(bot.idle())
            const failure = bot.failures()[0]!
            expect(failure.error).toMatchObject({ name: "Bearer [redacted]", code: "Bot [redacted]" })
            expect(JSON.stringify(failure)).not.toContain(fixtureToken)
            const reported = await Effect.runPromise(
                createNativeTestBot({
                    onError: (report) =>
                        Effect.sync(() => {
                            descriptions.push(report.describe())
                        }),
                    events: { messageCreate: () => Effect.fail(error) },
                }).pipe(Scope.provide(scope)),
            )
            await Effect.runPromise(reported.ready())
            await Effect.runPromise(reported.emit("MESSAGE_CREATE", reported.fixtures.message()))
            await Effect.runPromise(reported.idle())
        }
        expect(descriptions).toHaveLength(1)
        expect(descriptions[0]).not.toContain(fixtureToken)
        expect(descriptions[0]).toContain("[redacted]")
    },
)

test("native log causes and annotations mask application error names and codes", async () => {
    const records: unknown[] = []
    const reported = Promise.withResolvers<void>()
    const logger = Logger.make((record) => {
        const annotations = { ...record.fiber.getRef(References.CurrentLogAnnotations) }
        records.push({ cause: record.cause, annotations })
        if (annotations["fluxerly.code"] === "events.handlerFailed") reported.resolve()
    })
    const server = await startGatewayServer()
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* native.createClient({ token: fixtureToken })
                yield* client.on("typingStart", () => Effect.fail(metadataError(fixtureToken)))
                yield* client.connect()
                server.dispatch("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 })
                yield* Effect.promise(() => reported.promise)
                yield* client.shutdown()
            }),
        ).pipe(Effect.withLogger(logger)),
    )
    const output = inspect(records, { depth: 20 })
    expect(output).not.toContain(fixtureToken)
    expect(output).toContain("[redacted]")
})
