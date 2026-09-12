import { Cause, Effect, Exit, Scope, Stream } from "effect"
import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { setImmediate as turn } from "node:timers/promises"
import { Session } from "node:inspector"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { openAsBlob } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Result } from "neverthrow"
import {
    createClient,
    type Attachment,
    type AttachmentFileSource,
    type ClientOptions,
    type EditMessageInput,
    type MessageInput,
    SdkDefect,
} from "../src/index.js"
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
    options: Pick<ClientOptions, "instance" | "uploads"> = {},
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
        download: async (input: Attachment, maxBytes = 1024, signal?: AbortSignal) =>
            defaultApi
                ? unwrap(
                      await defaultApi.attachments.download(input, {
                          maxBytes,
                          timeoutMs: 2000,
                          ...(signal ? { signal } : {}),
                      }),
                  )
                : run(native!.attachments.download(input, { maxBytes, timeoutMs: 2000 }), signal),
        downloadOptions: async (input: Attachment, options: { maxBytes: number; timeoutMs?: number }) =>
            defaultApi
                ? unwrap(await defaultApi.attachments.download(input, options))
                : run(native!.attachments.download(input, options)),
        stream: (input: Attachment, options: { maxBytes: number; timeoutMs?: number; signal?: AbortSignal }) =>
            defaultApi!.attachments.stream(input, options),
        native,
    }
}

async function readBytes(init: RequestInit) {
    return new Uint8Array(await new Response(init.body).arrayBuffer())
}

function instanceDocument(presignedAttachmentUploads: boolean) {
    return {
        api_code_version: 1,
        endpoints: {
            api_public: "https://api.fluxer.app",
            gateway: "wss://gateway.fluxer.app",
            media: "https://media.fluxer.app",
            static_cdn: "https://cdn.fluxer.app",
            webapp: "https://web.fluxer.app",
            invite: "https://fluxer.app",
        },
        features: { presigned_attachment_uploads: presignedAttachmentUploads },
    }
}

async function loopbackDownloadFixture(handleAttachment: (response: ServerResponse) => void) {
    let origin = ""
    const server = createServer((request, response) => {
        const target = new URL(request.url ?? "/", origin)
        if (target.pathname === "/.well-known/fluxer") {
            response.writeHead(200, { "content-type": "application/json" })
            response.end(
                JSON.stringify({
                    api_code_version: 1,
                    endpoints: {
                        api_public: origin,
                        gateway: origin.replace("http:", "ws:"),
                        media: origin,
                        static_cdn: origin,
                        webapp: origin,
                        invite: origin,
                    },
                    features: { presigned_attachment_uploads: true },
                }),
            )
            return
        }
        if (target.pathname.startsWith("/attachments/")) return void handleAttachment(response)
        response.statusCode = 404
        response.end()
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing loopback download fixture address")
    origin = `http://127.0.0.1:${address.port}`
    return {
        origin,
        async close() {
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

function chunks(values: readonly Uint8Array<ArrayBuffer>[], onCancel?: () => void) {
    let index = 0
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
            const value = values[index++]
            if (value) controller.enqueue(value)
            else controller.close()
        },
        ...(onCancel ? { cancel: onCancel } : {}),
    })
}

async function requestJson(init: RequestInit, headers: Headers): Promise<any> {
    if (!headers.get("content-type")?.startsWith("multipart/form-data;")) return JSON.parse(String(init.body))
    const text = new TextDecoder().decode(await readBytes(init))
    const payload = /name="payload_json"\r\nContent-Type: application\/json\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1]
    if (!payload) throw new Error("Missing multipart payload JSON")
    return JSON.parse(payload)
}

function transport(
    handlers: {
        put?: (init: RequestInit) => Promise<Response>
        message?: (json: any, init: RequestInit) => Promise<Response>
        plan?: (value: any) => unknown | Promise<unknown>
        complete?: (value: any) => unknown
        download?: (url: string, init: RequestInit) => Promise<Response>
        presignedAttachmentUploads?: boolean
        discovery?: () => Promise<Response>
    } = {},
) {
    let sequence = 0
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers)
        if (url === "https://fluxer.app/.well-known/fluxer") {
            expect(init.method).toBe("GET")
            expect(headers.has("authorization")).toBe(false)
            expect(init.redirect).toBe("manual")
            return handlers.discovery
                ? handlers.discovery()
                : Response.json(instanceDocument(handlers.presignedAttachmentUploads ?? true))
        }
        expect(init.redirect).toBe("error")
        if (url.startsWith("https://media.fluxer.app/attachments/")) {
            expect(headers.has("authorization")).toBe(false)
            expect(init.method).toBe("GET")
            if (!handlers.download) throw new Error("Missing download handler")
            return handlers.download(url, init)
        }
        if (url.startsWith("https://") && !url.startsWith("https://api.fluxer.app/")) {
            expect(headers.has("authorization")).toBe(false)
            expect(init.method).toBe("PUT")
            if (handlers.put) return handlers.put(init)
            expect((await readBytes(init)).byteLength).toBe(Number(headers.get("content-length")))
            return new Response(null, { status: 200 })
        }
        expect(url.startsWith("https://api.fluxer.app/v1/")).toBe(true)
        expect(headers.get("authorization")).toBe("Bot fixture-only-not-a-credential")
        const json = await requestJson(init, headers)
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
            const response = handlers.plan ? await handlers.plan(value) : value
            return response instanceof Response ||
                (typeof response === "object" && response !== null && "status" in response)
                ? (response as Response)
                : Response.json(response)
        }
        if (url.endsWith("/attachments/complete")) {
            const value = { uploads: json.uploads.map((item: any) => ({ upload_filename: item.upload_filename })) }
            const response = handlers.complete ? handlers.complete(value) : value
            return response instanceof Response ||
                (typeof response === "object" && response !== null && "status" in response)
                ? (response as Response)
                : Response.json(response)
        }
        if (!headers.get("content-type")?.startsWith("multipart/form-data;"))
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
        await api.edit({
            attachments: [
                { id: attachment.id, title: "Edited title", description: null },
                { data: new Uint8Array([2]), filename: "new.bin" },
            ],
        })
        expect(calls[2]!.json.attachments).toEqual([
            { id: attachment.id, title: "Edited title", description: null },
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

test.each(modes)(
    "%s changes retained attachment metadata without reading or accepting unrelated fields",
    async (mode) => {
        const calls: { json: any; method: string }[] = []
        const fetch = transport({
            message: async (json, init) => {
                calls.push({ json, method: init.method! })
                return Response.json(
                    wire([
                        {
                            ...attachment,
                            ...(json.attachments[0].title === undefined ? {} : { title: json.attachments[0].title }),
                            ...(json.attachments[0].description === undefined
                                ? {}
                                : { description: json.attachments[0].description }),
                        },
                    ]),
                )
            },
        })
        const api = await driver(mode)
        const updated = await api.edit({
            attachments: [{ id: attachment.id, title: "Edited title", description: null }],
        })
        const cleared = await api.edit({
            attachments: [{ id: attachment.id, title: null, description: "Edited description" }],
        })
        expect(calls).toEqual([
            {
                method: "PATCH",
                json: {
                    attachments: [{ id: attachment.id, title: "Edited title", description: null }],
                    allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
                },
            },
            {
                method: "PATCH",
                json: {
                    attachments: [{ id: attachment.id, title: null, description: "Edited description" }],
                    allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
                },
            },
        ])
        expect(updated.attachments[0]).toMatchObject({
            id: attachment.id,
            filename: attachment.filename,
            size: attachment.size,
            flags: attachment.flags,
            url: attachment.url,
            proxyUrl: attachment.proxy_url,
            title: "Edited title",
        })
        expect(updated.attachments[0]).not.toHaveProperty("description")
        expect(cleared.attachments[0]).toMatchObject({
            id: attachment.id,
            filename: attachment.filename,
            size: attachment.size,
            flags: attachment.flags,
            url: attachment.url,
            proxyUrl: attachment.proxy_url,
            description: "Edited description",
        })
        expect(cleared.attachments[0]).not.toHaveProperty("title")
        expect(Object.isFrozen(updated.attachments)).toBe(true)
        expect(Object.isFrozen(updated.attachments[0])).toBe(true)
        expect(Object.isFrozen(cleared.attachments[0])).toBe(true)
        const before = fetch.mock.calls.length
        for (const attachments of [
            [{ id: attachment.id, title: "" }],
            [{ id: attachment.id, description: "" }],
            [{ id: attachment.id, title: "x".repeat(1025) }],
            [{ id: attachment.id, description: "x".repeat(4097) }],
            [{ id: attachment.id, filename: "renamed.bin" }],
            [{ id: attachment.id, contentType: "image/png" }],
            [{ id: attachment.id, spoiler: false }],
            [{ id: attachment.id, flags: 0 }],
            [{ id: attachment.id, data: new Uint8Array([1]) }],
            [{ id: attachment.id }, { id: attachment.id, title: "Duplicate" }],
        ])
            await expect(api.edit({ attachments } as EditMessageInput)).rejects.toBeDefined()
        expect(fetch).toHaveBeenCalledTimes(before)
    },
)

test.each(modes)("%s links same-message image uploads through embed image and thumbnail only", async (mode) => {
    const messages: { json: any; method: string }[] = []
    const fetch = transport({
        message: async (json, init) => {
            messages.push({ json, method: init.method! })
            return Response.json({
                ...wire(json.attachments?.length === 0 ? [] : [attachment]),
                embeds: (json.embeds ?? []).map((embed: any) => ({
                    ...embed,
                    type: "rich",
                    ...(embed.image ? { image: { ...embed.image, flags: 0 } } : {}),
                    ...(embed.thumbnail ? { thumbnail: { ...embed.thumbnail, flags: 0 } } : {}),
                })),
            })
        },
    })
    const api = await driver(mode)
    const image = { data: new Uint8Array([137, 80, 78, 71]), filename: "image.PNG" }
    const sent = await api.send({
        content: "Image",
        attachments: [image],
        embeds: [
            {
                image: { url: "attachment://image.PNG", description: "Full image" },
                thumbnail: { url: "attachment://image.PNG", description: "Small image" },
            },
        ],
    })
    await api.reply({
        content: "Reply",
        attachments: [{ data: new Uint8Array([1]), filename: "reply.gif" }],
        embeds: [{ image: { url: "attachment://reply.gif" } }],
    })
    await api.edit({
        attachments: [{ id: attachment.id }, { data: new Uint8Array([1]), filename: "edit.webp" }],
        embeds: [{ thumbnail: { url: "attachment://edit.webp" } }],
    })
    expect(messages).toEqual([
        expect.objectContaining({
            method: "POST",
            json: expect.objectContaining({
                embeds: [
                    {
                        image: { url: "attachment://image.PNG", description: "Full image" },
                        thumbnail: { url: "attachment://image.PNG", description: "Small image" },
                    },
                ],
            }),
        }),
        expect.objectContaining({
            method: "POST",
            json: expect.objectContaining({
                message_reference: { message_id: target.id, channel_id: target.channelId, type: 0 },
                embeds: [{ image: { url: "attachment://reply.gif" } }],
            }),
        }),
        expect.objectContaining({
            method: "PATCH",
            json: expect.objectContaining({
                embeds: [{ thumbnail: { url: "attachment://edit.webp" } }],
            }),
        }),
    ])
    expect(sent.embeds[0]?.image?.url).toBe("attachment://image.PNG")
    expect(Object.isFrozen(sent.embeds)).toBe(true)
    expect(Object.isFrozen(sent.embeds[0])).toBe(true)
    const before = fetch.mock.calls.length
    const upload = (filename: string) => ({ data: new Uint8Array([1]), filename })
    for (const input of [
        { content: "Missing", embeds: [{ image: { url: "attachment://missing.png" } }] },
        {
            content: "Case",
            attachments: [upload("image.png")],
            embeds: [{ image: { url: "attachment://Image.png" } }],
        },
        {
            content: "Text",
            attachments: [upload("file.txt")],
            embeds: [{ image: { url: "attachment://file.txt" } }],
        },
        {
            content: "Duplicate",
            attachments: [upload("same.png"), upload("same.png")],
            embeds: [{ image: { url: "attachment://same.png" } }],
        },
        { content: "Top level", attachments: [upload("image.png")], embeds: [{ url: "attachment://image.png" }] },
        {
            content: "Author",
            attachments: [upload("image.png")],
            embeds: [{ author: { name: "Author", url: "attachment://image.png" } }],
        },
        {
            content: "Author icon",
            attachments: [upload("image.png")],
            embeds: [{ author: { name: "Author", iconUrl: "attachment://image.png" } }],
        },
        {
            content: "Footer",
            attachments: [upload("image.png")],
            embeds: [{ footer: { text: "Footer", iconUrl: "attachment://image.png" } }],
        },
    ])
        await expect(api.send(input as MessageInput)).rejects.toBeDefined()
    await expect(
        api.edit({ attachments: [{ id: attachment.id }], embeds: [{ image: { url: "attachment://retained.png" } }] }),
    ).rejects.toBeDefined()
    expect(fetch).toHaveBeenCalledTimes(before)
})

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
    vi.stubGlobal("fetch", async (url: string) =>
        Response.json(
            url === "https://fluxer.app/.well-known/fluxer"
                ? instanceDocument(true)
                : url.includes("?")
                  ? [wire(payload)]
                  : wire(payload),
        ),
    )
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
        expect(fetch).toHaveBeenCalledTimes(9)
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
        expect(
            fetch.mock.calls.filter(([url]) => new URL(url).pathname === "/v1/channels/20/attachments"),
        ).toHaveLength(1)
    }
})

