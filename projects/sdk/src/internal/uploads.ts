import type { FilePart } from "./attachments.js"
import { record } from "./message.js"

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

function destination(value: unknown): value is string {
    if (!text(value, 8192)) return false
    try {
        const url = new URL(value)
        // The hosted upload relay was verified separately from the authenticated API origin
        // Fail closed on new destinations rather than sending private bytes to an arbitrary response URL
        return (
            url.origin === "https://uploads.fluxer.app" && url.username === "" && url.password === "" && url.hash === ""
        )
    } catch {
        return false
    }
}

/** Validate the complete plan before dispatching any file bytes; unknown response properties are discarded */
export function decodeUploadPlans(value: unknown, files: readonly FilePart[]): UploadPlan[] | undefined {
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
            item.file_size !== file.data.byteLength ||
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
            if (!destination(item.upload_url) || item.file_size > 10_485_760) return undefined
            plan.parts.push({ url: item.upload_url, offset: 0, size: file.data.byteLength })
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
                item.parts.length !== Math.ceil(file.data.byteLength / item.part_size)
            )
                return undefined
            plan.uploadId = item.upload_id
            for (let index = 0; index < item.parts.length; index++) {
                const part = item.parts[index]
                if (!record(part) || part.part_number !== index + 1 || !destination(part.upload_url)) return undefined
                const offset = index * item.part_size
                plan.parts.push({
                    url: part.upload_url,
                    offset,
                    size: Math.min(item.part_size, file.data.byteLength - offset),
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
        if (!ended) await reader.cancel()
        reader.releaseLock()
    }
}

/** One bounded view stream per PUT attempt, without concatenating or copying the owned file */
export function uploadBody(data: Uint8Array, offset: number, size: number) {
    let retained: Uint8Array | undefined = data
    const end = offset + size
    let controller: ReadableStreamDefaultController<Uint8Array>
    let ended = false
    const body = new ReadableStream<Uint8Array>(
        {
            start(value) {
                controller = value
            },
            pull(value) {
                if (offset === end) {
                    ended = true
                    retained = undefined
                    value.close()
                    return
                }
                const next = Math.min(offset + 65_536, end)
                value.enqueue(retained!.subarray(offset, next))
                offset = next
            },
            cancel() {
                ended = true
                retained = undefined
            },
        },
        { highWaterMark: 0 },
    )
    return {
        body,
        stop() {
            retained = undefined
            if (!ended) {
                ended = true
                controller.error(new Error("Upload body closed"))
            }
        },
    }
}
