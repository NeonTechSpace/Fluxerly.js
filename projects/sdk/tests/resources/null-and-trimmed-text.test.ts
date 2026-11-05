import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { createWebhookClient, MessageFlags } from "../../src/index.js"
import { createWebhookClient as createNativeWebhook } from "../../src/effect.js"
import { modes, type Mode } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { expectErr, settle } from "../support/settle.js"

// These follow Fluxer at commit 0098958f. Message sends, edits and webhook messages accept null content
// (MessageRequestSchemas.ts:336, WebhookRequestSchemas.ts:90, 158-160), and an edit with null content clears the text
// (MessagePersistenceService.ts:435-449). New attachments accept null metadata (AttachmentSchemas.ts:15-29), except in a
// webhook send's multipart schema (WebhookRequestSchemas.ts:64-86). Nonces and message search text are checked after
// normalizeString trims them (SchemaPrimitives.ts:20-22, 176-183, MessageRequestSchemas.ts:235-324)

async function open(mode: Mode) {
    if (mode === "default") {
        const test = createDefaultTestClient()
        onTestFinished(() => test.shutdown())
        return test
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
}

async function webhookClient(mode: Mode) {
    const options = { id: "100", token: "test_only_secret" }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const webhook =
        mode === "native"
            ? await Effect.runPromise(createNativeWebhook(options).pipe(Effect.provideService(Scope.Scope, scope)))
            : createWebhookClient(options)
    onTestFinished(async () => {
        const stopped = webhook.shutdown()
        await (Effect.isEffect(stopped) ? Effect.runPromise(stopped) : stopped)
    })
    return webhook
}

/** The JSON body of a recorded webhook request, read from payload_json when the request is multipart */
async function requestJson(init: RequestInit): Promise<Record<string, unknown>> {
    if (init.body instanceof FormData) return JSON.parse(String(init.body.get("payload_json")))
    if (typeof init.body === "string") return JSON.parse(init.body)
    const text = await new Response(init.body).text()
    const part = /name="payload_json"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1]
    return JSON.parse(part ?? text)
}

const webhookMessage = {
    id: "400",
    channel_id: "300",
    webhook_id: "100",
    content: "",
    author: { id: "100", username: "Deployments", bot: true },
}

const body = (route: { requests(): readonly { body?: unknown }[] }, index = 0) =>
    route.requests()[index]?.body as Record<string, unknown> | undefined

const notDispatched = { reason: "input", outcome: "notDispatched" }

afterEach(() => vi.unstubAllGlobals())

test.each(modes)("%s sends null content with an embed and refuses null content alone", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("POST /channels/20/messages", { body: api.fixtures.message({ channel_id: "20" }) })
    await settle(api.client.messages.send("20", { content: null, embeds: [{ title: "Report" }] }))
    expect(body(route)).toMatchObject({ content: null, embeds: [{ title: "Report" }] })
    expect(await expectErr(api.client.messages.send("20", { content: null } as never))).toMatchObject({
        ...notDispatched,
        inputValidation: { path: "input", constraint: "required" },
    })
    // Fluxer reads the mention settings when content is present, null included (MessageSendService.ts:757-759)
    expect(
        await expectErr(
            api.client.messages.send("20", {
                content: null,
                embeds: [{ title: "Report" }],
                allowedMentions: { everyone: true, users: ["30"] },
            }),
        ),
    ).toMatchObject({ ...notDispatched, inputValidation: { path: "allowedMentions" } })
    expect(route.requests()).toHaveLength(1)
})

test.each(modes)("%s clears message text with null content and keeps the empty-edit rule", async (mode) => {
    const api = await open(mode)
    const target = { channelId: "20", id: "10" }
    const route = api.rest.respond("PATCH /channels/20/messages/10", {
        body: api.fixtures.message({ id: "10", channel_id: "20" }),
    })
    expect(await expectErr(api.client.messages.edit(target, { content: null } as never))).toMatchObject(notDispatched)
    expect(route.requests()).toHaveLength(0)
    await settle(api.client.messages.edit(target, { content: null, flags: 0 }))
    expect(body(route, 0)).toMatchObject({ content: null, flags: 0 })
    await settle(api.client.messages.edit(target, { content: null, embeds: [{ title: "Kept" }] }))
    expect(body(route, 1)).toMatchObject({ content: null, embeds: [{ title: "Kept" }] })
})

