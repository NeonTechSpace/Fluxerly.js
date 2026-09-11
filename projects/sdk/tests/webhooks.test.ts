import { inspect } from "node:util"
import { createServer } from "node:http"
import { once } from "node:events"
import { Cause, Effect, Exit, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { SdkDefect, createClient, createWebhookClient, type WebhookClientOptions } from "../src/index.js"
import { createClient as createNative, createWebhookClient as createNativeWebhook } from "../src/effect.js"
import { hostedOperationCalls, stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
const secret = "test_only_secret"
const metadata = (extra = {}) => ({
    id: "100",
    guild_id: "200",
    channel_id: "300",
    name: "Deployments",
    avatar: null,
    token: secret,
    ...extra,
})
const message = (extra = {}) => ({
    id: "400",
    channel_id: "300",
    webhook_id: "100",
    content: "Deploying",
    author: { id: "100", username: "Deployments", bot: true },
    ...extra,
})
const metadataMessage = (extra = {}) =>
    message({
        timestamp: "2026-09-09T12:00:00.000Z",
        edited_timestamp: null,
        type: 19,
        flags: 4,
        guild_id: "200",
        mention_everyone: false,
        mentions: [{ id: "101", username: "mentioned", bot: true }],
        mention_roles: ["102"],
        mention_channels: [{ id: "300", name: "deployments", type: 0 }],
        reactions: [{ emoji: { id: null, name: "👍", animated: null }, count: 2, me: null }],
        message_reference: { message_id: "401", channel_id: "300", guild_id: "200", type: 0 },
        referenced_message: { id: "401", channel_id: "300", content: "not retained" },
        ...extra,
    })
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function settle<A>(value: ResultAsync<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) {
        const result = await Effect.runPromise(Effect.result(value))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = await value
    if (result.isErr()) throw result.error
    return result.value
}

async function setup(mode: (typeof modes)[number], options: WebhookClientOptions = { id: "100", token: secret }) {
    const scope = Scope.makeUnsafe()
    const bot =
        mode === "native"
            ? await Effect.runPromise(
                  createNative({ token: "test_bot" }).pipe(Effect.provideService(Scope.Scope, scope)),
              )
            : createClient({ token: "test_bot" })._unsafeUnwrap()
    const webhook =
        mode === "native"
            ? await Effect.runPromise(createNativeWebhook(options).pipe(Effect.provideService(Scope.Scope, scope)))
            : createWebhookClient(options)._unsafeUnwrap()
    const shutdown = async () => {
        const a = webhook.shutdown(),
            b = bot.shutdown()
        await Promise.all([
            Effect.isEffect(a) ? Effect.runPromise(a) : a,
            Effect.isEffect(b) ? Effect.runPromise(b) : b,
        ])
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
    onTestFinished(shutdown)
    return { bot, webhook, shutdown }
}

test.each(modes)("%s sends sticker-only webhook messages without bot authentication", async (mode) => {
    const { webhook } = await setup(mode)
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        expect(url).toContain("/webhooks/100/")
        expect(new Headers(init.headers).has("Authorization")).toBe(false)
        expect(JSON.parse(String(init.body)).sticker_ids).toEqual(["501"])
        return Response.json(message({ content: "", stickers: [{ id: "501", name: "Fixture", animated: false }] }))
    })
    expect((await settle(webhook.send({ stickerIds: ["501"] }))).stickers).toEqual([
        { id: "501", name: "Fixture", animated: false },
    ])
})

test.each(modes)("%s manages webhooks with token-free snapshots and explicit credential access", async (mode) => {
    const requests: { path: string; method: string; body: unknown }[] = []
    stubFetchWithHostedDiscovery(
        vi.fn(async (url: string, init: RequestInit) => {
            expect(new Headers(init.headers).get("authorization")).toBe("Bot test_bot")
            const path = new URL(url).pathname
            requests.push({ path, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined })
            if (init.method === "DELETE") return new Response(null, { status: 204 })
            if (init.method === "GET" && path.endsWith("/webhooks")) return Response.json([metadata()])
            return Response.json(metadata())
        }),
    )
    const { bot } = await setup(mode)
    const created = await settle(
        bot.webhooks.create("300", { name: "Deployments" }, { auditReason: "Created for deployment" }),
    )
    expect(created.webhook).toEqual({ id: "100", guildId: "200", channelId: "300", name: "Deployments", avatar: null })
    expect(Object.isFrozen(created.webhook)).toBe(true)
    expect(created.credentials.revealToken()).toBe(secret)
    expect(JSON.stringify(created)).not.toContain(secret)
    expect(inspect(created, { showHidden: true, depth: 8 })).not.toContain(secret)
    const standalone = createWebhookClient(created.credentials)._unsafeUnwrap()
    await standalone.shutdown()
    expect(await settle(bot.webhooks.fetch("100"))).toEqual(created.webhook)
    expect(await settle(bot.webhooks.fetchChannel("300"))).toEqual([created.webhook])
    expect(await settle(bot.webhooks.fetchGuild("200"))).toEqual([created.webhook])
    await settle(bot.webhooks.edit("100", { name: "Renamed", avatar: null, channelId: "301" }))
    await settle(bot.webhooks.delete("100"))
    expect(requests.map((x) => [x.path, x.method])).toEqual([
        ["/v1/channels/300/webhooks", "POST"],
        ["/v1/webhooks/100", "GET"],
        ["/v1/channels/300/webhooks", "GET"],
        ["/v1/guilds/200/webhooks", "GET"],
        ["/v1/webhooks/100", "PATCH"],
        ["/v1/webhooks/100", "DELETE"],
    ])
    expect(requests[4]!.body).toEqual({ name: "Renamed", avatar: null, channel_id: "301" })
})

test.each(modes)("%s sends and manages owned messages without bot authentication", async (mode) => {
    const calls: { url: string; body: unknown }[] = []
    stubFetchWithHostedDiscovery(
        vi.fn(async (url: string, init: RequestInit) => {
            expect(new Headers(init.headers).has("authorization")).toBe(false)
            expect(init.redirect).toBe("error")
            calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
            return init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(message())
        }),
    )
    const { webhook } = await setup(mode)
    await settle(
        webhook.send({
            content: "@everyone Deploying",
            username: "Build",
            avatarUrl: "https://example.com/avatar.png",
        }),
    )
    await settle(webhook.fetchMessage("400"))
    await settle(webhook.editMessage("400", { content: "Deployed", embeds: [] }))
    await settle(webhook.deleteMessage("400"))
    expect(calls[0]!.url).toBe(`https://api.fluxer.app/v1/webhooks/100/${secret}?wait=true`)
    expect(calls[0]!.body).toMatchObject({
        username: "Build",
        avatar_url: "https://example.com/avatar.png",
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    })
    expect(calls[0]!.body).not.toHaveProperty("nonce")
    expect(calls.slice(1).every((call) => call.url.endsWith("/messages/400"))).toBe(true)
})

test.each(modes)("%s manages its webhook through token routes without closing local ownership", async (mode) => {
    const calls: { url: string; method: string; body: unknown; authorization: string | null }[] = []
    let deleted = false
    stubFetchWithHostedDiscovery(
        vi.fn(async (url: string, init: RequestInit) => {
            calls.push({
                url,
                method: init.method!,
                body: init.body ? JSON.parse(String(init.body)) : undefined,
                authorization: new Headers(init.headers).get("authorization"),
            })
            if (deleted) return new Response(null, { status: 404 })
            if (init.method === "DELETE") {
                deleted = true
                return new Response(null, { status: 204 })
            }
            return Response.json(metadata({ creator_id: "999", user: { token: secret }, private: secret }))
        }),
    )
    const { webhook } = await setup(mode)
    expect(await settle(webhook.fetch())).toEqual({
        id: "100",
        guildId: "200",
        channelId: "300",
        name: "Deployments",
        avatar: null,
    })
    expect(await settle(webhook.edit({ name: "Rotated", avatar: null }))).toMatchObject({ name: "Deployments" })
    await settle(webhook.delete())
    await expect(settle(webhook.fetch())).rejects.toMatchObject({ reason: "notFound", outcome: "rejected" })
    expect(calls.map((call) => [call.url, call.method, call.body, call.authorization])).toEqual([
        [`https://api.fluxer.app/v1/webhooks/100/${secret}`, "GET", undefined, null],
        [`https://api.fluxer.app/v1/webhooks/100/${secret}`, "PATCH", { name: "Rotated", avatar: null }, null],
        [`https://api.fluxer.app/v1/webhooks/100/${secret}`, "DELETE", undefined, null],
        [`https://api.fluxer.app/v1/webhooks/100/${secret}`, "GET", undefined, null],
    ])
})

test.each(modes)("%s encodes tagged webhook reply and forward references", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    let status = 200
    stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)))
            return status === 200
                ? Response.json(
                      message({
                          message_snapshots: [
                              { content: "source", timestamp: "2026-09-11T12:00:00.000Z", type: 0, flags: 0 },
                          ],
                      }),
                  )
                : Response.json({}, { status })
        }),
    )
    const { webhook } = await setup(mode)
    await settle(
        webhook.send({
            content: "reply",
            messageReference: { type: "reply", target: { id: "401", channelId: "300" } },
        }),
    )
    const forwarded = await settle(
        webhook.send({
            messageReference: {
                type: "forward",
                source: { source: { id: "401", channelId: "300" }, attachmentIds: ["501"], embedIndices: [0] },
            },
            username: "Forwarder",
            avatarUrl: "https://example.com/forwarder.png",
            flags: 4,
            allowedMentions: { everyone: true },
        }),
    )
    expect(bodies).toEqual([
        expect.objectContaining({ message_reference: { message_id: "401", channel_id: "300", type: 0 } }),
        expect.objectContaining({
            message_reference: {
                message_id: "401",
                channel_id: "300",
                type: 1,
                attachment_ids: ["501"],
                embed_indices: [0],
            },
            username: "Forwarder",
            avatar_url: "https://example.com/forwarder.png",
            flags: 4,
        }),
    ])
    expect(forwarded.messageSnapshots?.[0]?.content).toBe("source")
    for (const input of [
        {
            content: "not a forward",
            messageReference: { type: "forward", source: { source: { id: "401", channelId: "300" } } },
        },
        { messageReference: { type: "reply", target: { id: "401", channelId: "bad" } } },
        { content: "missing reply target", messageReference: { type: "reply" } },
        { content: "null reply target", messageReference: { type: "reply", target: null } },
        { content: "malformed reply target", messageReference: { type: "reply", target: { id: "401" } } },
    ])
        await expect(settle(webhook.send(input as never))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    status = 400
    await expect(
        settle(
            webhook.send({
                messageReference: { type: "forward", source: { source: { id: "401", channelId: "301" } } },
            }),
        ),
    ).rejects.toMatchObject({ reason: "rejected", outcome: "rejected", status: 400 })
})

