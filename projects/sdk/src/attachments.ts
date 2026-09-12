import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** One complete result read from an attachment stream.
 * The structural shape accepts Node's native ReadableStream without adding DOM declarations to default consumers
 */
export type AttachmentStreamReadResult =
    | { readonly done?: false; readonly value: Uint8Array }
    | { readonly done: true; readonly value: Uint8Array | undefined }
    | { readonly done: true; readonly value?: Uint8Array }

/** Reader owned by the SDK only after an upload begins consuming its AttachmentStreamSource.
 * The SDK releases it on normal completion and cancels then releases it after a read, transport or cancellation failure
 */
export interface AttachmentStreamReader {
    read(): PromiseLike<AttachmentStreamReadResult>
    cancel(reason?: unknown): PromiseLike<void>
    releaseLock(): void
}

/** Optional native stream-reader mode. Attachment uploads always acquire the default byte reader */
export interface AttachmentStreamReaderOptions {
    readonly mode?: "byob"
}

/** Finite byte stream accepted as an attachment source.
 * Its exact byte count must be supplied by AttachmentStreamInput. The SDK reads it once and cannot replay it
 */
export interface AttachmentStreamSource {
    /** Standard ReadableStream reader factory. The SDK calls the zero-argument overload and validates its result before consuming it */
    getReader(options: { readonly mode: "byob" }): unknown
    getReader(): AttachmentStreamReader
    getReader(options?: AttachmentStreamReaderOptions): unknown
}

/** Sized sliceable byte source accepted as an attachment file.
 * Node Blob and File values, including fs.openAsBlob results, match this structural contract without requiring Node or DOM types.
 * The SDK opens per-part streams only after upload planning, does not close a caller path or FileHandle, and cannot protect a file changed during reading
 */
export interface AttachmentFileSource {
    readonly size: number
    slice(start?: number, end?: number, contentType?: string): AttachmentFileSource
    stream(): AttachmentStreamSource
}

interface AttachmentMetadata {
    /** Display filename, not a filesystem path. Nonempty, at most 255 characters, without control characters or path separators.
     * Fluxer may normalize the filename when preparing the upload
     */
    readonly filename: string
    /** Optional MIME hint, at most 255 printable ASCII characters. Defaults to application/octet-stream in the upload request.
     * Fluxer's upload plan determines the transport MIME type and may override this hint using the filename
     */
    readonly contentType?: string
    /** Optional display title, 1 to 1,024 characters */
    readonly title?: string
    /** Optional alternative-text description, 1 to 4,096 characters */
    readonly description?: string
    /** Mark the file as a spoiler. Defaults to false */
    readonly spoiler?: boolean
    readonly id?: never
}

/** New caller-owned bytes supplied as an attachment.
 * Bytes are copied when the operation starts, before waiting. Later caller mutation cannot change an accepted upload
 */
export interface AttachmentBytesInput extends AttachmentMetadata {
    /** File bytes, including Node buffers and subarray views. Shared-memory buffers are rejected.
     * Empty files are accepted. At most 50 MiB per file; the deployed server may impose a lower limit
     */
    readonly data: Uint8Array
    readonly file?: never
    readonly stream?: never
    readonly size?: never
}

/** New caller-owned sized file supplied as an attachment.
 * File bytes are streamed without an SDK copy or spool. Empty files are accepted and the reported size must be a nonnegative safe integer no greater than 50 MiB.
 * Node openAsBlob files can fail during reading if the file changes. A caller may retry only with a stable source and a new message operation.
 * An inline multipart 429 reports rateLimit rather than reopening a mutable file source
 */
export interface AttachmentFileInput extends AttachmentMetadata {
    readonly file: AttachmentFileSource
    readonly data?: never
    readonly stream?: never
    readonly size?: never
}

/** New caller-owned finite stream supplied as an attachment.
 * Size is the exact nonnegative byte count, not a maximum. The SDK streams without copying or spooling and consumes it at most once after planning succeeds.
 * It does not constrain chunks already allocated by the source. Early EOF, extra bytes, source failure, cancellation or an inline multipart 429 stop the operation without replay
 */
export interface AttachmentStreamInput extends AttachmentMetadata {
    readonly stream: AttachmentStreamSource
    readonly size: number
    readonly data?: never
    readonly file?: never
}

/** A new attachment supplied by the caller, not a path, URL or upload session.
 * Bytes are copied when the operation starts, while file and stream sources are read after upload planning. Default calls start immediately, while native Effects prepare separately on each execution
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
    readonly data?: never
    readonly file?: never
    readonly stream?: never
    readonly size?: never
    readonly filename?: never
    readonly contentType?: never
    readonly spoiler?: never
}

/** Frozen received file metadata, not file bytes. URLs may expire; no automatic download or refresh */
export interface Attachment {
    /** Decimal attachment ID */
    readonly id: string
    /** Display filename returned by Fluxer */
    readonly filename: string
    /** File size in bytes, not the SDK's retained metadata size */
    readonly size: number
    /** File URL returned by Fluxer, not a guarantee of current availability */
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

/** Required limits for one attachment download.
 * maxBytes is a positive safe integer no greater than 52,428,800. It bounds returned bytes, not Fluxer's media size, total JavaScript heap or source-side buffering while the SDK packs the result.
 * timeoutMs covers endpoint discovery, URL validation and the full GET, defaults to 30,000, and cleanup is awaited afterward. The GET shares the client-local four-request limit but does not wait for bot API rate limits
 */
export interface AttachmentDownloadOptions {
    readonly maxBytes: number
    readonly timeoutMs?: number
}

/** Default attachment download options with cooperative cancellation for this GET only */
export interface DefaultAttachmentDownloadOptions extends AttachmentDownloadOptions, OperationOptions {}

/** Default attachment-stream options with cooperative cancellation for this one consumption */
export interface DefaultAttachmentStreamOptions extends AttachmentDownloadOptions, OperationOptions {}

/** Expected bounded attachment-download failure, without a URL, response body or credential */
export class AttachmentDownloadError extends Error {
    readonly _tag = "AttachmentDownloadError"
    /** SDK-owned local input detail, or null for non-input and unattributable failures */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** Local validation, untrusted attachment URL, local scheduler saturation, transport, response decoding, output limit or deadline */
        readonly reason: "input" | "untrustedUrl" | "busy" | "network" | "response" | "tooLarge" | "timeout",
        /** HTTP status when a response was received, otherwise null */
        readonly status: number | null = null,
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

/** Expected attachment-download failures shared by both entry points. Default cancellation adds CancelledError */
export type AttachmentDownloadFailure = AttachmentDownloadError | ClientClosedError