test.each(modes)("%s sends null content in webhook sends and edits", async (mode) => {
    const webhook = await webhookClient(mode)
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(await requestJson(init))
        return Response.json(webhookMessage)
    })
    await settle(webhook.send({ content: null, embeds: [{ title: "Deploy" }] }))
    expect(bodies[0]).toMatchObject({ content: null, embeds: [{ title: "Deploy" }] })
    expect(await expectErr(webhook.editMessage("400", { content: null }))).toMatchObject(notDispatched)
    expect(bodies).toHaveLength(1)
    await settle(webhook.editMessage("400", { content: null, flags: 0 }))
    expect(bodies[1]).toMatchObject({ content: null, flags: 0 })
})

test.each(modes)("%s sends null metadata on a new attachment", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("POST /channels/20/messages", { body: api.fixtures.message({ channel_id: "20" }) })
    const file = { data: new Uint8Array([1]), filename: "notes.txt" }
    await settle(
        api.client.messages.send("20", {
            attachments: [{ ...file, title: null, description: null, duration: null, waveform: null }],
        }),
    )
    expect(body(route)?.attachments).toEqual([
        expect.objectContaining({ title: null, description: null, duration: null, waveform: null }),
    ])
    // A voice note still needs a waveform and a duration that are not null (MessageValidationService.ts:223-234)
    const voice = { data: new Uint8Array([1]), filename: "voice.ogg", contentType: "audio/ogg" }
    expect(
        await expectErr(
            api.client.messages.send("20", {
                flags: MessageFlags.VoiceMessage,
                attachments: [{ ...voice, duration: 2, waveform: null }],
            }),
        ),
    ).toMatchObject({ ...notDispatched, inputValidation: { path: "attachments[].waveform" } })
    expect(
        await expectErr(
            api.client.messages.send("20", {
                flags: MessageFlags.VoiceMessage,
                attachments: [{ ...voice, duration: null, waveform: "AAAA" }],
            }),
        ),
    ).toMatchObject({ ...notDispatched, inputValidation: { path: "attachments[].duration" } })
    expect(route.requests()).toHaveLength(1)
})

test.each(modes)("%s allows only a null title on a webhook attachment", async (mode) => {
    const webhook = await webhookClient(mode)
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(await requestJson(init))
        return Response.json(webhookMessage)
    })
    const file = { data: new Uint8Array([1]), filename: "notes.txt" }
    for (const key of ["description", "duration", "waveform"])
        expect(await expectErr(webhook.send({ attachments: [{ ...file, [key]: null }] }))).toMatchObject({
            ...notDispatched,
            inputValidation: { path: `attachments[].${key}` },
        })
    expect(bodies).toHaveLength(0)
    await settle(webhook.send({ attachments: [{ ...file, title: null }] }))
    expect(bodies[0]?.attachments).toEqual([expect.objectContaining({ title: null })])
})

test.each(modes)("%s checks nonces after Fluxer's trimming", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("POST /channels/20/messages", { body: api.fixtures.message({ channel_id: "20" }) })
    for (const nonce of [" ", "\f‮ ", ` ${"n".repeat(33)} `])
        expect(await expectErr(api.client.messages.send("20", { content: "Hi", nonce }))).toMatchObject({
            ...notDispatched,
            inputValidation: { path: "nonce", constraint: "length" },
        })
    expect(route.requests()).toHaveLength(0)
    // Surrounding whitespace does not count, and the nonce is sent as given
    const padded = `  ${"n".repeat(32)}  `
    await settle(api.client.messages.send("20", { content: "Hi", nonce: padded }))
    expect(body(route)?.nonce).toBe(padded)
})

