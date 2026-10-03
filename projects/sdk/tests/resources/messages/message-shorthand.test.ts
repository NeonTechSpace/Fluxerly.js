import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { builders, createWebhookClient, MessageType } from "../../../src/index.js"
import { createWebhookClient as createNativeWebhook, MessageType as NativeMessageType } from "../../../src/effect.js"
import { modes, setup, type Mode } from "../../support/both-apis.js"
import { hostedOperationCalls, stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { settle } from "../../support/settle.js"

afterEach(() => vi.unstubAllGlobals())

/** A created or edited message in the addressed channel, keeping an edited message's ID and marking webhook messages */
function messageWire(path: string) {
    const [, , resource, owner] = path.split("/")
    return {
        id: /\/messages\/(\d+)$/.exec(path)?.[1] ?? "400",
        channel_id: resource === "channels" ? owner : "300",
        content: "Sent",
        author: { id: "30", username: "fixture" },
        ...(resource === "webhooks" ? { webhook_id: owner } : {}),
    }
}

/** Record each message write's method, path and JSON body, answering with the written message */
function recordWrites() {
    const writes: { method: string; path: string; body: Record<string, unknown> }[] = []
    const fetch = stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname
        if (path === "/v1/users/@me/channels")
            return Response.json({
                id: "301",
                type: 1,
                recipients: [
                    {
                        id: "30",
                        username: "fixture",
                        discriminator: "0001",
                        global_name: null,
                        avatar: null,
                        avatar_color: null,
                        flags: 0,
                    },
                ],
            })
        writes.push({ method: init.method ?? "GET", path, body: JSON.parse(String(init.body)) })
        return Response.json(messageWire(path))
    })
    return { writes, fetch }
}

test.each(modes)("%s sends, replies, edits and direct messages accept a plain string as the content", async (mode) => {
    const client = await setup(mode)
    const { writes } = recordWrites()
    const target = { channelId: "300", id: "399" }

    await settle(client.messages.send("300", "Hello"))
    await settle(client.messages.reply(target, "Reply"))
    await settle(client.messages.edit(target, "Edited"))
    await settle(client.directMessages.send("30", "Private"))

    expect(writes.map(({ method, path, body }) => [method, path, body.content])).toEqual([
        ["POST", "/v1/channels/300/messages", "Hello"],
        ["POST", "/v1/channels/300/messages", "Reply"],
        ["PATCH", "/v1/channels/300/messages/399", "Edited"],
        ["POST", "/v1/channels/301/messages", "Private"],
    ])
    // The shorthand is a whole message, so the reply keeps its reference and embeds stay unchanged in the edit
    expect(writes[1]!.body.message_reference).toMatchObject({ message_id: "399", channel_id: "300" })
    expect(writes[2]!.body).not.toHaveProperty("embeds")
})

test.each(modes)("%s rejects an empty string like empty content, before any request", async (mode) => {
    const client = await setup(mode)
    const { fetch } = recordWrites()
    await expect(settle<unknown, unknown>(client.messages.send("300", ""))).rejects.toMatchObject({
        reason: "input",
        outcome: "notDispatched",
        inputValidation: { path: "input", constraint: "required" },
    })
    expect(hostedOperationCalls(fetch)).toHaveLength(0)
})

test.each(modes)("%s message embeds accept an EmbedBuilder, built when the operation reads its input", async (mode) => {
    const client = await setup(mode)
    const { writes } = recordWrites()
    const embed = builders.embed().title("Status").field("Shard", "0", { inline: true })

    await settle(client.messages.send("300", { embeds: [embed, { description: "Plain" }] }))
    // Changing the builder after the call does not change a message that was already sent
    embed.title("Changed")
    await settle(client.messages.edit({ channelId: "300", id: "399" }, { content: "Edited", embeds: [embed] }))

    expect(writes.map(({ body }) => body.embeds)).toEqual([
        [{ title: "Status", fields: [{ name: "Shard", value: "0", inline: true }] }, { description: "Plain" }],
        [{ title: "Changed", fields: [{ name: "Shard", value: "0", inline: true }] }],
    ])
})

async function webhook(mode: Mode) {
    if (mode === "default") {
        const client = createWebhookClient({ id: "100", token: "test_only_secret" })
        onTestFinished(async () => void (await client.shutdown()))
        return client
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(
        createNativeWebhook({ id: "100", token: "test_only_secret" }).pipe(Effect.provideService(Scope.Scope, scope)),
    )
}

test.each(modes)("%s webhook sends and edits accept a plain string and an EmbedBuilder", async (mode) => {
    const client = await webhook(mode)
    const { writes } = recordWrites()

    await settle(client.send("Deploying"))
    await settle(client.editMessage("400", "Deployed"))
    await settle(client.editMessage("400", { embeds: [builders.embed().title("Done")] }))

    expect(writes.map(({ method, body }) => [method, body.content, body.embeds])).toEqual([
        ["POST", "Deploying", undefined],
        ["PATCH", "Deployed", undefined],
        ["PATCH", undefined, [{ title: "Done" }]],
    ])
})

test("MessageType names the type numbers Fluxer reports, and both APIs export the same table", () => {
    // Fluxer's MessageTypes at the pinned upstream revision, excluding its client-only CLIENT_SYSTEM value
    expect({ ...MessageType }).toEqual({
        Default: 0,
        RecipientAdd: 1,
        RecipientRemove: 2,
        Call: 3,
        ChannelNameChange: 4,
        ChannelIconChange: 5,
        ChannelPinnedMessage: 6,
        UserJoin: 7,
        ChannelFollowAdd: 12,
        Reply: 19,
    })
    expect(NativeMessageType).toBe(MessageType)
})

test.each(modes)("%s Message.type compares against MessageType", async (mode) => {
    const client = await setup(mode)
    stubFetchWithHostedDiscovery(async () =>
        Response.json({ ...messageWire("/v1/channels/300/messages/400"), type: 7 }),
    )
    const message = await settle(client.messages.fetch({ channelId: "300", id: "400" }))
    expect(message.type).toBe(MessageType.UserJoin)
})
