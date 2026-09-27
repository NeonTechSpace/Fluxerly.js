import { operationDetails } from "./errors.js"
import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import {
    operationErrorFields,
    operationErrorMessage,
    operationFailureHint,
    operationErrorSettings,
    operationErrorText,
    type ApiErrorDetail,
} from "./api-errors.js"
import { FluxerlyError, type OperationErrorOptions, type OperationOutcome, type OperationReason } from "./errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"
import type { MessageOperationOptions } from "./messages.js"

/** The result of reading an attachment stream: A byte chunk, or done true when the stream ends.
 * This type accepts Node's native ReadableStream without requiring browser types.
 * When done is false or omitted, value must be a Uint8Array. When done is true, the SDK stops reading and value may be omitted
 *
 * @category Messages
 */
export type AttachmentStreamReadResult =
    | {
          /** False or omitted while this result supplies a byte chunk */
          readonly done?: false
          /** Next bytes to upload as a Uint8Array backed by ordinary, not shared, memory */
          readonly value: Uint8Array
      }
    | {
          /** True when the source has ended. The SDK stops reading and checks the declared byte count */
          readonly done: true
          /** Included for native stream compatibility. When done is true, the SDK ignores value, so supply final bytes in an earlier chunk */
          readonly value: Uint8Array | undefined
      }
    | {
          /** True when the source has ended. The SDK stops reading and checks the declared byte count */
          readonly done: true
          /** May be omitted when done is true. The SDK ignores any value supplied then, so send final bytes in an earlier chunk */
          readonly value?: Uint8Array
      }

/** Reader owned by the SDK only after an upload begins consuming its AttachmentStreamSource.
 * The SDK releases it on normal completion and cancels then releases it after a read, transport or cancellation failure
 *
 * @category Messages
 */
export interface AttachmentStreamReader {
    /** Resolve with the next Uint8Array chunk, or done true when no bytes remain. A rejected read stops the upload.
     * Empty chunks are accepted. Sustained empty reads periodically yield to host timers and cancellation,
     * including while checking for EOF. This does not impose a time limit on a caller's read or cancel implementation
     */
    read(): PromiseLike<AttachmentStreamReadResult>
    /** Stop reading and release source resources. The SDK awaits this after an interrupted or failed read, normally without a reason */
    cancel(reason?: unknown): PromiseLike<void>
    /** Release this reader's exclusive stream lock. The SDK calls this after completion and also attempts it if cancellation fails */
    releaseLock(): void
}

/**
 * Optional native stream-reader mode. Attachment uploads always acquire the default byte reader
 *
 * @category Messages
 */
export interface AttachmentStreamReaderOptions {
    /** Native bring-your-own-buffer mode, included for compatibility. The SDK does not request this mode */
    readonly mode?: "byob"
}

/** Finite byte stream accepted as an attachment source.
 * Its exact byte count must be supplied by AttachmentStreamInput. The SDK reads it once and cannot replay it
 *
 * @category Messages
 */
export interface AttachmentStreamSource {
    /** Native bring-your-own-buffer reader form, included for compatibility. The SDK does not use it */
    getReader(options: {
        /** Select the native bring-your-own-buffer reader, which SDK uploads do not request */
        readonly mode: "byob"
    }): unknown
    /** Return the default byte reader, locking the stream until releaseLock. The SDK validates the reader before consuming it */
    getReader(): AttachmentStreamReader
    /** Native optional-options overload, included for compatibility with ReadableStream */
    getReader(options?: AttachmentStreamReaderOptions): unknown
}

/** A file-like source the SDK can read in byte ranges for an attachment upload.
 * Node Blob and File values, including fs.openAsBlob results, fit this type without requiring Node or browser type declarations.
 * The SDK opens streams for individual upload parts only after planning. It does not close a caller's path or FileHandle and cannot protect against file changes during reading
 *
 * @category Messages
 */