test.each(modes)("%s stops before message mutation when multipart completion is invalid", async (mode) => {
    const api = await driver(mode)
    const input = { attachments: [{ data: new Uint8Array(10_485_761), filename: "file.bin" }] }
    const fetch = transport({ complete: () => ({ uploads: [{ upload_filename: "wrong-key" }] }) })
    await expect(api.edit(input)).rejects.toMatchObject({ reason: "response", outcome: "notDispatched" })
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
        "/.well-known/fluxer",
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
        expect(
            fetch.mock.calls.filter(([url]) => new URL(url).pathname === "/v1/channels/20/attachments"),
        ).toHaveLength(1)
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
                return Response.json(
                    { code: "MISSING_PERMISSIONS", message: "Private fixture body", retry_after: 0.5 },
                    { status },
                )
            },
        })
        const error = await api.send(input).catch((error) => error)
        expect(error.delivery).toBe("notSent")
        expect(error.status).toBe(status)
        expect(error.apiError).toBeNull()
        expect(error.message).not.toContain("MISSING_PERMISSIONS")
        expect(error.message).not.toContain("bot lacks a required permission")
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
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (url === "https://fluxer.app/.well-known/fluxer") return Response.json(instanceDocument(true))
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
    vi.stubGlobal("fetch", async (url: string) =>
        Response.json(
            url === "https://fluxer.app/.well-known/fluxer" ? instanceDocument(true) : wire(projected.attachments),
        ),
    )
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

test.each(modes)(
    "%s streams structural exact-size sources with source backpressure and reader release",
    async (mode) => {
        let reads = 0
        let released = false
        let cancelled = false
        const source = {
            getReader: () => ({
                read: async () => {
                    reads++
                    return reads === 1 ? { value: new Uint8Array(130_000).fill(7) } : { done: true as const }
                },
                cancel: async () => {
                    cancelled = true
                },
                releaseLock: () => {
                    released = true
                },
            }),
        }
        const chunks: number[] = []
        transport({
            put: async (init) => {
                for await (const chunk of init.body as ReadableStream<Uint8Array>) chunks.push(chunk.byteLength)
                return new Response(null, { status: 200 })
            },
        })
        const api = await driver(mode)
        await api.send({ attachments: [{ stream: source, size: 130_000, filename: "stream.bin" }] })
        expect(chunks).toEqual([65_536, 64_464])
        expect(reads).toBe(2)
        expect(released).toBe(true)
        expect(cancelled).toBe(false)
    },
)

