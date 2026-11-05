import { inspect } from "node:util"
import { createServer } from "node:http"
import { once } from "node:events"
import { setImmediate as turn } from "node:timers/promises"
import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    ConfigurationError,
    createClient,
    createWebhookClient,
    errors,
    MessageFlags,
    voiceWaveform,
    type EmbedInput,
    type WebhookClientOptions,
} from "../../../src/index.js"
import {
    createClient as createNative,
    createWebhookClient as createNativeWebhook,
    voiceWaveform as nativeVoiceWaveform,
} from "../../../src/effect.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { driveSdkTime, sdkClock } from "../../support/client-clock.js"
import { hostedOperationCalls, stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { captureLogs } from "../../support/log-capture.js"
import { expectErr, settle } from "../../support/settle.js"
import { fixtureHost } from "../../support/loopback.js"
import { expectThrown } from "../defects.js"

const secret = "test_only_secret"
const metadata = (extra = {}) => ({
    id: "100",
    guild_id: "200",
    channel_id: "300",
    type: 1,
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
        referenced_message: {
            id: "401",
            channel_id: "300",
            content: "reply context",
            author: { id: "101", username: "mentioned", bot: true },
        },
        ...extra,
    })
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function setup(mode: Mode, options: WebhookClientOptions = { id: "100", token: secret }) {
    const scope = Scope.makeUnsafe()
    const bot =
        mode === "native"
            ? await Effect.runPromise(
                  createNative({ token: "test_bot" }).pipe(Effect.provideService(Scope.Scope, scope)),
              )
            : createClient({ token: "test_bot" })
    const webhook =
        mode === "native"
            ? await Effect.runPromise(createNativeWebhook(options).pipe(Effect.provideService(Scope.Scope, scope)))
            : createWebhookClient(options)
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

// messages.send reads getters and non-enumerable fields, so a webhook send of the same object must keep them too
test.each(modes)("%s keeps getter-backed and non-enumerable webhook message fields", async (mode) => {
    const { webhook } = await setup(mode)
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json(message())
    })
    class Announcement {
        get content() {
            return "Deploying"
        }
        get username() {
            return "Release bot"
        }
        get allowedMentions() {
            return { users: ["101"] }
        }
    }
    const input = new Announcement()
    Object.defineProperty(input, "flags", { value: MessageFlags.SuppressEmbeds, enumerable: false })
    await settle(webhook.send(input as never))
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ content: "Deploying", username: "Release bot", flags: 4 })
    expect(bodies[0]!.allowed_mentions).toMatchObject({ users: ["101"] })
})

// The shared image check accepts media type parameters, as Fluxer and the community and user image fields do
test.each(modes)("%s accepts a webhook avatar data URI with media type parameters", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json(metadata())
    })
    const { bot, webhook } = await setup(mode)
    const avatar = "data:image/png;charset=utf-8;base64,iVBORw0K"
    await settle(bot.webhooks.create("300", { name: "Deployments", avatar }))
    await settle(webhook.edit({ avatar }))
    expect(bodies).toEqual([{ name: "Deployments", avatar }, { avatar }])
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
    expect(created.webhook).toEqual({
        id: "100",
        guildId: "200",
        channelId: "300",
        type: 1,
        name: "Deployments",
        avatar: null,
    })
    expect(Object.isFrozen(created.webhook)).toBe(true)
    expect(created.credentials.revealToken()).toBe(secret)
    expect(JSON.stringify(created)).not.toContain(secret)
    expect(inspect(created, { showHidden: true, depth: 8 })).not.toContain(secret)
    const standalone = createWebhookClient(created.credentials)
    await standalone.shutdown()
    expect(await settle(bot.webhooks.fetch("100"))).toEqual(created.webhook)
    expect(await settle(bot.webhooks.fetchForChannel("300"))).toEqual([created.webhook])
    expect(await settle(bot.webhooks.fetchForGuild("200"))).toEqual([created.webhook])
    await settle(bot.webhooks.edit("100", { name: "Renamed", avatar: null, channelId: "301" }))
    await settle(bot.webhooks.delete("100"))
    expect(requests.map((x) => [x.path, x.method])).toEqual([
        ["/api/v1/channels/300/webhooks", "POST"],
        ["/api/v1/webhooks/100", "GET"],
        ["/api/v1/channels/300/webhooks", "GET"],
        ["/api/v1/guilds/200/webhooks", "GET"],
        ["/api/v1/webhooks/100", "PATCH"],
        ["/api/v1/webhooks/100", "DELETE"],
    ])
    expect(requests[4]!.body).toEqual({ name: "Renamed", avatar: null, channel_id: "301" })
})

