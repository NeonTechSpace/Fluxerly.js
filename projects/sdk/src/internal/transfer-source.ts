import { setImmediate as yieldToHost } from "node:timers/promises"
import type { AttachmentStreamReadResult, AttachmentStreamReader, AttachmentStreamSource } from "#sdk/attachments"
import type { FilePart } from "./attachments.js"

const chunkBytes = 65_536

export type AttachmentTransferBody = {
    readonly body: ReadableStream<Uint8Array>
    verify(): Promise<void>
    finish(): Promise<void>
    stop(): Promise<void>
}

/** Marks reader finalization failures so the REST boundary does not present them as transport failures */
export class AttachmentTransferCleanupError extends Error {
    constructor(cause: unknown) {
        super("Attachment source finalization failed", { cause })
        this.name = "AttachmentTransferCleanupError"
    }
}

/** Keeps an exact-length failure separate from a source cleanup defect */
export class AttachmentTransferVerificationCleanupError extends Error {
    constructor(
        readonly verification: unknown,
        readonly cleanup: unknown,
    ) {
        super("Attachment source verification and cleanup failed", { cause: cleanup })
        this.name = "AttachmentTransferVerificationCleanupError"
    }
}

function validChunk(value: unknown): value is Uint8Array {
    return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer
}

function readResult(value: unknown): AttachmentStreamReadResult | undefined {
    if (typeof value !== "object" || value === null) return undefined
    const done = "done" in value ? value.done : undefined
    if (done === true)
        return { done: true, value: "value" in value && validChunk(value.value) ? value.value : undefined }
    if (done !== false && done !== undefined) return undefined
    if (!("value" in value) || !validChunk(value.value)) return undefined
    return { done: false, value: value.value }
}

async function readNonempty(reader: AttachmentStreamReader, closed: () => boolean, invalid: string) {
    let emptyReads = 0
    for (;;) {
        if (closed()) throw new Error("Attachment source closed")
        const next = readResult(await reader.read())
        if (closed()) throw new Error("Attachment source closed")
        if (!next) throw new Error(invalid)
        if (next.done) return undefined
        if (next.value.byteLength !== 0) return next.value
        // Empty chunks are valid, but immediately resolved reads must not starve
        // host timers and cancellation, including during the final EOF check
        if (++emptyReads === 256) {
            emptyReads = 0
            await yieldToHost()
        }
    }
}

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
    if (failures.length > 1) throw new AggregateError(failures, "Attachment source cleanup failed")
}

/** One operation-owned exact-length source. Byte inputs are copied before construction; file and stream sources remain caller-owned outside an acquired reader */
export class AttachmentTransferSource {
    readonly size: number
    /** Byte inputs are snapshot-owned and can recreate a fully consumed inline body after a confirmed rate-limit rejection */
    readonly replayable: boolean
    #streamReader: AttachmentStreamReader | undefined
    #streamPending: Uint8Array | undefined
    #streamOffset = 0
    #streamPosition = 0
    #closed = false

    constructor(private readonly file: FilePart) {
        this.size = file.size
        this.replayable = file.source.kind === "bytes"
    }