test.each(modes)("%s preserves a raw stream across multipart upload ranges", async (mode) => {
    const boundary = 10_485_760
    const bytes = new Uint8Array(boundary + 1)
    bytes[0] = 7
    bytes[boundary - 1] = 8
    bytes[boundary] = 9
    let reads = 0
    let released = false
    const source = {
        getReader: () => ({
            read: async () => (reads++ === 0 ? { value: bytes } : { done: true as const }),
            cancel: async () => {},
            releaseLock: () => {
                released = true
            },
        }),
    }
    const parts: Uint8Array[] = []
    transport({
        put: async (init) => {
            parts.push(await readBytes(init))
            return new Response(null, { status: 200 })
        },
    })
    const api = await driver(mode)
    await api.send({ attachments: [{ stream: source, size: bytes.byteLength, filename: "multipart.bin" }] })
    expect(parts.map((part) => part.byteLength)).toEqual([boundary, 1])
    expect([parts[0]![0], parts[0]![boundary - 1], parts[1]![0]]).toEqual([7, 8, 9])
    expect(reads).toBe(2)
    expect(released).toBe(true)
})

test.each(modes)(
    "%s stops early EOF and overrun streams before message mutation and releases their readers",
    async (mode) => {
        for (const variant of ["eof", "overrun"] as const) {
            let cancelled = false
            let released = false
            let calls = 0
            const source = {
                getReader: () => ({
                    read: async () =>
                        variant === "eof"
                            ? { done: true as const }
                            : { done: false as const, value: new Uint8Array([1, 2]) },
                    cancel: async () => {
                        cancelled = true
                    },
                    releaseLock: () => {
                        released = true
                    },
                }),
            }
            transport({
                put: async (init) => {
                    calls++
                    await readBytes(init)
                    return new Response(null, { status: 200 })
                },
                message: async () => {
                    calls++
                    return Response.json(wire())
                },
            })
            const api = await driver(mode)
            if (mode === "default") {
                const error = await api
                    .send({ attachments: [{ stream: source, size: 1, filename: "stream.bin" }] })
                    .catch((error) => error)
                expect(error).toMatchObject({ _tag: "MessageError", reason: "network", delivery: "notSent" })
            } else {
                const exit = await Effect.runPromiseExit(
                    api.native!.messages.send("20", {
                        attachments: [{ stream: source, size: 1, filename: "stream.bin" }],
                    }),
                )
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isFailure(exit)) {
                    expect(Cause.hasDies(exit.cause)).toBe(false)
                    expect(exit.cause.reasons).toContainEqual(
                        expect.objectContaining({
                            _tag: "Fail",
                            error: expect.objectContaining({
                                _tag: "MessageError",
                                reason: "network",
                                delivery: "notSent",
                            }),
                        }),
                    )
                }
            }
            expect(calls).toBe(1)
            expect(cancelled).toBe(true)
            expect(released).toBe(true)
        }
    },
)

test.each(modes)("%s fails a stream upload when its acquired reader cannot release", async (mode) => {
    let messages = 0
    let reads = 0
    const source = {
        getReader: () => ({
            read: async () => (reads++ === 0 ? { value: new Uint8Array([1]) } : { done: true as const }),
            cancel: async () => {},
            releaseLock: () => {
                throw new Error("fixture release failure")
            },
        }),
    }
    transport({
        put: async (init) => {
            await readBytes(init)
            return new Response(null, { status: 200 })
        },
        message: async () => {
            messages++
            return Response.json(wire())
        },
    })
    const api = await driver(mode)
    if (mode === "default")
        await expect(
            api.send({ attachments: [{ stream: source, size: 1, filename: "release.bin" }] }),
        ).rejects.toMatchObject({ operation: "send", reasons: [{ kind: "Defect" }] })
    else {
        const exit = await Effect.runPromiseExit(
            api.native!.messages.send("20", { attachments: [{ stream: source, size: 1, filename: "release.bin" }] }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
    }
    expect(messages).toBe(0)
})

test.each(modes)(
    "%s keeps inline stream failures expected, cleanup failures defective and both retained",
    async (mode) => {
        for (const variant of ["eof", "eof-release", "release"] as const) {
            let cancelled = false
            let released = false
            let reads = 0
            const source = {
                getReader: () => ({
                    read: async () =>
                        variant === "eof" || variant === "eof-release"
                            ? { done: true as const }
                            : reads++ === 0
                              ? { value: new Uint8Array([1]) }
                              : { done: true as const },
                    cancel: async () => {
                        cancelled = true
                    },
                    releaseLock: () => {
                        released = true
                        if (variant === "eof-release" || variant === "release")
                            throw new Error("fixture inline release failure")
                    },
                }),
            }
            let messages = 0
            transport({
                presignedAttachmentUploads: false,
                message: async () => {
                    messages++
                    return Response.json(wire())
                },
            })
            const api = await driver(mode)
            const input = { attachments: [{ stream: source, size: 1, filename: "inline-reader.bin" }] }
            if (mode === "default") {
                const error = await api.send(input).catch((error) => error)
                if (variant === "eof") {
                    expect(error).toMatchObject({ _tag: "MessageError", reason: "network", delivery: "unknown" })
                } else {
                    expect(error).toMatchObject({ operation: "send" })
                    expect((error as SdkDefect).reasons.map((reason) => reason.kind)).toEqual(
                        variant === "eof-release" ? ["Failure", "Defect"] : ["Defect"],
                    )
                }
            } else {
                const exit = await Effect.runPromiseExit(api.native!.messages.send("20", input))
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isFailure(exit)) {
                    expect(Cause.hasDies(exit.cause)).toBe(variant !== "eof")
                    if (variant === "eof" || variant === "eof-release")
                        expect(exit.cause.reasons).toContainEqual(
                            expect.objectContaining({
                                _tag: "Fail",
                                error: expect.objectContaining({
                                    _tag: "MessageError",
                                    reason: "network",
                                    delivery: "unknown",
                                }),
                            }),
                        )
                }
            }
            expect(messages).toBe(0)
            expect(cancelled).toBe(variant !== "release")
            expect(released).toBe(true)
        }
    },
)

test.each(modes)("%s retains a bounded upload response failure with reader cleanup defects", async (mode) => {
    for (const stage of ["plan", "complete"] as const) {
        let cancelled = false
        let released = false
        const cleanupResponse = () =>
            ({
                status: 200,
                ok: true,
                headers: new Headers(),
                bodyUsed: false,
                body: {
                    getReader: () => ({
                        read: async () => ({ done: false as const, value: new Uint8Array(1_048_577) }),
                        cancel: async () => {
                            cancelled = true
                            throw new Error("fixture upload reader cancel failure")
                        },
                        releaseLock: () => {
                            released = true
                            throw new Error("fixture upload reader release failure")
                        },
                    }),
                },
            }) as unknown as Response
        let messages = 0
        transport({
            ...(stage === "plan" ? { plan: cleanupResponse } : { complete: cleanupResponse }),
            message: async () => {
                messages++
                return Response.json(wire())
            },
        })
        const api = await driver(mode)
        const input = {
            attachments: [{ data: new Uint8Array(stage === "complete" ? 10_485_761 : 1), filename: "reader.bin" }],
        }
        if (mode === "default") {
            const error = await api.send(input).catch((error) => error)
            expect(error).toBeInstanceOf(SdkDefect)
            expect((error as SdkDefect).operation).toBe("send")
            expect((error as SdkDefect).reasons.map((reason) => reason.kind)).toEqual(["Failure", "Defect"])
            expect((error as SdkDefect).reasons[0]).toMatchObject({
                failure: { _tag: "MessageError", reason: "response", delivery: "notSent" },
            })
        } else {
            const exit = await Effect.runPromiseExit(api.native!.messages.send("20", input))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                expect(Cause.hasDies(exit.cause)).toBe(true)
                expect(exit.cause.reasons).toContainEqual(
                    expect.objectContaining({
                        _tag: "Fail",
                        error: expect.objectContaining({
                            _tag: "MessageError",
                            reason: "response",
                            delivery: "notSent",
                        }),
                    }),
                )
            }
        }
        expect(messages).toBe(0)
        expect(cancelled).toBe(true)
        expect(released).toBe(true)
    }
})

test.each(modes)("%s leaves no owned REST work when opening a file source throws", async (mode) => {
    const file: AttachmentFileSource = {
        size: 1,
        slice() {
            throw new Error("fixture file slice failure")
        },
        stream() {
            throw new Error("fixture file stream failure")
        },
    }
    let puts = 0
    transport({
        put: async () => {
            puts++
            return new Response(null, { status: 200 })
        },
    })
    const api = await driver(mode)
    await expect(api.send({ attachments: [{ file, filename: "broken.bin" }] })).rejects.toBeDefined()
    expect(puts).toBe(0)
    await expect(api.close()).resolves.toBeUndefined()
})