test.each(modes)("%s keeps the creator on bot reads and leaves it out of token reads", async (mode) => {
    // Bot-authenticated reads carry the creator's public user, and token reads leave it out
    const creator = {
        id: "500",
        username: "creator",
        discriminator: "0042",
        global_name: null,
        avatar: null,
        avatar_color: null,
        flags: 0,
    }
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) =>
        new Headers(init.headers).has("authorization")
            ? Response.json(metadata({ user: creator }))
            : Response.json(metadata()),
    )
    const { bot, webhook } = await setup(mode)
    expect(await settle(bot.webhooks.fetch("100"))).toMatchObject({
        id: "100",
        creator: { id: "500", username: "creator" },
    })
    expect(await settle(webhook.fetch())).not.toHaveProperty("creator")
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
    expect(calls[0]!.url).toBe(`https://fluxer.com/api/v1/webhooks/100/${secret}?wait=true`)
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
        type: 1,
        name: "Deployments",
        avatar: null,
    })
    expect(await settle(webhook.edit({ name: "Rotated", avatar: null }))).toMatchObject({ name: "Deployments" })
    await settle(webhook.delete())
    await expect(settle(webhook.fetch())).rejects.toMatchObject({ reason: "notFound", outcome: "rejected" })
    expect(calls.map((call) => [call.url, call.method, call.body, call.authorization])).toEqual([
        [`https://fluxer.com/api/v1/webhooks/100/${secret}`, "GET", undefined, null],
        [`https://fluxer.com/api/v1/webhooks/100/${secret}`, "PATCH", { name: "Rotated", avatar: null }, null],
        [`https://fluxer.com/api/v1/webhooks/100/${secret}`, "DELETE", undefined, null],
        [`https://fluxer.com/api/v1/webhooks/100/${secret}`, "GET", undefined, null],
    ])
})

test.each(modes)("%s rejects non-incoming metadata on token-authenticated routes", async (mode) => {
    const { webhook } = await setup(mode)
    for (const type of [2, 99]) {
        stubFetchWithHostedDiscovery(vi.fn(async () => Response.json(metadata({ type }))))
        for (const operation of [webhook.fetch(), webhook.edit({ name: "Renamed" })]) {
            const failure = await expectErr(operation)
            expect(failure).toMatchObject({ reason: "response" })
            expect(JSON.stringify(failure)).not.toContain(secret)
        }
    }
})

test.each(modes)("%s uses initially validated shared webhook settings", async (mode) => {
    const bodies: unknown[] = []
    stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)))
            return Response.json(metadata())
        }),
    )
    const { bot, webhook } = await setup(mode)
    const switchingName = (initial: string, changed: string) => {
        let reads = 0
        return {
            get name() {
                return reads++ === 0 ? initial : changed
            },
        }
    }
    let channelReads = 0
    const switchingChannel = {
        name: "Stable",
        get channelId() {
            return channelReads++ === 0 ? "300" : "301"
        },
    }
    await settle(bot.webhooks.create("300", switchingName("Created", "Changed")))
    await settle(bot.webhooks.edit("100", switchingChannel))
    await settle(webhook.edit(switchingName("Token", "Changed token")))
    expect(bodies).toEqual([{ name: "Created" }, { name: "Stable", channel_id: "300" }, { name: "Token" }])
})

