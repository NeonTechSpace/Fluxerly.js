import { Effect, Exit, Scope } from "effect"
import { setImmediate as turn } from "node:timers/promises"
import { Session } from "node:inspector"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Result } from "neverthrow"
import { createClient, type MessageInput, type EditMessageInput, type ClientOptions } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"

afterEach(() => vi.unstubAllGlobals())
const modes = ["default", "native"] as const
const target = { id: "10", channelId: "20" }
const attachment = {
    id: "40",
    filename: "fixture.bin",
    size: 4,
    flags: 8,
    url: "https://example.com/file",
    proxy_url: "https://example.com/proxy",
}
const wire = (attachments: unknown = [attachment]) => ({
    id: "10",
    channel_id: "20",
    content: "",
    author: { id: "30", username: "fixture", bot: true },
    attachments,
})
async function driver(
    mode: (typeof modes)[number],
    options: Pick<ClientOptions, "uploads"> = {},
    cacheBytes = 1_000_000,
) {
    const scope = Scope.makeUnsafe()
    const config = { token: "fixture-only-not-a-credential", cache: { messages: { maxBytes: cacheBytes } }, ...options }
    const defaultApi = mode === "default" ? createClient(config)._unsafeUnwrap() : undefined
    const native =
        mode === "native" ? await Effect.runPromise(createNative(config).pipe(Scope.provide(scope))) : undefined
    const run = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) => {
        const result = await Effect.runPromise(Effect.result(effect), signal ? { signal } : undefined)
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const close = async () => {
        if (defaultApi) (await defaultApi.shutdown())._unsafeUnwrap()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
    onTestFinished(close)
    const unwrap = <A, E>(result: Result<A, E>): A => {
        if (result.isErr()) throw result.error
        return result.value
    }
    return {
        close,
        send: async (input: MessageInput, timeoutMs = 2000, signal?: AbortSignal) =>
            defaultApi
                ? unwrap(await defaultApi.messages.send("20", input, { timeoutMs, ...(signal ? { signal } : {}) }))
                : run(native!.messages.send("20", input, { timeoutMs }), signal),
        reply: async (input: MessageInput) =>
            defaultApi
                ? unwrap(await defaultApi.messages.reply(target, input))
                : run(native!.messages.reply(target, input)),
        edit: async (input: EditMessageInput) =>
            defaultApi
                ? unwrap(await defaultApi.messages.edit(target, input))
                : run(native!.messages.edit(target, input)),
        fetch: async () =>
            defaultApi ? unwrap(await defaultApi.messages.fetch(target)) : run(native!.messages.fetch(target)),
        history: async () =>
            defaultApi
                ? unwrap(await defaultApi.messages.fetchHistory("20"))
                : run(native!.messages.fetchHistory("20")),
        get: async () =>
            defaultApi ? defaultApi.messages.get(target)._unsafeUnwrap() : run(native!.messages.get(target)),
        native,
    }
}

async function readBytes(init: RequestInit) {
    return new Uint8Array(await new Response(init.body).arrayBuffer())
}

function transport(
    handlers: {
        put?: (init: RequestInit) => Promise<Response>
        message?: (json: any, init: RequestInit) => Promise<Response>
        plan?: (value: any) => unknown
        complete?: (value: any) => unknown
    } = {},
) {
    let sequence = 0
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers)
        expect(init.redirect).toBe("error")
        if (url.startsWith("https://uploads.fluxer.app/")) {
            expect(headers.has("authorization")).toBe(false)
            expect(init.method).toBe("PUT")
            if (handlers.put) return handlers.put(init)
            expect((await readBytes(init)).byteLength).toBe(Number(headers.get("content-length")))
            return new Response(null, { status: 200 })
        }
        expect(url.startsWith("https://api.fluxer.app/v1/")).toBe(true)
        expect(headers.get("authorization")).toBe("Bot fixture-only-not-a-credential")
        const json = JSON.parse(String(init.body))
        if (url.endsWith("/attachments")) {
            const value = {
                attachments: json.attachments.map((file: any) => {
                    const key = `fixture-${sequence++}`
                    const common = { ...file, content_type: "application/octet-stream", upload_filename: key }
                    return file.file_size <= 10_485_760
                        ? { ...common, upload_mode: "singlepart", upload_url: `https://uploads.fluxer.app/${key}` }
                        : {
                              ...common,
                              upload_mode: "multipart",
                              upload_id: key,
                              part_size: 10_485_760,
                              parts: Array.from({ length: Math.ceil(file.file_size / 10_485_760) }, (_, index) => ({
                                  part_number: index + 1,
                                  upload_url: `https://uploads.fluxer.app/${key}/${index}`,
                              })),
                          }
                }),
            }
            const response = handlers.plan ? handlers.plan(value) : value
            return response instanceof Response ? response : Response.json(response)
        }
        if (url.endsWith("/attachments/complete")) {
            const value = { uploads: json.uploads.map((item: any) => ({ upload_filename: item.upload_filename })) }
            const response = handlers.complete ? handlers.complete(value) : value
            return response instanceof Response ? response : Response.json(response)
        }
        expect(headers.get("content-type")).toBe("application/json")
        return handlers.message ? handlers.message(json, init) : Response.json(wire())
    })
    vi.stubGlobal("fetch", fetch)
    return fetch
}