export interface AttachmentFileSource {
    /** Exact file length in bytes, a nonnegative safe integer no larger than 52,428,800 for an upload */
    readonly size: number
    /** Return a source for the byte range from start inclusive to end exclusive. The SDK uses explicit offsets for upload parts */
    slice(start?: number, end?: number, contentType?: string): AttachmentFileSource
    /** Create a byte stream for this source. The SDK calls it on selected file slices and owns only the readers it acquires */
    stream(): AttachmentStreamSource
}

interface AttachmentMetadata {
    /** Display filename, not a filesystem path. Nonempty, at most 255 `string.length` units, without control characters or path separators.
     * Fluxer may normalize the filename when preparing the upload
     */
    readonly filename: string
    /** Optional MIME type hint, at most 255 printable ASCII characters. The upload request defaults to application/octet-stream.
     * Fluxer's upload plan chooses the MIME type used for transfer and may override this hint based on the filename
     */
    readonly contentType?: string
    /** Optional display title, 1–1,024 normalized UTF-16 code units */
    readonly title?: string
    /** Optional alternative-text description, 1–4,096 normalized UTF-16 code units */
    readonly description?: string
    /** Mark the file as a spoiler. Defaults to false */
    readonly spoiler?: boolean
    /** Not accepted for new uploads, use AttachmentReference to keep an existing attachment during an edit */
    readonly id?: never
}

/** New caller-owned bytes supplied as an attachment.
 * Bytes are copied when the operation starts, before waiting. Later caller mutation cannot change an accepted upload
 *
 * @category Messages
 */
export interface AttachmentBytesInput extends AttachmentMetadata {
    /** File bytes, including Node buffers and subarray views. Shared-memory buffers are rejected.
     * Empty files are accepted. At most 50 MiB per file, the deployed server may impose a lower limit
     */
    readonly data: Uint8Array
    /** Do not combine a file source with data */
    readonly file?: never
    /** Do not combine a stream source with data */
    readonly stream?: never
    /** Do not supply size, the SDK uses data.byteLength */
    readonly size?: never
}

/** Attach a caller-owned file whose size is known.
 * The SDK streams the file without copying or storing its bytes first. Empty files are accepted. The reported size must be a nonnegative safe integer no greater than 50 MiB.
 * Node openAsBlob files can fail during reading if the file changes. A caller may retry only with a stable source and a new message operation.
 * An inline multipart 429 reports rateLimit rather than reopening a mutable file source
 *
 * @category Messages
 */
export interface AttachmentFileInput extends AttachmentMetadata {
    /** A Blob, File or compatible sized source, not a path string. Keep its underlying data stable while the operation reads it */
    readonly file: AttachmentFileSource
    /** Do not combine copied bytes with a file source */
    readonly data?: never
    /** Do not combine a separate stream with a file source */
    readonly stream?: never
    /** Do not supply size separately, the SDK uses file.size */
    readonly size?: never
}

/** Attach a caller-owned stream that ends after a known number of bytes.
 * Size is the exact nonnegative byte count, not a maximum. The SDK streams without copying or storing bytes first and reads it at most once after planning succeeds.
 * It cannot limit chunks the source already allocated. An early end, extra bytes, source failure, cancellation or inline multipart 429 stops the operation without reading it again
 *
 * @category Messages
 */
export interface AttachmentStreamInput extends AttachmentMetadata {
    /** A finite byte stream that can be consumed once, not a stream factory or an unbounded live feed */
    readonly stream: AttachmentStreamSource
    /** Exact byte count from 0 through 52,428,800. Too few or too many source bytes fail the upload */
    readonly size: number
    /** Do not combine copied bytes with a stream source */
    readonly data?: never
    /** Do not combine a file source with a stream source */
    readonly file?: never
}