test.each(modes)("%s rejects invalid first shared webhook settings without dispatch", async (mode) => {
    const fetch = vi.fn(async () => Response.json(metadata()))
    stubFetchWithHostedDiscovery(fetch)
    const { bot, webhook } = await setup(mode)
    let channelReads = 0
    await expect(
        settle(
            bot.webhooks.edit("100", {
                get channelId() {
                    return channelReads++ === 0 ? "invalid" : "300"
                },
            }),
        ),
    ).rejects.toMatchObject({ reason: "input", outcome: "notDispatched", inputValidation: { path: "channelId" } })
    let nameReads = 0
    await expect(
        settle(
            webhook.edit({
                get name() {
                    return nameReads++ === 0 ? " " : "Valid"
                },
            }),
        ),
    ).rejects.toMatchObject({ reason: "input", outcome: "notDispatched", inputValidation: { path: "name" } })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s webhook message edits may name a file the message already has", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json(message({ id: "401" }))
    })
    const { webhook } = await setup(mode)
    await settle(webhook.editMessage("401", { embeds: [{ thumbnail: { url: "attachment://chart.webp" } }] }))
    expect(bodies).toEqual([expect.objectContaining({ embeds: [{ thumbnail: { url: "attachment://chart.webp" } }] })])
})

test.each(modes)("%s webhook message edits send empty embed text, which Fluxer reads as absent there", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json(message({ id: "401" }))
    })
    const { webhook } = await setup(mode)
    // This route reads its body through Validator('json'), which turns "" into null, and Fluxer then drops an author,
    // footer or media object without its required text, unread (WebhookController.ts:462, Validator.ts:59-80)
    const kept: EmbedInput[] = [
        { title: "Kept", author: { name: "" } },
        { title: "Kept", author: { name: "", url: "not a URL", iconUrl: "javascript:void 0" } },
        { title: "Kept", footer: { text: "", iconUrl: "not a URL" } },
        { title: "Kept", image: { url: "", description: "" }, thumbnail: { url: "", description: "Unchecked" } },
        { title: "Kept", url: "", timestamp: "" },
        { description: "Kept", author: { name: "Author", url: "", iconUrl: "" }, footer: { text: "x", iconUrl: "" } },
        // A dropped author still holds a value here, so Fluxer keeps the embed
        { author: { name: "", url: "https://example.com" } },
        { color: 0 },
        { fields: [] },
    ]
    for (const embed of kept) await settle(webhook.editMessage("401", { embeds: [embed] }))
    expect(bodies.map((body) => body.embeds)).toEqual(
        kept.map((embed) => [JSON.parse(JSON.stringify(embed).replaceAll('"iconUrl"', '"icon_url"'))]),
    )
    // Fluxer turns an embed whose values are all empty into null and refuses it, so it fails locally
    for (const embed of [
        {},
        { title: "" },
        { title: "", description: "", url: "", timestamp: "" },
        { author: { name: "" } },
        { author: { name: "", url: "", iconUrl: "" } },
        { footer: { text: "" }, image: { url: "" }, thumbnail: { url: "", description: "" } },
    ] satisfies EmbedInput[])
        await expect(
            settle(webhook.editMessage("401", { content: "Text", embeds: [{ title: "Kept" }, embed] })),
        ).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path: "embeds[]", constraint: "required" },
        })
    // Webhook sends parse the raw body, so an empty author name still fails there
    await expect(settle(webhook.send({ embeds: [{ title: "Kept", author: { name: "" } }] }))).rejects.toMatchObject({
        reason: "input",
        inputValidation: { path: "embeds[].author.name" },
    })
    expect(bodies).toHaveLength(kept.length)
})