test.each(modes)("%s preserves supplied metadata from webhook message responses without hydration", async (mode) => {
    const fetch = vi.fn(async () => Response.json(metadataMessage()))
    stubFetchWithHostedDiscovery(fetch)
    const { webhook } = await setup(mode)
    const received = await settle(webhook.fetchMessage("400"))
    expect(received).toMatchObject({
        id: "400",
        createdAt: "2026-09-09T12:00:00.000Z",
        editedAt: null,
        type: 19,
        flags: 4,
        guildId: "200",
        mentionedEveryone: false,
        mentions: [{ id: "101", username: "mentioned", isBot: true }],
        mentionRoleIds: ["102"],
        mentionChannels: [{ id: "300", name: "deployments", type: 0 }],
        reactions: [{ emoji: { id: null, name: "👍", animated: null }, count: 2, me: null }],
        messageReference: { id: "401", channelId: "300", guildId: "200", type: 0 },
        referencedMessage: { id: "401", channelId: "300" },
    })
    expect("content" in received.referencedMessage!).toBe(false)
    expect(
        Object.isFrozen(received) &&
            Object.isFrozen(received.mentions) &&
            Object.isFrozen(received.mentions?.[0]) &&
            Object.isFrozen(received.mentionRoleIds) &&
            Object.isFrozen(received.mentionChannels) &&
            Object.isFrozen(received.mentionChannels?.[0]) &&
            Object.isFrozen(received.reactions) &&
            Object.isFrozen(received.reactions?.[0]) &&
            Object.isFrozen(received.reactions?.[0]?.emoji) &&
            Object.isFrozen(received.messageReference) &&
            Object.isFrozen(received.referencedMessage),
    ).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
})