test.each(modes)(
    "%s sends binary snapshots, every metadata field, replies and explicit replacement lists",
    async (mode) => {
        const calls: { json: any; files: { name: string; data: Uint8Array }[] }[] = []
        let uploaded: Uint8Array[] = []
        transport({
            put: async (init) => {
                uploaded.push(await readBytes(init))
                return new Response(null)
            },
            message: async (json) => {
                calls.push({
                    json,
                    files: uploaded.map((data, index) => ({
                        name: `files[${json.attachments.filter((item: any) => typeof item.id === "number")[index].id}]`,
                        data,
                    })),
                })
                uploaded = []
                return Response.json(wire(json.attachments?.length === 0 ? [] : [attachment]))
            },
        })
        const api = await driver(mode)
        const bytes = new Uint8Array([99, 0, 255, 13, 10, 99])
        const input = {
            data: bytes.subarray(1, 5),
            filename: 'fixture"ß.bin',
            contentType: "application/octet-stream",
            title: "Title",
            description: "Description",
            spoiler: true,
        }
        const pending = api.send({ attachments: [input] })
        bytes.fill(44)
        const sent = await pending
        expect(calls[0]!.files).toEqual([{ name: "files[0]", data: new Uint8Array([0, 255, 13, 10]) }])
        expect(calls[0]!.json.attachments).toEqual([
            {
                id: 0,
                filename: input.filename,
                content_type: input.contentType,
                title: "Title",
                description: "Description",
                flags: 8,
                file_size: 4,
                upload_filename: "fixture-0",
            },
        ])
        expect(calls[0]!.json.allowed_mentions.parse).toEqual([])
        expect(sent.attachments[0]?.proxyUrl).toBe(attachment.proxy_url)
        expect(Object.isFrozen(sent.attachments[0])).toBe(true)
        await api.reply({ attachments: [{ data: Buffer.from([1]), filename: "reply.bin" }] })
        expect(calls[1]!.json.message_reference.message_id).toBe(target.id)
        await api.edit({ attachments: [{ id: attachment.id }, { data: new Uint8Array([2]), filename: "new.bin" }] })
        expect(calls[2]!.json.attachments).toEqual([
            { id: attachment.id },
            {
                id: 1,
                filename: "new.bin",
                flags: 0,
                content_type: "application/octet-stream",
                file_size: 1,
                upload_filename: "fixture-2",
            },
        ])
        expect(calls[2]!.files[0]?.name).toBe("files[1]")
        await api.edit({ content: "Preserve" })
        expect(calls[3]!.json).not.toHaveProperty("attachments")
        await api.edit({ content: "Clear", attachments: [] })
        expect(calls[4]!.json.attachments).toEqual([])
        expect((await api.get())?.attachments).toEqual([])
        await expect(api.edit({ attachments: [] })).rejects.toBeDefined()
        expect(calls).toHaveLength(5)
    },
)

