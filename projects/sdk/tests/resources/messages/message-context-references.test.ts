import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { MessageFlags, MessageType, type Message, type MessageCore, type MessageFields } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { expectErr, settle } from "../../support/settle.js"

const target = { id: "10", channelId: "20" }
const source = { channel_id: "70", guild_id: "80", type: 0 }

// Matches the pinned upstream MessageResponseSchemas reference variants, rather than an SDK fixture's defaults
const wireMessage = (overrides: Record<string, unknown> = {}) => ({
    id: target.id,
    channel_id: target.channelId,
    guild_id: "40",
    content: "Announcement context",
    author: { id: "30", username: "fixture", bot: true },
    timestamp: "2026-10-03T12:00:00.000Z",
    edited_timestamp: null,
    type: 12,
    flags: 0,
    pinned: false,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    embeds: [],
    attachments: [],
    stickers: [],
    message_reference: source,
    ...overrides,
})

const contexts = [
    { name: "channel follow without message_id", reference: source, type: 12, flags: 0, id: undefined },
    {
        name: "channel follow with null message_id",
        reference: { ...source, message_id: null },
        type: 12,
        flags: 0,
        id: undefined,
    },
    {
        name: "published copy",
        reference: { ...source, message_id: "90" },
        type: 0,
        flags: 2,
        id: "90",
    },
] as const
const selections: { label: string; fields: MessageFields | undefined }[] = [
    { label: "full", fields: undefined },
    { label: "minimal", fields: [] },
]
const cases = modes.flatMap((mode) => selections.map((selection) => ({ mode, ...selection })))

