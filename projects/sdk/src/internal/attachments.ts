import type { Attachment } from "#sdk/attachments"
import { identifier, record } from "./message.js"

export type FilePart = { id: number; filename: string; contentType: string; data: Uint8Array }
export type EncodedBody = { json: string; files: FilePart[] }

/** Validate without copying binary bytes; admission owns the subsequent snapshot */
export function encodeAttachments(value: unknown, edit: boolean) {
    if (value === undefined) return { metadata: undefined, files: [] as FilePart[] }
    if (!Array.isArray(value)) return undefined
    const metadata: Record<string, unknown>[] = []
    const files: FilePart[] = []
    const retained = new Set<string>()
    for (const item of value) {
        if (!record(item)) return undefined
        if (item.id !== undefined) {
            if (!edit || !identifier(item.id) || Object.keys(item).some((key) => key !== "id") || retained.has(item.id))
                return undefined
            retained.add(item.id)
            metadata.push({ id: item.id })
            continue
        }
        if (
            Object.keys(item).some(
                (key) => !["data", "filename", "contentType", "title", "description", "spoiler"].includes(key),
            )
        )
            return undefined
        if (
            !(item.data instanceof Uint8Array) ||
            !(item.data.buffer instanceof ArrayBuffer) ||
            item.data.byteLength > 52_428_800
        )
            return undefined
        // Detached buffers cannot be snapshotted, even when their reported length is zero
        try {
            new Uint8Array(item.data.buffer, item.data.byteOffset, item.data.byteLength)
        } catch {
            return undefined
        }
        if (
            typeof item.filename !== "string" ||
            item.filename.length < 1 ||
            item.filename.length > 255 ||
            /[\x00-\x1f\x7f/\\]/.test(item.filename)
        )
            return undefined
        if (
            item.contentType !== undefined &&
            (typeof item.contentType !== "string" || !/^[\x20-\x7e]{1,255}$/.test(item.contentType))
        )
            return undefined
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
        const id = metadata.length
        metadata.push({
            id,
            filename: item.filename,
            ...(item.contentType === undefined ? {} : { content_type: item.contentType }),
            ...(item.title === undefined ? {} : { title: item.title }),
            ...(item.description === undefined ? {} : { description: item.description }),
            flags: item.spoiler === true ? 8 : 0,
        })
        files.push({
            id,
            filename: item.filename,
            contentType: item.contentType ?? "application/octet-stream",
            data: item.data,
        })
    }
    return { metadata, files }
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
