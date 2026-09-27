import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createWebhookClient } from "../../../src/index.js"
import { createWebhookClient as createNativeWebhook } from "../../../src/effect.js"
import { modes, setup, type Mode } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { expectErr, settle } from "../../support/settle.js"

// A getter that returns one value to validation and another to a later read would let invalid or unintended values
// reach Fluxer. Every send-like encoder must read each caller field once and send the value it validated

afterEach(() => vi.unstubAllGlobals())

const messageWire = (extra: Record<string, unknown> = {}) => ({
    id: "400",
    channel_id: "300",
    content: "validated",
    author: { id: "30", username: "fixture" },
    ...extra,
})

/** Record JSON request bodies, opening direct-message channel 301 and echoing a message for every send */
function recordSends() {
    const bodies: { method: string; path: string; body: Record<string, unknown> }[] = []
    const fetch = stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
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
        bodies.push({ method: init.method ?? "GET", path, body })
        return Response.json(messageWire({ channel_id: path.split("/")[3], webhook_id: "100" }))
    })
    return { bodies, fetch }
}

/**
 * Define getters that return their first value on the first read and their later value afterwards, counting reads.
 * The later values are chosen so that a second read would send something validation never accepted
 */
function flipping<T extends object>(target: T, fields: Record<string, readonly [first: unknown, later: unknown]>) {
    const reads: Record<string, number> = {}
    for (const [key, [first, later]] of Object.entries(fields)) {
        reads[key] = 0
        Object.defineProperty(target, key, {
            enumerable: true,
            get() {
                reads[key] = (reads[key] ?? 0) + 1
                return reads[key] === 1 ? first : later
            },
        })
    }
    return { input: target, reads }
}

const once = (reads: Record<string, number>) => Object.fromEntries(Object.keys(reads).map((key) => [key, 1] as const))

test.each(modes)("%s sends read each message field once and send the validated values", async (mode) => {
    const client = await setup(mode)
    const { bodies } = recordSends()
    const mentions = flipping({}, { everyone: [false, true], repliedUser: [false, true] })
    const message = flipping(
        {},
        {
            content: ["validated", 42],
            flags: [4, 1],
            tts: [true, "later"],
            allowedMentions: [mentions.input, { everyone: true }],
            messageReference: [
                { id: "399", channelId: "300" },
                { id: "1", channelId: "300" },
            ],
        },
    )
    const stickers = flipping({}, { stickerIds: [["500"], "later"] })
    const embeds = flipping({}, { embeds: [[{ title: "validated" }], [{ title: "later" }]] })

    await settle(client.messages.send("300", message.input as never))
    await settle(client.messages.send("300", stickers.input as never))
    await settle(client.messages.send("300", embeds.input as never))

    expect(message.reads).toEqual(once(message.reads))
    expect(mentions.reads).toEqual(once(mentions.reads))
    expect(stickers.reads).toEqual(once(stickers.reads))
    expect(embeds.reads).toEqual(once(embeds.reads))
    expect(bodies.map(({ body }) => body)).toEqual([
        expect.objectContaining({
            content: "validated",
            flags: 4,
            tts: true,
            allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
            message_reference: { message_id: "399", channel_id: "300", type: 0 },
        }),
        expect.objectContaining({ sticker_ids: ["500"] }),
        expect.objectContaining({ embeds: [{ title: "validated" }] }),
    ])
})

test.each(modes)("%s replies read each message field once and send the validated values", async (mode) => {
    const client = await setup(mode)
    const { bodies } = recordSends()
    const reply = flipping({}, { content: ["validated", 42], flags: [4096, 1] })

    await settle(client.messages.reply({ channelId: "300", id: "399" }, reply.input as never))

    expect(reply.reads).toEqual(once(reply.reads))
    expect(bodies[0]?.body).toMatchObject({
        content: "validated",
        flags: 4096,
        message_reference: { message_id: "399", channel_id: "300", type: 0 },
    })
})

test.each(modes)("%s direct messages read messageReference once and never send a later reference", async (mode) => {
    const client = await setup(mode)
    const { bodies } = recordSends()
    const direct = flipping(
        { content: "validated" },
        { messageReference: [undefined, { id: "399", channelId: "301" }] },
    )

    await settle(client.directMessages.send("30", direct.input as never))
    const rejected = flipping(
        { content: "validated" },
        { messageReference: [{ id: "399", channelId: "301" }, undefined] },
    )
    const failure = await expectErr(client.directMessages.send("30", rejected.input as never))

    expect(direct.reads).toEqual({ messageReference: 1 })
    expect(rejected.reads).toEqual({ messageReference: 1 })
    expect(failure).toMatchObject({ reason: "input", inputValidation: { path: "messageReference" } })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.body).not.toHaveProperty("message_reference")
})

test.each(modes)("%s edits read each field and retained attachment field once", async (mode) => {
    const client = await setup(mode)
    const { bodies } = recordSends()
    const attachment = flipping({}, { id: ["40", "41"], title: ["validated", ""] })
    const edit = flipping(
        {},
        { content: ["validated", 42], flags: [4, 1], attachments: [[attachment.input], [{ id: "41" }]] },
    )

    await settle(client.messages.edit({ channelId: "300", id: "400" }, edit.input as never))

    expect(edit.reads).toEqual(once(edit.reads))
    expect(attachment.reads).toEqual(once(attachment.reads))
    expect(bodies[0]).toMatchObject({
        method: "PATCH",
        body: { content: "validated", flags: 4, attachments: [{ id: "40", title: "validated" }] },
    })
})

test.each(modes)("%s new attachments read each attachment field once during validation", async (mode) => {
    const client = await setup(mode)
    const { fetch } = recordSends()
    const attachment = flipping(
        {},
        {
            data: [new Uint8Array([1, 2, 3]), "later"],
            filename: ["validated.bin", "later/invalid"],
            contentType: ["application/octet-stream", "\n"],
            title: ["validated", ""],
            description: ["validated", ""],
            spoiler: [false, "later"],
        },
    )
    // Only data is an own property here, so the entry is a byte attachment whose other fields are inherited getters
    const entry = Object.create(attachment.input) as Record<string, unknown>
    Object.defineProperty(entry, "data", Object.getOwnPropertyDescriptor(attachment.input, "data")!)

    // Invalid flags stop the send after attachment validation, so no upload starts
    const failure = await expectErr(client.messages.send("300", { attachments: [entry], flags: 1 } as never))

    expect(failure).toMatchObject({ reason: "input", inputValidation: { path: "flags" } })
    expect(attachment.reads).toEqual(once(attachment.reads))
    expect(fetch).not.toHaveBeenCalled()
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

test.each(modes)("%s webhook replies read the reference type and target once", async (mode) => {
    const client = await webhook(mode)
    const { bodies } = recordSends()
    const reference = flipping(
        {},
        {
            type: ["reply", "forward"],
            target: [
                { channelId: "300", id: "399" },
                { channelId: "302", id: "1" },
            ],
        },
    )

    await settle(client.send({ content: "validated", messageReference: reference.input } as never))

    expect(reference.reads).toEqual(once(reference.reads))
    expect(bodies[0]?.body).toMatchObject({
        content: "validated",
        message_reference: { message_id: "399", channel_id: "300", type: 0 },
    })
})