// Fluxer reads the mention settings of a webhook send with content, and never those of a webhook message edit
// (fluxer_api/src/api/channel/services/message/MessageSendService.ts:1083-1085, 1178-1240 at 0098958f)
test.each(modes)("%s refuses everyone with listed users or roles on sends, and edits send it", async (mode) => {
    const fetch = stubFetchWithHostedDiscovery(async () => Response.json(message()))
    const { webhook } = await setup(mode)
    for (const allowedMentions of [
        { everyone: true, users: ["30"] },
        { everyone: true, roles: ["40"] },
    ])
        await expect(settle(webhook.send({ content: "mixed", allowedMentions }))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path: "allowedMentions", constraint: "relationship" },
        })
    expect(hostedOperationCalls(fetch)).toEqual([])
    await settle(webhook.editMessage("400", { content: "mixed", allowedMentions: { everyone: true, users: ["30"] } }))
    expect(hostedOperationCalls(fetch)).toHaveLength(1)
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
        referencedMessage: {
            id: "401",
            channelId: "300",
            content: "reply context",
            author: { id: "101", username: "mentioned", isBot: true },
        },
    })
    expect("referencedMessage" in received.referencedMessage!).toBe(false)
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
            Object.isFrozen(received.referencedMessage) &&
            Object.isFrozen(received.referencedMessage?.author),
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
        await expect(settle<unknown, unknown>(operation())).rejects.toMatchObject({
            _tag: "WebhookOperationError",
            reason: "input",
            outcome: "notDispatched",
        })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s bounds avatarUrl at Fluxer's 2,048 characters after normalization", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    const fetch = stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json(message())
    })
    const { webhook } = await setup(mode)
    const longest = `https://example.com/${"a".repeat(2048 - "https://example.com/".length)}`
    await settle(webhook.send({ content: "x", avatarUrl: `  ${longest}\u202e ` }))
    expect(bodies.map((body) => body.avatar_url)).toEqual([`  ${longest}\u202e `])
    await expect(settle(webhook.send({ content: "x", avatarUrl: `${longest}a` }))).rejects.toMatchObject({
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "avatarUrl", constraint: "format" },
    })
    expect(hostedOperationCalls(fetch)).toHaveLength(1)
})

test.each(modes)("%s rejects mismatched identities and malformed lists without exposing secrets", async (mode) => {
    let response: unknown = message({ webhook_id: "101", private: secret })
    stubFetchWithHostedDiscovery(vi.fn(async () => Response.json(response)))
    const { bot, webhook } = await setup(mode)
    const failures = [await expectErr(webhook.send({ content: "x" }))]
    response = [metadata(), metadata()]
    failures.push(await expectErr(bot.webhooks.fetchForGuild("200")))
    response = metadata({ channel_id: "301" })
    failures.push(await expectErr(bot.webhooks.create("300", { name: "x" })))
    expect(failures).toMatchObject([
        { reason: "response", outcome: "unknown" },
        { reason: "response" },
        { reason: "response" },
    ])
    for (const failure of failures) {
        expect(JSON.stringify(failure)).not.toContain(secret)
        expect(inspect(failure)).not.toContain(secret)
    }
})

test.each(modes)("%s does not replay unknown sends, but retries confirmed rate limits", async (mode) => {
    const clock = sdkClock()
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
    const error = await expectErr(webhook.send({ content: "x" }))
    expect(error).toMatchObject({ reason: "network", outcome: "unknown" })
    expect(inspect(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(attempts).toBe(1)
    rate = true
    attempts = 0
    await driveSdkTime(clock, settle(webhook.send({ content: "x" })))
    expect(attempts).toBe(2)
})

// Catches: A Blob upload failed on a 429 without any log record, unlike ratelimit.wait and ratelimit.deadline
test.each(modes)("%s logs a rate-limited Blob upload that cannot be sent twice", async (mode) => {
    let attempts = 0
    stubFetchWithHostedDiscovery(
        vi.fn(async () => {
            attempts++
            return Response.json({ retry_after: 0.005, global: false }, { status: 429 })
        }),
    )
    const logs = captureLogs()
    const { webhook } = await setup(mode, { id: "100", token: secret, logging: logs.logging })
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
    const error = await expectErr(webhook.send({ attachments: [{ file: blob, filename: "chart.png" }] }))
    expect(error).toMatchObject({ reason: "rateLimit", retryAfterMs: 5 })
    expect(attempts).toBe(1)
    expect(logs.withCode("ratelimit.notResent")).toEqual([
        expect.objectContaining({ level: "warn", status: 429, delayMs: 5, route: "/webhooks/:id/:token" }),
    ])
})

// Catches: A rate-limited stream upload was called retryable with the generic wait hint, although the same call would
// send the used stream again. A Blob can be read again by a new call, so it stays retryable
test.each(modes)("%s marks a rate-limited stream upload as not retryable and names a new stream", async (mode) => {
    stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            // The upload reads the stream before the rate limit arrives
            await new Response(init.body).arrayBuffer()
            return Response.json({ retry_after: 0.005, global: false }, { status: 429 })
        }),
    )
    const { webhook } = await setup(mode, { id: "100", token: secret })
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array([1]))
            controller.close()
        },
    })
    const streamed = await expectErr(webhook.send({ attachments: [{ stream, size: 1, filename: "chart.png" }] }))
    expect(streamed).toMatchObject({ reason: "rateLimit", details: expect.objectContaining({ streamUsed: true }) })
    expect(streamed.hint).toContain("new stream")
    expect(errors.isRetryable(streamed)).toBe(false)
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" })
    const blobbed = await expectErr(webhook.send({ attachments: [{ file: blob, filename: "chart.png" }] }))
    expect(blobbed.details).not.toHaveProperty("streamUsed")
    expect(errors.isRetryable(blobbed)).toBe(true)
})

