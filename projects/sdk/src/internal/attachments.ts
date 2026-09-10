import type { Attachment, AttachmentFileSource, AttachmentStreamSource } from "#sdk/attachments"
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

function metadata(item: Record<string, unknown>, id: number, values: Record<string, unknown>[]): string | undefined {
    if (!filename(item.filename)) return undefined
    const providedContentType = item.contentType
    if (providedContentType !== undefined && !contentType(providedContentType)) return undefined
    for (const [key, max] of [
        ["title", 1024],
        ["description", 4096],
    ] as const)
        if (
            item[key] !== undefined &&
            (typeof item[key] !== "string" || item[key].length < 1 || item[key].length > max)
        )
            return undefined
    if (item.spoiler !== undefined && typeof item.spoiler !== "boolean") return undefined
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
    if (!Array.isArray(value)) return undefined
    const metadataValues: Record<string, unknown>[] = []
    const files: FilePart[] = []
    const uploadedFilenames: string[] = []
    const retained = new Set<string>()
    for (const item of value) {
        if (!record(item)) return undefined
        if (item.id !== undefined) {
            if (
                !edit ||
                !identifier(item.id) ||
                Object.keys(item).some((key) => !["id", "title", "description"].includes(key)) ||
                retained.has(item.id)
            )
                return undefined
            for (const [key, max] of [
                ["title", 1024],
                ["description", 4096],
            ] as const)
                if (
                    item[key] !== undefined &&
                    item[key] !== null &&
                    (typeof item[key] !== "string" || item[key].length < 1 || item[key].length > max)
                )
                    return undefined
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
                ) ||
                !(item.data instanceof Uint8Array) ||
                !(item.data.buffer instanceof ArrayBuffer) ||
                item.data.byteLength > attachmentMaxBytes
            )
                return undefined
            try {
                new Uint8Array(item.data.buffer, item.data.byteOffset, item.data.byteLength)
            } catch {
                return undefined
            }
            source = { kind: "bytes", data: item.data }
            size = item.data.byteLength
        } else if (Object.prototype.hasOwnProperty.call(item, "file")) {
            if (
                Object.keys(item).some(
                    (key) => !["file", "filename", "contentType", "title", "description", "spoiler"].includes(key),
                ) ||
                !fileSource(item.file)
            )
                return undefined
            source = { kind: "file", file: item.file }
            size = item.file.size
        } else if (Object.prototype.hasOwnProperty.call(item, "stream")) {
            if (
                Object.keys(item).some(
                    (key) =>
                        !["stream", "size", "filename", "contentType", "title", "description", "spoiler"].includes(key),
                ) ||
                !streamSource(item.stream) ||
                typeof item.size !== "number" ||
                !Number.isSafeInteger(item.size) ||
                item.size < 0 ||
                item.size > attachmentMaxBytes
            )
                return undefined
            source = { kind: "stream", stream: item.stream }
            size = item.size
        } else return undefined
        const acceptedContentType = metadata(item, id, metadataValues)
        if (acceptedContentType === undefined || !filename(item.filename)) return undefined
        uploadedFilenames.push(item.filename)
        files.push({ id, filename: item.filename, contentType: acceptedContentType, size, source })
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