test.each(modes)("%s rejects invalid input before any dispatch", async (mode) => {
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    const { bot, webhook } = await setup(mode)
    for (const operation of [
        () => bot.webhooks.create("bad", { name: "x" }),
        () => bot.webhooks.create("300", { name: " " }),
        () => bot.webhooks.edit("100", {}),
        () => bot.webhooks.delete("100", { auditReason: "line\nbreak" }),
        () => webhook.edit({ channelId: "300" } as never),
        () => webhook.edit({}),
        () => webhook.send({ content: "x", avatarUrl: "file:///private" }),
        () => webhook.send({ content: "x", username: " " }),
        () => webhook.fetchMessage("../400"),
        () => webhook.editMessage("400", { attachments: [] } as never),
        () => webhook.send({ content: "x" }, { timeoutMs: 0 }),
        () => webhook.send({ content: "x" }, { auditReason: "unsupported" } as never),
    ])
        await expect(settle<unknown>(operation())).rejects.toMatchObject({
            _tag: "WebhookOperationError",
            reason: "input",
            outcome: "notDispatched",
        })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s rejects mismatched identities and malformed lists without exposing secrets", async (mode) => {
    let response: unknown = message({ webhook_id: "101", private: secret })
    stubFetchWithHostedDiscovery(vi.fn(async () => Response.json(response)))
    const { bot, webhook } = await setup(mode)
    await expect(settle(webhook.send({ content: "x" }))).rejects.toMatchObject({
        reason: "response",
        outcome: "unknown",
    })
    response = [metadata(), metadata()]
    await expect(settle(bot.webhooks.fetchGuild("200"))).rejects.toMatchObject({ reason: "response" })
    response = metadata({ channel_id: "301" })
    await expect(settle(bot.webhooks.create("300", { name: "x" }))).rejects.toMatchObject({ reason: "response" })
})

