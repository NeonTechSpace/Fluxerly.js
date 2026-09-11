import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { createClient, MessageFlags, type ForwardMessageInput } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { decodeMessage, encodeEdit, encodeForward } from "../src/internal/message.js"
import { InputValidationFailure } from "../src/input-validation.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

afterEach(() => vi.unstubAllGlobals())

const message = (overrides: Record<string, unknown> = {}) => ({
    id: "99",
    channel_id: "20",
    content: "",
    author: { id: "30", username: "fixture", bot: false },
    ...overrides,
})

const forwardedMessage = () =>
    message({
        message_reference: { message_id: "10", channel_id: "30", type: 1 },
        message_snapshots: [
            {
                content: "captured",
                timestamp: "2026-09-10T12:00:00.000Z",
                edited_timestamp: null,
                mentions: ["31"],
                mention_roles: ["32"],
                mention_channels: [{ id: "33", name: "source", type: 0 }],
                embeds: [],
                attachments: [{ id: "34", filename: "captured.png", size: 1, flags: 0 }],
                stickers: [{ id: "35", name: "captured", animated: false }],
                type: 0,
                flags: MessageFlags.SuppressEmbeds,
            },
        ],
    })

function fixture() {
    const requests: { url: string; method: string; body: Record<string, unknown> }[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        requests.push({ url, method: init.method ?? "GET", body })
        const reference = body.message_reference as Record<string, unknown> | undefined
        return Response.json(reference?.type === 1 ? forwardedMessage() : message())
    })
    return requests
}

function unwrap<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

const apiSurfaces = ["default", "native"] as const

async function forwardSuccess(surface: (typeof apiSurfaces)[number], input: ForwardMessageInput) {
    if (surface === "default") {
        const client = unwrap(createClient({ token: "fixture" }))
        try {
            return unwrap(await client.messages.forward("20", input))
        } finally {
            unwrap(await client.shutdown())
        }
    }
    return Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture" })
                return yield* client.messages.forward("20", input)
            }),
        ),
    )
}

async function forwardFailure(surface: (typeof apiSurfaces)[number], input: ForwardMessageInput): Promise<unknown> {
    if (surface === "default") {
        const client = unwrap(createClient({ token: "fixture" }))
        try {
            const result = await client.messages.forward("20", input)
            if (!result.isErr()) throw new Error("Expected forward to fail")
            return result.error
        } finally {
            unwrap(await client.shutdown())
        }
    }
    return Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture" })
                return yield* client.messages.forward("20", input).pipe(Effect.flip)
            }),
        ),
    )
}

test("forward encodes only an immutable source reference and rejects malformed media selections", () => {
    const encoded = encodeForward(
        "20",
        { source: { id: "10", channelId: "30" }, attachmentIds: ["40"], embedIndices: [0, 2] },
        "nonce",
    )
    expect(encoded).not.toMatchObject({ _tag: "MessageError" })
    if ("_tag" in encoded) throw encoded
    expect(encoded.files).toEqual([])
    expect(JSON.parse(encoded.json)).toEqual({
        nonce: "nonce",
        message_reference: {
            message_id: "10",
            channel_id: "30",
            type: 1,
            attachment_ids: ["40"],
            embed_indices: [0, 2],
        },
    })
    const emptySelectors = encodeForward(
        "20",
        { source: { id: "10", channelId: "30" }, attachmentIds: [], embedIndices: [] },
        "nonce",
    )
    expect(emptySelectors).not.toMatchObject({ _tag: "MessageError" })
    if ("_tag" in emptySelectors) throw emptySelectors
    expect(JSON.parse(emptySelectors.json)).toMatchObject({
        message_reference: { attachment_ids: [], embed_indices: [] },
    })
    for (const input of [
        { source: { id: "10", channelId: "30" }, content: "not supported" },
        { source: { id: "10", channelId: "30" }, attachmentIds: ["40", "invalid"] },
        { source: { id: "10", channelId: "30" }, embedIndices: [-1] },
        { source: { id: "10", channelId: "30" }, embedIndices: new Array(1) },
    ])
        expect(encodeForward("20", input, "nonce")).toMatchObject({ _tag: "MessageError", reason: "input" })
})

