import { setImmediate as turn } from "node:timers/promises"
import { expect, test, vi } from "vitest"
import type { AttachmentFileSource, AttachmentStreamReader } from "../src/attachments.js"
import { AttachmentTransferSource } from "../src/internal/transfer-source.js"

function transfer(kind: "stream" | "file", reader: AttachmentStreamReader) {
    const getReader = vi.fn(() => reader)
    const stream = { getReader }
    const file: AttachmentFileSource = { size: 1, slice: () => file, stream: () => stream }
    const source = new AttachmentTransferSource({
        id: 0,
        filename: "fixture.bin",
        contentType: "application/octet-stream",
        size: 1,
        source: kind === "stream" ? { kind, stream } : { kind, file },
    })
    return { body: source.open(0, 1), getReader }
}

const paths = [
    ["stream", "read"],
    ["stream", "eof"],
    ["file", "read"],
    ["file", "eof"],
] as const

test.each(paths)("%s %s allows host timers before exhausting sustained empty chunks", async (kind, stage) => {
    let empties = 0
    let data = false
    let timerSaw: number | undefined
    const reader = {
        read: async () => {
            if (stage === "eof" && !data) {
                data = true
                return { value: new Uint8Array([42]) }
            }
            if (empties === 0)
                setTimeout(() => {
                    timerSaw = empties
                }, 0)
            if (empties++ < 100_000) return { value: new Uint8Array(0) }
            if (!data) {
                data = true
                return { value: new Uint8Array([42]) }
            }
            return { done: true as const }
        },
        cancel: vi.fn(async () => {}),
        releaseLock: vi.fn(),
    }
    const { body, getReader } = transfer(kind, reader)
    expect([...new Uint8Array(await new Response(body.body).arrayBuffer())]).toEqual([42])
    await body.verify()
    await body.finish()
    await body.stop()
    expect(timerSaw).toBeDefined()
    expect(timerSaw).toBeLessThan(100_000)
    expect(getReader).toHaveBeenCalledTimes(1)
    expect(reader.cancel).not.toHaveBeenCalled()
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
})

test.each(paths)("%s %s stops during an empty-chunk yield without reacquiring its reader", async (kind, stage) => {
    let reads = 0
    let stoppedAt = 0
    let stop: Promise<void> | undefined
    const reader = {
        read: vi.fn(async () => {
            reads++
            if (stage === "eof" && reads === 1) return { value: new Uint8Array([42]) }
            if (reads === (stage === "eof" ? 2 : 1)) {
                setImmediate(() => {
                    stoppedAt = reads
                    stop = body.stop()
                })
            }
            // Finite so a missing yield fails assertions rather than hanging the runner
            if (reads < 100_000) return { value: new Uint8Array(0) }
            return { done: true as const }
        }),
        cancel: vi.fn(async () => {}),
        releaseLock: vi.fn(),
    }
    const { body, getReader } = transfer(kind, reader)
    const consume = async () => {
        await new Response(body.body).arrayBuffer()
        await body.verify()
    }
    await expect(consume()).rejects.toThrow()
    await turn()
    await stop
    await body.stop()
    expect(stoppedAt).toBeGreaterThan(0)
    expect(stoppedAt).toBeLessThan(100_000)
    expect(reads).toBe(stoppedAt)
    expect(getReader).toHaveBeenCalledTimes(1)
    expect(reader.cancel).toHaveBeenCalledTimes(1)
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
})

test.each(["stream", "file"] as const)("%s ignores a late read after cancellation", async (kind) => {
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<{ value: Uint8Array }>()
    const reader = {
        read: vi.fn(() => {
            started.resolve()
            return pending.promise
        }),
        cancel: vi.fn(async () => {}),
        releaseLock: vi.fn(),
    }
    const { body, getReader } = transfer(kind, reader)
    const result = new Response(body.body).arrayBuffer().catch((error: unknown) => error)
    await started.promise
    await body.stop()
    pending.resolve({ value: new Uint8Array([42]) })
    expect(await result).toBeInstanceOf(Error)
    await turn()
    await body.stop()
    expect(reader.read).toHaveBeenCalledTimes(1)
    expect(getReader).toHaveBeenCalledTimes(1)
    expect(reader.cancel).toHaveBeenCalledTimes(1)
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
})