/** A file to send with a message, using exactly one source: Data bytes, a sized file, or a finite stream with its exact size.
 * All forms also require a display filename. A filesystem path or URL alone is not accepted
 *
 * Title and description limits are measured after U+000C and U+202E removal and surrounding-whitespace trimming.
 * This normalization is validation-only, and the original metadata strings are sent unchanged
 *
 * The SDK copies data bytes when the operation starts. It reads file and stream sources after upload planning. Default API calls start immediately. Effect API calls prepare separately each time they run
 *
 * Files upload before the SDK creates or edits the message. Fluxer may provide presigned upload URLs, or require a direct multipart upload when preuploads are disabled.
 * Byte PUTs to presigned URLs carry no bot credential. Planning, completion and message requests use the client's API authentication
 *
 * Failed operations may leave temporary remote files, with no rollback or crash recovery
 *
 * One deadline covers endpoint discovery, planning, PUTs, completion and the message request. Failed PUTs are not retried automatically.
 * After a confirmed inline-message HTTP 429, the SDK retries only copied byte inputs. File and stream sources report rateLimit instead of being read again
 *
 * @example
 * ```ts
 * import type { AttachmentInput } from "@neontechspace/fluxerly"
 * export const attachmentExample: AttachmentInput = {
 *     data: new Uint8Array([72, 105]),
 *     filename: "greeting.txt",
 *     contentType: "text/plain",
 *     title: "Greeting",
 *     description: "A short greeting",
 *     spoiler: false,
 * }
 * ```
 *
 * @example
 * ```ts
 * import type { AttachmentFileSource, AttachmentInput, AttachmentStreamSource } from "@neontechspace/fluxerly"
 * // Pass a Blob/File, such as the result of Node's fs.openAsBlob, and a finite byte stream
 * export function sizedAttachmentExamples(file: AttachmentFileSource, stream: AttachmentStreamSource, size: number): readonly AttachmentInput[] {
 *     return [
 *         { file, filename: "report.csv", contentType: "text/csv" },
 *         { stream, size, filename: "generated.bin" },
 *     ]
 * }
 * ```
 *
 * @category Messages
 */
export type AttachmentInput = AttachmentBytesInput | AttachmentFileInput | AttachmentStreamInput

/** Keep an existing attachment while editing a message, optionally changing its display title or description. Fluxer may ignore unknown IDs.
 * Omit title and description to preserve their current values. Pass null to clear either value.
 * Non-null title and description limits are measured after U+000C and U+202E removal and surrounding-whitespace
 * trimming. This normalization is validation-only, and the original metadata strings are sent unchanged.
 * The SDK does not fetch the attachment, find it by position, rename it or change its flags
 *
 * @category Messages
 */
export interface AttachmentReference {
    /** Decimal attachment ID from the message being edited, not its message ID */
    readonly id: string
    /** Replacement display title, 1–1,024 normalized UTF-16 code units, or null to clear */
    readonly title?: string | null
    /** Replacement alternative-text description, 1–4,096 normalized UTF-16 code units, or null to clear */
    readonly description?: string | null
    /** Keeping an attachment does not accept new byte data */
    readonly data?: never
    /** Keeping an attachment does not accept a new file source */
    readonly file?: never
    /** Keeping an attachment does not accept a new stream source */
    readonly stream?: never
    /** The existing attachment's byte size cannot be replaced */
    readonly size?: never
    /** The existing attachment cannot be renamed through this reference */
    readonly filename?: never
    /** The existing attachment's media type cannot be replaced */
    readonly contentType?: never
    /** The existing attachment's spoiler flag cannot be replaced */
    readonly spoiler?: never
}

/** Information about a file attached to a received message. Use client.attachments to refresh its URL explicitly, then download or stream its bytes.
 * This object is frozen. Its URLs may expire, and the SDK never refreshes or downloads them automatically
 *
 * @category Messages
 */