test.each(modes)("%s stops and releases short and excess file slices without creating a message", async (mode) => {
    for (const variant of ["short", "excess"] as const) {
        let cancelled = false
        let released = false
        let reads = 0
        const stream = {
            getReader: () => ({
                read: async () =>
                    variant === "short"
                        ? { done: true as const }
                        : reads++ === 0
                          ? { value: new Uint8Array([1, 2]) }
                          : { done: true as const },
                cancel: async () => {
                    cancelled = true
                },
                releaseLock: () => {
                    released = true
                },
            }),
        }
        const file: AttachmentFileSource = {
            size: 1,
            slice: () => ({ stream: () => stream }) as AttachmentFileSource,
            stream: () => stream,
        }
        let puts = 0
        let messages = 0
        transport({
            put: async (init) => {
                puts++
                await readBytes(init)
                return new Response(null, { status: 200 })
            },
            message: async () => {
                messages++
                return Response.json(wire())
            },
        })
        const api = await driver(mode)
        const input = { attachments: [{ file, filename: `${variant}.bin` }] }
        if (mode === "default") {
            const error = await api.send(input).catch((error) => error)
            expect(error).toMatchObject({ _tag: "MessageError", reason: "network", delivery: "notSent" })
        } else {
            const exit = await Effect.runPromiseExit(api.native!.messages.send("20", input))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                expect(Cause.hasDies(exit.cause)).toBe(false)
                expect(exit.cause.reasons).toContainEqual(
                    expect.objectContaining({
                        _tag: "Fail",
                        error: expect.objectContaining({
                            _tag: "MessageError",
                            reason: "network",
                            delivery: "notSent",
                        }),
                    }),
                )
            }
        }
        expect(puts).toBe(1)
        expect(messages).toBe(0)
        expect(cancelled).toBe(true)
        expect(released).toBe(true)
    }
})

test.each(modes)("%s reports Node openAsBlob file mutation without dispatching a message", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "fluxerly-attachment-source-"))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, "source.bin")
    await writeFile(path, new Uint8Array([1, 2, 3]))
    const file = await openAsBlob(path)
    let messages = 0
    transport({
        plan: async (value) => {
            await appendFile(path, new Uint8Array([4]))
            return value
        },
        message: async () => {
            messages++
            return Response.json(wire())
        },
    })
    const api = await driver(mode)
    if (mode === "default") {
        const error = await api.send({ attachments: [{ file, filename: "source.bin" }] }).catch((error) => error)
        expect(error).toBeInstanceOf(SdkDefect)
        expect((error as SdkDefect).operation).toBe("send")
        expect((error as SdkDefect).reasons.map((reason) => reason.kind)).toEqual(["Failure", "Defect"])
    } else {
        const exit = await Effect.runPromiseExit(
            api.native!.messages.send("20", { attachments: [{ file, filename: "source.bin" }] }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            expect(Cause.hasFails(exit.cause)).toBe(true)
            expect(Cause.hasDies(exit.cause)).toBe(true)
        }
    }
    expect(messages).toBe(0)
})

test.each(modes)("%s accepts direct HTTPS plan destinations without bot credentials", async (mode) => {
    let uploaded: Uint8Array | undefined
    transport({
        plan: (value) => {
            value.attachments[0].upload_url = "https://storage.example.test/signed-upload?capability=fixture"
            return value
        },
        put: async (init) => {
            uploaded = await readBytes(init)
            return new Response(null, { status: 200 })
        },
    })
    const api = await driver(mode)
    await api.send({ attachments: [{ data: new Uint8Array([9, 8]), filename: "direct.bin" }] })
    expect(uploaded).toEqual(new Uint8Array([9, 8]))
})

test.each(modes)("%s streams inline multipart when discovery disables preuploads", async (mode) => {
    let messages = 0
    transport({
        presignedAttachmentUploads: false,
        message: async (json, init) => {
            messages++
            expect(new Headers(init.headers).get("content-type")).toMatch(/^multipart\/form-data;/)
            expect(json.attachments).toEqual([
                { id: 0, filename: "inline.bin", content_type: "application/octet-stream", flags: 0 },
            ])
            return Response.json(wire())
        },
    })
    const api = await driver(mode)
    await api.send({ attachments: [{ data: new Uint8Array([1, 2, 3]), filename: "inline.bin" }] })
    expect(messages).toBe(1)
})

test.each(modes)("%s falls back once to inline multipart for the exact temporary-preupload rejection", async (mode) => {
    let messages = 0
    transport({
        plan: () => Response.json({ code: "FEATURE_TEMPORARILY_DISABLED" }, { status: 403 }),
        message: async (_json, init) => {
            messages++
            expect(new Headers(init.headers).get("content-type")).toMatch(/^multipart\/form-data;/)
            return Response.json(wire())
        },
    })
    const api = await driver(mode)
    await api.send({ attachments: [{ data: new Uint8Array([1]), filename: "temporary.bin" }] })
    expect(messages).toBe(1)
})

test.each(modes)("%s does not reread a finite stream after an inline multipart rate limit", async (mode) => {
    let calls = 0
    let reads = 0
    const source = {
        getReader: () => ({
            read: async () => (reads++ === 0 ? { value: new Uint8Array([1]) } : { done: true as const }),
            cancel: async () => {},
            releaseLock: () => {},
        }),
    }
    transport({
        presignedAttachmentUploads: false,
        message: async () => {
            calls++
            return Response.json({ retry_after: 0.001 }, { status: 429 })
        },
    })
    const api = await driver(mode)
    await expect(
        api.send({ attachments: [{ stream: source, size: 1, filename: "one-use.bin" }] }),
    ).rejects.toMatchObject({ reason: "rateLimit" })
    expect(calls).toBe(1)
    expect(reads).toBe(2)
})

test.each(modes)("%s recreates copied inline bytes when a 429 arrives before multipart consumption", async (mode) => {
    let attempts = 0
    const observed: Uint8Array[] = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "https://fluxer.app/.well-known/fluxer") return Response.json(instanceDocument(false))
        expect(url).toBe("https://api.fluxer.app/v1/channels/20/messages")
        expect(new Headers(init.headers).get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
        if (++attempts === 1) return Response.json({ retry_after: 0.001 }, { status: 429 })
        const headers = new Headers(init.headers)
        const body = await new Response(init.body).arrayBuffer()
        const form = await new Response(body, { headers }).formData()
        observed.push(new Uint8Array(await (form.get("files[0]") as File).arrayBuffer()))
        return Response.json(wire())
    })
    vi.stubGlobal("fetch", fetch)
    const api = await driver(mode)
    const bytes = new Uint8Array([1, 2, 3])
    const pending = api.send({ attachments: [{ data: bytes, filename: "early-429.bin" }] })
    bytes.fill(9)
    await pending
    expect(attempts).toBe(2)
    expect(observed).toEqual([new Uint8Array([1, 2, 3])])
})

test.each(modes)("%s retains reviewed detail for a non-fallback preupload rejection", async (mode) => {
    let messages = 0
    transport({
        plan: () => Response.json({ code: "MISSING_PERMISSIONS", message: "private provider detail" }, { status: 403 }),
        message: async () => {
            messages++
            return Response.json(wire())
        },
    })
    const api = await driver(mode)
    await expect(
        api.send({ attachments: [{ data: new Uint8Array([1]), filename: "rejected.bin" }] }),
    ).rejects.toMatchObject({
        apiError: { providerCode: "MISSING_PERMISSIONS" },
        message: expect.stringContaining("The provider reports that the bot lacks a required permission"),
    })
    expect(messages).toBe(0)
})

test.each(modes)("%s bounds trusted attachment downloads without proxy fallback or authorization", async (mode) => {
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 3,
        flags: 0,
        url: "https://media.fluxer.app/attachments/20/40/fixture.bin?capability=fixture",
        proxyUrl: "https://untrusted.example.test/proxy",
    }
    transport({
        download: async () => new Response(new Uint8Array([4, 5, 6]), { status: 200 }),
    })
    const api = await driver(mode)
    await expect(api.download(input, 3)).resolves.toEqual(new Uint8Array([4, 5, 6]))
    await expect(api.download(input, 2)).rejects.toMatchObject({ _tag: "AttachmentDownloadError", reason: "tooLarge" })
    const { url: _url, ...withoutUrl } = input
    await expect(api.download(withoutUrl, 3)).rejects.toMatchObject({
        _tag: "AttachmentDownloadError",
        reason: "untrustedUrl",
    })
})