test.each(modes)("%s validates metadata and projects nullable fields across fetch/history/cache", async (mode) => {
    let payload: unknown = [
        {
            ...attachment,
            title: "Title",
            description: "Description",
            content_type: "image/png",
            content_hash: "hash",
            width: 10,
            height: 20,
            placeholder: "preview",
            nsfw: false,
            duration: 3,
            waveform: "AA==",
            expires_at: "2026-09-09T00:00:00Z",
            expired: false,
            ignored: "omit",
        },
    ]
    vi.stubGlobal("fetch", async (url: string) => Response.json(url.includes("?") ? [wire(payload)] : wire(payload)))
    const api = await driver(mode)
    const value = (await api.fetch()).attachments[0]!
    expect(value).toEqual({
        id: "40",
        filename: "fixture.bin",
        size: 4,
        flags: 8,
        url: attachment.url,
        proxyUrl: attachment.proxy_url,
        title: "Title",
        description: "Description",
        contentType: "image/png",
        contentHash: "hash",
        width: 10,
        height: 20,
        placeholder: "preview",
        nsfw: false,
        duration: 3,
        waveform: "AA==",
        expiresAt: "2026-09-09T00:00:00Z",
        expired: false,
    })
    expect((await api.history())[0]!.attachments[0]).toEqual(value)
    expect((await api.get())!.attachments[0]).toEqual(value)
    payload = [
        {
            id: "40",
            filename: "expired.bin",
            size: 0,
            flags: 0,
            url: null,
            proxy_url: null,
            title: null,
            expired: true,
        },
    ]
    expect((await api.fetch()).attachments).toEqual([
        { id: "40", filename: "expired.bin", size: 0, flags: 0, expired: true },
    ])
    for (const malformed of [
        [{ ...attachment, size: -1 }],
        [{ ...attachment, flags: null }],
        [{ ...attachment, url: 42 }],
        [{ ...attachment, expired: "yes" }],
        {},
    ]) {
        payload = malformed
        await expect(api.fetch()).rejects.toBeDefined()
    }
    payload = null
    expect((await api.fetch()).attachments).toEqual([])
})

test.each(modes)(
    "%s rejects invalid uploads locally and accepts an exact 50 MiB file in bounded chunks",
    async (mode) => {
        let parts = 0,
            fileBytes = 0
        const fetch = transport({
            put: async (init) => {
                const expected = Number(new Headers(init.headers).get("content-length"))
                let total = 0,
                    largest = 0
                for await (const chunk of init.body as ReadableStream<Uint8Array>) {
                    total += chunk.length
                    largest = Math.max(largest, chunk.length)
                }
                expect(total).toBe(expected)
                expect(largest).toBeLessThanOrEqual(65_536)
                expect(total).toBeLessThanOrEqual(10_485_760)
                parts++
                fileBytes += total
                return new Response(null)
            },
        })
        const api = await driver(mode)
        const valid = { data: new Uint8Array([1]), filename: "file.bin" }
        const detached = new Uint8Array(1)
        structuredClone(detached.buffer, { transfer: [detached.buffer] })
        for (const input of [
            { ...valid, data: "file" },
            { ...valid, data: new Uint8Array(new SharedArrayBuffer(1)) },
            { ...valid, data: detached },
            { ...valid, filename: "../file" },
            { ...valid, filename: "x\r\ny" },
            { ...valid, contentType: "text/plain\r\nx:y" },
            { ...valid, title: "" },
            { ...valid, description: null },
            { ...valid, spoiler: 1 },
            { ...valid, extra: true },
            { id: "40" },
            { ...valid, id: "40" },
        ])
            await expect(api.send({ attachments: [input] } as unknown as MessageInput)).rejects.toBeDefined()
        await expect(api.send({ attachments: [{ ...valid, data: new Uint8Array(52_428_801) }] })).rejects.toBeDefined()
        expect(fetch).not.toHaveBeenCalled()
        await api.send({ attachments: [{ ...valid, data: new Uint8Array(52_428_800) }] })
        expect(fetch).toHaveBeenCalledTimes(8)
        expect(parts).toBe(5)
        expect(fileBytes).toBe(52_428_800)
    },
)

test.each(modes)("%s holds upload admission through active work and cancellation cleanup", async (mode) => {
    let release!: () => void
    let began!: () => void
    const started = new Promise<void>((resolve) => (began = resolve))
    let aborted!: () => void
    const abortSeen = new Promise<void>((resolve) => (aborted = resolve))
    let calls = 0
    transport({
        put: async (init) => {
            calls++
            if (calls > 1) {
                await readBytes(init)
                return Response.json(wire())
            }
            await readBytes(init)
            began()
            await new Promise<void>((resolve) => {
                release = resolve
                init.signal!.addEventListener("abort", () => aborted(), { once: true })
            })
            throw Error("Fixture transport stopped")
        },
    })
    const api = await driver(mode, { uploads: { maxBytes: 4 } })
    const input = { attachments: [{ data: new Uint8Array(4), filename: "file.bin" }] }
    const controller = new AbortController()
    const pending = api.send(input, 2000, controller.signal).catch((error) => error)
    await started
    await expect(api.send(input)).rejects.toBeDefined()
    controller.abort()
    await abortSeen
    await expect(api.send(input)).rejects.toBeDefined()
    expect(calls).toBe(1)
    release()
    await pending
    await api.send(input)
    expect(calls).toBe(2)
})

