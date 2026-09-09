import { randomUUID } from "node:crypto"
import type { EncodedBody } from "./attachments.js"

/** Stream owned file snapshots without concatenation or an additional Blob copy */
export function multipart(body: EncodedBody) {
    const boundary = `fluxerly-${randomUUID()}`
    const encoder = new TextEncoder()
    const segments: Uint8Array[] = [
        encoder.encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${body.json}\r\n`,
        ),
    ]
    for (const file of body.files) {
        const filename = file.filename.replaceAll('"', "%22")
        segments.push(
            encoder.encode(
                `--${boundary}\r\nContent-Disposition: form-data; name="files[${file.id}]"; filename="${filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
            ),
            file.data,
            encoder.encode("\r\n"),
        )
    }
    segments.push(encoder.encode(`--${boundary}--\r\n`))
    const size = segments.reduce((sum, segment) => sum + segment.byteLength, 0)
    let index = 0,
        offset = 0,
        ended = false
    let controller: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>(
        {
            start(value) {
                controller = value
            },
            pull(value) {
                while (index < segments.length && offset === segments[index]!.length) {
                    index++
                    offset = 0
                }
                if (index === segments.length) {
                    ended = true
                    segments.length = 0
                    value.close()
                    return
                }
                const segment = segments[index]!,
                    end = Math.min(segment.length, offset + 65_536)
                value.enqueue(segment.subarray(offset, end))
                offset = end
            },
            cancel() {
                ended = true
                segments.length = 0
            },
        },
        { highWaterMark: 0 },
    )
    return {
        body: stream,
        size,
        contentType: `multipart/form-data; boundary=${boundary}`,
        stop() {
            segments.length = 0
            if (!ended) {
                ended = true
                controller.error(new Error("Multipart body closed"))
            }
        },
    }
}