test.each(modes)("%s streams attachment chunks lazily, one time, and releases an early consumer", async (mode) => {
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 99,
        flags: 0,
        url: "https://media.fluxer.app/attachments/20/40/fixture.bin?capability=fixture",
    }
    let fetches = 0
    let cancelled = 0
    transport({
        download: async () => {
            fetches++
            return new Response(
                chunks([new Uint8Array([4, 5]), new Uint8Array([6])], () => cancelled++),
                { status: 200 },
            )
        },
    })
    const api = await driver(mode)
    if (mode === "default") {
        const stream = api.stream(input, { maxBytes: 3 })
        expect(fetches).toBe(0)
        const iterator = stream[Symbol.asyncIterator]()
        const first = await iterator.next()
        expect(first).toMatchObject({ done: false, value: { value: new Uint8Array([4, 5]) } })
        expect(fetches).toBe(1)
        await iterator.return?.()
        await vi.waitFor(() => expect(cancelled).toBe(1))
        const repeated = stream[Symbol.asyncIterator]()
        await expect(repeated.next()).resolves.toMatchObject({ value: { error: { reason: "busy" } } })
    } else {
        const stream = api.native!.attachments.stream(input, { maxBytes: 3 })
        expect(fetches).toBe(0)
        const first = await Effect.runPromise(Stream.runHead(stream))
        expect(first).toMatchObject({ _tag: "Some", value: new Uint8Array([4, 5]) })
        await vi.waitFor(() => expect(cancelled).toBe(1))
        const repeated = await Effect.runPromise(Effect.flip(Stream.runHead(stream)))
        expect(repeated).toMatchObject({ reason: "busy" })
    }
})

test.each(modes)(
    "%s rejects streamed header and runtime byte overages without reading beyond its limit",
    async (mode) => {
        const input: Attachment = {
            id: "40",
            filename: "fixture.bin",
            size: 0,
            flags: 0,
            url: "https://media.fluxer.app/attachments/20/40/fixture.bin?capability=fixture",
        }
        let call = 0
        transport({
            download: async () => {
                call++
                return call === 1
                    ? new Response(chunks([new Uint8Array([1])]), { headers: { "content-length": "3" } })
                    : new Response(chunks([new Uint8Array([1]), new Uint8Array([2])]))
            },
        })
        const api = await driver(mode)
        if (mode === "default") {
            const header = await api.stream(input, { maxBytes: 2 })[Symbol.asyncIterator]().next()
            expect(header).toMatchObject({ value: { error: { reason: "tooLarge" } } })
            const iterator = api.stream(input, { maxBytes: 1 })[Symbol.asyncIterator]()
            expect(await iterator.next()).toMatchObject({ value: { value: new Uint8Array([1]) } })
            expect(await iterator.next()).toMatchObject({ value: { error: { reason: "tooLarge" } } })
        } else {
            const header = await Effect.runPromise(
                Effect.flip(Stream.runDrain(api.native!.attachments.stream(input, { maxBytes: 2 }))),
            )
            expect(header).toMatchObject({ reason: "tooLarge" })
            const runtime = await Effect.runPromise(
                Effect.flip(Stream.runDrain(api.native!.attachments.stream(input, { maxBytes: 1 }))),
            )
            expect(runtime).toMatchObject({ reason: "tooLarge" })
        }
    },
)

test.each(modes)("%s releases an idle attachment stream during client shutdown", async (mode) => {
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 0,
        flags: 0,
        url: "https://media.fluxer.app/attachments/20/40/fixture.bin?capability=fixture",
    }
    let cancelled = 0
    transport({
        download: async () => new Response(chunks([new Uint8Array([1]), new Uint8Array([2])], () => cancelled++)),
    })
    const api = await driver(mode)
    let consumption: Promise<unknown> | undefined
    const pause = Promise.withResolvers<void>()
    const delivered = Promise.withResolvers<void>()
    if (mode === "default") {
        const iterator = api.stream(input, { maxBytes: 2 })[Symbol.asyncIterator]()
        await iterator.next()
    } else {
        consumption = Effect.runPromise(
            Effect.result(
                Stream.runForEach(api.native!.attachments.stream(input, { maxBytes: 2 }), () =>
                    Effect.promise(() => {
                        delivered.resolve()
                        return pause.promise
                    }),
                ),
            ),
        )
        await delivered.promise
    }
    await api.close()
    pause.resolve()
    if (consumption) expect(await consumption).toMatchObject({ failure: { _tag: "ClientClosedError" } })
    expect(cancelled).toBe(1)
})

test.each(modes)("%s rejects untrusted streamed media before a credential-free GET", async (mode) => {
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 1,
        flags: 0,
        url: "https://other.test/attachments/20/40",
    }
    const fetch = transport()
    const api = await driver(mode)
    if (mode === "default") {
        const result = await api.stream(input, { maxBytes: 1 })[Symbol.asyncIterator]().next()
        expect(result).toMatchObject({ value: { error: { reason: "untrustedUrl" } } })
    } else {
        const result = await Effect.runPromise(
            Effect.flip(Stream.runDrain(api.native!.attachments.stream(input, { maxBytes: 1 }))),
        )
        expect(result).toMatchObject({ reason: "untrustedUrl" })
    }
    expect(fetch.mock.calls).toHaveLength(1)
})

test.each(modes)("%s cancels a pending streamed read and admits a later stream", async (mode) => {
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 1,
        flags: 0,
        url: "https://media.fluxer.app/attachments/20/40/fixture.bin",
    }
    let release: (() => void) | undefined
    let starts = 0
    transport({
        download: async () => {
            starts++
            if (starts > 1) return new Response(new Uint8Array([9]))
            return new Response(new ReadableStream({ pull: () => new Promise<void>((resolve) => (release = resolve)) }))
        },
    })
    const api = await driver(mode)
    const controller = new AbortController()
    if (mode === "default") {
        const iterator = api.stream(input, { maxBytes: 1, signal: controller.signal })[Symbol.asyncIterator]()
        const pending = iterator.next()
        await vi.waitFor(() => expect(release).toBeTypeOf("function"))
        controller.abort()
        await expect(pending).resolves.toMatchObject({ value: { error: { _tag: "CancelledError" } } })
        const later = await api.stream(input, { maxBytes: 1 })[Symbol.asyncIterator]().next()
        expect(later).toMatchObject({ value: { value: new Uint8Array([9]) } })
    } else {
        const pending = Effect.runPromiseExit(Stream.runDrain(api.native!.attachments.stream(input, { maxBytes: 1 })), {
            signal: controller.signal,
        })
        await vi.waitFor(() => expect(release).toBeTypeOf("function"))
        controller.abort()
        const exit = await pending
        expect(Exit.isFailure(exit)).toBe(true)
        const later = await Effect.runPromise(Stream.runHead(api.native!.attachments.stream(input, { maxBytes: 1 })))
        expect(later).toMatchObject({ value: new Uint8Array([9]) })
    }
    release?.()
})

test("default validates malformed streamed signals and leaves never-started streams inert", async () => {
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 1,
        flags: 0,
        url: "https://media.fluxer.app/attachments/20/40/fixture.bin",
    }
    const fetch = transport({ download: async () => new Response(new Uint8Array([1])) })
    const api = await driver("default")
    const malformed = api.stream(input, { maxBytes: 1, signal: {} as AbortSignal })[Symbol.asyncIterator]()
    await expect(malformed.next()).resolves.toMatchObject({ value: { error: { reason: "input" } } })
    const controller = new AbortController()
    controller.abort()
    const aborted = api.stream(input, { maxBytes: 1, signal: controller.signal })[Symbol.asyncIterator]()
    await expect(aborted.next()).resolves.toMatchObject({ value: { error: { _tag: "CancelledError" } } })
    expect(fetch.mock.calls).toHaveLength(0)
})