export interface Attachment {
    /** Decimal attachment ID */
    readonly id: string
    /** Display filename returned by Fluxer */
    readonly filename: string
    /** File size in bytes, not the SDK's retained metadata size */
    readonly size: number
    /** File URL returned by Fluxer */
    readonly url?: string
    /** Proxy URL returned by Fluxer */
    readonly proxyUrl?: string
    /** Platform attachment bit flags, including spoiler bit 1 << 3 */
    readonly flags: number
    /** Optional display title */
    readonly title?: string
    /** Optional alternative-text description */
    readonly description?: string
    /** Optional detected MIME type */
    readonly contentType?: string
    /** Optional server content hash */
    readonly contentHash?: string
    /** Optional image/video width in pixels */
    readonly width?: number
    /** Optional image/video height in pixels */
    readonly height?: number
    /** Optional encoded preview placeholder */
    readonly placeholder?: string
    /** Optional server adult-content classification */
    readonly nsfw?: boolean
    /** Optional audio/video duration in seconds */
    readonly duration?: number
    /** Optional base64-encoded audio waveform */
    readonly waveform?: string
    /** Optional ISO timestamp supplied by Fluxer for expiry */
    readonly expiresAt?: string
    /** Optional server expiry observation, not a live availability check */
    readonly expired?: boolean
}

/** One result from an explicit attachment URL refresh.
 * Fluxer returns these frozen entries in the same order as the requested URLs
 *
 * @category Messages
 */
export interface RefreshedAttachmentUrl {
    /** Requested string exactly as supplied to attachments.refreshUrls */
    readonly original: string
    /** Newly signed URL, or the original string when it is not an attachment URL of the selected instance */
    readonly refreshed: string
}

/**
 * Per-call deadline for an attachment URL refresh, separate from attachment download limits
 *
 * @category Messages
 */
export interface AttachmentRefreshOptions extends MessageOperationOptions {}

/**
 * Add cancellation to an attachment URL refresh in the default API
 *
 * @category Messages
 */
export interface DefaultAttachmentRefreshOptions extends AttachmentRefreshOptions, OperationOptions {}

/**
 * Attachment URL refresh operation identified by safe failure metadata
 *
 * @category Errors
 */
export type AttachmentRefreshOperation = "attachments.refreshUrls"

/** The SDK could not refresh one ordered batch of attachment URL strings.
 * Failures contain no requested URL, refreshed URL, response body or credential.
 * HTTP 404 does not distinguish an older unsupported deployment from an unavailable route or denied access
 *
 * @category Errors
 */
export class AttachmentRefreshError extends FluxerlyError {
    /** Stable expected-failure discriminator */
    readonly _tag = "AttachmentRefreshError"
    /** Requested operation */
    readonly operation: AttachmentRefreshOperation
    /** Input validation, local capacity, HTTP 404 or another rejection, transport, response decoding, deadline or rate limit */
    readonly reason: OperationReason
    /** Whether the request may have reached Fluxer, described by {@link OperationOutcome}.
     * Refreshing does not create or change an attachment, but an unknown outcome cannot recover a lost response
     */
    readonly outcome: OperationOutcome
    /** HTTP status when received, otherwise null */
    readonly status: number | null
    /** Fluxer's retry delay in milliseconds when usable, otherwise null */
    readonly retryAfterMs: number | null
    /** Reviewed Fluxer rejection detail, or null when no safe classification is available */
    readonly apiError: ApiErrorDetail | null
    /** Safe explanation of the locally invalid property, or null when no input problem could be identified */
    readonly inputValidation: InputValidationDetail | null

    /** Create the failure from its operation, reason and outcome, with optional status, retry wait, API detail, input detail and cause */
    constructor(options: OperationErrorOptions<AttachmentRefreshOperation>) {
        const fields = operationErrorFields(options)
        super(operationErrorText("Attachment URL", fields), operationErrorSettings("attachment", fields, options.cause))
        this.operation = fields.operation
        this.reason = fields.reason
        this.outcome = fields.outcome
        this.status = fields.status
        this.retryAfterMs = fields.retryAfterMs
        this.apiError = fields.apiError
        this.inputValidation = freezeInputValidationDetail(fields.inputValidation)
        this.name = this._tag
    }
}

/** Expected attachment URL refresh failures shared by both entry points.
 * Native interruption remains in the Effect cause, while default API calls additionally return CancelledError
 *
 * @category Errors
 */
export type AttachmentRefreshFailure = AttachmentRefreshError | ClientClosedError

