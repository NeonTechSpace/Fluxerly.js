/**
 * Attachment encoding and projection: Message attachment inputs, their file sources and received attachment metadata.
 * Invariant: Byte inputs are copied before any wait, while sized files and finite streams stay caller-owned until a transfer
 * reader is acquired. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { Attachment, AttachmentFileSource, AttachmentStreamSource } from "#sdk/attachments"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { fieldsOnce, identifier, record } from "./decode/primitives.js"
import { normalizedText } from "./field-text.js"

const attachmentMaxBytes = 52_428_800
/** Fluxer's attachment flag bits a caller sets: IS_SPOILER and CONTAINS_EXPLICIT_MEDIA (packages/constants/src/ChannelConstants.ts at 5f3fc0b1) */
const spoilerFlag = 8
const explicitMediaFlag = 16

export type FileSource =
    | { readonly kind: "bytes"; readonly data: Uint8Array }
    | { readonly kind: "file"; readonly file: AttachmentFileSource }
    | { readonly kind: "stream"; readonly stream: AttachmentStreamSource }

export type FilePart = {
    id: number
    filename: string
    contentType: string
    size: number
    source: FileSource
}
export type EncodedBody = { json: string; files: FilePart[] }

function filename(value: unknown): value is string {
    // oxlint-disable-next-line no-control-regex -- rejects control characters in attachment filenames
    return typeof value === "string" && value.length >= 1 && value.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(value)
}

function contentType(value: unknown): value is string {
    return typeof value === "string" && /^[\x20-\x7e]{1,255}$/.test(value)
}

function metadata(
    field: (key: string) => unknown,
    id: number,
    values: Record<string, unknown>[],
    waveformTarget: WaveformTarget,
): string | InputValidationFailure {
    const acceptedFilename = field("filename")
    if (!filename(acceptedFilename))
        return inputValidationFailure(
            "attachments[].filename",
            "format",
            "Attachment filenames must contain 1 through 255 UTF-16 code units without slashes, backslashes, or control characters",
        )
    const providedContentType = field("contentType")
    if (providedContentType !== undefined && !contentType(providedContentType))
        return inputValidationFailure(
            "attachments[].contentType",
            "format",
            "Attachment content types must contain 1 through 255 printable ASCII characters",
        )
    for (const [key, max] of [
        ["title", 1024],
        ["description", 4096],
    ] as const)
        if (field(key) !== undefined && !normalizedText(field(key), 1, max))
            return inputValidationFailure(
                `attachments[].${key}`,
                "length",
                `Attachment ${key} must contain 1 through ${max} UTF-16 code units after Fluxer's normalization`,
            )
    const spoiler = field("spoiler")
    if (spoiler !== undefined && typeof spoiler !== "boolean")
        return inputValidationFailure("attachments[].spoiler", "type", "Attachment spoiler must be a boolean")
    const explicitMedia = field("explicitMedia")
    if (explicitMedia !== undefined && typeof explicitMedia !== "boolean")
        return inputValidationFailure(
            "attachments[].explicitMedia",
            "type",
            "Attachment explicitMedia must be a boolean",
        )
    const duration = field("duration")
    const waveform = field("waveform")
    // Fluxer reads duration as a 32-bit integer of seconds and waveform as 1 through 4,096 characters after its string
    // normalization (packages/schema/src/domains/message/AttachmentSchemas.ts at 5f3fc0b1). A negative length is refused here
    if (
        duration !== undefined &&
        (typeof duration !== "number" || !Number.isInteger(duration) || duration < 0 || duration > 2_147_483_647)
    )
        return inputValidationFailure(
            "attachments[].duration",
            "range",
            "Attachment duration must be a whole number of seconds from 0 through 2,147,483,647",
        )
    if (waveform !== undefined && !normalizedText(waveform, 1, waveformLimits[waveformTarget]))
        return inputValidationFailure(
            "attachments[].waveform",
            "length",
            waveformTarget === "webhook"
                ? "Webhook voice notes support a waveform of 1 through 256 UTF-16 code units after Fluxer's normalization. A voiceWaveform result fits for audio up to 19.2 seconds"
                : "Attachment waveform must be a string of 1 through 4,096 UTF-16 code units after Fluxer's normalization",
        )
    values.push({
        id,
        filename: acceptedFilename,
        ...(providedContentType === undefined ? {} : { content_type: providedContentType }),
        ...(field("title") === undefined ? {} : { title: field("title") }),
        ...(field("description") === undefined ? {} : { description: field("description") }),
        flags: (spoiler === true ? spoilerFlag : 0) | (explicitMedia === true ? explicitMediaFlag : 0),
        ...(duration === undefined ? {} : { duration }),
        ...(waveform === undefined ? {} : { waveform }),
    })
    return providedContentType ?? "application/octet-stream"
}