test.each(modes)("%s composes a bounded streamed download into one finite upload", async (mode) => {
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 0,
        flags: 0,
        url: "https://media.fluxer.app/attachments/20/40/fixture.bin?capability=fixture",
    }
    const uploaded: Uint8Array[] = []
    transport({
        download: async () => new Response(chunks([new Uint8Array([7]), new Uint8Array([8])])),
        put: async (init) => {
            uploaded.push(await readBytes(init))
            return new Response(null, { status: 200 })
        },
    })
    const api = await driver(mode)
    if (mode === "default") {
        const iterator = api.stream(input, { maxBytes: 2 })[Symbol.asyncIterator]()
        const reader = {
            async read() {
                const next = await iterator.next()
                if (next.done) return { done: true as const }
                if (next.value.isErr()) throw next.value.error
                return { done: false as const, value: next.value.value }
            },
            async cancel() {
                await iterator.return?.()
            },
            releaseLock() {},
        }
        await api.send({ attachments: [{ stream: { getReader: () => reader }, size: 2, filename: "copied.bin" }] })
    } else {
        const readable = Stream.toReadableStream(api.native!.attachments.stream(input, { maxBytes: 2 }))
        await api.send({ attachments: [{ stream: readable, size: 2, filename: "copied.bin" }] })
    }
    expect(uploaded).toEqual([new Uint8Array([7, 8])])
})

const streamInput: Attachment = {
    id: "40",
    filename: "fixture.bin",
    size: 1,
    flags: 0,
    url: "https://media.fluxer.app/attachments/20/40/fixture.bin",
}

test.each(modes)("%s cancels streaming GET acquisition and awaits a late response body", async (mode) => {
    const entered = Promise.withResolvers<AbortSignal>()
    const response = Promise.withResolvers<Response>()
    let cancelled = false
    transport({
        download: async (_url, init) => {
            entered.resolve(init.signal as AbortSignal)
            return response.promise
        },
    })
    const api = await driver(mode)
    const controller = new AbortController()
    let settled = false
    const pending =
        mode === "default"
            ? api.stream(streamInput, { maxBytes: 1, signal: controller.signal })[Symbol.asyncIterator]().next()
            : Effect.runPromiseExit(Stream.runDrain(api.native!.attachments.stream(streamInput, { maxBytes: 1 })), {
                  signal: controller.signal,
              })
    void pending.then(() => {
        settled = true
    })
    const signal = await entered.promise
    controller.abort()
    try {
        await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 500 })
        expect(settled).toBe(false)
    } finally {
        response.resolve(
            new Response(
                new ReadableStream({
                    cancel: () => {
                        cancelled = true
                    },
                }),
            ),
        )
    }
    const result = await pending
    expect(cancelled).toBe(true)
    if (mode === "default") expect(result).toMatchObject({ value: { error: { _tag: "CancelledError" } } })
    else
        expect(
            Exit.isFailure(result as Exit.Exit<unknown, unknown>) &&
                Cause.hasInterruptsOnly((result as Exit.Failure<unknown, unknown>).cause),
        ).toBe(true)
})

test.each(modes)(
    "%s streaming cancellation during discovery releases the bootstrap before completion",
    async (mode) => {
        const entered = Promise.withResolvers<void>()
        const response = Promise.withResolvers<Response>()
        let cancelled = false
        const fetch = transport({
            discovery: async () => {
                entered.resolve()
                return response.promise
            },
        })
        const api = await driver(mode)
        const controller = new AbortController()
        const pending =
            mode === "default"
                ? api.stream(streamInput, { maxBytes: 1, signal: controller.signal })[Symbol.asyncIterator]().next()
                : Effect.runPromiseExit(Stream.runDrain(api.native!.attachments.stream(streamInput, { maxBytes: 1 })), {
                      signal: controller.signal,
                  })
        await entered.promise
        controller.abort()
        response.resolve(
            new Response(
                new ReadableStream({
                    cancel: () => {
                        cancelled = true
                    },
                }),
            ),
        )
        await pending
        expect(cancelled).toBe(true)
        expect(fetch).toHaveBeenCalledTimes(1)
    },
)

test.each(
    modes.flatMap(
        (mode) =>
            [
                [mode, "idle"],
                [mode, "reading"],
            ] as const,
    ),
)("%s streamed deadline closes an %s consumer without another pull", async (mode, phase) => {
    const cancelled = Promise.withResolvers<void>()
    const pause = Promise.withResolvers<void>()
    transport({
        download: async () =>
            new Response(
                new ReadableStream({
                    start: (controller) => {
                        if (phase === "idle") controller.enqueue(new Uint8Array([1]))
                    },
                    cancel: () => {
                        cancelled.resolve()
                    },
                }),
            ),
    })
    const api = await driver(mode)
    let pending: Promise<unknown>
    if (mode === "default") {
        const iterator = api.stream(streamInput, { maxBytes: 2, timeoutMs: 100 })[Symbol.asyncIterator]()
        if (phase === "idle") await iterator.next()
        pending = phase === "idle" ? cancelled.promise.then(() => iterator.next()) : iterator.next()
    } else {
        const stream = api.native!.attachments.stream(streamInput, { maxBytes: 2, timeoutMs: 100 })
        pending = Effect.runPromise(
            Effect.result(
                Stream.runForEach(stream, () => (phase === "idle" ? Effect.promise(() => pause.promise) : Effect.void)),
            ),
        )
    }
    try {
        await cancelled.promise
    } finally {
        pause.resolve()
    }
    const result = await pending
    expect(result).toMatchObject(
        mode === "default" ? { value: { error: { reason: "timeout" } } } : { failure: { reason: "timeout" } },
    )
})

test("default return interrupts a pending pull and never-started streams own no signal listener", async () => {
    const entered = Promise.withResolvers<void>()
    let cancelled = 0
    transport({
        download: async () =>
            new Response(
                new ReadableStream({
                    pull: () => {
                        entered.resolve()
                    },
                    cancel: () => {
                        cancelled++
                    },
                }),
            ),
    })
    const api = await driver("default")
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, "addEventListener")
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    const iterator = api.stream(streamInput, { maxBytes: 1, signal: controller.signal })[Symbol.asyncIterator]()
    expect(add).not.toHaveBeenCalled()
    const unused = api.stream(streamInput, { maxBytes: 1, signal: controller.signal })[Symbol.asyncIterator]()
    await unused.return?.()
    expect(add).not.toHaveBeenCalled()
    const pending = iterator.next()
    await entered.promise
    await iterator.return?.()
    await pending
    expect(cancelled).toBe(1)
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length)
})

test.each(modes)("%s preserves sanitized streamed response cleanup defects", async (mode) => {
    const marker = "private-reader-secret"
    transport({
        download: async () =>
            new Response(
                new ReadableStream({
                    cancel: () => {
                        throw new Error(marker)
                    },
                }),
                { status: 403 },
            ),
    })
    const api = await driver(mode)
    if (mode === "default") {
        const rejected = api.stream(streamInput, { maxBytes: 1 })[Symbol.asyncIterator]().next()
        await expect(rejected).rejects.toBeInstanceOf(SdkDefect)
        await rejected.catch((error) => expect(String(error)).not.toContain(marker))
    } else {
        const exit = await Effect.runPromiseExit(
            Stream.runDrain(api.native!.attachments.stream(streamInput, { maxBytes: 1 })),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            expect(Cause.hasDies(exit.cause)).toBe(true)
            expect(exit.cause.reasons).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ _tag: "Fail", error: expect.objectContaining({ reason: "response" }) }),
                ]),
            )
            expect(Cause.pretty(exit.cause)).not.toContain(marker)
        }
    }
})

test("default shutdown retains an abandoned idle stream's neutral cleanup defect", async () => {
    const cancelled = Promise.withResolvers<void>()
    transport({
        download: async () =>
            new Response(
                new ReadableStream({
                    start: (controller) => controller.enqueue(new Uint8Array([1])),
                    cancel: () => {
                        cancelled.resolve()
                        throw new Error("private abandoned cleanup")
                    },
                }),
            ),
    })
    const client = createClient({ token: "fixture-only-not-a-credential" })._unsafeUnwrap()
    const controller = new AbortController()
    const iterator = client.attachments
        .stream(streamInput, { maxBytes: 2, signal: controller.signal })
        [Symbol.asyncIterator]()
    try {
        await iterator.next()
        controller.abort()
        await cancelled.promise
        await expect(client.shutdown()).rejects.toBeInstanceOf(SdkDefect)
    } finally {
        await Promise.resolve(client.shutdown()).catch(() => undefined)
    }
})

