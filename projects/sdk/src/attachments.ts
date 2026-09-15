import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** What an attachment reader returns from read: A byte chunk while reading, or done true at the end.
 * This shape accepts Node's native ReadableStream without requiring browser type declarations.
 * With done false or omitted, value must be a Uint8Array. With done true, no more reads occur and value may be omitted
 */
export type AttachmentStreamReadResult =
    | {
          /** False or omitted while this result supplies a byte chunk */
          readonly done?: false
          /** Next bytes to upload. Must be a Uint8Array backed by ordinary, not shared, memory */
          readonly value: Uint8Array
      }
    | {
          /** True when the source has ended. The SDK stops reading and checks the declared byte count */
          readonly done: true
          /** Included for native stream compatibility. The SDK ignores value when done is true, supply final bytes in an earlier chunk */
          readonly value: Uint8Array | undefined
      }
    | {
          /** True when the source has ended. The SDK stops reading and checks the declared byte count */
          readonly done: true
          /** May be omitted at the end. Any supplied value is ignored, supply final bytes in an earlier chunk */
          readonly value?: Uint8Array
      }

/** Reader owned by the SDK only after an upload begins consuming its AttachmentStreamSource.
 * The SDK releases it on normal completion and cancels then releases it after a read, transport or cancellation failure
 */
export interface AttachmentStreamReader {
    /** Resolve with the next Uint8Array chunk, or done true when no bytes remain. A rejected read stops the upload */
    read(): PromiseLike<AttachmentStreamReadResult>
    /** Stop reading and release source resources. The SDK awaits this after an interrupted or failed read, normally without a reason */
    cancel(reason?: unknown): PromiseLike<void>
    /** Release this reader's exclusive stream lock. The SDK calls this after completion and also attempts it if cancellation fails */
    releaseLock(): void
}

/** Optional native stream-reader mode. Attachment uploads always acquire the default byte reader */
export interface AttachmentStreamReaderOptions {
    /** Native bring-your-own-buffer mode, included for compatibility. The SDK does not request this mode */
    readonly mode?: "byob"
}

/** Finite byte stream accepted as an attachment source.
 * Its exact byte count must be supplied by AttachmentStreamInput. The SDK reads it once and cannot replay it
 */
export interface AttachmentStreamSource {
    /** Native BYOB reader overload, included for compatibility. The SDK does not use it */
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
 * Node Blob and File values, including fs.openAsBlob results, match this structural contract without requiring Node or DOM types.
 * The SDK opens per-part streams only after upload planning, does not close a caller path or FileHandle, and cannot protect a file changed during reading
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
    /** Optional MIME hint, at most 255 printable ASCII characters. Defaults to application/octet-stream in the upload request.
     * Fluxer's upload plan determines the transport MIME type and may override this hint using the filename
     */
    readonly contentType?: string
    /** Optional display title, 1 to 1,024 `string.length` units */
    readonly title?: string
    /** Optional alternative-text description, 1 to 4,096 `string.length` units */
    readonly description?: string
    /** Mark the file as a spoiler. Defaults to false */
    readonly spoiler?: boolean
    /** Not accepted for new uploads, use AttachmentReference to keep an existing attachment during an edit */
    readonly id?: never
}

/** New caller-owned bytes supplied as an attachment.
 * Bytes are copied when the operation starts, before waiting. Later caller mutation cannot change an accepted upload
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

/** New caller-owned sized file supplied as an attachment.
 * File bytes are streamed without an SDK copy or spool. Empty files are accepted and the reported size must be a nonnegative safe integer no greater than 50 MiB.
 * Node openAsBlob files can fail during reading if the file changes. A caller may retry only with a stable source and a new message operation.
 * An inline multipart 429 reports rateLimit rather than reopening a mutable file source
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

/** New caller-owned finite stream supplied as an attachment.
 * Size is the exact nonnegative byte count, not a maximum. The SDK streams without copying or spooling and consumes it at most once after planning succeeds.
 * It does not constrain chunks already allocated by the source. Early EOF, extra bytes, source failure, cancellation or an inline multipart 429 stop the operation without replay
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
 * Bytes are copied when the operation starts, while file and stream sources are read after upload planning. Default API calls start immediately, while native Effects prepare separately on each execution
 *
 * Files upload before message creation/editing, using Fluxer's presigned upload plan or a direct multipart fallback when the instance disables preuploads.
 * Presigned byte PUTs carry no bot credential. Planning, completion and message requests use the client's API authentication
 *
 * Failed operations may leave temporary remote files, with no rollback or crash recovery
 *
 * One deadline covers endpoint discovery, planning, PUTs, completion and the message request. Failed PUTs are not retried automatically.
 * A confirmed inline-message 429 recreates only copied byte inputs. File and stream sources report rateLimit instead of being read again
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
 */
