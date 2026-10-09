import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished } from "vitest"
import {
    type MessageInput,
    type MessageReference,
    type EditMessageInput,
    type CollectorOptions,
    type Message,
    type CollectorResult,
    type EmbedInput,
} from "../../../src/index.js"
import { createClient as createNative } from "../../../src/effect.js"
import { defaultApi, fixtureToken, type Mode } from "../../support/both-apis.js"
import { startGatewayServer } from "../../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { settle } from "../../support/settle.js"

/*
 * Message content fixture shared by the embed and sticker tests. A test file that uses it must redirect gateway sockets
 * with vi.mock("ws", ...) and ws-redirect, because startGatewayServer points redirected sockets at its loopback server
 */
const author = { id: "30", username: "fixture", bot: true }
const target = { id: "10", channelId: "20" }
export const wire = (embeds: unknown = []) => ({ id: "10", channel_id: "20", content: "original", author, embeds })
export const input: EmbedInput = {
    title: "Title",
    description: "Description",
    url: "https://example.com/build",
    color: 0x3d66b8,
    timestamp: "2026-09-08T14:30:00.000Z",
    author: { name: "Author", url: "https://example.com/author", iconUrl: "https://example.com/author.png" },
    footer: { text: "Footer", iconUrl: "https://example.com/footer.png" },
    image: { url: "https://example.com/image.png", description: "Image" },
    thumbnail: { url: "https://example.com/thumb.png", description: "Thumbnail" },
    fields: [
        { name: "Status", value: "Passed", inline: true },
        { name: "Details", value: "" },
    ],
}
export const inputWire = {
    ...input,
    author: { name: "Author", url: "https://example.com/author", icon_url: "https://example.com/author.png" },
    footer: { text: "Footer", icon_url: "https://example.com/footer.png" },
}
export const media = {
    url: "https://example.com/media",
    proxy_url: "https://example.com/proxy",
    content_type: "video/mp4",
    content_hash: "fixture-hash",
    width: 640,
    height: 480,
    description: "Media",
    placeholder: "fixture-base64",
    duration: 12,
    flags: 8,
}
export const responseEmbed = {
    ...inputWire,
    type: "future-preview",
    fields: input.fields!.map((field) => ({ ...field, inline: field.inline ?? false })),
    author: { ...inputWire.author, proxy_icon_url: "https://example.com/proxy-author" },
    footer: { ...inputWire.footer, proxy_icon_url: "https://example.com/proxy-footer" },
    image: media,
    thumbnail: media,
    video: media,
    audio: media,
    provider: { name: "Provider", url: "https://example.com" },
    html: "<div>Fixture</div>",
    html_width: 640,
    html_height: 480,
    nsfw: false,
    children: [{ type: "image", image: media }],
    ignored: "not projected",
}

/** A message REST and gateway fixture whose writes are echoed as MESSAGE_CREATE or MESSAGE_UPDATE dispatches */
export async function fixture() {
    let message: Record<string, any> = wire([responseEmbed])
    const requests: { url: string; method: string; body: any }[] = []
    const gateway = await startGatewayServer({ sessionId: "fixture" })
    const deliver = (event: string) => gateway.dispatch(event, message)
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        if (url.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.fluxer.app" })
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        requests.push({ url, method: init.method!, body })
        if (init.method === "POST" || init.method === "PATCH") {
            if (init.method === "PATCH" && body.embeds?.length === 0 && !body.content)
                return Response.json({}, { status: 400 })
            const base = init.method === "POST" ? wire([]) : message
            message = {
                ...base,
                ...(body.sticker_ids === undefined
                    ? {}
                    : { stickers: body.sticker_ids.map((id: string) => ({ id, name: "Fixture", animated: false })) }),
                ...(body.content === undefined ? {} : { content: body.content }),
                ...(body.embeds === undefined
                    ? {}
                    : {
                          embeds: body.embeds.map((embed: any) => ({
                              ...embed,
                              type: "rich",
                              ...(embed.fields
                                  ? {
                                        fields: embed.fields.map((field: any) => ({
                                            ...field,
                                            inline: field.inline ?? false,
                                        })),
                                    }
                                  : {}),
                              ...(embed.image ? { image: { ...embed.image, flags: 0 } } : {}),
                              ...(embed.thumbnail ? { thumbnail: { ...embed.thumbnail, flags: 0 } } : {}),
                          })),
                      }),
            }
            if (init.method === "POST" && body.content === undefined) message.content = ""
            deliver(init.method === "POST" ? "MESSAGE_CREATE" : "MESSAGE_UPDATE")
        }
        return Response.json(url.includes("?") ? [message] : message)
    })
    return {
        requests,
        set: (value: Record<string, any>) => {
            message = value
        },
        deliver,
    }
}

/** Message operations for one API style, returning snapshots or throwing the typed failure */
export async function driver(mode: Mode, maxBytes = 1_000_000) {
    const options = {
        gateway: { onMalformedDispatch: "terminate" as const },
        cache: { messages: { maxBytes } },
    }
    const regular = mode === "default" ? defaultApi(options) : undefined
    // The native client shares this test-owned Scope with the driver's subscriptions and collectors
    const scope = Scope.makeUnsafe()
    const native =
        mode === "native"
            ? await Effect.runPromise(createNative({ token: fixtureToken, ...options }).pipe(Scope.provide(scope)))
            : undefined
    onTestFinished(async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        send: (input: MessageInput): Promise<Message> =>
            regular ? settle(regular.messages.send("20", input)) : settle(native!.messages.send("20", input)),
        reply: (input: MessageInput): Promise<Message> =>
            regular ? settle(regular.messages.reply(target, input)) : settle(native!.messages.reply(target, input)),
        edit: (input: EditMessageInput): Promise<Message> =>
            regular ? settle(regular.messages.edit(target, input)) : settle(native!.messages.edit(target, input)),
        fetch: (): Promise<Message> =>
            regular ? settle(regular.messages.fetch(target)) : settle(native!.messages.fetch(target)),
        history: (): Promise<readonly Message[]> =>
            regular ? settle(regular.messages.fetchHistory("20")) : settle(native!.messages.fetchHistory("20")),
        get: (ref: MessageReference = target) =>
            regular ? settle(regular.messages.get(ref)) : settle(native!.messages.get(ref)),
        connect: () => (regular ? settle(regular.connect()) : settle(native!.connect())),
        closed: async () => {
            if (regular) {
                const result = await regular.waitForClose()
                return result.isErr() ? result.error : undefined
            }
            return settle(native!.waitForClose().pipe(Effect.flip))
        },
        updates: async (receive: (message: Message) => void) => {
            if (regular) await settle(regular.on("messageUpdate", receive))
            else
                await Effect.runPromise(
                    native!
                        .on("messageUpdate", (message) => Effect.sync(() => receive(message)))
                        .pipe(Scope.provide(scope)),
                )
        },
        collect: async (options?: CollectorOptions) => {
            if (regular) {
                const collector = await settle(regular.messages.collect("20", options))
                return (): Promise<CollectorResult> => settle(collector.result())
            }
            const collector = await Effect.runPromise(
                native!.messages.collect("20", options).pipe(Scope.provide(scope)),
            )
            return () => settle(collector.result())
        },
    }
}

/** Expect a local input rejection that dispatched nothing */
export function rejectsInput(operation: Promise<unknown>) {
    return expect(operation).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
}

/** Expect a malformed-response rejection */
export function rejectsResponse(operation: Promise<unknown>) {
    return expect(operation).rejects.toMatchObject({ reason: "response" })
}