test.each(modes)("%s does not replay unknown sends, but retries confirmed rate limits", async (mode) => {
    let attempts = 0,
        rate = false
    stubFetchWithHostedDiscovery(
        vi.fn(async () => {
            attempts++
            if (!rate) throw new Error(`private upstream ${secret}`)
            if (attempts === 1) return Response.json({ retry_after: 0.005 }, { status: 429 })
            return Response.json(message())
        }),
    )
    const { webhook } = await setup(mode)
    try {
        await settle(webhook.send({ content: "x" }))
    } catch (error) {
        expect(error).toMatchObject({ reason: "network", outcome: "unknown" })
        expect(inspect(error)).not.toContain(secret)
        expect(JSON.stringify(error)).not.toContain(secret)
    }
    expect(attempts).toBe(1)
    rate = true
    attempts = 0
    await settle(webhook.send({ content: "x" }))
    expect(attempts).toBe(2)
})

test.each(modes)("%s supports non-voice webhook flags and rejects invalid flags without dispatch", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    const hostedFetch = stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)))
            return Response.json(message())
        }),
    )
    const { webhook } = await setup(mode)
    await settle(webhook.send({ content: "quiet", flags: 4100 }))
    await settle(webhook.editMessage("400", { flags: 4 }))
    await settle(webhook.editMessage("400", { flags: 0 }))
    expect(bodies.map((body) => body.flags)).toEqual([4100, 4, 0])
    for (const flags of [8192, -1, 1.5, 2 ** 32 + 4]) {
        await expect(settle(webhook.send({ content: "quiet", flags }))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
        await expect(settle(webhook.editMessage("400", { flags }))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    }
    expect(hostedOperationCalls(hostedFetch)).toHaveLength(3)
})