test.each(modes)(
    "%s reserves queued uploads, replays only 429 with the snapshot and releases on timeout",
    async (mode) => {
        let calls = 0
        let first!: () => void
        const started = new Promise<void>((resolve) => (first = resolve))
        const contents: number[][] = []
        const nonces: string[] = []
        transport({
            put: async (init) => {
                contents.push([...(await readBytes(init))])
                return new Response(null)
            },
            message: async (json) => {
                nonces.push(json.nonce)
                calls++
                if (calls === 1) {
                    first()
                    return Response.json({ retry_after: 0.08, global: true }, { status: 429 })
                }
                return Response.json(wire())
            },
        })
        const api = await driver(mode, { uploads: { maxBytes: 8 } })
        const data = new Uint8Array([1, 2, 3, 4])
        const input = { attachments: [{ data, filename: "file.bin" }] }
        const pending = api.send(input)
        await started
        await turn()
        data.fill(9)
        const queued = api.send(input, 20).catch((error) => error)
        await expect(api.send(input)).rejects.toBeDefined()
        await queued
        await pending
        expect(contents).toEqual([[1, 2, 3, 4]])
        expect(nonces[0]).toBe(nonces[1])
        await api.send(input)
        expect(calls).toBe(3)
    },
)

test.each(modes)("%s rejects untrusted upload plans before disclosing file bytes", async (mode) => {
    const api = await driver(mode, { uploads: { maxBytes: 2 } })
    const input = {
        attachments: [
            { data: new Uint8Array([1]), filename: "first.bin" },
            { data: new Uint8Array([2]), filename: "second.bin" },
        ],
    }
    for (const change of [
        (value: any) => {
            value.attachments.pop()
        },
        (value: any) => {
            value.attachments[1].id = 0
        },
        (value: any) => {
            value.attachments[1].file_size = 2
        },
        (value: any) => {
            value.attachments[1].upload_filename = value.attachments[0].upload_filename
        },
        (value: any) => {
            value.attachments[1].content_type = "text/plain\r\nx:y"
        },
        ...[
            "http://uploads.fluxer.app/file",
            "https://uploads.fluxer.app.evil.invalid/file",
            "https://127.0.0.1/file",
            "https://user@uploads.fluxer.app/file",
            "https://uploads.fluxer.app/file#fragment",
        ].map((url) => (value: any) => {
            value.attachments[1].upload_url = url
        }),
    ]) {
        const fetch = transport({
            plan: (value) => {
                change(value)
                return value
            },
        })
        await expect(api.send(input)).rejects.toMatchObject({ reason: "response", delivery: "notSent" })
        expect(fetch).toHaveBeenCalledTimes(1)
    }
})

test.each(modes)("%s stops before message mutation when multipart completion is invalid", async (mode) => {
    const api = await driver(mode)
    const input = { attachments: [{ data: new Uint8Array(10_485_761), filename: "file.bin" }] }
    const fetch = transport({ complete: () => ({ uploads: [{ upload_filename: "wrong-key" }] }) })
    await expect(api.edit(input)).rejects.toMatchObject({ reason: "response", outcome: "notDispatched" })
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
        "/v1/channels/20/attachments",
        "/fixture-0/0",
        "/fixture-0/1",
        "/v1/channels/20/attachments/complete",
    ])
    transport()
    expect((await api.send(input)).id).toBe("10")
})

test.each(modes)("%s rejects malformed part ranges before uploading and bounds plan responses", async (mode) => {
    const api = await driver(mode)
    const input = { attachments: [{ data: new Uint8Array(10_485_761), filename: "file.bin" }] }
    for (const change of [
        (plan: any) => {
            plan.part_size = 0
        },
        (plan: any) => {
            plan.parts.pop()
        },
        (plan: any) => {
            plan.parts[1].part_number = 1
        },
        (plan: any) => {
            plan.parts[1].upload_url = plan.parts[0].upload_url
        },
        (plan: any) => {
            plan.upload_id = ""
        },
        (plan: any) => {
            plan.ignored = "x".repeat(1_048_576)
        },
    ]) {
        const fetch = transport({
            plan: (value) => {
                change(value.attachments[0])
                return value
            },
        })
        await expect(api.send(input)).rejects.toMatchObject({ reason: "response", delivery: "notSent" })
        expect(fetch).toHaveBeenCalledTimes(1)
    }
})