test("default overlapping streaming pulls do not read twice or cancel the first pull", async () => {
    const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>>()
    let cancellations = 0
    transport({
        download: async () =>
            new Response(
                new ReadableStream<Uint8Array<ArrayBuffer>>({
                    start: (controller) => ready.resolve(controller),
                    cancel: () => {
                        cancellations++
                    },
                }),
            ),
    })
    const api = await driver("default")
    const iterator = api.stream(streamInput, { maxBytes: 2 })[Symbol.asyncIterator]()
    const first = iterator.next()
    const controller = await ready.promise
    await expect(iterator.next()).resolves.toMatchObject({ value: { error: { reason: "busy" } } })
    expect(cancellations).toBe(0)
    controller.enqueue(new Uint8Array([1]))
    await expect(first).resolves.toMatchObject({ value: { value: new Uint8Array([1]) } })
    controller.close()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
})

test("observing one streamed cleanup defect does not discard another abandoned source's failure", async () => {
    transport({
        download: async () =>
            new Response(
                new ReadableStream({
                    start: (controller) => controller.enqueue(new Uint8Array([1])),
                    cancel: () => {
                        throw new Error("private cleanup")
                    },
                }),
            ),
    })
    const client = createClient({ token: "fixture-only-not-a-credential" })._unsafeUnwrap()
    const controllers = [new AbortController(), new AbortController()]
    const iterators = controllers.map((controller) =>
        client.attachments.stream(streamInput, { maxBytes: 2, signal: controller.signal })[Symbol.asyncIterator](),
    )
    try {
        await Promise.all(iterators.map((iterator) => iterator.next()))
        controllers.forEach((controller) => controller.abort())
        await turn()
        await expect(iterators[0]!.next()).rejects.toBeInstanceOf(SdkDefect)
        await expect(client.shutdown()).rejects.toBeInstanceOf(SdkDefect)
    } finally {
        await Promise.resolve(client.shutdown()).catch(() => undefined)
    }
})

test("default idle streaming shutdown removes the caller signal listener", async () => {
    transport({
        download: async () =>
            new Response(new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array([1])) })),
    })
    const api = await driver("default")
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, "addEventListener")
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    await api.stream(streamInput, { maxBytes: 2, signal: controller.signal })[Symbol.asyncIterator]().next()
    await api.close()
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
})

test("native streaming interruption retains a neutral reader cleanup defect", async () => {
    const reading = Promise.withResolvers<void>()
    const cancelEntered = Promise.withResolvers<void>()
    const releaseCancel = Promise.withResolvers<void>()
    const marker = "private stream interruption secret"
    transport({
        download: async () =>
            new Response(
                new ReadableStream({
                    pull: () => {
                        reading.resolve()
                    },
                    cancel: async () => {
                        cancelEntered.resolve()
                        await releaseCancel.promise
                        throw new Error(marker)
                    },
                }),
            ),
    })
    const api = await driver("native")
    const controller = new AbortController()
    let finished = false
    const pending = Effect.runPromiseExit(
        Stream.runDrain(api.native!.attachments.stream(streamInput, { maxBytes: 1 })),
        { signal: controller.signal },
    )
    void pending.then(() => {
        finished = true
    })
    await reading.promise
    controller.abort()
    await cancelEntered.promise
    expect(finished).toBe(false)
    releaseCancel.resolve()
    const exit = await pending
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(Cause.pretty(exit.cause)).not.toContain(marker)
    }
})

test.each(modes)(
    "%s early streaming exit releases a real HTTP response without treating its own abort as a defect",
    async (mode) => {
        let closed = false
        const fixture = await loopbackDownloadFixture((response) => {
            response.writeHead(200)
            response.write("chunk")
            response.once("close", () => {
                closed = true
            })
        })
        const api = await driver(mode, { instance: { url: fixture.origin, allowInsecure: true } })
        const input = { ...streamInput, url: `${fixture.origin}/attachments/20/40/fixture.bin` }
        try {
            if (mode === "default") {
                const iterator = api.stream(input, { maxBytes: 10 })[Symbol.asyncIterator]()
                await iterator.next()
                await iterator.return?.()
            } else await Effect.runPromise(Stream.runHead(api.native!.attachments.stream(input, { maxBytes: 10 })))
            await vi.waitFor(() => expect(closed).toBe(true))
        } finally {
            await api.close()
            await fixture.close()
        }
    },
)

test.each(modes)("%s keeps a real declared-size download rejection expected after body cleanup", async (mode) => {
    let closed = false
    const fixture = await loopbackDownloadFixture((response) => {
        response.writeHead(200, { "content-length": "8" })
        response.flushHeaders()
        response.write("body")
        response.once("close", () => {
            closed = true
        })
    })
    const api = await driver(mode, { instance: { url: fixture.origin, allowInsecure: true } })
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 8,
        flags: 0,
        url: `${fixture.origin}/attachments/20/40/fixture.bin?capability=fixture`,
    }
    try {
        if (mode === "default") {
            await expect(api.download(input, 3)).rejects.toMatchObject({
                _tag: "AttachmentDownloadError",
                reason: "tooLarge",
            })
        } else {
            const exit = await Effect.runPromiseExit(api.native!.attachments.download(input, { maxBytes: 3 }))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                expect(failure).toMatchObject({ _tag: "Fail" })
                if (failure?._tag === "Fail")
                    expect(failure.error).toMatchObject({ _tag: "AttachmentDownloadError", reason: "tooLarge" })
                expect(Cause.hasDies(exit.cause)).toBe(false)
            }
        }
        await vi.waitFor(() => expect(closed).toBe(true))
    } finally {
        await api.close()
        await fixture.close()
    }
})

test.each(modes)("%s keeps real response-reader cancellation free of cleanup defects", async (mode) => {
    let sent!: () => void
    const sentFirstBodyBytes = new Promise<void>((resolve) => {
        sent = resolve
    })
    let closed = false
    const fixture = await loopbackDownloadFixture((response) => {
        response.writeHead(200, { "content-length": "8" })
        response.flushHeaders()
        response.write("body", sent)
        response.once("close", () => {
            closed = true
        })
    })
    const api = await driver(mode, { instance: { url: fixture.origin, allowInsecure: true } })
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 8,
        flags: 0,
        url: `${fixture.origin}/attachments/20/40/fixture.bin?capability=fixture`,
    }
    const controller = new AbortController()
    try {
        if (mode === "default") {
            const pending = api.download(input, 8, controller.signal)
            await sentFirstBodyBytes
            await turn()
            controller.abort()
            await expect(pending).rejects.toMatchObject({ _tag: "CancelledError" })
        } else {
            const pending = Effect.runPromiseExit(
                api.native!.attachments.download(input, { maxBytes: 8, timeoutMs: 2000 }),
                { signal: controller.signal },
            )
            await sentFirstBodyBytes
            await turn()
            controller.abort()
            const exit = await pending
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                expect(Cause.hasInterrupts(exit.cause)).toBe(true)
                expect(Cause.hasDies(exit.cause)).toBe(false)
            }
        }
        await vi.waitFor(() => expect(closed).toBe(true))
    } finally {
        await api.close()
        await fixture.close()
    }
})

test.each(modes)("%s preserves a foreign download-body cancellation defect", async (mode) => {
    const foreign = new DOMException("fixture foreign abort", "AbortError")
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 3,
        flags: 0,
        url: "https://media.fluxer.app/attachments/20/40/fixture.bin?capability=fixture",
    }
    transport({
        download: async () =>
            ({
                status: 200,
                ok: true,
                headers: new Headers({ "content-length": "3" }),
                bodyUsed: false,
                body: { cancel: () => Promise.reject(foreign) },
            }) as unknown as Response,
    })
    const api = await driver(mode)
    if (mode === "default") {
        const thrown: unknown = await api.download(input, 2).catch((error) => error)
        expect(thrown).toBeInstanceOf(SdkDefect)
        if (!(thrown instanceof SdkDefect)) throw new Error("Expected foreign download cleanup defect")
        const error = thrown
        expect(error).toMatchObject({ operation: "attachments.download" })
        const failure = error.reasons.find((reason) => reason.kind === "Failure")
        expect(failure).toMatchObject({ kind: "Failure" })
        if (failure?.kind === "Failure")
            expect(failure.failure).toMatchObject({ _tag: "AttachmentDownloadError", reason: "tooLarge" })
        expect(error.reasons.some((reason) => reason.kind === "Defect")).toBe(true)
    } else {
        const exit = await Effect.runPromiseExit(api.native!.attachments.download(input, { maxBytes: 2 }))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
            expect(defect).toMatchObject({ _tag: "Die" })
            if (defect?._tag === "Die") {
                expect(defect.defect).toBeInstanceOf(AggregateError)
                expect((defect.defect as AggregateError).errors).toContain(foreign)
            }
        }
    }
})

