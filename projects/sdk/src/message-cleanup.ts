import type { OperationOptions } from "./client.js"
import type { MessageOperationError } from "./message-errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"
import type { Message, MessageCore, MessageOperationOptions } from "./messages.js"

/** Choose messages for previewCleanup without deleting them.
 * Set explicit scan and selection limits, and supply authorId, filter, or both.
 * With both supplied, a message must match the author before the filter runs.
 * Messages are inspected newest first, using this client's messageFields selection.
 * The SDK keeps the preview and deletion plan only in memory, not on disk
 */
export interface MessageCleanupSelection<M extends MessageCore = Message> {
    /** Select only messages authored by this account ID, as a decimal string */
    readonly authorId?: string
    /** Return true to select a message, false to skip it. Runs synchronously, so do not block or return a Promise.
     * A throw or non-boolean return fails preview with reason filter, before any deletion.
     * Cancellation and timeouts cannot preempt blocking JavaScript. Mistaken asynchronous work is not awaited or cancelled
     */
    readonly filter?: (message: M) => boolean
    /** Maximum history messages to fetch and inspect, a required integer from 1 through 10,000 */
    readonly maxScanned: number
    /** Maximum selected snapshots to keep in the plan, a required integer from 1 through 10,000 */
    readonly maxSelected: number
}

/** Why preview stopped: An empty history page, the scan cap, or the selected-message cap.
 * scanLimit and selectionLimit do not mean that the channel's history was exhausted
 */
export type MessageCleanupStopReason = "historyExhausted" | "scanLimit" | "selectionLimit"

/** Frozen preview that lets you inspect the exact messages before requesting deletion.
 * Pass the original object to cleanup on the client that produced it. Reconstructed JSON and plans from another client are rejected.
 * Cleanup marks a valid plan as used before it sends any deletion request, even if it then fails before sending one.
 * A consumed plan cannot be retried. Use a fresh preview or explicit deleteMany requests after application-owned reconciliation.
 * The plan does not store a reference to its client or save requests to disk. The SDK cannot recover it after a crash
 */
export interface MessageCleanupPlan<M extends MessageCore = Message> {
    /** Channel inspected by preview and the only channel this plan can delete from */
    readonly channelId: string
    /** Exact selected message snapshots, newest first. Changes after preview do not update this selection */
    readonly selectedMessages: readonly M[]
    /** Number of messages inspected, including messages rejected by the selection */
    readonly scannedCount: number
    /** Condition that ended preview. Even historyExhausted describes an observed empty page, not a stable remote snapshot */
    readonly stopReason: MessageCleanupStopReason
}

/** Exact IDs in one cleanup bulk-delete request, containing at most 100 IDs.
 * Batches run sequentially. A successful HTTP response means Fluxer accepted the request. It does not prove that every ID existed or was deleted
 */
export interface MessageCleanupBatch {
    /** Submission position, with 0 identifying the first batch */
    readonly batchIndex: number
    /** Selected IDs assigned to this request, in preview order. Cleanup does not rescan history */
    readonly messageIds: readonly string[]
}

/** Report returned after cleanup received successful responses for its selected batches.
 * This reports submissions, not a verified number of deleted messages.
 * Deletion is not atomic and the SDK does not roll back earlier batches.
 * An empty selection produces a successful report without a delete request
 */
export interface MessageCleanupReport {
    /** Channel targeted by the preview plan */
    readonly channelId: string
    /** Exact IDs copied from the plan, newest first */
    readonly selectedMessageIds: readonly string[]
    /** Number of history messages inspected during the earlier preview, not during deletion */
    readonly scannedCount: number
    /** Batch requests that received successful HTTP responses, in submission order */
    readonly submittedBatches: readonly MessageCleanupBatch[]
}

/** Progress notification for a cleanup batch, not durable evidence of individual deletions.
 * onProgress runs synchronously. Its throws and rejected asynchronous returns are ignored.
 * Persist the notification synchronously yourself if your application needs it for reconciliation.
 * Cancellation or interruption can leave a submitting batch uncertain without a terminal failed notification
 */
export type MessageCleanupProgress =
    | {
          /** The batch is about to be attempted, not proof that it was dispatched */
          readonly state: "submitting"
          /** Exact planned batch */
          readonly batch: MessageCleanupBatch
      }
    | {
          /** Fluxer returned a successful HTTP response for this batch, without per-message deletion proof */
          readonly state: "submitted"
          /** Batch whose request succeeded */
          readonly batch: MessageCleanupBatch
      }
    | {
          /** A batch request failed with one of the documented errors, rather than being interrupted */
          readonly state: "failed"
          /** Failed or uncertain batch */
          readonly batch: MessageCleanupBatch
          /** Safe failure classification without message bodies or application callback errors */
          readonly failure: MessageCleanupFailureMetadata
      }

