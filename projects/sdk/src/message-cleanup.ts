import type { OperationOptions } from "./client.js"
import type { MessageOperationError } from "./message-errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"
import type { Message, MessageOperationOptions } from "./messages.js"

/** Required bounded selection for one moderation cleanup preview.
 * At least authorId or filter is required. Both criteria must match. The synchronous filter receives each fetched
 * message newest first. It must return a boolean and must not block. A blocking filter cannot be preempted by timeout
 * or cancellation. The SDK never persists the criterion, messages, or plan
 */
export interface MessageCleanupSelection {
    /** Restrict selection to one decimal message-author ID */
    readonly authorId?: string
    /** Synchronous application predicate combined with authorId. Throwing, non-boolean, and thenable results fail preview before deletion */
    readonly filter?: (message: Message) => boolean
    /** Maximum messages fetched and inspected, from 1 through 10,000 */
    readonly maxScanned: number
    /** Maximum selected messages retained in the plan, from 1 through 10,000 */
    readonly maxSelected: number
}

/** Why preview stopped reading history. A selection limit is not a complete history result */
export type MessageCleanupStopReason = "historyExhausted" | "scanLimit" | "selectionLimit"

/** Immutable exact selection returned by previewCleanup and accepted only by its producing client.
 * selectedMessages are caller-owned message snapshots. The plan is in-memory only: JSON reconstruction, a different
 * client, or a prior cleanup attempt is rejected before dispatch. Use a fresh preview or explicit deleteMany calls for
 * application-controlled reconciliation. The SDK does not journal, replay, or recover this plan
 */
export interface MessageCleanupPlan {
    /** Channel used for preview and the only channel cleanup can target */
    readonly channelId: string
    /** Exact frozen snapshots selected during preview, in newest-to-oldest history order */
    readonly selectedMessages: readonly Message[]
    /** Number of history messages inspected before preview stopped */
    readonly scannedCount: number
    /** Bound or empty page that stopped preview, not proof of a stable remote history */
    readonly stopReason: MessageCleanupStopReason
}

/** One sequential bulk-delete submission in a cleanup report or failure.
 * HTTP completion only means Fluxer accepted the batch request. It does not prove every ID existed or was deleted
 */
export interface MessageCleanupBatch {
    /** Zero-based submission order */
    readonly batchIndex: number
    /** Exact selected IDs submitted in this request, never a later history selection */
    readonly messageIds: readonly string[]
}

/** Successful cleanup submission report. submittedBatches is not a deletion count or atomic outcome */
export interface MessageCleanupReport {
    /** Channel from the immutable plan */
    readonly channelId: string
    /** IDs copied from the immutable plan, in its preview order */
    readonly selectedMessageIds: readonly string[]
    /** History messages scanned by the earlier preview */
    readonly scannedCount: number
    /** Earlier successful HTTP batch submissions in sequence */
    readonly submittedBatches: readonly MessageCleanupBatch[]
}

/** Best-effort synchronous cleanup progress observation.
 * The SDK ignores callback throws and rejected thenables. Persist synchronously in the callback if application-owned
 * reconciliation needs the event. No event proves deletion, and interruption can leave a submitting batch unknown
 */
export type MessageCleanupProgress =
    | {
          /** The batch is about to be submitted and may become unknown if interrupted */
          readonly state: "submitting"
          readonly batch: MessageCleanupBatch
      }
    | {
          /** Fluxer returned the batch's successful HTTP status, not per-message deletion proof */
          readonly state: "submitted"
          readonly batch: MessageCleanupBatch
      }
    | {
          /** A non-interruption terminal batch failure, with only SDK-owned metadata */
          readonly state: "failed"
          readonly batch: MessageCleanupBatch
          readonly failure: MessageCleanupFailureMetadata
      }

/** Safe terminal batch metadata exposed in a cleanup progress event */
export interface MessageCleanupFailureMetadata {
    /** Local validation, callback misuse, client closure, REST failure, response decoding, deadline or rate limit */
    readonly reason: MessageCleanupErrorReason
    /** Whether the terminal batch was not dispatched, rejected, or may have reached Fluxer */
    readonly outcome: MessageCleanupOutcome
    /** HTTP status when known, otherwise null */
    readonly status: number | null
    /** Usable provider retry delay in milliseconds when known, otherwise null */
    readonly retryAfterMs: number | null
    /** Reviewed provider rejection detail when known, otherwise null. It excludes provider response text and field paths */
    readonly apiError: ApiErrorDetail | null
}

/** Per-call cleanup settings. One deadline covers all preview reads or all cleanup batch submissions */
export interface MessageCleanupOptions extends MessageOperationOptions {
    /** Best-effort synchronous progress callback. It is not awaited, durable, or a retry/recovery scheduler */
    readonly onProgress?: (progress: MessageCleanupProgress) => unknown
}

/** Default cleanup cancellation settings. Abort preserves default cancellation rather than converting it to a report */
export interface DefaultMessageCleanupOptions extends MessageCleanupOptions, OperationOptions {}

/** Cleanup error reason. No message body, criterion, callback error, upstream body, or credential is retained */
export type MessageCleanupErrorReason = "filter" | "closed" | "input" | MessageOperationError["reason"]

/** Submission knowledge for a cleanup failure. unknown never authorizes an automatic retry */
export type MessageCleanupOutcome = "notDispatched" | "rejected" | "unknown"

/** Expected preview or cleanup failure with partial submission information and no message bodies or criteria.
 * submittedBatches records only earlier HTTP-success batches. terminalBatchIds identifies the failed or uncertain
 * request when one was reached. This never proves individual deletion, atomic rollback, or safe replay
 */
export class MessageCleanupError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "MessageCleanupError"
    /** Frozen SDK-owned validation facts for local input failures, otherwise null; presentation remains application-owned */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** Preview never submits deletion. Cleanup can have earlier submitted batches */
        readonly phase: "preview" | "cleanup",
        /** SDK-owned failure classification */
        readonly reason: MessageCleanupErrorReason,
        /** Dispatch knowledge for the terminal stage */
        readonly outcome: MessageCleanupOutcome,
        /** HTTP status for the terminal stage, if available */
        readonly status: number | null,
        /** Provider retry delay for the terminal stage, if available */
        readonly retryAfterMs: number | null,
        /** Number of history messages inspected during preview before this failure */
        readonly scannedCount: number,
        /** Exact selected IDs, never message content or filter details */
        readonly selectedMessageIds: readonly string[],
        /** Earlier successful HTTP submissions, never inferred deletion success */
        readonly submittedBatches: readonly MessageCleanupBatch[],
        /** Failed or uncertain batch IDs when a cleanup request was reached, otherwise null */
        readonly terminalBatchIds: readonly string[] | null,
        inputValidation: InputValidationDetail | null = null,
        /** Reviewed terminal Fluxer rejection detail, or null when no safe classification is available */
        readonly apiError: ApiErrorDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "Message cleanup",
                phase,
                reason,
                outcome,
                status,
                apiError,
                inputValidation?.explanation ?? null,
                retryAfterMs,
            ),
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

/** Cleanup has one expected error type in both entry points. Native interruption remains outside this union */
export type MessageCleanupFailure = MessageCleanupError