test.each(modes)("%s snapshots binary uploads and replays identical multipart after 429", async (mode) => {
    let calls = 0
    const bytes = new Uint8Array([1, 2, 3])
    const observed: Uint8Array[] = []
    stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            const headers = new Headers(init.headers)
            expect(headers.has("authorization")).toBe(false)
            const body = await new Response(init.body).arrayBuffer()
            expect(body.byteLength).toBe(Number(headers.get("content-length")))
            const form = await new Response(body, { headers }).formData()
            const file = form.get("files[0]") as File
            observed.push(new Uint8Array(await file.arrayBuffer()))
            const payload = JSON.parse(String(form.get("payload_json")))
            expect(payload.attachments[0]).toMatchObject({ id: 0, filename: "report.txt", description: "Build log" })
            bytes.fill(9)
            return ++calls === 1 ? Response.json({ retry_after: 0.005 }, { status: 429 }) : Response.json(message())
        }),
    )
    const { webhook } = await setup(mode)
    await settle(webhook.send({ attachments: [{ data: bytes, filename: "report.txt", description: "Build log" }] }))
    expect(observed).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])])
})

test.each(modes)("%s recreates copied webhook bytes when a 429 arrives before multipart consumption", async (mode) => {
    let attempts = 0
    const observed: Uint8Array[] = []
    stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            const headers = new Headers(init.headers)
            expect(headers.has("authorization")).toBe(false)
            expect(headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
            if (++attempts === 1) return Response.json({ retry_after: 0.001 }, { status: 429 })
            const body = await new Response(init.body).arrayBuffer()
            const form = await new Response(body, { headers }).formData()
            observed.push(new Uint8Array(await (form.get("files[0]") as File).arrayBuffer()))
            return Response.json(message())
        }),
    )
    const { webhook } = await setup(mode)
    const bytes = new Uint8Array([4, 5, 6])
    const pending = settle(webhook.send({ attachments: [{ data: bytes, filename: "early-429.txt" }] }))
    bytes.fill(9)
    await pending
    expect(attempts).toBe(2)
    expect(observed).toEqual([new Uint8Array([4, 5, 6])])
})

test.each(modes)("%s shutdown awaits active body cleanup and rejects new requests", async (mode) => {
    let started!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
        started = resolve
    })
    const cleanup = new Promise<void>((resolve) => {
        release = resolve
    })
    stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            started()
            await new Promise<void>((resolve) =>
                init.signal!.addEventListener("abort", () => resolve(), { once: true }),
            )
            await cleanup
            throw new Error("aborted")
        }),
    )
    const { webhook, shutdown } = await setup(mode)
    const sent = settle(webhook.send({ content: "x" })).catch((error) => error)
    await ready
    let done = false
    const stopped = shutdown().then(() => {
        done = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(done).toBe(false)
    release()
    await stopped
    expect(await sent).toMatchObject({ _tag: "ClientClosedError" })
    await expect(settle(webhook.fetchMessage("400"))).rejects.toMatchObject({ _tag: "ClientClosedError" })
})

test.each(modes)("%s bounds retained upload bytes and releases reservations after failure", async (mode) => {
    const hostedFetch = stubFetchWithHostedDiscovery(vi.fn(async () => Response.json(message())))
    const { webhook } = await setup(mode, { id: "100", token: secret, uploadMaxBytes: 2 })
    await expect(
        settle(webhook.send({ attachments: [{ data: new Uint8Array(3), filename: "a" }] })),
    ).rejects.toMatchObject({ reason: "busy", outcome: "notDispatched" })
    await settle(webhook.send({ content: "x" }))
    expect(hostedOperationCalls(hostedFetch)).toHaveLength(1)
})