test.each(modes)("%s uses one deadline across upload stages and does not dispatch after PUT failure", async (mode) => {
    const api = await driver(mode, { uploads: { maxBytes: 1 } })
    const input = { attachments: [{ data: new Uint8Array([1]), filename: "file.bin" }] }
    let puts = 0,
        messages = 0
    transport({
        put: async (init) => {
            puts++
            await readBytes(init)
            await new Promise<void>((resolve) =>
                init.signal!.addEventListener("abort", () => resolve(), { once: true }),
            )
            throw Error("Fixture signed URL must not escape")
        },
        message: async () => {
            messages++
            return Response.json(wire())
        },
    })
    await expect(api.send(input, 30)).rejects.toMatchObject({ reason: "timeout", delivery: "notSent" })
    expect(puts).toBe(1)
    expect(messages).toBe(0)
    for (const status of [403, 429, 500]) {
        const fetch = transport({
            put: async (init) => {
                await readBytes(init)
                return new Response("Private fixture body", { status })
            },
        })
        const error = await api.send(input).catch((error) => error)
        expect(error.delivery).toBe("notSent")
        expect(error.status).toBe(status)
        expect(String(error)).not.toContain("Private fixture")
        expect(fetch).toHaveBeenCalledTimes(2)
    }
    transport()
    expect((await api.send(input)).id).toBe("10")
})

test.each(modes)("%s retries rejected preparation stages without repeating PUTs or losing file IDs", async (mode) => {
    const api = await driver(mode)
    let plans = 0,
        completions = 0,
        puts = 0
    const uploaded: number[] = []
    const retry = () => Response.json({ retry_after: 0.01 }, { status: 429 })
    transport({
        plan: (value) => (++plans === 1 ? retry() : value),
        complete: (value) => (++completions === 1 ? retry() : value),
        put: async (init) => {
            puts++
            let size = 0
            for await (const chunk of init.body as ReadableStream<Uint8Array>) size += chunk.length
            uploaded.push(size)
            return new Response(null)
        },
        message: async (json) => {
            expect(json.attachments.map((item: any) => item.id)).toEqual(["40", 1, 2, 3])
            expect(json.attachments.slice(1).map((item: any) => item.file_size)).toEqual([0, 10_485_761, 10_485_761])
            expect(json.attachments.slice(1).every((item: any) => typeof item.upload_filename === "string")).toBe(true)
            return Response.json(wire())
        },
    })
    await api.edit({
        attachments: [
            { id: "40" },
            { data: new Uint8Array(), filename: "empty.bin" },
            { data: new Uint8Array(10_485_761), filename: "first.bin" },
            { data: new Uint8Array(10_485_761), filename: "second.bin" },
        ],
    })
    expect(plans).toBe(2)
    expect(completions).toBe(2)
    expect(puts).toBe(5)
    expect(uploaded).toEqual([0, 10_485_760, 1, 10_485_760, 1])
})

test.each(modes)("%s rejects invalid upload configuration without allocating a client", async (mode) => {
    for (const uploads of [
        null,
        [],
        { maxBytes: 0 },
        { maxBytes: -1 },
        { maxBytes: 1.5 },
        { maxBytes: null },
        { maxBytes: Infinity },
        { extra: 1 },
    ]) {
        const options = { token: "fixture-only-not-a-credential", uploads } as unknown as Pick<
            ClientOptions,
            "token" | "uploads"
        >
        if (mode === "default") expect(createClient(options).isErr()).toBe(true)
        else expect((await Effect.runPromise(Effect.result(Effect.scoped(createNative(options)))))._tag).toBe("Failure")
    }
})
test("native Effects snapshot on each execution rather than construction", async () => {
    const api = await driver("native", { uploads: { maxBytes: 1 } })
    const observed: number[] = []
    transport({
        put: async (init) => {
            observed.push((await readBytes(init))[0]!)
            return Response.json(wire())
        },
    })
    const data = new Uint8Array([1])
    const send = api.native!.messages.send("20", { attachments: [{ data, filename: "file.bin" }] })
    data[0] = 2
    await Effect.runPromise(send)
    data[0] = 3
    await Effect.runPromise(send)
    expect(observed).toEqual([2, 3])
})