async function open(mode: Mode, messageFields: MessageFields | undefined) {
    const options = {
        messageFields,
        gateway: { ignoredEvents: [] as const, onMalformedDispatch: "terminate" as const },
        cache: { messages: true as const },
    }
    if (mode === "default") {
        const testClient = createDefaultTestClient(options)
        onTestFinished(() => testClient.shutdown())
        return {
            testClient,
            get: async () => testClient.client.messages.get(target),
            on: async (event: "messageCreate" | "messageUpdate", handler: (message: MessageCore) => void) => {
                testClient.client.on(event, handler)
            },
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const testClient = await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
    return {
        testClient,
        get: () => settle(testClient.client.messages.get(target)),
        on: async (event: "messageCreate" | "messageUpdate", handler: (message: MessageCore) => void) => {
            await Effect.runPromise(
                testClient.client
                    .on(event, (message) => Effect.sync(() => handler(message)))
                    .pipe(Scope.provide(scope)),
            )
        },
    }
}

function expectContext(
    message: MessageCore & Partial<Message>,
    fields: MessageFields | undefined,
    context: (typeof contexts)[number],
) {
    expect(message).toMatchObject({ ...target, guildId: "40", content: "Announcement context" })
    if (fields !== undefined) {
        expect(Object.hasOwn(message, "messageReference")).toBe(false)
        expect(Object.hasOwn(message, "type")).toBe(false)
        expect(Object.hasOwn(message, "flags")).toBe(false)
        return
    }
    expect(message.type).toBe(context.type)
    expect(message.flags).toBe(context.flags)
    expect(message.messageReference).toEqual({
        channelId: "70",
        guildId: "80",
        type: 0,
        ...(context.id === undefined ? {} : { id: context.id }),
    })
    expect(Object.hasOwn(message.messageReference!, "id")).toBe(context.id !== undefined)
    expect(Object.isFrozen(message.messageReference)).toBe(true)
}

test.each(cases.flatMap((options) => contexts.map((context) => ({ ...options, context, name: context.name }))))(
    "$mode $label decodes $name through gateway, REST, pages and cache",
    async ({ mode, fields, context }) => {
        const { testClient, on, get } = await open(mode, fields)
        const payload = wireMessage({ message_reference: context.reference, type: context.type, flags: context.flags })
        const created: MessageCore[] = []
        const updated: MessageCore[] = []
        await on("messageCreate", (message) => {
            created.push(message)
        })
        await on("messageUpdate", (message) => {
            updated.push(message)
        })
        await settle(testClient.ready())
        await settle(testClient.emit("MESSAGE_CREATE", payload))
        await settle(testClient.emit("MESSAGE_UPDATE", payload))
        await settle(testClient.idle())
        expect(created).toHaveLength(1)
        expect(updated).toHaveLength(1)
        expectContext(created[0]!, fields, context)
        expectContext(updated[0]!, fields, context)
        expectContext((await get())!, fields, context)

        testClient.rest.respond("GET /channels/:id/messages/:id", { body: payload })
        expectContext(await settle(testClient.client.messages.fetch(target)), fields, context)
        testClient.rest.respond("GET /channels/:id/messages", { body: [payload] })
        const history = await settle(testClient.client.messages.fetchHistory("20", { limit: 1 }))
        expect(history).toHaveLength(1)
        expectContext(history[0]!, fields, context)
        expectContext((await get())!, fields, context)

        testClient.rest.respond("GET /channels/:id/messages/pins", {
            body: {
                items: [{ message: { ...payload, pinned: true }, pinned_at: "2026-10-03T12:00:00.000Z" }],
                has_more: false,
            },
        })
        const pins = await settle(testClient.client.messages.fetchPins("20"))
        expect(pins.items).toHaveLength(1)
        expectContext(pins.items[0]!.message, fields, context)
        testClient.rest.respond("POST /search/messages", {
            body: {
                messages: [payload],
                channels: [{ id: "20", guild_id: "40", type: 0 }],
                total: 1,
                hits_per_page: 25,
                page: 1,
            },
        })
        const search = await settle(testClient.client.messages.search({ channelId: "20" }))
        if (search.indexing) throw new Error("Expected indexed messages")
        expect(search.messages).toHaveLength(1)
        expectContext(search.messages[0]!, fields, context)
        expect(testClient.requests()).toHaveLength(4)
    },
)

test.each(cases)(
    "$mode $label rejects a malformed present message_id even when context is excluded",
    async ({ mode, fields }) => {
        const { testClient, on, get } = await open(mode, fields)
        const malformed = wireMessage({ message_reference: { ...source, message_id: "not-a-message-id" } })
        testClient.rest.respond("GET /channels/:id/messages/:id", { body: malformed })
        expect(await expectErr(testClient.client.messages.fetch(target))).toMatchObject({
            _tag: "MessageOperationError",
            operation: "fetch",
            reason: "response",
        })
        testClient.rest.respond("GET /channels/:id/messages", { body: [malformed] })
        expect(await expectErr(testClient.client.messages.fetchHistory("20"))).toMatchObject({
            _tag: "MessageOperationError",
            operation: "fetchHistory",
            reason: "response",
        })
        const received: MessageCore[] = []
        await on("messageCreate", (message) => {
            received.push(message)
        })
        await settle(testClient.ready())
        const closed = expectErr(testClient.client.waitForClose())
        await settle(testClient.emit("MESSAGE_CREATE", malformed))
        expect(await closed).toMatchObject({ reason: "protocol" })
        expect(received).toEqual([])
        expect(await get()).toBeUndefined()
    },
)

test.each(cases)("$mode $label validates channel-only references inside a resolved reply", async ({ mode, fields }) => {
    const { testClient } = await open(mode, fields)
    for (const messageId of [undefined, null, "not-a-message-id"]) {
        const nested = wireMessage({
            message_reference: { ...source, ...(messageId === undefined ? {} : { message_id: messageId }) },
        })
        testClient.rest.respond("GET /channels/:id/messages/:id", {
            body: wireMessage({
                type: 19,
                message_reference: { ...source, message_id: "90" },
                referenced_message: nested,
            }),
        })
        if (messageId === "not-a-message-id") {
            expect(await expectErr(testClient.client.messages.fetch(target))).toMatchObject({ reason: "response" })
            continue
        }
        const reply = await settle(testClient.client.messages.fetch(target))
        if (fields === undefined) {
            expect(reply.referencedMessage?.messageReference).toEqual({ channelId: "70", guildId: "80", type: 0 })
            expect(Object.hasOwn(reply.referencedMessage!.messageReference!, "id")).toBe(false)
        } else expect(Object.hasOwn(reply, "referencedMessage")).toBe(false)
    }
})

test.each(modes)("%s rejects every server-managed flag before send or edit dispatch", async (mode) => {
    const { testClient } = await open(mode, undefined)
    // Exact provider bit values also protect the public constants from accidental reassignment
    expect(MessageFlags.Crossposted).toBe(1)
    expect(MessageFlags.IsCrosspost).toBe(2)
    expect(MessageFlags.SourceMessageDeleted).toBe(8)
    expect(MessageFlags.VoiceMessage).toBe(8192)
    expect(MessageType.ChannelFollowAdd).toBe(12)
    for (const flag of [MessageFlags.Crossposted, MessageFlags.IsCrosspost, MessageFlags.SourceMessageDeleted]) {
        for (const flags of [flag, flag | MessageFlags.SuppressEmbeds]) {
            expect(
                await expectErr(testClient.client.messages.send("20", { content: "Not sent", flags })),
            ).toMatchObject({
                _tag: "MessageError",
                reason: "input",
                outcome: "notDispatched",
                inputValidation: { path: "flags", constraint: "allowedValue" },
            })
            expect(await expectErr(testClient.client.messages.edit(target, { flags }))).toMatchObject({
                _tag: "MessageOperationError",
                operation: "edit",
                reason: "input",
                inputValidation: { path: "flags", constraint: "allowedValue" },
            })
        }
    }
    expect(testClient.requests()).toEqual([])
})
