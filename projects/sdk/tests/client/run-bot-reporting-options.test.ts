import { Cause, Effect, Exit, Logger } from "effect"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { runBot, SdkDefect } from "../../src/index.js"
import { runBot as runNativeBot } from "../../src/effect.js"
import { captureLogs } from "../support/log-capture.js"

const token = "111111111111111111.fixture_fixture_fixture_fixture_fixture_fixture"
let previousExitCode: typeof process.exitCode

beforeEach(() => {
    previousExitCode = process.exitCode
    process.exitCode = undefined
})

afterEach(() => {
    process.exitCode = previousExitCode
    vi.restoreAllMocks()
})

function transport() {
    return {
        fetch: vi.fn(async () => {
            throw new Error("Unexpected HTTP request")
        }),
        webSocket: vi.fn(() => {
            throw new Error("Unexpected gateway connection")
        }),
    }
}

function throwingOption(options: object, key: string, failure: unknown) {
    return Object.defineProperty(options, key, {
        enumerable: true,
        get() {
            throw failure
        },
    })
}

/** Observe the native default logger without replacing any SDK implementation */
async function nativeOutcome(options: object) {
    const output: string[] = []
    const logger = Logger.make((entry) => {
        const parts = Array.isArray(entry.message) ? entry.message : [entry.message]
        output.push(
            parts.map((part) => (Cause.isCause(part) ? Cause.pretty(part) : String(part))).join(" "),
            Cause.pretty(entry.cause),
        )
    })
    const exit = await Effect.runPromiseExit(
        runNativeBot(options as never).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger]))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    return { error, output }
}

function expectNoTransport(network: ReturnType<typeof transport>) {
    expect(network.fetch).not.toHaveBeenCalled()
    expect(network.webSocket).not.toHaveBeenCalled()
}

describe.each(["default", "native"] as const)("%s runBot reporting options", (mode) => {
    test.each(["'", '"'])("masks a token enclosed in %s in a failure before client creation", async (quote) => {
        const logs = captureLogs()
        const network = transport()
        // The leading word character prevents token-shape heuristics from hiding a normalization regression
        const failure = new Error(`Registration failed for x${token}`, {
            cause: new Error(`Nested registration failure for x${token}`),
        })
        const options = {
            token: `  ${quote}  ${token}  ${quote}  `,
            logging: logs.logging,
            transport: network,
            commands: {
                prefix: "!",
                commands: () => {
                    throw failure
                },
            },
        }
        const error =
            mode === "default"
                ? await runBot(options).then((result) => (result.isErr() ? result.error : undefined))
                : (await nativeOutcome(options)).error
        expect(error).toMatchObject({ _tag: "ApplicationError", source: "runBot commands", cause: failure })
        const records = logs.withCode("lifecycle.botFailed")
        expect(records).toHaveLength(1)
        expect(records[0]?.error?.cause?.message).toContain("Registration failed for")
        expect(records[0]?.error?.cause?.cause?.message).toContain("Nested registration failure for")
        expect(JSON.stringify(records)).not.toContain(token)
        expect(process.exitCode).toBe(1)
        expectNoTransport(network)
    })

    test.each(["events", "connection"])("keeps the failure contract when the %s getter throws", async (key) => {
        const logs = captureLogs()
        const network = transport()
        const failure = new Error(`Option failed for x${token}`)
        const options = throwingOption(
            { token: ` '${token}' `, logging: logs.logging, transport: network },
            key,
            failure,
        )
        if (mode === "default") {
            let error: unknown
            try {
                void runBot(options as never)
            } catch (thrown) {
                error = thrown
            }
            expect(error).toBeInstanceOf(SdkDefect)
            expect(error).toMatchObject({ code: "application.defect", operation: "runBot", cause: failure })
            expect(logs.records).toEqual([])
            expect(process.exitCode).toBeUndefined()
        } else {
            const { error, output } = await nativeOutcome(options)
            expect(error).toBe(failure)
            expect(logs.withCode("lifecycle.botFailed")).toHaveLength(1)
            expect(JSON.stringify(logs.records)).not.toContain(token)
            expect(output).toEqual([])
            expect(process.exitCode).toBe(1)
        }
        expectNoTransport(network)
    })

    test("keeps reportFailure false when an unrelated getter throws", async () => {
        const logs = captureLogs()
        const network = transport()
        const failure = new Error("Synthetic option failure")
        const options = throwingOption(
            { token, logging: logs.logging, reportFailure: false, transport: network },
            "events",
            failure,
        )
        // An application-owned nonzero status must not be replaced by the runner
        process.exitCode = 7
        if (mode === "default") {
            expect(() => runBot(options as never)).toThrow(SdkDefect)
        } else {
            const { error, output } = await nativeOutcome(options)
            expect(error).toBe(failure)
            expect(output).toEqual([])
        }
        expect(logs.records).toEqual([])
        expect(process.exitCode).toBe(7)
        expectNoTransport(network)
    })
})

describe("native runBot independent reporting getters", () => {
    test("keeps the configured sink when the token getter throws", async () => {
        const logs = captureLogs()
        const failure = new Error("Synthetic token getter failure")
        const options = throwingOption({ logging: logs.logging }, "token", failure)
        const { error, output } = await nativeOutcome(options)
        expect(error).toBe(failure)
        expect(logs.withCode("lifecycle.botFailed")).toHaveLength(1)
        expect(output).toEqual([])
        expect(process.exitCode).toBe(1)
    })

    test("uses the native default logger with token masking when the logging getter throws", async () => {
        const failure = new Error(`Logging getter failed for x${token}`)
        const options = throwingOption({ token: ` "${token}" ` }, "logging", failure)
        const { error, output } = await nativeOutcome(options)
        expect(error).toBe(failure)
        expect(output.join("\n")).toContain("Logging getter failed for")
        expect(output.join("\n")).not.toContain(token)
        expect(process.exitCode).toBe(1)
    })

    test("keeps token masking and the sink when the reportFailure getter throws", async () => {
        const logs = captureLogs()
        const failure = new Error(`Report setting failed for x${token}`)
        const options = throwingOption({ token: ` '${token}' `, logging: logs.logging }, "reportFailure", failure)
        const { error, output } = await nativeOutcome(options)
        expect(error).toBe(failure)
        expect(logs.withCode("lifecycle.botFailed")).toHaveLength(1)
        expect(JSON.stringify(logs.records)).not.toContain(token)
        expect(output).toEqual([])
        expect(process.exitCode).toBe(1)
    })

    test.each(["token", "logging"])("does not report a throwing %s getter when reportFailure is false", async (key) => {
        const logs = captureLogs()
        const failure = new Error("Synthetic reporting getter failure")
        const options = throwingOption({ token, logging: logs.logging, reportFailure: false }, key, failure)
        const { error, output } = await nativeOutcome(options)
        expect(error).toBe(failure)
        expect(logs.records).toEqual([])
        expect(output).toEqual([])
        expect(process.exitCode).toBeUndefined()
    })
})