test("received forward snapshots retain nullable response state and freeze every retained layer", () => {
    const decoded = decodeMessage(forwardedMessage())
    expect(decoded?.messageSnapshots).toEqual([
        {
            content: "captured",
            createdAt: "2026-09-10T12:00:00.000Z",
            editedAt: null,
            mentionUserIds: ["31"],
            mentionRoleIds: ["32"],
            mentionChannels: [{ id: "33", name: "source", type: 0 }],
            embeds: [],
            attachments: [{ id: "34", filename: "captured.png", size: 1, flags: 0 }],
            stickers: [{ id: "35", name: "captured", animated: false }],
            type: 0,
            flags: MessageFlags.SuppressEmbeds,
        },
    ])
    const snapshot = decoded?.messageSnapshots?.[0]
    expect(snapshot).toBeDefined()
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded?.messageSnapshots)).toBe(true)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot?.attachments)).toBe(true)
    expect(Object.isFrozen(snapshot?.attachments?.[0])).toBe(true)
    expect(decodeMessage(message({ message_snapshots: null }))?.messageSnapshots).toBeNull()
    expect(
        decodeMessage(message({ message_snapshots: [{ timestamp: "not-a-timestamp", type: 0, flags: 0 }] })),
    ).toBeUndefined()
})

test("default and native forward calls use the shared create route without extra body fields", async () => {
    const requests = fixture()
    const defaultApi = unwrap(createClient({ token: "fixture" }))
    try {
        const forwarded = unwrap(
            await defaultApi.messages.forward("20", {
                source: { id: "10", channelId: "30" },
                attachmentIds: ["40"],
                embedIndices: [0],
            }),
        )
        expect(forwarded.messageSnapshots?.[0]?.content).toBe("captured")
    } finally {
        unwrap(await defaultApi.shutdown())
    }
    const native = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture" })
                return yield* client.messages.forward("20", { source: { id: "10", channelId: "30" } })
            }),
        ),
    )
    expect(native.messageSnapshots?.[0]?.content).toBe("captured")
    expect(requests).toHaveLength(2)
    expect(requests.every((request) => request.url === "https://api.fluxer.app/v1/channels/20/messages")).toBe(true)
    expect(requests.every((request) => request.method === "POST")).toBe(true)
    expect(requests[0]?.body).toMatchObject({
        message_reference: {
            message_id: "10",
            channel_id: "30",
            type: 1,
            attachment_ids: ["40"],
            embed_indices: [0],
        },
    })
    expect(Object.keys(requests[0]!.body).sort()).toEqual(["message_reference", "nonce"])
})

test.each(apiSurfaces)(
    "forward retries a confirmed rate limit with the same nonce through the %s API",
    async (surface) => {
        const requests: Record<string, unknown>[] = []
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>
            requests.push(body)
            if (requests.length === 1) return Response.json({ retry_after: 0.01 }, { status: 429 })
            return Response.json(forwardedMessage())
        })
        await forwardSuccess(surface, {
            source: { id: "10", channelId: "30" },
            attachmentIds: ["40"],
            embedIndices: [0],
        })
        expect(requests).toHaveLength(2)
        expect(requests[0]?.nonce).toBe(requests[1]?.nonce)
        expect(requests[1]?.message_reference).toEqual({
            message_id: "10",
            channel_id: "30",
            type: 1,
            attachment_ids: ["40"],
            embed_indices: [0],
        })
    },
)

test.each(apiSurfaces)(
    "forward does not retry after a dispatched request loses its response through the %s API",
    async (surface) => {
        const requests: Record<string, unknown>[] = []
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            requests.push(JSON.parse(String(init.body)) as Record<string, unknown>)
            throw new TypeError("fixture lost response")
        })
        const failure = await forwardFailure(surface, { source: { id: "10", channelId: "30" } })
        expect(failure).toMatchObject({ _tag: "MessageError", delivery: "unknown" })
        expect(requests).toHaveLength(1)
    },
)