/**
 * The longest waveform Fluxer reads for a new attachment, by where it is sent. Messages and forum posts use the message
 * attachment schema (packages/schema/src/domains/message/AttachmentSchemas.ts:29 at 5f3fc0b1). Webhook sends with files
 * are always multipart, whose attachment schema keeps the default string limit of 256
 * (packages/schema/src/domains/webhook/WebhookRequestSchemas.ts:79 and primitives/SchemaPrimitives.ts:176)
 */
const waveformLimits = { message: 4096, webhook: 256 } as const

/** Where a new attachment is sent, which sets its longest waveform */
export type WaveformTarget = keyof typeof waveformLimits

/** The validated size of a bounded file source, read once with its method checks, or undefined for another value */
function fileSourceSize(value: unknown): number | undefined {
    if (!record(value)) return undefined
    const size = value.size
    return typeof size === "number" &&
        Number.isSafeInteger(size) &&
        size >= 0 &&
        size <= attachmentMaxBytes &&
        typeof value.slice === "function" &&
        typeof value.stream === "function"
        ? size
        : undefined
}

function streamSource(value: unknown): value is AttachmentStreamSource {
    return record(value) && typeof value.getReader === "function"
}

/**
 * Validate attachment structure without reading caller files or streams. Admission later snapshots byte arrays and
 * reserves exact source sizes. The list is read by index and each attachment field at most once, so the validated
 * values are the ones sent. The waveform target sets the longest waveform a new attachment may carry
 */
export function encodeAttachments(value: unknown, edit: boolean, waveformTarget: WaveformTarget = "message") {
    if (value === undefined) return { metadata: undefined, files: [] as FilePart[], uploadedFilenames: [] as string[] }
    if (!Array.isArray(value)) return inputValidationFailure("attachments", "type", "Attachments must be an array")
    const metadataValues: Record<string, unknown>[] = []
    const files: FilePart[] = []
    const uploadedFilenames: string[] = []
    const retained = new Set<string>()
    const count = value.length
    for (let index = 0; index < count; index += 1) {
        const item: unknown = value[index]
        if (!record(item)) return inputValidationFailure("attachments[]", "type", "Each attachment must be an object")
        const field = fieldsOnce(item)
        if (field("id") !== undefined) {
            const retainedMetadata = encodeRetainedAttachment(item, field, edit, retained)
            if (retainedMetadata instanceof InputValidationFailure) return retainedMetadata
            metadataValues.push(retainedMetadata)
            continue
        }
        const id = metadataValues.length
        const selected = encodeAttachmentSource(item, field)
        if (selected instanceof InputValidationFailure) return selected
        const acceptedContentType = metadata(field, id, metadataValues, waveformTarget)
        if (acceptedContentType instanceof InputValidationFailure) return acceptedContentType
        const acceptedFilename = field("filename") as string
        uploadedFilenames.push(acceptedFilename)
        files.push({
            id,
            filename: acceptedFilename,
            contentType: acceptedContentType,
            size: selected.size,
            source: selected.source,
        })
    }
    return { metadata: metadataValues, files, uploadedFilenames }
}

