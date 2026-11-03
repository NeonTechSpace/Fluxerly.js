import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { ConfigurationError, type FailureReport, type LogRecord } from "../../src/index.js"
import { createTestBot } from "../../src/effect-testing.js"
import { ClientLogger, loggingConfiguration } from "../../src/internal/logging.js"

afterEach(() => {
    vi.restoreAllMocks()
})

function configured(value: unknown) {
    const result = loggingConfiguration(value, false)
    if (result instanceof ConfigurationError) throw result
    expect(result).toBeInstanceOf(ClientLogger)
    return result
}

/** A task that fails and whose cleanup then dies, which Effect keeps as two reasons in one Cause */
const failingWithCleanup = Effect.fail(new Error("The report task failed")).pipe(
    Effect.ensuring(Effect.die(new Error("The release step failed"))),
)

// Catches: Only the first failure of a Cause reached sinks and describe(), so a failed cleanup was never shown there
test("a task whose cleanup also fails names both failures in sink records and describe()", async () => {
    for (const hooked of [false, true]) {
        const reports: FailureReport[] = []
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const bot = await Effect.runPromise(
            createTestBot(
                hooked ? { onError: (report: FailureReport) => Effect.sync(() => void reports.push(report)) } : {},
            ).pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(bot.ready())
        await Effect.runPromise(bot.client.schedule(failingWithCleanup, { name: "daily report" }))
        if (hooked) {
            await vi.waitFor(() => expect(reports).toHaveLength(1))
            const description = reports[0]!.describe()
            expect(description).toContain("The report task failed")
            expect(description).toContain("Also failed: Error: The release step failed")
            continue
        }
        await vi.waitFor(() => expect(bot.failures()).toHaveLength(1))
        const record = bot.failures()[0]!
        expect(record.error).toMatchObject({ message: "The report task failed" })
        expect(record.otherErrors).toEqual([expect.objectContaining({ message: "The release step failed" })])
    }
})

// Catches: JSON and pretty console output printed only the record's first error
test("JSON and pretty output print every failure of the record's Cause", () => {
    const failure = new Error("The report task failed")
    const cleanup = new Error("The release step failed")
    const exit = Effect.runSyncExit(Effect.fail(failure).pipe(Effect.ensuring(Effect.die(cleanup))))
    if (!Exit.isFailure(exit)) throw new Error("The probe did not fail")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    for (const format of ["json", "pretty"] as const) {
        log.mockClear()
        configured({ format }).log({
            level: "error",
            category: "lifecycle",
            code: "lifecycle.taskFailed",
            message: "A scheduled task failed",
            error: failure,
            cause: exit.cause,
            origin: "application",
        })
        const text = String(log.mock.calls[0]![0])
        if (format === "json") {
            const record = JSON.parse(text) as LogRecord
            expect(record.error?.message).toBe("The report task failed")
            expect(record.otherErrors?.map((other) => other.message)).toEqual(["The release step failed"])
        } else {
            expect(text).toContain("The report task failed")
            expect(text).toMatch(/^\s+Also failed: Error: The release step failed$/m)
        }
    }
})

// A record whose Cause holds only its own error keeps the same shape as before
test("a record with a single failure has no otherErrors", () => {
    const records: LogRecord[] = []
    const logger = configured({ sink: (record: LogRecord) => records.push(record) })
    const failure = new Error("Only failure")
    const exit = Effect.runSyncExit(Effect.fail(failure))
    if (!Exit.isFailure(exit)) throw new Error("The probe did not fail")
    logger.log({
        level: "error",
        category: "lifecycle",
        code: "lifecycle.taskFailed",
        message: "A scheduled task failed",
        error: failure,
        cause: exit.cause,
    })
    expect(records[0]).not.toHaveProperty("otherErrors")
})