test.each(modes)(
    "%s accepts only writable webhook flags and rejects unsupported flags without dispatch",
    async (mode) => {
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
        for (const flags of [
            MessageFlags.Crossposted,
            MessageFlags.IsCrosspost,
            MessageFlags.SourceMessageDeleted,
            MessageFlags.VoiceMessage,
            MessageFlags.HasThread,
            MessageFlags.FailedToMentionSomeRolesInThread,
            MessageFlags.Crossposted | MessageFlags.SuppressEmbeds,
            -1,
            1.5,
            2 ** 32 + 4,
        ]) {
            for (const input of [
                { content: "quiet", flags },
                {
                    content: "quiet",
                    flags,
                    messageReference: { type: "reply", target: { id: "401", channelId: "300" } },
                },
                { flags, messageReference: { type: "forward", source: { source: { id: "401", channelId: "300" } } } },
            ] as const)
                await expect(settle(webhook.send(input))).rejects.toMatchObject({
                    reason: "input",
                    outcome: "notDispatched",
                    // A webhook send may be a voice note, which cannot have content, while a forward never is one
                    inputValidation: {
                        path: flags === MessageFlags.VoiceMessage && "content" in input ? "content" : "flags",
                    },
                })
            await expect(settle(webhook.editMessage("400", { flags }))).rejects.toMatchObject({
                reason: "input",
                outcome: "notDispatched",
                inputValidation: { path: "flags" },
            })
        }
        expect(hostedOperationCalls(hostedFetch)).toHaveLength(3)
    },
)