test.each(modes)("%s snapshots attachment download URL and output budget before discovery", async (mode) => {
    const original = "https://media.fluxer.app/attachments/20/40/original.bin?capability=fixture"
    const input = {
        id: "40",
        filename: "fixture.bin",
        size: 3,
        flags: 0,
        url: original,
    }
    const options = { maxBytes: 2, timeoutMs: 2000 }
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    let requested = ""
    transport({
        discovery: async () => {
            await held
            return Response.json(instanceDocument(true))
        },
        download: async (url) => {
            requested = url
            return new Response(new Uint8Array([4, 5, 6]), { status: 200 })
        },
    })
    const api = await driver(mode)
    const pending = api.downloadOptions(input, options)
    await turn()
    input.url = "https://media.fluxer.app/attachments/20/40/mutated.bin?capability=fixture"
    options.maxBytes = Infinity
    release()
    await expect(pending).rejects.toMatchObject({ _tag: "AttachmentDownloadError", reason: "tooLarge" })
    expect(requested).toBe(original)
})

test.each(modes)(
    "%s queues bounded downloads with media-only concurrency and releases a cancelled waiter",
    async (mode) => {
        const input: Attachment = {
            id: "40",
            filename: "fixture.bin",
            size: 3,
            flags: 0,
            url: "https://media.fluxer.app/attachments/20/40/fixture.bin?capability=fixture",
        }
        let release!: () => void
        const held = new Promise<void>((resolve) => (release = resolve))
        let active = 0
        let starts = 0
        transport({
            download: async () => {
                starts++
                active++
                await held
                active--
                return new Response(new Uint8Array([4, 5, 6]), { status: 200 })
            },
        })
        const api = await driver(mode)
        const downloads = Array.from({ length: 4 }, () => api.download(input, 3))
        try {
            await vi.waitFor(() => expect(active).toBe(4))
            const controller = new AbortController()
            const queued = api.download(input, 3, controller.signal)
            await turn()
            expect(starts).toBe(4)
            controller.abort()
            await expect(queued).rejects.toBeDefined()
            expect(starts).toBe(4)
        } finally {
            release()
            await Promise.all(downloads)
        }
        expect(active).toBe(0)
        await expect(api.download(input, 3)).resolves.toEqual(new Uint8Array([4, 5, 6]))
    },
)

test.each(modes)(
    "%s admits held discovery through the local request limit and removes cancelled waiters",
    async (mode) => {
        let release!: () => void
        const held = new Promise<void>((resolve) => (release = resolve))
        let discoveryCalls = 0
        let messages = 0
        transport({
            discovery: async () => {
                discoveryCalls++
                await held
                return Response.json(instanceDocument(true))
            },
            message: async () => {
                messages++
                return Response.json(wire())
            },
        })
        const api = await driver(mode)
        const admitted = Array.from({ length: 4 }, () => api.send({ content: "held discovery" }))
        try {
            await vi.waitFor(() => expect(discoveryCalls).toBe(1))
            const controller = new AbortController()
            const queued = api.send({ content: "cancelled discovery waiter" }, 2000, controller.signal)
            await turn()
            expect(messages).toBe(0)
            controller.abort()
            await expect(queued).rejects.toBeDefined()
            expect(messages).toBe(0)
        } finally {
            release()
            await Promise.all(admitted)
        }
        expect(messages).toBe(4)
    },
)

test.each(modes)("%s waits for a late cancelled download response before releasing its media slot", async (mode) => {
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 3,
        flags: 0,
        url: "https://media.fluxer.app/attachments/20/40/fixture.bin?capability=fixture",
    }
    let starts = 0
    let resolveFirst!: (response: Response) => void
    const resolveOther: ((response: Response) => void)[] = []
    let firstCancelled = false
    let firstResolved = false
    let draining = false
    transport({
        download: async () => {
            starts++
            if (draining) return new Response(new Uint8Array([4, 5, 6]), { status: 200 })
            return new Promise<Response>((resolve) => {
                if (starts === 1) resolveFirst = resolve
                else resolveOther.push(resolve)
            })
        },
    })
    const api = await driver(mode)
    const controller = new AbortController()
    const first = api.download(input, 3, controller.signal)
    const other = Array.from({ length: 3 }, () => api.download(input, 3))
    let queued: Promise<Uint8Array> | undefined
    try {
        await vi.waitFor(() => expect(starts).toBe(4))
        controller.abort()
        queued = api.download(input, 3)
        await turn()
        expect(starts).toBe(4)
        firstResolved = true
        resolveFirst(
            new Response(
                new ReadableStream<Uint8Array>({
                    cancel() {
                        firstCancelled = true
                    },
                }),
            ),
        )
        await expect(first).rejects.toBeDefined()
        await vi.waitFor(() => expect(starts).toBe(5))
        expect(firstCancelled).toBe(true)
    } finally {
        draining = true
        if (!firstResolved && resolveFirst) resolveFirst(new Response(new Uint8Array([4, 5, 6]), { status: 200 }))
        for (const resolve of resolveOther) resolve(new Response(new Uint8Array([4, 5, 6]), { status: 200 }))
        await Promise.allSettled([...other, first, ...(queued ? [queued] : [])])
    }
})

test.each(modes)("%s cancels and releases a reader after data before admitting the next download", async (mode) => {
    const input: Attachment = {
        id: "40",
        filename: "fixture.bin",
        size: 3,
        flags: 0,
        url: "https://media.fluxer.app/attachments/20/40/fixture.bin?capability=fixture",
    }
    let started = 0
    let yielded!: () => void
    const yieldedData = new Promise<void>((resolve) => (yielded = resolve))
    let resolveRead!: (value: ReadableStreamReadResult<Uint8Array>) => void
    let cancelled = false
    let released = false
    let reads = 0
    const held: ((response: Response) => void)[] = []
    transport({
        download: async () => {
            started++
            if (started === 1)
                return {
                    status: 200,
                    ok: true,
                    headers: new Headers(),
                    bodyUsed: false,
                    body: {
                        getReader: () => ({
                            read: async () => {
                                if (reads++ === 0) {
                                    yielded()
                                    return { done: false as const, value: new Uint8Array([4, 5, 6]) }
                                }
                                return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
                                    resolveRead = resolve
                                })
                            },
                            cancel: async () => {
                                cancelled = true
                                resolveRead({ done: true, value: undefined })
                            },
                            releaseLock: () => {
                                released = true
                            },
                        }),
                    },
                } as unknown as Response
            if (started === 5) return new Response(new Uint8Array([4, 5, 6]), { status: 200 })
            return new Promise<Response>((resolve) => held.push(resolve))
        },
    })
    const api = await driver(mode)
    const controller = new AbortController()
    const first = api.download(input, 3, controller.signal)
    const others = Array.from({ length: 3 }, () => api.download(input, 3))
    let queued: Promise<Uint8Array> | undefined
    try {
        await yieldedData
        await vi.waitFor(() => expect(started).toBe(4))
        queued = api.download(input, 3)
        await turn()
        expect(started).toBe(4)
        controller.abort()
        await expect(first).rejects.toBeDefined()
        await vi.waitFor(() => expect(started).toBe(5))
        expect(cancelled).toBe(true)
        expect(released).toBe(true)
        await expect(queued).resolves.toEqual(new Uint8Array([4, 5, 6]))
    } finally {
        for (const resolve of held) resolve(new Response(new Uint8Array([4, 5, 6]), { status: 200 }))
        await Promise.allSettled([first, ...others, ...(queued ? [queued] : [])])
    }
})