test("native creation and operations are lazy, independently scoped and release credentials on closure", async () => {
    const request = vi.fn(async () => Response.json(message()))
    stubFetchWithHostedDiscovery(request)
    const scope = Scope.makeUnsafe()
    const creation = createNativeWebhook({ id: "100", token: secret })
    expect(request).not.toHaveBeenCalled()
    const webhook = await Effect.runPromise(creation.pipe(Effect.provideService(Scope.Scope, scope)))
    const operation = webhook.send({ content: "x" })
    expect(request).not.toHaveBeenCalled()
    await Effect.runPromise(operation)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await expect(settle(operation)).rejects.toMatchObject({ _tag: "ClientClosedError" })
})

test("invalid client configuration contains no rejected values", () => {
    for (const value of [
        { id: "../100", token: secret },
        { id: "100", token: "x/y" },
        { id: "100", token: secret, uploadMaxBytes: 0 },
    ]) {
        const result = createWebhookClient(value)
        expect(result.isErr()).toBe(true)
        expect(JSON.stringify(result)).not.toContain(secret)
    }
})

test.each(modes)("%s retries transient reads but never retries rejected or server-failed writes", async (mode) => {
    let calls = 0,
        status = 503
    stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            calls++
            if (init.method === "GET" && calls === 3) return Response.json(message())
            return Response.json({ private: secret }, { status })
        }),
    )
    const { webhook } = await setup(mode)
    await settle(webhook.fetchMessage("400"))
    expect(calls).toBe(3)
    for (const code of [400, 403, 404, 500, 503]) {
        calls = 0
        status = code
        await expect(settle(webhook.send({ content: "x" }))).rejects.toMatchObject({
            status: code,
            outcome: code < 500 ? "rejected" : "unknown",
        })
        expect(calls).toBe(1)
    }
})

test.each(modes)("%s exposes only reviewed API rejection detail", async (mode) => {
    const privateMessage = "private provider detail"
    stubFetchWithHostedDiscovery(
        vi.fn(async () => {
            const body = JSON.stringify({ code: "MISSING_PERMISSIONS", message: privateMessage })
            return new Response(body, {
                status: 403,
                headers: { "content-length": String(Buffer.byteLength(body)), "content-type": "application/json" },
            })
        }),
    )
    const { webhook } = await setup(mode)
    let failure: unknown
    try {
        await settle(webhook.send({ content: "x" }))
    } catch (error) {
        failure = error
    }
    expect(failure).toMatchObject({
        _tag: "WebhookOperationError",
        reason: "rejected",
        outcome: "rejected",
        status: 403,
        apiError: {
            code: "missingPermissions",
            explanation: "The provider reports that the bot lacks a required permission",
        },
    })
    expect(JSON.stringify(failure)).not.toContain(privateMessage)
})

test.each(modes)("%s classifies finite chunked API errors without Content-Length", async (mode) => {
    const codes = [
        ["MISSING_ACCESS", "missingAccess"],
        ["MISSING_PERMISSIONS", "missingPermissions"],
        ["COMMUNICATION_DISABLED", "communicationDisabled"],
        ["CANNOT_SEND_MESSAGES_TO_USER", "cannotSendMessagesToUser"],
    ] as const
    for (const [providerCode, code] of codes) {
        stubFetchWithHostedDiscovery(
            vi.fn(
                async () =>
                    new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue(new TextEncoder().encode(`{"code":"${providerCode}"}`))
                                controller.close()
                            },
                        }),
                        { status: 403, headers: { "content-type": "application/json" } },
                    ),
            ),
        )
        const { webhook } = await setup(mode)
        await expect(settle(webhook.send({ content: "x" }))).rejects.toMatchObject({ apiError: { code } })
    }
})

test.each(modes)("%s rejects unsafe API error details", async (mode) => {
    for (const providerCode of ["UNKNOWN", "__proto__", "constructor"]) {
        stubFetchWithHostedDiscovery(vi.fn(async () => Response.json({ code: providerCode }, { status: 403 })))
        const { webhook } = await setup(mode)
        await expect(settle(webhook.send({ content: "x" }))).rejects.toMatchObject({ apiError: null })
    }
})