export type AttachmentInput = AttachmentBytesInput | AttachmentFileInput | AttachmentStreamInput

/** Keep an existing attachment during an edit, optionally changing its display metadata. Unknown IDs may be ignored by Fluxer.
 * Omit title and description to preserve their current values. Pass null to clear either value.
 * No hidden fetch, positional lookup or filename or flag update is performed by the SDK
 */
export interface AttachmentReference {
    /** Decimal attachment ID from the message being edited, not its message ID */
    readonly id: string
    /** Replacement display title, 1 to 1,024 characters, or null to clear */
    readonly title?: string | null
    /** Replacement alternative-text description, 1 to 4,096 characters, or null to clear */
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

/** Metadata for a file attached to a received message. Use client.attachments to download or stream its bytes.
 * This object is frozen. Its URLs may expire, the SDK does not refresh them or download automatically
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

/** Set the maximum bytes to accept and how long to wait for an attachment download.
 * maxBytes is required, a positive safe integer no greater than 52,428,800.
 * It bounds returned bytes, not Fluxer's media size, total JavaScript heap or source-side buffering while the SDK packs the result.
 * timeoutMs covers endpoint discovery, URL validation and the full GET, and defaults to 30,000.
 * The SDK still waits for cleanup after the deadline.
 * Media discovery and GETs use four client-local slots, separate from the four REST/upload slots, for at most eight active HTTP requests.
 * Both pools share the pending-request budget. Media does not wait for bot API rate limits
 */
export interface AttachmentDownloadOptions {
    /** Maximum bytes to accept, required and from 1 through 52,428,800. Exceeding it fails with reason tooLarge rather than truncating */
    readonly maxBytes: number
    /** Total deadline in milliseconds, an integer from 1 through 2,147,483,647, including discovery and the GET.
     * Defaults to 30,000, cleanup is still awaited after expiry
     */
    readonly timeoutMs?: number
}

/** Add an optional AbortSignal to the download limits. Aborting cancels this download, not the client or other operations */
export interface DefaultAttachmentDownloadOptions extends AttachmentDownloadOptions, OperationOptions {}

/** Add an optional AbortSignal to the stream limits. Aborting stops this stream's consumption, not the client or other operations */
export interface DefaultAttachmentStreamOptions extends AttachmentDownloadOptions, OperationOptions {}

/** Expected bounded attachment-download failure, without a URL, response body or credential */
export class AttachmentDownloadError extends Error {
    /** Stable tag for identifying this expected failure */
    readonly _tag = "AttachmentDownloadError"
    /** SDK-owned local input detail, or null for non-input and unattributable failures */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** Local validation, untrusted attachment URL, local scheduler saturation, transport, response decoding, output limit or deadline */
        readonly reason: "input" | "untrustedUrl" | "busy" | "network" | "response" | "tooLarge" | "timeout",
        /** HTTP status when a response was received, otherwise null */
        readonly status: number | null = null,
        /** Optional safe input explanation, copied and frozen on construction, not the rejected value */
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "Attachment download",
                "fetch",
                reason,
                "unknown",
                status,
                null,
                inputValidation?.explanation ?? null,
            ),
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

/** Expected attachment-download failures shared by both entry points. Cancellation in the default API adds CancelledError */
export type AttachmentDownloadFailure = AttachmentDownloadError | ClientClosedError
