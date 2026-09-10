import type { FilePart } from "./attachments.js"
import { record } from "./message.js"

/** Bounded response parsing completed, but releasing its owned reader failed */
export class UploadResponseCleanupError extends Error {
    constructor(
        readonly cause: unknown,
        readonly status: number,
    ) {
        super("Attachment upload response cleanup failed", { cause })
        this.name = "UploadResponseCleanupError"
    }
}

export type UploadPlan = {
    id: number
    filename: string
    contentType: string
    key: string
    uploadId?: string
    parts: { url: string; offset: number; size: number }[]
}

const text = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= max

function destination(value: unknown, allowInsecure: boolean): value is string {
    if (!text(value, 8192)) return false
    try {
        const url = new URL(value)
        // Signed plan URLs are authenticated upload capabilities. Preserve their query, do not send bot auth, and never follow redirects
        return (
            (url.protocol === "https:" || (allowInsecure && url.protocol === "http:")) &&
            url.username === "" &&
            url.password === "" &&
            url.hash === ""
        )
    } catch {
        return false
    }
}

/** Validate the complete plan before dispatching any file bytes; unknown response properties are discarded */
export function decodeUploadPlans(
    value: unknown,
    files: readonly FilePart[],
    allowInsecure: boolean,
): UploadPlan[] | undefined {
    if (!record(value) || !Array.isArray(value.attachments) || value.attachments.length !== files.length)
        return undefined
    const plans: UploadPlan[] = []
    const keys = new Set<string>()
    const urls = new Set<string>()
    for (const file of files) {
        const matches = value.attachments.filter((item) => record(item) && item.id === file.id)
        if (matches.length !== 1) return undefined
        const item = matches[0]!
        if (
            !record(item) ||
            item.file_size !== file.size ||
            !text(item.filename, 255) ||
            /[\x00-\x1f\x7f/\\]/.test(item.filename) ||
            !text(item.content_type, 255) ||
            !/^[\x20-\x7e]+$/.test(item.content_type) ||
            !text(item.upload_filename, 4096) ||
            keys.has(item.upload_filename)
        )
            return undefined
        keys.add(item.upload_filename)
        const plan: UploadPlan = {
            id: file.id,
            filename: item.filename,
            contentType: item.content_type,
            key: item.upload_filename,
            parts: [],
        }
        if (item.upload_mode === "singlepart") {
            if (!destination(item.upload_url, allowInsecure) || item.file_size > 10_485_760) return undefined
            plan.parts.push({ url: item.upload_url, offset: 0, size: file.size })
        } else if (item.upload_mode === "multipart") {
            if (
                !text(item.upload_id, 1024) ||
                typeof item.part_size !== "number" ||
                !Number.isSafeInteger(item.part_size) ||
                item.part_size <= 0 ||
                item.part_size > 52_428_800 ||
                !Array.isArray(item.parts) ||
                item.parts.length === 0 ||
                item.parts.length > 10_000 ||
                item.parts.length !== Math.ceil(file.size / item.part_size)
            )
                return undefined
            plan.uploadId = item.upload_id
            for (let index = 0; index < item.parts.length; index++) {
                const part = item.parts[index]
                if (!record(part) || part.part_number !== index + 1 || !destination(part.upload_url, allowInsecure))
                    return undefined
                const offset = index * item.part_size
                plan.parts.push({
                    url: part.upload_url,
                    offset,
                    size: Math.min(item.part_size, file.size - offset),
                })
            }
        } else return undefined
        for (const part of plan.parts) {
            if (urls.has(part.url)) return undefined
            urls.add(part.url)
        }
        plans.push(plan)
    }
    return plans
}

/** Bound untrusted plan/completion JSON before parsing; signed capabilities never become public error detail */
export async function readUploadJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader()
    if (!reader) return undefined
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let result = "",
        bytes = 0,
        ended = false
    try {
        while (true) {
            const next = await reader.read()
            if (next.done) {
                ended = true
                break
            }
            bytes += next.value.byteLength
            if (bytes > 1_048_576) return undefined
            result += decoder.decode(next.value, { stream: true })
        }
        return JSON.parse(result + decoder.decode()) as unknown
    } catch {
        return undefined
    } finally {
        const failures: unknown[] = []
        for (const action of [...(!ended ? [() => reader.cancel()] : []), () => reader.releaseLock()]) {
            try {
                await action()
            } catch (error) {
                failures.push(error)
            }
        }
        if (failures.length)
            throw new UploadResponseCleanupError(
                failures.length === 1 ? failures[0] : new AggregateError(failures, "Upload response cleanup failed"),
                response.status,
            )
    }
}