    async #closeStream(cancel: boolean) {
        this.#closed = !this.replayable
        const reader = this.#streamReader
        this.#streamReader = undefined
        this.#streamPending = undefined
        this.#streamOffset = 0
        if (!reader) return
        await completeCleanup([...(cancel ? [() => reader.cancel()] : []), () => reader.releaseLock()])
    }

    async close() {
        // Copied bytes have no caller-owned reader or mutable source to release. They can
        // recreate an inline multipart body after a confirmed 429, including when the server
        // replied before reading the first body
        if (!this.replayable) this.#closed = true
        await this.#closeStream(true)
    }

    #streamReaderForRead(): AttachmentStreamReader {
        if (this.#closed) throw new Error("Attachment source closed")
        if (this.#streamReader) return this.#streamReader
        if (this.file.source.kind !== "stream") throw new Error("Attachment source is not a stream")
        const reader = this.file.source.stream.getReader()
        if (!isAttachmentStreamReader(reader)) throw new Error("Invalid attachment stream reader")
        this.#streamReader = reader
        return reader
    }

    async #nextStreamChunk(): Promise<Uint8Array | undefined> {
        if (!this.#streamPending || this.#streamOffset === this.#streamPending.byteLength) {
            this.#streamPending = undefined
            this.#streamOffset = 0
            this.#streamPending = await readNonempty(
                this.#streamReaderForRead(),
                () => this.#closed,
                "Invalid attachment stream result",
            )
        }
        return this.#streamPending
    }

    #streamRange(offset: number, size: number): AttachmentTransferBody {
        const owner = this
        if (offset !== this.#streamPosition) throw new Error("Attachment stream parts must remain sequential")
        let remaining = size
        let ended = false
        let finished = false
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined
        const stream = new ReadableStream<Uint8Array>(
            {
                pull: async (value) => {
                    if (remaining === 0) {
                        ended = true
                        value.close()
                        return
                    }
                    const chunk = await owner.#nextStreamChunk()
                    if (!chunk) throw new Error("Attachment stream ended before its declared size")
                    const available = chunk.byteLength - owner.#streamOffset
                    const length = Math.min(available, remaining, chunkBytes)
                    const next = chunk.subarray(owner.#streamOffset, owner.#streamOffset + length)
                    owner.#streamOffset += length
                    owner.#streamPosition += length
                    remaining -= length
                    value.enqueue(next)
                },
                cancel: async () => {
                    ended = true
                    await owner.close()
                },
                start(value) {
                    controller = value
                },
            },
            { highWaterMark: 0 },
        )
        return {
            body: stream,
            async verify() {
                if (!ended || remaining !== 0) throw new Error("Attachment stream did not finish its requested range")
                if (owner.#streamPosition !== owner.size) return
                const extra = await owner.#nextStreamChunk()
                if (extra) throw new Error("Attachment stream exceeded its declared size")
            },
            async finish() {
                finished = true
                if (owner.#streamPosition !== owner.size) return
                try {
                    await owner.#closeStream(false)
                } catch (error) {
                    throw new AttachmentTransferCleanupError(error)
                }
            },
            async stop() {
                if (!ended) {
                    ended = true
                    controller?.error(new Error("Attachment upload body closed"))
                }
                if (!finished) await owner.close()
            },
        }
    }

    #rangeStream(stream: AttachmentStreamSource, size: number): AttachmentTransferBody {
        let reader: AttachmentStreamReader | undefined
        let closed = false
        let pending: Uint8Array | undefined
        let pendingOffset = 0
        let remaining = size
        let ended = false
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined
        const take = async (): Promise<Uint8Array | undefined> => {
            if (closed) throw new Error("Attachment source closed")
            if (!reader) {
                const candidate = stream.getReader()
                if (!isAttachmentStreamReader(candidate)) throw new Error("Invalid attachment file stream reader")
                reader = candidate
            }
            if (!pending || pendingOffset === pending.byteLength) {
                pending = undefined
                pendingOffset = 0
                pending = await readNonempty(reader, () => closed, "Invalid attachment file stream result")
            }
            return pending
        }
        const body = new ReadableStream<Uint8Array>(
            {
                pull: async (value) => {
                    if (remaining === 0) {
                        ended = true
                        value.close()
                        return
                    }
                    const next = await take()
                    if (!next) throw new Error("Attachment file ended before its reported size")
                    const length = Math.min(next.byteLength - pendingOffset, remaining, chunkBytes)
                    pendingOffset += length
                    remaining -= length
                    value.enqueue(next.subarray(pendingOffset - length, pendingOffset))
                },
                cancel: async () => {
                    ended = true
                    await release(true)
                },
                start(value) {
                    controller = value
                },
            },
            { highWaterMark: 0 },
        )
        const release = async (cancel: boolean) => {
            closed = true
            if (!reader) return
            const current = reader
            reader = undefined
            await completeCleanup([...(cancel ? [() => current.cancel()] : []), () => current.releaseLock()])
        }
        return {
            body,
            async verify() {
                if (!ended || remaining !== 0) throw new Error("Attachment file did not finish its requested range")
                if (pending && pendingOffset < pending.byteLength)
                    throw new Error("Attachment file exceeded its reported size")
                pending = undefined
                pendingOffset = 0
                const extra = await take()
                if (extra) throw new Error("Attachment file exceeded its reported size")
            },
            async finish() {
                try {
                    await release(false)
                } catch (error) {
                    throw new AttachmentTransferCleanupError(error)
                }
            },
            async stop() {
                if (!ended) {
                    ended = true
                    controller?.error(new Error("Attachment upload body closed"))
                }
                await release(true)
            },
        }
    }

    #bytesRange(data: Uint8Array, offset: number, size: number): AttachmentTransferBody {
        let position = offset
        const end = offset + size
        let ended = false
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined
        const body = new ReadableStream<Uint8Array>(
            {
                pull(value) {
                    if (position === end) {
                        ended = true
                        value.close()
                        return
                    }
                    const next = Math.min(position + chunkBytes, end)
                    value.enqueue(data.subarray(position, next))
                    position = next
                },
                cancel() {
                    ended = true
                },
                start(value) {
                    controller = value
                },
            },
            { highWaterMark: 0 },
        )
        return {
            body,
            async verify() {
                if (!ended || position !== end) throw new Error("Attachment bytes did not finish their requested range")
            },
            async finish() {},
            async stop() {
                if (!ended) {
                    ended = true
                    controller?.error(new Error("Attachment upload body closed"))
                }
            },
        }
    }

    open(offset: number, size: number): AttachmentTransferBody {
        if (this.#closed || offset < 0 || size < 0 || offset + size > this.size)
            throw new Error("Invalid attachment range")
        if (this.file.source.kind === "bytes") {
            return this.#bytesRange(this.file.source.data, offset, size)
        }
        if (this.file.source.kind === "file") {
            const slice = this.file.source.file.slice(offset, offset + size)
            if (!slice || typeof slice.stream !== "function") throw new Error("Invalid attachment file slice")
            return this.#rangeStream(slice.stream(), size)
        }
        return this.#streamRange(offset, size)
    }
}

function isAttachmentStreamReader(value: unknown): value is AttachmentStreamReader {
    if (typeof value !== "object" || value === null) return false
    return (
        "read" in value &&
        typeof value.read === "function" &&
        "cancel" in value &&
        typeof value.cancel === "function" &&
        "releaseLock" in value &&
        typeof value.releaseLock === "function"
    )
}
