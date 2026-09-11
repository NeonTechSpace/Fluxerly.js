import type { Attachment, AttachmentFileSource, AttachmentStreamSource } from "#sdk/attachments"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import { identifier, record } from "./message.js"

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
    return typeof value === "string" && value.length >= 1 && value.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(value)
}

function contentType(value: unknown): value is string {
    return typeof value === "string" && /^[\x20-\x7e]{1,255}$/.test(value)
}

function metadata(
    item: Record<string, unknown>,
    id: number,
    values: Record<string, unknown>[],
): string | InputValidationFailure {
    if (!filename(item.filename))
        return inputValidationFailure(
            "attachments[].filename",
            "format",
            "Attachment filenames must contain 1 through 255 safe characters",
        )
    const providedContentType = item.contentType
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
        if (
            item[key] !== undefined &&
            (typeof item[key] !== "string" || item[key].length < 1 || item[key].length > max)
        )
            return inputValidationFailure(
                `attachments[].${key}`,
                "length",
                `Attachment ${key} must contain 1 through ${max} UTF-16 code units`,
            )
    if (item.spoiler !== undefined && typeof item.spoiler !== "boolean")
        return inputValidationFailure("attachments[].spoiler", "type", "Attachment spoiler must be a boolean")
    values.push({
        id,
        filename: item.filename,
        ...(providedContentType === undefined ? {} : { content_type: providedContentType }),
        ...(item.title === undefined ? {} : { title: item.title }),
        ...(item.description === undefined ? {} : { description: item.description }),
        flags: item.spoiler === true ? 8 : 0,
    })
    return providedContentType ?? "application/octet-stream"
}

function fileSource(value: unknown): value is AttachmentFileSource {
    return (
        record(value) &&
        typeof value.size === "number" &&
        Number.isSafeInteger(value.size) &&
        value.size >= 0 &&
        value.size <= attachmentMaxBytes &&
        typeof value.slice === "function" &&
        typeof value.stream === "function"
    )
}

function streamSource(value: unknown): value is AttachmentStreamSource {
    return record(value) && typeof value.getReader === "function"
}

