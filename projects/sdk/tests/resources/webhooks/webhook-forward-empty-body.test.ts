import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createWebhookClient } from "../../../src/index.js"
import { createWebhookClient as createNativeWebhook } from "../../../src/effect.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { expectErr, settle } from "../../support/settle.js"

// These follow Fluxer at commit 0098958f. A webhook forward is refused only when data.content is truthy or the embed,
// attachment or sticker list is nonempty (fluxer_api/src/api/channel/services/message/MessageSendService.ts:310,
// 395-413). Content is normalized first (MessageRequestSchemas.ts:330, SchemaPrimitives.ts:185-187), so null, an empty
// string and a blank string all pass beside a forward, as do empty lists

const notDispatched = { reason: "input", outcome: "notDispatched" }
const source = { source: { source: { channelId: "300", id: "401" } } }
const forward = { type: "forward", ...source } as const

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

const webhookMessage = {
    id: "402",
    channel_id: "300",
    webhook_id: "100",
    content: "",
    author: { id: "100", username: "Deployments", bot: true },
}

afterEach(() => vi.unstubAllGlobals())

test.each(modes)("%s sends a webhook forward beside null, empty or blank content and empty lists", async (mode) => {
    const webhook = await webhookClient(mode)
    const bodies: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        if (String(url).includes("/webhooks/")) bodies.push(JSON.parse(String(init.body)))
        return Response.json(webhookMessage)
    })
    // Fails on the old code: Any content, embeds, attachments or stickerIds key beside a forward failed locally
    for (const extra of [
        { content: null },
        { content: "" },
        { content: " \n\u000c‮" },
        { embeds: [] },
        { attachments: [] },
        { stickerIds: [] },
        { stickerIds: null },
        { content: null, embeds: [], attachments: [], stickerIds: [] },
    ] as const)
        await settle(webhook.send({ ...extra, messageReference: forward }))
    expect(bodies).toHaveLength(8)
    expect(
        bodies.map(({ content, embeds, attachments, sticker_ids }) => ({ content, embeds, attachments, sticker_ids })),
    ).toEqual([
        { content: null },
        { content: "" },
        { content: " \n\u000c‮" },
        { embeds: [] },
        { attachments: [] },
        { sticker_ids: [] },
        { sticker_ids: null },
        { content: null, embeds: [], attachments: [], sticker_ids: [] },
    ])
    for (const body of bodies)
        expect(body.message_reference).toMatchObject({ message_id: "401", channel_id: "300", type: 1 })
})

test.each(modes)("%s still refuses a webhook forward beside text, embeds, uploads or stickers", async (mode) => {
    const webhook = await webhookClient(mode)
    const fetch = stubFetchWithHostedDiscovery(async () => Response.json(webhookMessage))
    for (const extra of [
        { content: "Hi" },
        // A zero-width space is not removed by Fluxer's normalization, so it counts as text
        { content: "​" },
        { embeds: [{ title: "Deploy" }] },
        { attachments: [{ name: "a.txt", data: new Uint8Array(1) }] },
        { stickerIds: ["500"] },
    ])
        expect(
            await expectErr(webhook.send({ ...(extra as object), messageReference: forward } as never)),
        ).toMatchObject({ ...notDispatched, inputValidation: { path: "messageReference", constraint: "relationship" } })
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("/webhooks/"))).toHaveLength(0)
})
