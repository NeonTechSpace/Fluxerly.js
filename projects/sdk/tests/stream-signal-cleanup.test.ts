import { afterEach, expect, test, vi } from "vitest"
import { createClient, SdkDefect, type Attachment, type DefaultAttachmentStreamOptions } from "../src/index.js"

afterEach(() => vi.unstubAllGlobals())

const input: Attachment = {
    id: "40",
    filename: "fixture.bin",
    size: 2,
    flags: 0,
    url: "https://media.fluxer.app/attachments/20/40/fixture.bin",
}

test("stream input access stays lazy and rejects accessor defects without requests", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const client = createClient({ token: "fixture-only" })._unsafeUnwrap()
    let reads = 0
    const options = {
        maxBytes: 2,
        get signal(): AbortSignal {
            reads++
            throw new Error("private fixture")
        },
    }
    try {
        const stream = client.attachments.stream(input, options)
        let iterator: ReturnType<(typeof stream)[typeof Symbol.asyncIterator]> | undefined
        expect(() => {
            iterator = stream[Symbol.asyncIterator]()
        }).not.toThrow()
        expect(reads).toBe(0)
        await expect(iterator!.next()).rejects.toBeInstanceOf(SdkDefect)
        expect(fetch).not.toHaveBeenCalled()
    } finally {
        await client.shutdown()
    }
})

test("stream removes an attached listener even when registration throws", async () => {
    const client = createClient({ token: "fixture-only" })._unsafeUnwrap()
    const listeners = new Set<unknown>()
    const signal = {
        aborted: false,
        addEventListener: (_type: string, listener: unknown) => {
            listeners.add(listener)
            throw new Error("private registration")
        },
        removeEventListener: (_type: string, listener: unknown) => {
            listeners.delete(listener)
        },
    } as unknown as AbortSignal
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    try {
        const iterator = client.attachments.stream(input, { maxBytes: 2, signal })[Symbol.asyncIterator]()
        await expect(iterator.next()).rejects.toBeInstanceOf(SdkDefect)
        expect(listeners.size).toBe(0)
        expect(fetch).not.toHaveBeenCalled()
    } finally {
        await client.shutdown()
    }
})

test.each([false, true])(
    "stream return closes its body despite listener removal failure (body defect %s)",
    async (bodyDefect) => {
        const cancel = vi.fn(() => {
            if (bodyDefect) throw new Error("private body cleanup")
        })
        const response = new Response(
            new ReadableStream({
                start: (controller) => controller.enqueue(new Uint8Array([1])),
                cancel,
            }),
        )
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string | URL | Request) =>
                String(url).includes(".well-known")
                    ? Response.json({
                          api_code_version: 1,
                          endpoints: {
                              api_public: "https://api.fluxer.app",
                              gateway: "wss://gateway.fluxer.app",
                              media: "https://media.fluxer.app",
                              static_cdn: "https://cdn.fluxer.app",
                              webapp: "https://web.fluxer.app",
                              invite: "https://fluxer.app",
                          },
                          features: { presigned_attachment_uploads: true },
                      })
                    : response,
            ),
        )
        const nativeSignal = new AbortController().signal
        const remove = vi.fn(() => {
            throw new Error("private listener cleanup")
        })
        const signal = {
            aborted: false,
            addEventListener: nativeSignal.addEventListener.bind(nativeSignal),
            removeEventListener: remove,
        } as unknown as AbortSignal
        const client = createClient({ token: "fixture-only" })._unsafeUnwrap()
        try {
            const iterator = client.attachments
                .stream(input, { maxBytes: 2, signal } satisfies DefaultAttachmentStreamOptions)
                [Symbol.asyncIterator]()
            const chunk = await iterator.next()
            expect(chunk.done).toBe(false)
            expect(chunk.value?._unsafeUnwrap()).toEqual(new Uint8Array([1]))
            const failure = await iterator.return!().then(
                () => undefined,
                (error: unknown) => error,
            )
            expect(failure).toBeInstanceOf(SdkDefect)
            expect(String(failure)).not.toContain("private")
            expect(cancel).toHaveBeenCalledTimes(1)
            expect(response.body!.locked).toBe(false)
            expect(remove).toHaveBeenCalledTimes(1)
            if (bodyDefect)
                expect((failure as SdkDefect).reasons.filter((reason) => reason.kind === "Defect")).toHaveLength(2)
        } finally {
            await Promise.resolve(client.shutdown()).catch(() => undefined)
        }
    },
)