test.each(modes)("%s releases upload storage after network/rejection failures without replaying", async (mode) => {
    const api = await driver(mode, { uploads: { maxBytes: 1 } })
    let calls = 0
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    transport({
        put: async (init) => {
            calls++
            reader = (init.body as ReadableStream<Uint8Array>).getReader()
            await reader.read()
            if (calls === 1) throw Error("Fixture network failure")
            return Response.json({}, { status: 403 })
        },
    })
    const input = { attachments: [{ data: new Uint8Array([1]), filename: "private-fixture.bin" }] }
    for (let index = 0; index < 2; index++) {
        const error = await api.send(input).catch((error) => error)
        expect(error).toBeDefined()
        expect(String(error)).not.toContain("private-fixture")
        await expect(reader!.read()).rejects.toBeDefined()
        reader!.releaseLock()
    }
    expect(calls).toBe(2)
})

test.each(modes)("%s shutdown settles active and queued upload operations", async (mode) => {
    const api = await driver(mode, { uploads: { maxBytes: 5 } })
    let active = 0
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        active++
        await new Promise<void>((resolve) => init.signal!.addEventListener("abort", () => resolve(), { once: true }))
        active--
        throw Error("Fixture closed")
    })
    const input = { attachments: [{ data: new Uint8Array([1]), filename: "file.bin" }] }
    const pending = Array.from({ length: 5 }, () => api.send(input).catch((error) => error))
    await vi.waitFor(() => expect(active).toBe(4))
    await expect(api.send(input)).rejects.toBeDefined()
    await api.close()
    for (const failure of await Promise.all(pending)) expect(failure._tag).toBe("ClientClosedError")
    expect(active).toBe(0)
})

test.each(modes)("%s cache budgets measure attachment metadata rather than remote file bytes", async (mode) => {
    const projected = {
        id: "10",
        channelId: "20",
        content: "",
        embeds: [],
        attachments: [{ id: "40", filename: "file.bin", size: 52_428_800, flags: 0 }],
        stickers: [],
        author: { id: "30", username: "fixture", isBot: true },
    }
    const size = Buffer.byteLength(JSON.stringify(projected))
    vi.stubGlobal("fetch", async () => Response.json(wire(projected.attachments)))
    const exact = await driver(mode, {}, size)
    const small = await driver(mode, {}, size - 1)
    await exact.fetch()
    await small.fetch()
    expect(await exact.get()).toEqual(projected)
    expect(await small.get()).toBeUndefined()
})
test.each(modes)("%s releases owned file buffers while the caller input and client remain alive", async (mode) => {
    const api = await driver(mode)
    const input = { attachments: [{ data: new Uint8Array(128 * 1024), filename: "file.bin" }] }
    const weak: WeakRef<ArrayBufferLike>[] = []
    transport({
        put: async (init) => {
            for await (const chunk of init.body as ReadableStream<Uint8Array>) {
                if (chunk.byteLength === 65_536) weak.push(new WeakRef(chunk.buffer))
            }
            return Response.json(wire())
        },
    })
    await api.send(input)
    expect(weak).toHaveLength(2)
    // Mock call history owns request streams; real fetch does not keep this test-only history
    vi.mocked(fetch).mockClear()
    const session = new Session()
    session.connect()
    try {
        for (let attempt = 0; attempt < 10; attempt++) {
            await turn()
            await new Promise<void>((resolve, reject) =>
                session.post("HeapProfiler.collectGarbage", (error) => (error ? reject(error) : resolve())),
            )
            if (weak.every((reference) => reference.deref() === undefined)) break
        }
        expect(weak.map((reference) => reference.deref() === undefined)).toEqual([true, true])
        expect(input.attachments[0]!.data.byteLength).toBe(128 * 1024)
        expect((await api.get())?.id).toBe("10")
    } finally {
        session.disconnect()
    }
})
test.each(modes)("%s default upload budget admits two 50 MiB files without consuming JSON capacity", async (mode) => {
    const api = await driver(mode)
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    let active = 0
    transport({
        put: async (init) => {
            if (typeof init.body !== "string") {
                active++
                for await (const _chunk of init.body as ReadableStream<Uint8Array>) {
                    /* Drain the fixture upload */
                }
                await hold
                active--
            }
            return Response.json(wire())
        },
    })
    const input = { attachments: [{ data: new Uint8Array(52_428_800), filename: "file.bin" }] }
    const first = api.send(input)
    const second = api.send(input)
    try {
        await vi.waitFor(() => expect(active).toBe(2))
        await expect(api.send(input)).rejects.toMatchObject({ reason: "busy" })
        expect((await api.send({ content: "JSON still fits" })).id).toBe("10")
    } finally {
        release()
        await Promise.all([first, second])
    }
    expect(active).toBe(0)
})
