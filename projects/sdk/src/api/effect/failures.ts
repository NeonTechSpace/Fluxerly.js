import type * as Cause from "effect/Cause"
import type { FailureReport as SharedFailureReport } from "#sdk/failures"

/**
 * A failure outside any returned result, delivered to a native onError hook or logged at Error with its full error.
 * The error field is the handler's typed failure or defect value, and cause keeps the complete Effect Cause, including every reason.
 * The message reference contains IDs only. The original error and Cause can contain message content or other
 * application data
 *
 * @category Logging and diagnostics
 */
export interface FailureReport extends SharedFailureReport {
    /** The complete Effect Cause of the failure */
    readonly cause: Cause.Cause<unknown>
}