// Webhook files always go as multipart, and Fluxer's multipart webhook schema reads waveforms of at most 256 characters
// (packages/schema/src/domains/webhook/WebhookRequestSchemas.ts:79 at 5f3fc0b1), while it accepts the voice note itself
test.each(modes)("%s sends a voice note whose waveform fits the webhook multipart limit", async (mode) => {
    const payloads: Record<string, any>[] = []
    const hostedFetch = stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            const headers = new Headers(init.headers)
            const form = await new Response(await new Response(init.body).arrayBuffer(), { headers }).formData()
            payloads.push(JSON.parse(String(form.get("payload_json"))))
            expect(new Uint8Array(await (form.get("files[0]") as File).arrayBuffer())).toEqual(new Uint8Array([1]))
            return Response.json(message())
        }),
    )
    const { webhook } = await setup(mode)
    const fits = "A".repeat(256)
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array([1]))
            controller.close()
        },
    })
    const voice = { filename: "note.ogg", contentType: "audio/ogg", duration: 25 }
    await settle(
        webhook.send({
            attachments: [{ ...voice, data: new Uint8Array([1]), waveform: fits }],
            flags: MessageFlags.VoiceMessage,
        }),
    )
    await settle(
        webhook.send({
            attachments: [{ ...voice, stream, size: 1, waveform: fits }],
            flags: MessageFlags.VoiceMessage | MessageFlags.SuppressNotifications,
            messageReference: { type: "reply", target: { id: "401", channelId: "300" } },
        }),
    )
    expect(payloads).toEqual([
        expect.objectContaining({
            flags: MessageFlags.VoiceMessage,
            attachments: [expect.objectContaining({ duration: 25, waveform: fits })],
        }),
        expect.objectContaining({
            flags: MessageFlags.VoiceMessage | MessageFlags.SuppressNotifications,
            attachments: [expect.objectContaining({ duration: 25, waveform: fits })],
            message_reference: expect.objectContaining({ message_id: "401" }),
        }),
    ])
    for (const messageReference of [undefined, { type: "reply", target: { id: "401", channelId: "300" } }] as const) {
        const failure = await expectErr(
            webhook.send({
                attachments: [{ ...voice, data: new Uint8Array([1]), waveform: `${fits}A` }],
                flags: MessageFlags.VoiceMessage,
                ...(messageReference === undefined ? {} : { messageReference }),
            }),
        )
        expect(failure).toMatchObject({
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path: "attachments[].waveform", constraint: "length" },
        })
        expect(failure.message).toContain("256")
    }
    // Fluxer still checks the voice note itself, so the SDK keeps refusing content beside it
    expect(
        await expectErr(
            webhook.send({
                content: "hello",
                attachments: [{ ...voice, data: new Uint8Array([1]), waveform: "AAEC" }],
                flags: MessageFlags.VoiceMessage,
            }),
        ),
    ).toMatchObject({ reason: "input", inputValidation: { path: "content" } })
    expect(hostedOperationCalls(hostedFetch)).toHaveLength(2)
})

// Catches: The SDK's own waveform helper had no result that a webhook send accepts for audio over 19.2 seconds
test.each(modes)("%s sends a long voice note whose helper waveform uses 192 points", async (mode) => {
    const payloads: Record<string, any>[] = []
    stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            const headers = new Headers(init.headers)
            const form = await new Response(await new Response(init.body).arrayBuffer(), { headers }).formData()
            payloads.push(JSON.parse(String(form.get("payload_json"))))
            return Response.json(message())
        }),
    )
    const { webhook } = await setup(mode)
    // 25 seconds of audio at 1,000 samples a second
    const samples = Float32Array.from({ length: 25_000 }, (_, index) => Math.sin(index / 40))
    const helper = mode === "default" ? voiceWaveform : nativeVoiceWaveform
    const voice = { filename: "note.ogg", contentType: "audio/ogg", data: new Uint8Array([1]) }
    const fitted = helper(samples, 1_000, { maxPoints: 192 })
    await settle(webhook.send({ attachments: [{ ...voice, ...fitted }], flags: MessageFlags.VoiceMessage }))
    expect(payloads).toEqual([
        expect.objectContaining({
            attachments: [expect.objectContaining({ duration: 25, waveform: fitted.waveform })],
        }),
    ])
    // The default result keeps Fluxer's 256 points, which is too long for a webhook and fails before sending
    const failure = await expectErr(
        webhook.send({ attachments: [{ ...voice, ...helper(samples, 1_000) }], flags: MessageFlags.VoiceMessage }),
    )
    expect(failure).toMatchObject({ reason: "input", inputValidation: { path: "attachments[].waveform" } })
    expect(payloads).toHaveLength(1)
})

test.each(modes)("%s snapshots binary uploads and replays identical multipart after 429", async (mode) => {
    const clock = sdkClock()
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
    await driveSdkTime(
        clock,
        settle(webhook.send({ attachments: [{ data: bytes, filename: "report.txt", description: "Build log" }] })),
    )
    expect(observed).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])])
})

test.each(modes)("%s recreates copied webhook bytes when a 429 arrives before multipart consumption", async (mode) => {
    const clock = sdkClock()
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
    await driveSdkTime(clock, pending)
    expect(attempts).toBe(2)
    expect(observed).toEqual([new Uint8Array([4, 5, 6])])
})