test("forward copies selectors before waiting for REST admission", async () => {
    type HeldRequest = { body: Record<string, unknown>; resolve(response: Response): void }
    const held: HeldRequest[] = []
    stubFetchWithHostedDiscovery((_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        return new Promise<Response>((resolve) => {
            held.push({ body, resolve })
        })
    })
    const client = unwrap(createClient({ token: "fixture" }))
    const active = Array.from({ length: 4 }, () => client.messages.send("20", { content: "blocking" }))
    try {
        await vi.waitFor(() => expect(held).toHaveLength(4))
        const input = {
            source: { id: "10", channelId: "30" },
            attachmentIds: ["40"],
            embedIndices: [0],
        }
        const forwarded = client.messages.forward("20", input)
        input.source.id = "11"
        input.source.channelId = "31"
        input.attachmentIds[0] = "41"
        input.embedIndices[0] = 1
        for (const request of held.splice(0)) request.resolve(Response.json(message()))
        await vi.waitFor(() => expect(held).toHaveLength(1))
        expect(held[0]?.body.message_reference).toEqual({
            message_id: "10",
            channel_id: "30",
            type: 1,
            attachment_ids: ["40"],
            embed_indices: [0],
        })
        held[0]!.resolve(Response.json(forwardedMessage()))
        expect(unwrap(await forwarded).messageSnapshots?.[0]?.content).toBe("captured")
        expect((await Promise.all(active)).every((result) => !result.isErr())).toBe(true)
    } finally {
        for (const request of held.splice(0)) request.resolve(Response.json(message()))
        unwrap(await client.shutdown())
    }
})

test.each(apiSurfaces)(
    "non-voice flags are accepted by send, reply and flags-only edit through the %s API",
    async (surface) => {
        const requests = fixture()
        if (surface === "default") {
            const client = unwrap(createClient({ token: "fixture" }))
            try {
                unwrap(
                    await client.messages.send("20", {
                        content: "suppressed",
                        flags: MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications,
                    }),
                )
                unwrap(
                    await client.messages.reply(
                        { id: "99", channelId: "20" },
                        { content: "suppressed reply", flags: MessageFlags.SuppressEmbeds },
                    ),
                )
                unwrap(await client.messages.edit({ id: "99", channelId: "20" }, { flags: 0 }))
                const rejected = await client.messages.send("20", { content: "voice", flags: 1 << 13 })
                expect(rejected.isErr() && rejected.error).toMatchObject({ _tag: "MessageError", reason: "input" })
            } finally {
                unwrap(await client.shutdown())
            }
        } else {
            await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const client = yield* createNative({ token: "fixture" })
                        yield* client.messages.send("20", {
                            content: "suppressed",
                            flags: MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications,
                        })
                        yield* client.messages.reply(
                            { id: "99", channelId: "20" },
                            { content: "suppressed reply", flags: MessageFlags.SuppressEmbeds },
                        )
                        yield* client.messages.edit({ id: "99", channelId: "20" }, { flags: 0 })
                        const rejected = yield* client.messages
                            .send("20", { content: "voice", flags: 1 << 13 })
                            .pipe(Effect.flip)
                        expect(rejected).toMatchObject({ _tag: "MessageError", reason: "input" })
                    }),
                ),
            )
        }
        expect(requests).toHaveLength(3)
        expect(requests.map((request) => request.body.flags)).toEqual([4100, MessageFlags.SuppressEmbeds, 0])
        expect(requests[1]?.body.message_reference).toEqual({ message_id: "99", channel_id: "20", type: 0 })
    },
)

test("flags do not bypass edit body validation", () => {
    expect(encodeEdit({ flags: MessageFlags.SuppressEmbeds, content: 42 })).toBeInstanceOf(InputValidationFailure)
    expect(encodeEdit({ flags: MessageFlags.SuppressEmbeds, attachments: [] })).toBeInstanceOf(InputValidationFailure)
})
