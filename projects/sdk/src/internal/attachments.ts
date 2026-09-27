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
    values.push({
        id,
        filename: acceptedFilename,
        ...(providedContentType === undefined ? {} : { content_type: providedContentType }),
        ...(field("title") === undefined ? {} : { title: field("title") }),
        ...(field("description") === undefined ? {} : { description: field("description") }),
        flags: spoiler === true ? 8 : 0,
    })
    return providedContentType ?? "application/octet-stream"
}

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
 * values are the ones sent
 */
export function encodeAttachments(value: unknown, edit: boolean) {
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
        const retainedId = field("id")
        if (retainedId !== undefined) {
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
            metadataValues.push({
                id: retainedId,
                ...(field("title") === undefined ? {} : { title: field("title") }),
                ...(field("description") === undefined ? {} : { description: field("description") }),
            })
            continue
        }
        const id = metadataValues.length
        let source: FileSource
        let size: number
        if (Object.prototype.hasOwnProperty.call(item, "data")) {
            const unsupported = unsupportedKeyFailure(
                item,
                ["data", "filename", "contentType", "title", "description", "spoiler"],
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
            source = { kind: "bytes", data }
            size = byteLength
        } else if (Object.prototype.hasOwnProperty.call(item, "file")) {
            const unsupported = unsupportedKeyFailure(
                item,
                ["file", "filename", "contentType", "title", "description", "spoiler"],
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
            source = { kind: "file", file: file as AttachmentFileSource }
            size = fileSize
        } else if (Object.prototype.hasOwnProperty.call(item, "stream")) {
            const unsupported = unsupportedKeyFailure(
                item,
                ["stream", "size", "filename", "contentType", "title", "description", "spoiler"],
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
            source = { kind: "stream", stream }
            size = streamSize
        } else
            return inputValidationFailure(
                "attachments[]",
                "required",
                "Each new attachment must contain exactly one of data, file, or stream",
            )
        const acceptedContentType = metadata(field, id, metadataValues)
        if (acceptedContentType instanceof InputValidationFailure) return acceptedContentType
        const acceptedFilename = field("filename") as string
        uploadedFilenames.push(acceptedFilename)
        files.push({ id, filename: acceptedFilename, contentType: acceptedContentType, size, source })
    }
    return { metadata: metadataValues, files, uploadedFilenames }
}

export function decodeAttachments(value: unknown): readonly Attachment[] | undefined
export function decodeAttachments(value: unknown, construct: boolean): readonly Attachment[] | true | undefined
/** False validates metadata without constructing a projection. The value true is the validation-only success marker */
export function decodeAttachments(value: unknown, construct = true): readonly Attachment[] | true | undefined {
    if (value === undefined || value === null) return construct ? Object.freeze([]) : true
    if (!Array.isArray(value)) return undefined
    const result: Attachment[] | undefined = construct ? [] : undefined
    for (const item of value) {
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
        if (out) result!.push(Object.freeze(out) as unknown as Attachment)
    }
    return result ? Object.freeze(result) : true
}