/** Limit the bytes and time used by an attachment download.
 * The maxBytes option is required, a positive safe integer no greater than 52,428,800.
 * This limits returned bytes, not the file size on Fluxer, total JavaScript memory or buffering while the SDK assembles the result.
 * The timeoutMs option covers endpoint discovery, URL validation and the full GET, and defaults to the client's rest.defaultTimeoutMs, 30,000 unless configured.
 * The SDK still waits for cleanup after the deadline.
 * Media discovery and GETs use client-local media slots, separate from the REST/upload slots. The media slots default to four (rest.mediaConcurrency), and the REST slots to four per local shard (rest.concurrency).
 * Both pools share the pending-request budget. Media does not wait for bot API rate limits
 *
 * @category Messages
 */
export interface AttachmentDownloadOptions {
    /** Maximum bytes to accept, required and from 1 through 52,428,800. Exceeding it fails with reason tooLarge rather than truncating */
    readonly maxBytes: number
    /** Total deadline in milliseconds, an integer from 1 through 2,147,483,647, including discovery and the GET.
     * Defaults to the client's rest.defaultTimeoutMs, 30,000 unless configured. Cleanup is still awaited after expiry
     */
    readonly timeoutMs?: number
}

/**
 * Add an optional AbortSignal to the download limits. Aborting cancels this download, not the client or other operations
 *
 * @category Messages
 */
export interface DefaultAttachmentDownloadOptions extends AttachmentDownloadOptions, OperationOptions {}

/**
 * Add an optional AbortSignal to the stream limits. Aborting stops this stream's consumption, not the client or other operations
 *
 * @category Messages
 */
export interface DefaultAttachmentStreamOptions extends AttachmentDownloadOptions, OperationOptions {}

/**
 * Expected bounded attachment-download failure, without a URL, response body or credential
 *
 * @category Errors
 */
export class AttachmentDownloadError extends FluxerlyError {
    /** Stable tag for identifying this expected failure */
    readonly _tag = "AttachmentDownloadError"
    /** SDK-owned local input detail, or null for non-input and unattributable failures */
    readonly inputValidation: InputValidationDetail | null
    /** Local validation, untrusted attachment URL, local scheduler saturation, transport, response decoding, output limit or deadline */
    readonly reason: "input" | "untrustedUrl" | "busy" | "network" | "response" | "tooLarge" | "timeout"
    /** HTTP status when a response was received, otherwise null */
    readonly status: number | null
    /** Describe a download failure. Construction performs no request and does not release or retry a download */
    constructor(options: {
        /** Failure category, as described on the reason field */
        readonly reason: AttachmentDownloadError["reason"]
        /** HTTP status when a response was received. Defaults to null */
        readonly status?: number | null | undefined
        /** Safe input explanation, not the rejected value. It is copied and frozen. Defaults to null */
        readonly inputValidation?: InputValidationDetail | null | undefined
        /** Underlying failure retained as the error's cause */
        readonly cause?: unknown
    }) {
        const { reason, status = null, inputValidation = null } = options
        super(
            operationErrorMessage({
                subject: "Attachment",
                operation: "download",
                reason,
                outcome: reason === "input" || reason === "untrustedUrl" ? "notDispatched" : "unknown",
                status,
                inputExplanation: inputValidation?.explanation ?? null,
                facts: { read: true },
            }),
            {
                code: `attachment.download.${reason}`,
                hint: operationFailureHint({
                    reason,
                    outcome: reason === "input" || reason === "untrustedUrl" ? "notDispatched" : "unknown",
                    status,
                    read: true,
                    inputPath: inputValidation?.path ?? null,
                }),
                cause: options.cause,
                details: operationDetails({ reason, status }),
            },
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
        this.reason = reason
        this.status = status
    }
}

/**
 * Expected attachment-download failures shared by both entry points. Cancellation in the default API adds CancelledError
 *
 * @category Errors
 */
export type AttachmentDownloadFailure = AttachmentDownloadError | ClientClosedError