/** Validate an attachment an edit keeps by ID, recording its ID in retained, and return its metadata */
function encodeRetainedAttachment(
    item: Record<string, unknown>,
    field: (key: string) => unknown,
    edit: boolean,
    retained: Set<string>,
): Record<string, unknown> | InputValidationFailure {
    const retainedId = field("id")
    if (!edit)
        return inputValidationFailure(
            "attachments[].id",
            "relationship",
            "Retained attachment IDs are accepted only when editing a message",
        )
    if (!identifier(retainedId))
        return inputValidationFailure("attachments[].id", "format", "Attachment IDs must be decimal strings")
    const unsupported = unsupportedKeyFailure(
        item,
        ["id", "title", "description"],
        "attachments[]",
        "A retained attachment",
    )
    if (unsupported) return unsupported
    if (retained.has(retainedId))
        return inputValidationFailure("attachments[].id", "unique", "Retained attachment IDs must be unique")
    for (const [key, max] of [
        ["title", 1024],
        ["description", 4096],
    ] as const)
        if (field(key) !== undefined && field(key) !== null && !normalizedText(field(key), 1, max))
            return inputValidationFailure(
                `attachments[].${key}`,
                "length",
                `Retained attachment ${key} must be null or contain 1 through ${max} UTF-16 code units after Fluxer's normalization`,
            )
    retained.add(retainedId)
    return {
        id: retainedId,
        ...(field("title") === undefined ? {} : { title: field("title") }),
        ...(field("description") === undefined ? {} : { description: field("description") }),
    }
}

type SizedSource = { readonly source: FileSource; readonly size: number }

/** Validate the one byte, file or stream source of a new attachment */
function encodeAttachmentSource(
    item: Record<string, unknown>,
    field: (key: string) => unknown,
): SizedSource | InputValidationFailure {
    if (Object.prototype.hasOwnProperty.call(item, "data")) return encodeByteSource(item, field)
    if (Object.prototype.hasOwnProperty.call(item, "file")) return encodeFileSource(item, field)
    if (Object.prototype.hasOwnProperty.call(item, "stream")) return encodeStreamSource(item, field)
    return inputValidationFailure(
        "attachments[]",
        "required",
        "Each new attachment must contain exactly one of data, file, or stream",
    )
}

function encodeByteSource(
    item: Record<string, unknown>,
    field: (key: string) => unknown,
): SizedSource | InputValidationFailure {
    const unsupported = unsupportedKeyFailure(
        item,
        ["data", "filename", "contentType", "title", "description", "spoiler", "explicitMedia", "duration", "waveform"],
        "attachments[]",
        "A byte attachment",
    )
    if (unsupported) return unsupported
    const data = field("data")
    const buffer = data instanceof Uint8Array ? data.buffer : undefined
    if (!(data instanceof Uint8Array) || !(buffer instanceof ArrayBuffer))
        return inputValidationFailure(
            "attachments[].data",
            "type",
            "Attachment data must be an ArrayBuffer-backed Uint8Array",
        )
    const byteLength = data.byteLength
    if (byteLength > attachmentMaxBytes)
        return inputValidationFailure(
            "attachments[].data",
            "size",
            "Attachment data must not exceed 52,428,800 bytes (50 MiB)",
        )
    try {
        new Uint8Array(buffer, data.byteOffset, byteLength)
    } catch {
        // allow-silent: A detached or invalid buffer becomes the typed input failure returned below
        return inputValidationFailure(
            "attachments[].data",
            "type",
            "Attachment data must reference an accessible ArrayBuffer range",
        )
    }
    return { source: { kind: "bytes", data }, size: byteLength }
}