test.each(modes)("%s shutdown awaits active body cleanup and rejects new requests", async (mode) => {
    let started!: () => void, release!: () => void, aborted!: () => void
    const ready = new Promise<void>((resolve) => {
        started = resolve
    })
    const cleanupStarted = new Promise<void>((resolve) => {
        aborted = resolve
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
            aborted()
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
    // Shutdown has aborted the request, whose cleanup is now held. Let any premature completion arrive first
    await cleanupStarted
    for (let index = 0; index < 5; index++) await turn()
    expect(done).toBe(false)
    release()
    await stopped
    expect(await sent).toMatchObject({ _tag: "ClientClosedError" })
    await expect(settle(webhook.fetchMessage("400"))).rejects.toMatchObject({ _tag: "ClientClosedError" })
})

test.each(modes)("%s bounds retained upload bytes and releases reservations after failure", async (mode) => {
    const hostedFetch = stubFetchWithHostedDiscovery(vi.fn(async () => Response.json(message())))
    const { webhook } = await setup(mode, { id: "100", token: secret, uploadMaxBytes: 2 })
    const oversized = settle(webhook.send({ attachments: [{ data: new Uint8Array(3), filename: "a" }] }))
    await expect(oversized).rejects.toMatchObject({
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "files" },
    })
    // Catches: The failure told a webhook caller to raise uploads.maxBytes, which only the bot client has
    const text = await oversized.catch((error: unknown) => String((error as Error).message))
    expect(text).toContain("uploadMaxBytes")
    expect(text).not.toContain("uploads.maxBytes")
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
        { id: "100", token: secret, uploadMaxBytes: null },
    ]) {
        // A null upload budget exercises untyped JavaScript configuration at the public boundary
        const failure = expectThrown(() => createWebhookClient(value as never))
        expect(failure).toBeInstanceOf(ConfigurationError)
        expect(JSON.stringify(failure)).not.toContain(secret)
        expect(inspect(failure)).not.toContain(secret)
    }
})