test.each(modes)("%s drops deceptively short oversized API error bodies", async (mode) => {
    let cancelled = false
    stubFetchWithHostedDiscovery(
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode(
                                    `{"code":"MISSING_PERMISSIONS","private":"${"x".repeat(9_000)}"}`,
                                ),
                            )
                        },
                        cancel() {
                            cancelled = true
                        },
                    }),
                    { status: 403, headers: { "content-length": "1", "content-type": "application/json" } },
                ),
        ),
    )
    const { webhook } = await setup(mode)
    await expect(settle(webhook.send({ content: "x" }))).rejects.toMatchObject({ apiError: null, outcome: "rejected" })
    expect(cancelled).toBe(true)
})

test.each(modes)("%s bounds stalled API error reads and releases their body", async (mode) => {
    let reading!: () => void
    const started = new Promise<void>((resolve) => {
        reading = resolve
    })
    let cancelled = false
    stubFetchWithHostedDiscovery(
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        pull() {
                            reading()
                            return new Promise<void>(() => undefined)
                        },
                        cancel() {
                            cancelled = true
                        },
                    }),
                    { status: 403, headers: { "content-type": "application/json" } },
                ),
        ),
    )
    const { webhook } = await setup(mode)
    const operation = settle(webhook.send({ content: "x" }))
    await started
    await expect(operation).rejects.toMatchObject({
        _tag: "WebhookOperationError",
        outcome: "rejected",
        apiError: null,
    })
    expect(cancelled).toBe(true)
})

test.each(modes)("%s cancels stalled API error reads without retaining their body", async (mode) => {
    let reading!: () => void
    const started = new Promise<void>((resolve) => {
        reading = resolve
    })
    let cancelled = false
    const controller = new AbortController()
    stubFetchWithHostedDiscovery(
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        pull() {
                            reading()
                            return new Promise<void>(() => undefined)
                        },
                        cancel() {
                            cancelled = true
                        },
                    }),
                    { status: 403, headers: { "content-type": "application/json" } },
                ),
        ),
    )
    const { webhook } = await setup(mode)
    if (mode === "default") {
        const operation = settle(webhook.send({ content: "x" }, { signal: controller.signal }))
        await started
        controller.abort()
        await expect(operation).rejects.toMatchObject({ _tag: "CancelledError" })
    } else {
        const operation = Effect.runPromiseExit(
            (webhook as import("../src/effect.js").WebhookClient).send({ content: "x" }),
            { signal: controller.signal },
        )
        await started
        controller.abort()
        const exit = await operation
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }
    expect(cancelled).toBe(true)
})

test.each(modes)("%s retains a rejected outcome when API error body cleanup defects", async (mode) => {
    const privateMarker = "private API error cleanup marker"
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    onTestFinished(() => {
        process.off("unhandledRejection", onUnhandled)
    })
    stubFetchWithHostedDiscovery(
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        pull() {
                            return new Promise<void>(() => undefined)
                        },
                        cancel() {
                            return Promise.reject(new Error(privateMarker))
                        },
                    }),
                    { status: 403, headers: { "content-type": "application/json" } },
                ),
        ),
    )
    const { webhook } = await setup(mode)
    if (mode === "default") {
        const error = await settle(webhook.send({ content: "x" })).catch((failure) => failure)
        expect(error).toBeInstanceOf(SdkDefect)
        expect(error).toMatchObject({
            operation: "webhooks.send",
            reasons: expect.arrayContaining([
                {
                    kind: "Failure",
                    failure: expect.objectContaining({ _tag: "WebhookOperationError", outcome: "rejected" }),
                },
                { kind: "Defect" },
            ]),
        })
        expect(JSON.stringify(error)).not.toContain(privateMarker)
        expect(String(error)).not.toContain(privateMarker)
    } else {
        const exit = await Effect.runPromiseExit(
            (webhook as import("../src/effect.js").WebhookClient).send({ content: "x" }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons).toContainEqual(
                expect.objectContaining({
                    _tag: "Fail",
                    error: expect.objectContaining({ _tag: "WebhookOperationError", outcome: "rejected" }),
                }),
            )
            expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ _tag: "Die" }))
            expect(String(exit.cause)).not.toContain(privateMarker)
        }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(unhandled).toEqual([])
})