/** Expected batch failure details included in a failed progress notification.
 * Contains SDK-owned classifications, not message bodies, filter details or raw provider response text
 */
export interface MessageCleanupFailureMetadata {
    /** Classified cause of the failure, such as invalid input, closure, rejection or deadline expiry */
    readonly reason: MessageCleanupErrorReason
    /** What is known about dispatch: Not sent, definitively rejected, or uncertain */
    readonly outcome: MessageCleanupOutcome
    /** Known HTTP status, or null when none is available */
    readonly status: number | null
    /** Retry delay reported by Fluxer in milliseconds, or null. This does not establish that retrying is safe */
    readonly retryAfterMs: number | null
    /** Safe Fluxer rejection classification, or null, excluding raw response text and provider field paths */
    readonly apiError: ApiErrorDetail | null
}

/** Settings for cleanup's batch submissions.
 * One timeoutMs deadline covers the entire cleanup execution, including rate-limit waits between batches.
 * Preview has its own separate per-call deadline and does not accept onProgress
 */
export interface MessageCleanupOptions extends MessageOperationOptions {
    /** Observe submitting, submitted and failed batches synchronously.
     * Return values are not awaited. Callback failures are ignored, and the callback does not schedule retries or recovery
     */
    readonly onProgress?: (progress: MessageCleanupProgress) => unknown
}

/** Cleanup settings for the Promise and Result API, with AbortSignal cancellation.
 * Cancellation returns CancelledError rather than a partial report. Earlier requests may already have been submitted.
 * Use progress observations for application-owned reconciliation. The Effect entry point retains interruption in Cause
 */
export interface DefaultMessageCleanupOptions extends MessageCleanupOptions, OperationOptions {}

/** Expected preview or cleanup failure classification.
 * filter denotes a bad selection callback, closed denotes client closure, and input denotes invalid settings or plan ownership.
 * Other values preserve the underlying message operation's failure reason
 */
export type MessageCleanupErrorReason = "filter" | "closed" | "input" | MessageOperationError["reason"]

/** What is known about the failed stage's request.
 * notDispatched means no request was sent, rejected means confirmed rejection, and unknown means Fluxer may have acted.
 * An unknown outcome does not mean it is safe to repeat the request
 */
export type MessageCleanupOutcome = "notDispatched" | "rejected" | "unknown"

/** A cleanup preview or deletion failed, with selected IDs and batch progress where available.
 * Preview never deletes. Cleanup can fail after earlier batches received successful responses.
 * submittedBatches describes only those earlier responses. terminalBatchIds identifies the failed or uncertain request when reached.
 * This error contains no message bodies, criteria or original callback errors, and proves neither individual deletion nor safe replay.
 * Cancellation in the default API is returned separately as CancelledError. Native interruption and unexpected defects remain outside this error
 */
export class MessageCleanupError extends Error {
    /** Literal error tag for identifying MessageCleanupError */
    readonly _tag = "MessageCleanupError"
    /** Frozen local validation facts, or null for other failures. Your application chooses how to present them */
    readonly inputValidation: InputValidationDetail | null
    /** Record an expected preview or cleanup failure and the submission knowledge available at that point.
     * Optional validation and provider details default to null. Construction performs no requests, deletion or recovery
     */
    constructor(
        /** Which stage failed. preview never deletes, while cleanup can fail after earlier batch submissions */
        readonly phase: "preview" | "cleanup",
        /** Expected failure classification, without original application or provider error text */
        readonly reason: MessageCleanupErrorReason,
        /** What is known about dispatch at the failed stage, not about the earlier successful batches */
        readonly outcome: MessageCleanupOutcome,
        /** HTTP status at the failed stage, or null when unavailable */
        readonly status: number | null,
        /** Fluxer's retry delay in milliseconds, or null. This delay does not establish that a repeat request is safe */
        readonly retryAfterMs: number | null,
        /** Messages inspected before preview failed, or the completed preview's scan count when cleanup failed */
        readonly scannedCount: number,
        /** Selected message IDs known at failure time, without message bodies or filter details */
        readonly selectedMessageIds: readonly string[],
        /** Earlier batch requests with successful HTTP responses, not confirmed individual deletions */
        readonly submittedBatches: readonly MessageCleanupBatch[],
        /** Failed or uncertain batch's IDs when a batch request was reached, otherwise null */
        readonly terminalBatchIds: readonly string[] | null,
        /** Safe local validation detail, copied and frozen, or null for other failures */
        inputValidation: InputValidationDetail | null = null,
        /** Safe Fluxer rejection detail for the failed stage, or null when unavailable */
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

/** Expected preview and cleanup errors shared by both entry points.
 * CancelledError in the default API and interruption in Effect are separate from this type
 */
export type MessageCleanupFailure = MessageCleanupError
