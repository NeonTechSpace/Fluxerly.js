/**
 * Errors raised by the testing entry points, shared by the default and native test clients.
 * Invariant: Messages name the unhandled failure codes or the wait that timed out, never payloads or credentials.
 * Implements [SDK contracts: User-handler failures](/docs/SDK-CONTRACTS.md#user-handler-failures)
 */
import { FluxerlyError } from "#sdk/errors"
import type { LogRecord } from "#sdk/logging"

/**
 * A test client shut down after application code failed without a handler, such as an event handler or command that
 * threw or returned a failed Result. The failures list holds the Error records of those failures in order.
 * Reading failures() before shutdown marks the returned failures as expected, and an onError hook handles them instead
 *
 * @category Testing
 */
export class UnhandledTestFailuresError extends FluxerlyError {
    /** Discriminator for unhandled failures found when a test client shut down */
    readonly _tag = "UnhandledTestFailuresError"

    constructor(
        /** Error records of the unhandled failures, in the order they were logged */
        readonly failures: readonly LogRecord[],
    ) {
        const list = failures.map((record) => `${record.code}: ${record.message}`).join("\n")
        const count = failures.length === 1 ? "1 unhandled failure" : `${failures.length} unhandled failures`
        super(`The test client recorded ${count}:\n${list}`, {
            code: "testing.unhandledFailures",
            hint: "Fix the failing code, assert the expected failures with failures() before shutdown, or handle them with onError",
            details: { codes: failures.map((record) => record.code) },
        })
        this.failures = Object.freeze([...failures])
        this.name = this._tag
    }
}

/**
 * A test wait, such as TestRoute.next or idle, did not finish within its timeout
 *
 * @category Testing
 */
export class TestTimeoutError extends FluxerlyError {
    /** Discriminator for a test wait that ran out of time */
    readonly _tag = "TestTimeoutError"

    constructor(
        /** The wait that timed out, such as next or idle */
        readonly wait: "next" | "idle",
        /** The timeout in milliseconds */
        readonly timeoutMs: number,
    ) {
        super(
            wait === "next"
                ? `No matching request arrived within ${timeoutMs} ms`
                : `The test client was still busy after ${timeoutMs} ms`,
            {
                code: "testing.timeout",
                hint:
                    wait === "next"
                        ? "Check that the code under test sends the request and that the route matcher matches it, or raise timeoutMs"
                        : "Check for a handler or request that never finishes, or raise timeoutMs",
                details: { wait, timeoutMs },
            },
        )
        this.name = this._tag
    }
}
