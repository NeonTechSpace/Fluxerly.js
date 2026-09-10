import { randomUUID } from "node:crypto"
import type { EncodedBody, FilePart } from "./attachments.js"
import {
    AttachmentTransferCleanupError,
    AttachmentTransferSource,
    AttachmentTransferVerificationCleanupError,
    type AttachmentTransferBody,
} from "./transfer-source.js"

const chunkBytes = 65_536

type Segment = { readonly bytes: Uint8Array } | { readonly file: FilePart; readonly source: AttachmentTransferSource }

async function completeCleanup(actions: readonly (() => void | PromiseLike<void>)[]) {
    const failures: unknown[] = []
    for (const action of actions) {
        try {
            await action()
        } catch (error) {
            failures.push(error)
        }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "Attachment multipart cleanup failed")
}

/** Stream a message multipart body on demand without concatenating file bytes or adding an SDK file copy */
export function multipart(body: EncodedBody, sources: readonly AttachmentTransferSource[]) {
    const boundary = `fluxerly-${randomUUID()}`
    const encoder = new TextEncoder()
    const segments: Segment[] = [
        {
            bytes: encoder.encode(
                `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${body.json}\r\n`,
            ),
        },
    ]
    for (const [fileIndex, file] of body.files.entries()) {
        const source = sources[fileIndex]
        if (!source) throw new Error("Attachment multipart source is missing")
        const filename = file.filename.replaceAll('"', "%22")
        segments.push(
            {
                bytes: encoder.encode(
                    `--${boundary}\r\nContent-Disposition: form-data; name="files[${file.id}]"; filename="${filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
                ),
            },
            { file, source },
            { bytes: encoder.encode("\r\n") },
        )
    }
    segments.push({ bytes: encoder.encode(`--${boundary}--\r\n`) })
    const size = segments.reduce(
        (sum, segment) => sum + ("bytes" in segment ? segment.bytes.byteLength : segment.file.size),
        0,
    )
    let index = 0
    let offset = 0
    let current: AttachmentTransferBody | undefined
    let currentReader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let ended = false
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const closeCurrent = async (cancel: boolean, cancelReader = cancel) => {
        const reader = currentReader
        currentReader = undefined
        const transfer = current
        current = undefined
        await completeCleanup([
            ...(reader && cancelReader ? [() => reader.cancel()] : []),
            ...(reader ? [() => reader.releaseLock()] : []),
            ...(transfer && cancel ? [() => transfer.stop()] : []),
        ])
    }
    const stream = new ReadableStream<Uint8Array>(
        {
            async pull(value) {
                while (index < segments.length) {
                    const segment = segments[index]!
                    if ("bytes" in segment) {
                        if (offset === segment.bytes.byteLength) {
                            index++
                            offset = 0
                            continue
                        }
                        const next = Math.min(segment.bytes.byteLength, offset + chunkBytes)
                        value.enqueue(segment.bytes.subarray(offset, next))
                        offset = next
                        return
                    }
                    if (!current) {
                        current = segment.source.open(0, segment.file.size)
                        currentReader = current.body.getReader()
                    }
                    let next: ReadableStreamReadResult<Uint8Array>
                    try {
                        next = await currentReader!.read()
                    } catch (error) {
                        try {
                            await closeCurrent(true, false)
                        } catch (cleanup) {
                            throw new AttachmentTransferVerificationCleanupError(error, cleanup)
                        }
                        throw error
                    }
                    if (!next.done) {
                        value.enqueue(next.value)
                        return
                    }
                    try {
                        await current.verify()
                    } catch (error) {
                        try {
                            await closeCurrent(true)
                        } catch (cleanup) {
                            throw new AttachmentTransferVerificationCleanupError(error, cleanup)
                        }
                        throw error
                    }
                    try {
                        currentReader!.releaseLock()
                        currentReader = undefined
                        await current.finish()
                    } catch (error) {
                        try {
                            await closeCurrent(true)
                        } catch (cleanup) {
                            throw new AttachmentTransferCleanupError(
                                new AggregateError([error, cleanup], "Attachment multipart finalization failed"),
                            )
                        }
                        if (error instanceof AttachmentTransferCleanupError) throw error
                        throw new AttachmentTransferCleanupError(error)
                    }
                    current = undefined
                    index++
                }
                ended = true
                value.close()
            },
            async cancel() {
                ended = true
                await completeCleanup([() => closeCurrent(true), ...sources.map((source) => () => source.close())])
            },
            start(value) {
                controller = value
            },
        },
        { highWaterMark: 0 },
    )
    return {
        body: stream,
        size,
        contentType: `multipart/form-data; boundary=${boundary}`,
        async stop() {
            const unfinished = !ended
            if (!ended) {
                ended = true
                controller?.error(new Error("Multipart body closed"))
            }
            await completeCleanup([
                () => closeCurrent(unfinished),
                ...(unfinished ? sources.map((source) => () => source.close()) : []),
            ])
        },
    }
}