function encodeFileSource(
    item: Record<string, unknown>,
    field: (key: string) => unknown,
): SizedSource | InputValidationFailure {
    const unsupported = unsupportedKeyFailure(
        item,
        ["file", "filename", "contentType", "title", "description", "spoiler", "explicitMedia", "duration", "waveform"],
        "attachments[]",
        "A file attachment",
    )
    if (unsupported) return unsupported
    const file = field("file")
    const fileSize = fileSourceSize(file)
    if (fileSize === undefined)
        return inputValidationFailure(
            "attachments[].file",
            "type",
            "Attachment files must be File or Blob objects with slice and stream methods and a size from 0 through 52,428,800 bytes (50 MiB)",
        )
    return { source: { kind: "file", file: file as AttachmentFileSource }, size: fileSize }
}

function encodeStreamSource(
    item: Record<string, unknown>,
    field: (key: string) => unknown,
): SizedSource | InputValidationFailure {
    const unsupported = unsupportedKeyFailure(
        item,
        [
            "stream",
            "size",
            "filename",
            "contentType",
            "title",
            "description",
            "spoiler",
            "explicitMedia",
            "duration",
            "waveform",
        ],
        "attachments[]",
        "A stream attachment",
    )
    if (unsupported) return unsupported
    const stream = field("stream")
    if (!streamSource(stream))
        return inputValidationFailure(
            "attachments[].stream",
            "type",
            "Attachment streams must be ReadableStream objects with a getReader method",
        )
    const streamSize = field("size")
    if (
        typeof streamSize !== "number" ||
        !Number.isSafeInteger(streamSize) ||
        streamSize < 0 ||
        streamSize > attachmentMaxBytes
    )
        return inputValidationFailure(
            "attachments[].size",
            "range",
            "Attachment stream size must be an integer from 0 through 52,428,800 bytes (50 MiB)",
        )
    return { source: { kind: "stream", stream }, size: streamSize }
}

export function decodeAttachments(value: unknown): readonly Attachment[] | undefined
export function decodeAttachments(value: unknown, construct: boolean): readonly Attachment[] | true | undefined
/** False validates metadata without constructing a projection. The value true is the validation-only success marker */
export function decodeAttachments(value: unknown, construct = true): readonly Attachment[] | true | undefined {
    if (value === undefined || value === null) return construct ? Object.freeze([]) : true
    if (!Array.isArray(value)) return undefined
    const result: Attachment[] | undefined = construct ? [] : undefined
    for (const item of value) {
        const decoded = decodeAttachment(item, construct)
        if (decoded === undefined) return undefined
        if (result && decoded !== true) result.push(decoded)
    }
    return result ? Object.freeze(result) : true
}

/** Validate one received attachment. The value true is the validation-only success marker */
function decodeAttachment(item: unknown, construct: boolean): Attachment | true | undefined {
    if (
        !record(item) ||
        !identifier(item.id) ||
        typeof item.filename !== "string" ||
        typeof item.size !== "number" ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        typeof item.flags !== "number" ||
        !Number.isSafeInteger(item.flags) ||
        item.flags < 0
    )
        return undefined
    const out: Record<string, unknown> | undefined = construct
        ? {
              id: item.id,
              filename: item.filename,
              size: item.size,
              flags: item.flags,
          }
        : undefined
    for (const [key, wire] of Object.entries({
        title: "title",
        description: "description",
        contentType: "content_type",
        contentHash: "content_hash",
        url: "url",
        proxyUrl: "proxy_url",
        placeholder: "placeholder",
        waveform: "waveform",
        expiresAt: "expires_at",
    })) {
        if (item[wire] == null) continue
        if (typeof item[wire] !== "string") return undefined
        if (out) out[key] = item[wire]
    }
    for (const key of ["width", "height", "duration"] as const) {
        if (item[key] == null) continue
        if (
            typeof item[key] !== "number" ||
            !Number.isInteger(item[key]) ||
            item[key] < -2_147_483_648 ||
            item[key] > 2_147_483_647
        )
            return undefined
        if (out) out[key] = item[key]
    }
    for (const key of ["nsfw", "expired"] as const) {
        if (item[key] == null) continue
        if (typeof item[key] !== "boolean") return undefined
        if (out) out[key] = item[key]
    }
    return out ? (Object.freeze(out) as unknown as Attachment) : true
}