test.each(modes)("%s refuses a blank webhook nonce", async (mode) => {
    const webhook = await webhookClient(mode)
    const fetch = stubFetchWithHostedDiscovery(async () => Response.json(webhookMessage))
    expect(await expectErr(webhook.send({ content: "Hi", nonce: "   " }))).toMatchObject({
        ...notDispatched,
        inputValidation: { path: "nonce" },
    })
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("/webhooks/"))).toHaveLength(0)
})

test.each(modes)("%s checks message search text after Fluxer's trimming", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("POST /search/messages", {
        body: { messages: [], channels: [], total: 0, hits_per_page: 25, page: 1 },
    })
    for (const query of [
        { content: "   " },
        { content: "\f‮" },
        { contents: ["ok", " "] },
        { exactPhrases: [" "] },
        { embedProviders: [" "] },
        { excludeLinkHostnames: [" "] },
        { attachmentFilenames: ["\t"] },
        { attachmentExtensions: [" "] },
    ])
        expect(await expectErr(api.client.messages.search({ channelId: "20" }, query))).toMatchObject(notDispatched)
    expect(route.requests()).toHaveLength(0)
    const padded = ` ${"a".repeat(1024)} `
    await settle(api.client.messages.search({ channelId: "20" }, { content: padded, attachmentExtensions: [" png "] }))
    expect(body(route)).toMatchObject({ content: padded, attachment_extension: [" png "] })
})

test.each(modes)("%s checks webhook overrides as Fluxer does and accepts null for them", async (mode) => {
    const webhook = await webhookClient(mode)
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(await requestJson(init))
        return Response.json(webhookMessage)
    })
    // Fluxer reads both as nullish, and null keeps the webhook's own name and avatar (WebhookRequestSchemas.ts:106-107)
    await settle(webhook.send({ content: "Hi", username: null, avatarUrl: null }))
    expect(bodies[0]).toMatchObject({ username: null, avatar_url: null })
    // URLType checks the normalized value: A lowercase scheme and no @ before the path (UrlValidators.ts:28-50)
    for (const avatarUrl of ["HTTPS://cdn.example.com/a.png", "https://@cdn.example.com/a.png", "   "])
        expect(await expectErr(webhook.send({ content: "Hi", avatarUrl }))).toMatchObject({
            ...notDispatched,
            inputValidation: { path: "avatarUrl" },
        })
    expect(bodies).toHaveLength(1)
    const marked = "‮https://cdn.example.com/a.png"
    await settle(webhook.send({ content: "Hi", avatarUrl: marked }))
    expect(bodies[1]).toMatchObject({ avatar_url: marked })
})

test.each(modes)("%s sends everyone with listed users on a webhook forward", async (mode) => {
    const webhook = await webhookClient(mode)
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(await requestJson(init))
        return Response.json(webhookMessage)
    })
    // Fluxer reads no mention settings on a forward (MessageSendService.ts:1083-1085)
    await settle(
        webhook.send({
            messageReference: { type: "forward", source: { source: { id: "401", channelId: "300" } } },
            allowedMentions: { everyone: true, users: ["30"] },
        }),
    )
    expect(bodies[0]).not.toHaveProperty("embeds")
    expect(bodies[0]).not.toHaveProperty("content")
    expect(bodies[0]?.allowed_mentions).toMatchObject({ parse: ["everyone"], users: ["30"] })
})

test.each(modes)("%s accepts an embed reference that several uploads share", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("POST /channels/20/messages", { body: api.fixtures.message({ channel_id: "20" }) })
    // Fluxer keeps the stored names in a set and the last upload wins (MessageEmbedAttachmentResolver.ts:49-58, 124-143)
    await settle(
        api.client.messages.send("20", {
            embeds: [{ image: { url: "attachment://a_b.png" } }],
            attachments: [
                { data: new Uint8Array([1]), filename: "a b.png" },
                { data: new Uint8Array([2]), filename: "a_b.png" },
            ],
        }),
    )
    expect(body(route)?.embeds).toEqual([expect.objectContaining({ image: { url: "attachment://a_b.png" } })])
})
