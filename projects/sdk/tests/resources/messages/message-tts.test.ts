import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createWebhookClient } from "../../../src/index.js"
import { createWebhookClient as createNativeWebhook } from "../../../src/effect.js"
import { modes, setup, type Mode } from "../../support/both-apis.js"
import { hostedOperationCalls, stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { settle } from "../../support/settle.js"

afterEach(() => vi.unstubAllGlobals())

const messageWire = (extra: Record<string, unknown> = {}) => ({
    id: "400",
    channel_id: "300",
    content: "Spoken",
    author: { id: "30", username: "fixture" },
    ...extra,
})

/** Record every JSON request body and answer with a message echoing the requested tts value */
function recordSends() {
    const bodies: { path: string; body: Record<string, unknown> }[] = []
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
        bodies.push({ path, body })
        return Response.json(messageWire({ channel_id: path.split("/")[3], tts: body.tts ?? false }))
    })
    return { bodies, fetch }
}

test.each(modes)("%s sends tts on channel sends, replies and direct messages and reads it back", async (mode) => {
    const client = await setup(mode)
    const { bodies } = recordSends()

    const sent = await settle(client.messages.send("300", { content: "Spoken", tts: true }))
    const replied = await settle(
        client.messages.reply({ channelId: "300", id: "399" }, { content: "Spoken", tts: false }),
    )
    const direct = await settle(client.directMessages.send("30", { content: "Spoken", tts: true }))
    const plain = await settle(client.messages.send("300", { content: "Plain" }))

    expect(bodies.map(({ path, body }) => [path, body.tts])).toEqual([
        ["/v1/channels/300/messages", true],
        ["/v1/channels/300/messages", false],
        ["/v1/channels/301/messages", true],
        ["/v1/channels/300/messages", undefined],
    ])
    // An omitted value is not sent, so Fluxer applies its default
    expect(bodies.at(-1)!.body).not.toHaveProperty("tts")
    expect([sent.tts, replied.tts, direct.tts, plain.tts]).toEqual([true, false, true, false])
})

test.each(modes)("%s rejects a non-boolean tts before any request", async (mode) => {
    const client = await setup(mode)
    const { fetch } = recordSends()
    for (const operation of [
        () => client.messages.send("300", { content: "Spoken", tts: "yes" } as never),
        () => client.messages.reply({ channelId: "300", id: "399" }, { content: "Spoken", tts: 1 } as never),
        () => client.directMessages.send("30", { content: "Spoken", tts: null } as never),
    ])
        await expect(settle<unknown, unknown>(operation())).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path: "tts", constraint: "type" },
        })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s treats a non-boolean response tts as malformed and honours messageFields", async (mode) => {
    let response: unknown = messageWire({ tts: "true" })
    stubFetchWithHostedDiscovery(async () => Response.json(response))
    const client = await setup(mode)
    await expect(settle(client.messages.fetch({ channelId: "300", id: "400" }))).rejects.toMatchObject({
        reason: "response",
    })

    response = messageWire({ tts: true })
    const selected = await setup(mode, { messageFields: ["tts"] })
    expect((await settle(selected.messages.fetch({ channelId: "300", id: "400" }))).tts).toBe(true)
    const excluded = await setup(mode, { messageFields: ["pinned"] })
    expect(await settle(excluded.messages.fetch({ channelId: "300", id: "400" }))).not.toHaveProperty("tts")
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

test.each(modes)("%s webhook sends, replies and forwards reject tts before dispatch", async (mode) => {
    const client = await webhook(mode)
    const fetch = stubFetchWithHostedDiscovery(async () => Response.json(messageWire({ webhook_id: "100" })))
    const target = { channelId: "300", id: "399" }

    // Fluxer never sends a webhook message as text-to-speech, so the input type and runtime validation omit tts
    // @ts-expect-error tts is not part of WebhookMessageInput
    const typed = client.send({ content: "Spoken", tts: true })
    for (const operation of [
        typed,
        client.send({ content: "Spoken", tts: false, messageReference: { type: "reply", target } } as never),
        client.send({ messageReference: { type: "forward", source: target }, tts: true } as never),
    ])
        await expect(settle<unknown, unknown>(operation)).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path: "input", constraint: "allowedFields" },
        })
    expect(hostedOperationCalls(fetch)).toHaveLength(0)

    expect((await settle(client.send({ content: "Plain" }))).webhookId).toBe("100")
    expect(hostedOperationCalls(fetch)).toHaveLength(1)
})
