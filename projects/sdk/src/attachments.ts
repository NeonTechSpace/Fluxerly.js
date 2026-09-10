/** A new file supplied by the caller, not a path, URL or upload session.
 * Bytes are copied when the operation starts, before waiting; later caller mutation cannot change an accepted upload.
 * Default calls start immediately, while native Effects snapshot separately on each execution.
 * Files upload before message creation/editing, using Fluxer's presigned upload plan.
 * Only HTTPS destinations on uploads.fluxer.app are accepted; other destinations fail with reason response.
 * Upload requests carry no bot credential. Failed operations may leave temporary remote files; no rollback or crash recovery.
 * One deadline covers planning, PUTs, completion and the message request. Failed PUTs are not retried automatically
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
 */
export interface AttachmentInput {
    /** File bytes, including Node buffers and subarray views. Shared-memory buffers are rejected.
     * At most 50 MiB per file; the deployed server may impose a lower limit
     */
    readonly data: Uint8Array
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