test.each(modes)("%s freezes API error detail independently for each rejection", async (mode) => {
    stubFetchWithHostedDiscovery(vi.fn(async () => Response.json({ code: "MISSING_ACCESS" }, { status: 403 })))
    const { webhook } = await setup(mode)
    const first = (await settle(webhook.send({ content: "x" })).catch((failure) => failure)) as {
        readonly apiError: { readonly explanation: string } | null
    }
    expect(first.apiError).not.toBeNull()
    expect(Object.isFrozen(first.apiError)).toBe(true)
    expect(() => Object.assign(first.apiError!, { explanation: "poisoned" })).toThrow()
    const second = (await settle(webhook.send({ content: "x" })).catch((failure) => failure)) as {
        readonly apiError: { readonly explanation: string } | null
    }
    expect(second.apiError).toMatchObject({ explanation: "The provider denied access to the requested resource" })
})

test.each(modes)("%s cancellation waits for owned cleanup without stopping the client", async (mode) => {
    let started!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
        started = resolve
    })
    const cleanup = new Promise<void>((resolve) => {
        release = resolve
    })
    const controller = new AbortController()
    stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            started()
            await new Promise<void>((resolve) =>
                init.signal!.addEventListener("abort", () => resolve(), { once: true }),
            )
            await cleanup
            throw new Error("aborted")
        }),
    )
    const { webhook } = await setup(mode)
    const operation =
        mode === "default"
            ? (webhook as import("../src/index.js").WebhookClient).send({ content: "x" }, { signal: controller.signal })
            : (webhook as import("../src/effect.js").WebhookClient).send({ content: "x" })
    let done = false
    const result = Effect.isEffect(operation)
        ? Effect.runPromiseExit(operation, { signal: controller.signal }).then((exit) => {
              expect(Exit.isFailure(exit)).toBe(true)
              done = true
          })
        : operation.then((value) => {
              expect(value.isErr() && value.error._tag).toBe("CancelledError")
              done = true
          })
    await ready
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(done).toBe(false)
    release()
    await result
    stubFetchWithHostedDiscovery(vi.fn(async () => Response.json(message())))
    await settle(webhook.send({ content: "After cancellation" }))
})

test.each(modes)("%s validates explicit null upload budgets and bounds response bytes", async (mode) => {
    expect(createWebhookClient({ id: "100", token: secret, uploadMaxBytes: null } as never).isErr()).toBe(true)
    const { webhook } = await setup(mode)
    let cancelled = false
    stubFetchWithHostedDiscovery(
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(new Uint8Array(1_048_577))
                        },
                        cancel() {
                            cancelled = true
                        },
                    }),
                    { status: 200 },
                ),
        ),
    )
    await expect(settle(webhook.fetchMessage("400"))).rejects.toMatchObject({ reason: "response" })
    expect(cancelled).toBe(true)
})

test("multipart bytes cross a real HTTP transport with correct framing", async () => {
    const fetch = globalThis.fetch
    let received = false
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const data = Buffer.concat(chunks)
        const form = await new Response(data, { headers: { "content-type": req.headers["content-type"]! } }).formData()
        expect(new Uint8Array(await (form.get("files[0]") as File).arrayBuffer())).toEqual(new Uint8Array([5, 6]))
        expect(JSON.parse(String(form.get("payload_json"))).message_reference).toEqual({
            message_id: "401",
            channel_id: "300",
            type: 0,
        })
        expect(req.headers.authorization).toBeUndefined()
        received = true
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify(message()))
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture address")
    onTestFinished(
        () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()))
                server.closeAllConnections()
            }),
    )
    stubFetchWithHostedDiscovery((_url: string, init: RequestInit) => fetch(`http://127.0.0.1:${address.port}`, init))
    const { webhook } = await setup("default")
    await settle(
        webhook.send({
            attachments: [{ filename: "a.txt", data: new Uint8Array([5, 6]) }],
            messageReference: { type: "reply", target: { id: "401", channelId: "300" } },
        }),
    )
    expect(received).toBe(true)
})