/** Validate attachment structure without reading caller files or streams. Admission later snapshots byte arrays and reserves exact source sizes */
export function encodeAttachments(value: unknown, edit: boolean) {
    if (value === undefined) return { metadata: undefined, files: [] as FilePart[], uploadedFilenames: [] as string[] }
    if (!Array.isArray(value)) return inputValidationFailure("attachments", "type", "Attachments must be an array")
    const metadataValues: Record<string, unknown>[] = []
    const files: FilePart[] = []
    const uploadedFilenames: string[] = []
    const retained = new Set<string>()
    for (const item of value) {
        if (!record(item)) return inputValidationFailure("attachments[]", "type", "Each attachment must be an object")
        if (item.id !== undefined) {
            if (!edit)
                return inputValidationFailure(
                    "attachments[].id",
                    "relationship",
                    "Retained attachment IDs are accepted only when editing a message",
                )
            if (!identifier(item.id))
                return inputValidationFailure("attachments[].id", "format", "Attachment IDs must be decimal strings")
            if (Object.keys(item).some((key) => !["id", "title", "description"].includes(key)))
                return inputValidationFailure(
                    "attachments[]",
                    "allowedFields",
                    "Retained attachments may contain only id, title, and description",
                )
            if (retained.has(item.id))
                return inputValidationFailure("attachments[].id", "unique", "Retained attachment IDs must be unique")
            for (const [key, max] of [
                ["title", 1024],
                ["description", 4096],
            ] as const)
                if (
                    item[key] !== undefined &&
                    item[key] !== null &&
                    (typeof item[key] !== "string" || item[key].length < 1 || item[key].length > max)
                )
                    return inputValidationFailure(
                        `attachments[].${key}`,
                        "length",
                        `Retained attachment ${key} must be null or contain 1 through ${max} UTF-16 code units`,
                    )
            retained.add(item.id)
            metadataValues.push({
                id: item.id,
                ...(item.title === undefined ? {} : { title: item.title }),
                ...(item.description === undefined ? {} : { description: item.description }),
            })
            continue
        }
        const id = metadataValues.length
        let source: FileSource
        let size: number
        if (Object.prototype.hasOwnProperty.call(item, "data")) {
            if (
                Object.keys(item).some(
                    (key) => !["data", "filename", "contentType", "title", "description", "spoiler"].includes(key),
                )
            )
                return inputValidationFailure(
                    "attachments[]",
                    "allowedFields",
                    "Byte attachments may contain only data, filename, contentType, title, description, and spoiler",
                )
            if (!(item.data instanceof Uint8Array) || !(item.data.buffer instanceof ArrayBuffer))
                return inputValidationFailure(
                    "attachments[].data",
                    "type",
                    "Attachment data must be an ArrayBuffer-backed Uint8Array",
                )
            if (item.data.byteLength > attachmentMaxBytes)
                return inputValidationFailure(
                    "attachments[].data",
                    "size",
                    "Attachment data must not exceed 52,428,800 bytes",
                )
            try {
                new Uint8Array(item.data.buffer, item.data.byteOffset, item.data.byteLength)
            } catch {
                return inputValidationFailure(
                    "attachments[].data",
                    "type",
                    "Attachment data must reference an accessible ArrayBuffer range",
                )
            }
            source = { kind: "bytes", data: item.data }
            size = item.data.byteLength
        } else if (Object.prototype.hasOwnProperty.call(item, "file")) {
            if (
                Object.keys(item).some(
                    (key) => !["file", "filename", "contentType", "title", "description", "spoiler"].includes(key),
                )
            )
                return inputValidationFailure(
                    "attachments[]",
                    "allowedFields",
                    "File attachments may contain only file, filename, contentType, title, description, and spoiler",
                )
            if (!fileSource(item.file))
                return inputValidationFailure(
                    "attachments[].file",
                    "type",
                    "Attachment files must expose a bounded size, slice, and stream",
                )
            source = { kind: "file", file: item.file }
            size = item.file.size
        } else if (Object.prototype.hasOwnProperty.call(item, "stream")) {
            if (
                Object.keys(item).some(
                    (key) =>
                        !["stream", "size", "filename", "contentType", "title", "description", "spoiler"].includes(key),
                )
            )
                return inputValidationFailure(
                    "attachments[]",
                    "allowedFields",
                    "Stream attachments may contain only stream, size, filename, contentType, title, description, and spoiler",
                )
            if (!streamSource(item.stream))
                return inputValidationFailure(
                    "attachments[].stream",
                    "type",
                    "Attachment streams must expose getReader",
                )
            if (
                typeof item.size !== "number" ||
                !Number.isSafeInteger(item.size) ||
                item.size < 0 ||
                item.size > attachmentMaxBytes
            )
                return inputValidationFailure(
                    "attachments[].size",
                    "range",
                    "Attachment stream size must be an integer from 0 through 52,428,800 bytes",
                )
            source = { kind: "stream", stream: item.stream }
            size = item.size
        } else
            return inputValidationFailure(
                "attachments[]",
                "required",
                "Each new attachment must contain exactly one of data, file, or stream",
            )
        const acceptedContentType = metadata(item, id, metadataValues)
        if (acceptedContentType instanceof InputValidationFailure) return acceptedContentType
        const acceptedFilename = item.filename as string
        uploadedFilenames.push(acceptedFilename)
        files.push({ id, filename: acceptedFilename, contentType: acceptedContentType, size, source })
    }
    return { metadata: metadataValues, files, uploadedFilenames }
}

export function decodeAttachments(value: unknown): readonly Attachment[] | undefined {
    if (value === undefined || value === null) return Object.freeze([])
    if (!Array.isArray(value)) return undefined
    const result: Attachment[] = []
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
        const out: Record<string, unknown> = {
            id: item.id,
            filename: item.filename,
            size: item.size,
            flags: item.flags,
        }
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
            out[key] = item[wire]
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
            out[key] = item[key]
        }
        for (const key of ["nsfw", "expired"] as const) {
            if (item[key] == null) continue
            if (typeof item[key] !== "boolean") return undefined
            out[key] = item[key]
        }
        result.push(Object.freeze(out) as unknown as Attachment)
    }
    return Object.freeze(result)
}