test.each(modes)("%s retries transient reads but never retries rejected or server-failed writes", async (mode) => {
    const clock = sdkClock()
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
    await driveSdkTime(clock, settle(webhook.fetchMessage("400")))
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

test.each(modes)("%s sends a webhook file over 50 MiB and reports Fluxer's size refusal", async (mode) => {
    const sizes: number[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        sizes.push((await new Response(init.body).arrayBuffer()).byteLength)
        return Response.json({ code: "FILE_SIZE_TOO_LARGE", message: "x" }, { status: 400 })
    })
    const { webhook } = await setup(mode)
    // A webhook uses the limits of the user who created it, which an instance can raise above 50 MiB
    const data = new Uint8Array(52_428_801)
    await expect(settle(webhook.send({ attachments: [{ data, filename: "large.bin" }] }))).rejects.toMatchObject({
        reason: "rejected",
        outcome: "rejected",
        status: 400,
        apiError: { code: "fileSizeTooLarge" },
    })
    expect(sizes).toHaveLength(1)
    expect(sizes[0]).toBeGreaterThan(52_428_801)
})

test.each(modes)("%s reports busy upload slots as rejected only for Fluxer's own multipart answer", async (mode) => {
    let calls = 0
    let answer = () =>
        Response.json({ code: "SERVICE_UNAVAILABLE", message: "x" }, { status: 503, headers: { "retry-after": "5" } })
    stubFetchWithHostedDiscovery(
        vi.fn(async (_url: string, init: RequestInit) => {
            calls++
            // Fluxer reads the files before it answers
            if (init.body) await new Response(init.body).arrayBuffer()
            return answer()
        }),
    )
    const { webhook } = await setup(mode)
    const withFile = { content: "x", attachments: [{ data: new Uint8Array([1]), filename: "file.bin" }] }
    // Fluxer answers this way while it reads the files, before anything is applied, so a later send cannot duplicate it
    const busy = await expectErr(webhook.send(withFile))
    expect(busy).toMatchObject({
        reason: "rejected",
        outcome: "rejected",
        status: 503,
        retryAfterMs: 5000,
        apiError: { providerCode: "SERVICE_UNAVAILABLE" },
    })
    expect(calls).toBe(1)
    // Nothing was applied, so the same call may run again after the wait, unless it read a stream
    expect(busy.details.uploadSlotsBusy).toBe(true)
    expect(errors.isRetryable(busy)).toBe(true)
    expect(errors.retryAfterMs(busy)).toBe(5000)
    expect(busy.hint).toContain("Wait at least 5000 ms")
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array([1]))
            controller.close()
        },
    })
    const streamed = await expectErr(
        webhook.send({ content: "x", attachments: [{ stream, size: 1, filename: "file.bin" }] }),
    )
    expect(streamed).toMatchObject({ outcome: "rejected", details: expect.objectContaining({ streamUsed: true }) })
    expect(errors.isRetryable(streamed)).toBe(false)
    expect(streamed.hint).toContain("new stream")
    // A JSON send never waits for an upload slot, and Fluxer's other 503 answers can come after a message was saved
    await expect(settle(webhook.send({ content: "x" }))).rejects.toMatchObject({ status: 503, outcome: "unknown" })
    for (const other of [
        () =>
            Response.json(
                { code: "SERVICE_UNAVAILABLE", message: "x" },
                { status: 503, headers: { "retry-after": "1" } },
            ),
        () => Response.json({ code: "SERVICE_UNAVAILABLE", message: "x" }, { status: 503 }),
        () => new Response("Service Unavailable", { status: 503, headers: { "retry-after": "5" } }),
        () =>
            Response.json(
                { code: "SERVICE_UNAVAILABLE", message: "x" },
                { status: 500, headers: { "retry-after": "5" } },
            ),
    ]) {
        answer = other
        const failure = await expectErr(webhook.send(withFile))
        expect(failure).toMatchObject({ outcome: "unknown" })
        expect(failure.details).not.toHaveProperty("uploadSlotsBusy")
        expect(errors.isRetryable(failure)).toBe(false)
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
    const failure = await expectErr(webhook.send({ content: "x" }))
    expect(failure).toMatchObject({
        _tag: "WebhookOperationError",
        reason: "rejected",
        outcome: "rejected",
        status: 403,
        apiError: {
            code: "missingPermissions",
            providerCode: "MISSING_PERMISSIONS",
            explanation: expect.any(String),
        },
    })
    expect(JSON.stringify(failure)).not.toContain(privateMessage)
})

test.each(modes)("%s cancellation waits for owned cleanup without stopping the client", async (mode) => {
    let started!: () => void, release!: () => void, aborted!: () => void
    const ready = new Promise<void>((resolve) => {
        started = resolve
    })
    const cleanupStarted = new Promise<void>((resolve) => {
        aborted = resolve
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
            aborted()
            await cleanup
            throw new Error("aborted")
        }),
    )
    const { webhook } = await setup(mode)
    const operation =
        mode === "default"
            ? (webhook as import("../../../src/index.js").WebhookClient).send(
                  { content: "x" },
                  { signal: controller.signal },
              )
            : (webhook as import("../../../src/effect.js").WebhookClient).send({ content: "x" })
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
    // The request's cleanup is now held. Let any premature completion arrive first
    await cleanupStarted
    for (let index = 0; index < 5; index++) await turn()
    expect(done).toBe(false)
    release()
    await result
    stubFetchWithHostedDiscovery(vi.fn(async () => Response.json(message())))
    await settle(webhook.send({ content: "After cancellation" }))
})

test.each(modes)("%s bounds webhook response bytes and cancels the body", async (mode) => {
    const { webhook } = await setup(mode)
    let cancelled = false
    stubFetchWithHostedDiscovery(
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(new Uint8Array(16_777_217))
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
    server.listen(0, await fixtureHost())
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
    stubFetchWithHostedDiscovery((_url: string, init: RequestInit) =>
        fetch(`http://${address.address}:${address.port}`, init),
    )
    const { webhook } = await setup("default")
    await settle(
        webhook.send({
            attachments: [{ filename: "a.txt", data: new Uint8Array([5, 6]) }],
            messageReference: { type: "reply", target: { id: "401", channelId: "300" } },
        }),
    )
    expect(received).toBe(true)
})
