import { Effect, Fiber, Stream } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import {
    type Message,
    type MessageDeletion,
    type MessageBulkDeletion,
    type PresenceUpdate,
    type PresenceUpdateBulk,
    type VoiceState,
    type VoiceStateSnapshot,
} from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { Opcode as GatewayOpcode } from "../../src/internal/protocol/gateway.js"
import { decodeVoiceState, decodeVoiceStateSnapshot } from "../../src/internal/guilds.js"
import { defaultApi as fixtureClient } from "../support/both-apis.js"
import { captureLogs } from "../support/log-capture.js"
import { startHostedLoopback } from "../support/instance.js"
import { sendJson } from "../support/rest-server.js"
import { settle, typedResult } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
})
const wire = (content = "changed") => ({
    id: "10",
    channel_id: "20",
    content,
    author: { id: "30", username: "fixture" },
})
const metadataWire = (content = "metadata") => ({
    ...wire(content),
    timestamp: "2026-09-09T12:00:00.000Z",
    edited_timestamp: null,
    type: 19,
    flags: 4,
    guild_id: "40",
    mention_everyone: false,
    mentions: [{ id: "31", username: "mentioned", bot: true }],
    mention_roles: ["50"],
    mention_channels: [{ id: "60", name: "visible-channel", type: 0 }],
    reactions: [{ emoji: { id: null, name: "👍", animated: null }, count: 2, me: null }],
    message_reference: { message_id: "70", channel_id: "71", guild_id: null, type: 1 },
    referenced_message: {
        id: "70",
        channel_id: "71",
        content: "reply context",
        author: { id: "32", username: "reply-author", bot: true },
    },
    message_snapshots: [
        {
            content: "Forwarded source",
            timestamp: "2026-09-09T11:00:00.000Z",
            type: 0,
            flags: 0,
            attachments: [{ id: "72", filename: "source.txt", size: 2, flags: 0 }],
        },
    ],
})
const customStatusWire = {
    text: "Reviewing",
    expires_at: "2099-01-01T00:00:00.000Z",
    emoji_id: "55",
    emoji_name: "party",
    emoji_animated: true,
}
const customStatus = {
    text: "Reviewing",
    expiresAt: "2099-01-01T00:00:00.000Z",
    emoji: { id: "55", name: "party", animated: true },
}
const presenceWire = (overrides: Record<string, unknown> = {}) => ({
    guild_id: "40",
    user: { id: "30", username: "fixture" },
    status: "idle",
    mobile: true,
    afk: false,
    custom_status: customStatusWire,
    ...overrides,
})
const directPresenceWire = (overrides: Record<string, unknown> = {}) => ({
    user: { id: "30", username: "fixture" },
    status: "idle",
    mobile: true,
    afk: false,
    ...overrides,
})
const presenceBulkWire = (overrides: Record<string, unknown> = {}) => ({
    guild_id: "40",
    presences: [
        {
            user: { id: "30", username: "fixture" },
            status: "online",
            mobile: false,
            afk: true,
            custom_status: { text: null, expires_at: null, emoji_id: null, emoji_name: "🎉", emoji_animated: false },
        },
    ],
    ...overrides,
})
const voiceMemberWire = {
    user: { id: "30", username: "voice-member", bot: true },
    roles: ["50"],
    joined_at: "2026-01-02T03:04:05.000Z",
    nick: null,
    mute: false,
    deaf: true,
}
const voiceMember = {
    guildId: "40",
    userId: "30",
    username: "voice-member",
    isBot: true,
    roleIds: ["50"],
    joinedAt: "2026-01-02T03:04:05.000Z",
    nickname: null,
    isMuted: false,
    isDeafened: true,
}
const voiceStateWire = (overrides: Record<string, unknown> = {}) => ({
    guild_id: "40",
    channel_id: "41",
    user_id: "30",
    connection_id: "voice-connection",
    session_id: "voice-session",
    mute: false,
    deaf: true,
    self_mute: true,
    self_deaf: false,
    is_mobile: true,
    suppress: false,
    self_video: true,
    self_stream: true,
    viewer_stream_keys: ["40:41:remote-connection"],
    e2ee_capable: true,
    version: 3,
    member: voiceMemberWire,
    ...overrides,
})
const guildSnapshotWire = (voiceStates?: readonly unknown[]) => ({
    id: "40",
    properties: { id: "40", owner_id: "30", name: "fixture", features: [] },
    ...(voiceStates === undefined ? {} : { voice_states: voiceStates }),
})

async function fixture(initialGuild?: unknown) {
    const { rest, gateway } = await startHostedLoopback({
        fallback: (request, response) => {
            if (request.method === "DELETE") response.writeHead(204).end()
            else sendJson(response, wire(request.text ? JSON.parse(request.text).content : undefined))
        },
        gateway: {
            onCommand: (command, socket) => {
                if (command.op === GatewayOpcode.identify && initialGuild !== undefined)
                    gateway.dispatch("GUILD_CREATE", initialGuild, socket)
            },
        },
    })
    return {
        get requests() {
            return rest.requests.length
        },
        dispatch: (event: string, body: unknown) => gateway.dispatch(event, body),
    }
}

function defaultApi() {
    return fixtureClient({ gateway: { onMalformedDispatch: "terminate" } })
}

function expectMetadata(message: Message) {
    expect(message).toMatchObject({
        id: "10",
        channelId: "20",
        content: "metadata",
        createdAt: "2026-09-09T12:00:00.000Z",
        editedAt: null,
        type: 19,
        flags: 4,
        guildId: "40",
        mentionedEveryone: false,
        mentions: [{ id: "31", username: "mentioned", isBot: true }],
        mentionRoleIds: ["50"],
        mentionChannels: [{ id: "60", name: "visible-channel", type: 0 }],
        reactions: [{ emoji: { id: null, name: "👍", animated: null }, count: 2, me: null }],
        messageReference: { id: "70", channelId: "71", guildId: null, type: 1 },
        referencedMessage: {
            id: "70",
            channelId: "71",
            content: "reply context",
            author: { id: "32", username: "reply-author", isBot: true },
            embeds: [],
            attachments: [],
            stickers: [],
        },
        messageSnapshots: [
            {
                content: "Forwarded source",
                createdAt: "2026-09-09T11:00:00.000Z",
                type: 0,
                flags: 0,
                attachments: [{ id: "72", filename: "source.txt", size: 2, flags: 0 }],
            },
        ],
    })
    expect("referencedMessage" in message.referencedMessage!).toBe(false)
    for (const nested of [
        message,
        message.author,
        message.mentions,
        message.mentions?.[0],
        message.mentionRoleIds,
        message.mentionChannels,
        message.mentionChannels?.[0],
        message.reactions,
        message.reactions?.[0],
        message.reactions?.[0]?.emoji,
        message.messageReference,
        message.referencedMessage,
        message.referencedMessage?.author,
        message.referencedMessage?.embeds,
        message.referencedMessage?.attachments,
        message.referencedMessage?.stickers,
        message.messageSnapshots,
        message.messageSnapshots?.[0],
        message.messageSnapshots?.[0]?.attachments,
        message.messageSnapshots?.[0]?.attachments?.[0],
    ])
        expect(Object.isFrozen(nested)).toBe(true)
}

test("default callbacks and pull subscriptions route frozen updates and deletion payloads without cache or bulk fan-out", async () => {
    const server = await fixture()
    const client = defaultApi()
    const updates: Message[] = []
    const deletions: MessageDeletion[] = []
    const batches: MessageBulkDeletion[] = []
    let creates = 0
    client.on("messageCreate", () => {
        creates++
    })
    client.on("messageUpdate", (message) => {
        updates.push(message)
    })
    client.on("messageDelete", (message) => {
        deletions.push(message)
    })
    client.on("messageDeleteBulk", (batch) => {
        batches.push(batch)
    })
    const pull = client.subscribe("messageDelete")
    await settle(client.connect())
    server.dispatch("MESSAGE_UPDATE", wire())
    server.dispatch("MESSAGE_UPDATE", wire())
    for (const body of [
        { id: "10", channel_id: "20" },
        { id: "11", channel_id: "20", content: null },
        { id: "12", channel_id: "20", content: "", author_id: "30", guild_id: "99" },
    ])
        server.dispatch("MESSAGE_DELETE", body)
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["40", "41"], guild_id: "99" })
    await vi.waitFor(() => expect([updates.length, deletions.length, batches.length]).toEqual([2, 3, 1]))
    expect(creates).toBe(0)
    expect(updates[0]).toEqual({
        id: "10",
        channelId: "20",
        content: "changed",
        embeds: [],
        attachments: [],
        stickers: [],
        author: { id: "30", username: "fixture", isBot: false },
    })
    expect(deletions).toEqual([
        { id: "10", channelId: "20" },
        { id: "11", channelId: "20", content: null },
        { id: "12", channelId: "20", content: "", authorId: "30", guildId: "99" },
    ])
    expect(batches).toEqual([{ channelId: "20", ids: ["40", "41"], guildId: "99" }])
    expect(
        Object.isFrozen(updates[0]!.author) && Object.isFrozen(deletions[0]) && Object.isFrozen(batches[0]!.ids),
    ).toBe(true)
    for (const expected of deletions) expect(await settle(pull.next())).toEqual(expected)
    const controller = new AbortController()
    const waiting = pull.next({ signal: controller.signal })
    controller.abort()
    expect((await waiting).isErr()).toBe(true)
    expect(server.requests).toBe(0)
    await settle(client.shutdown())
    expect(await settle(pull.next())).toBeNull()
})

test("default and native message subscriptions preserve supplied metadata without hydration or recursive message graphs", async () => {
    const defaultServer = await fixture()
    const defaultClient = defaultApi()
    const defaultEvents = defaultClient.subscribe("messageCreate")
    await settle(defaultClient.connect())
    defaultServer.dispatch("MESSAGE_CREATE", metadataWire())
    expectMetadata((await settle(defaultEvents.next()))!)
    expect(defaultServer.requests).toBe(0)

    const nativeServer = await fixture()
    const nativeEvents: Message[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    gateway: { onMalformedDispatch: "terminate" as const },
                })
                const subscription = yield* client.on("messageCreate", (message) =>
                    Effect.sync(() => {
                        nativeEvents.push(message)
                    }),
                )
                yield* client.connect()
                nativeServer.dispatch("MESSAGE_CREATE", metadataWire())
                yield* Effect.promise(() => vi.waitFor(() => expect(nativeEvents).toHaveLength(1)))
                yield* subscription.close()
                yield* subscription.waitForClose()
            }),
        ),
    )
    expectMetadata(nativeEvents[0]!)
    expect(nativeServer.requests).toBe(0)
})

test("partial metadata preserves omissions and explicit nulls, while malformed supplied metadata closes the connection", async () => {
    const server = await fixture()
    const client = defaultApi()
    const updates = client.subscribe("messageUpdate")
    const closed = client.waitForClose()
    await settle(client.connect())
    server.dispatch("MESSAGE_UPDATE", {
        ...wire("partial"),
        edited_timestamp: null,
        mention_channels: null,
        reactions: null,
        message_reference: null,
        referenced_message: null,
    })
    const partial = (await settle(updates.next()))!
    expect(partial).toMatchObject({
        content: "partial",
        editedAt: null,
        mentionChannels: null,
        reactions: null,
        messageReference: null,
        referencedMessage: null,
    })
    for (const key of ["createdAt", "type", "flags", "guildId", "mentions", "mentionRoleIds"])
        expect(key in partial).toBe(false)

    server.dispatch("MESSAGE_UPDATE", { ...wire("malformed"), timestamp: "not-a-timestamp" })
    const outcome = await closed
    expect(outcome.isErr() && outcome.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
})

test("native callbacks and streams route updates and single and bulk deletions", async () => {
    const server = await fixture()
    const received: unknown[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    gateway: { onMalformedDispatch: "terminate" as const },
                })
                const update = yield* client.on("messageUpdate", (message) =>
                    Effect.sync(() => {
                        received.push(message)
                    }),
                )
                const deleted = yield* Effect.forkScoped(
                    Stream.runCollect(client.subscribe("messageDelete").pipe(Stream.take(2))),
                )
                const bulk = yield* Effect.forkScoped(
                    Stream.runCollect(client.subscribe("messageDeleteBulk").pipe(Stream.take(2))),
                )
                yield* client.connect()
                server.dispatch("MESSAGE_UPDATE", wire("native"))
                server.dispatch("MESSAGE_DELETE", {
                    id: "10",
                    channel_id: "20",
                    content: "native",
                    author_id: "30",
                    guild_id: "99",
                })
                server.dispatch("MESSAGE_DELETE", { id: "11", channel_id: "20" })
                server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["12", "13"], guild_id: "99" })
                server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["14", "15"] })
                expect(yield* Fiber.join(deleted)).toEqual([
                    { id: "10", channelId: "20", content: "native", authorId: "30", guildId: "99" },
                    { id: "11", channelId: "20" },
                ])
                expect(yield* Fiber.join(bulk)).toEqual([
                    { channelId: "20", ids: ["12", "13"], guildId: "99" },
                    { channelId: "20", ids: ["14", "15"] },
                ])
                yield* Effect.promise(() => vi.waitFor(() => expect(received).toHaveLength(1)))
                yield* update.close()
                yield* update.waitForClose()
                expect(server.requests).toBe(0)
            }),
        ),
    )
})

test("default presence callbacks and pull subscriptions project one frozen guild observation without a cache", async () => {
    const server = await fixture()
    const client = defaultApi()
    const callbacks: PresenceUpdate[] = []
    client.on("presenceUpdate", (presence) => {
        callbacks.push(presence)
    })
    const pull = client.subscribe("presenceUpdate")
    await settle(client.connect())
    server.dispatch("PRESENCE_UPDATE", presenceWire())
    await vi.waitFor(() => expect(callbacks).toHaveLength(1))
    const expected = { guildId: "40", userId: "30", status: "idle", mobile: true, afk: false, customStatus }
    expect(callbacks[0]).toEqual(expected)
    expect(await settle(pull.next())).toEqual(expected)
    expect(Object.isFrozen(callbacks[0])).toBe(true)
    expect(Object.isFrozen(callbacks[0]!.customStatus)).toBe(true)
    expect(Object.isFrozen(callbacks[0]!.customStatus!.emoji)).toBe(true)
})

test("default presence subscriptions preserve a valid relationship or group-DM observation without guild scope", async () => {
    const server = await fixture()
    const client = defaultApi()
    const pull = client.subscribe("presenceUpdate")
    await settle(client.connect())
    server.dispatch("PRESENCE_UPDATE", directPresenceWire())
    const presence = await settle(pull.next())
    expect(presence).toEqual({ userId: "30", status: "idle", mobile: true, afk: false, customStatus: null })
    expect(presence).not.toHaveProperty("guildId")
    expect(Object.isFrozen(presence)).toBe(true)
})

test("a presence with an unusable custom status field is still delivered, with that field read as null", async () => {
    const server = await fixture()
    const logs = captureLogs()
    const client = fixtureClient({ logging: logs.logging })
    const received: PresenceUpdate[] = []
    client.on("presenceUpdate", (presence) => {
        received.push(presence)
    })
    await settle(client.connect())
    // Fluxer stores user-supplied custom statuses without validation, so one odd field must not cost the presence
    server.dispatch("PRESENCE_UPDATE", presenceWire({ custom_status: { text: 5, emoji_name: "🎉" } }))
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]).toMatchObject({ customStatus: { text: null, emoji: { name: "🎉" } } })
    expect(client.diagnostics().counters).toMatchObject({ protocolFailures: 0, eventsDropped: { malformed: 0 } })
    expect(logs.withCode("gateway.dispatchRejected")).toEqual([])
})

// Catches: The animated flag was copied without an emoji ID, contradicting the documented false for a Unicode emoji
const unicodeAnimatedWire = presenceWire({
    custom_status: { text: null, expires_at: null, emoji_id: null, emoji_name: "🔥", emoji_animated: true },
})
const unicodeEmoji = { id: null, name: "🔥", animated: false }

test("default presence reads a Unicode custom status emoji as not animated, even when Fluxer sends the flag", async () => {
    const server = await fixture()
    const client = defaultApi()
    const pull = client.subscribe("presenceUpdate")
    await settle(client.connect())
    server.dispatch("PRESENCE_UPDATE", unicodeAnimatedWire)
    expect((await settle(pull.next()))?.customStatus?.emoji).toEqual(unicodeEmoji)
})

test("native presence reads a Unicode custom status emoji as not animated, even when Fluxer sends the flag", async () => {
    const server = await fixture()
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const native = yield* createNative({ token: "fixture-only-not-a-credential" })
                const stream = yield* Effect.forkScoped(
                    Stream.runCollect(native.subscribe("presenceUpdate").pipe(Stream.take(1))),
                )
                yield* native.connect()
                server.dispatch("PRESENCE_UPDATE", unicodeAnimatedWire)
                const [presence] = yield* Fiber.join(stream)
                expect(presence!.customStatus?.emoji).toEqual(unicodeEmoji)
            }),
        ),
    )
})

test("native presence callbacks and streams route the same frozen observation", async () => {
    const server = await fixture()
    const callbacks: PresenceUpdate[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    gateway: { onMalformedDispatch: "terminate" as const },
                })
                const subscription = yield* client.on("presenceUpdate", (presence) =>
                    Effect.sync(() => {
                        callbacks.push(presence)
                    }),
                )
                const stream = yield* Effect.forkScoped(
                    Stream.runCollect(client.subscribe("presenceUpdate").pipe(Stream.take(1))),
                )
                yield* client.connect()
                server.dispatch("PRESENCE_UPDATE", presenceWire({ status: "online", mobile: false, afk: true }))
                const expected = {
                    guildId: "40",
                    userId: "30",
                    status: "online",
                    mobile: false,
                    afk: true,
                    customStatus,
                }
                expect(yield* Fiber.join(stream)).toEqual([expected])
                yield* Effect.promise(() => vi.waitFor(() => expect(callbacks).toEqual([expected])))
                yield* subscription.close()
                yield* subscription.waitForClose()
            }),
        ),
    )
})

test("presence recovery batches stay frozen and distinct from individual observations through both entry points", async () => {
    const defaultServer = await fixture()
    const defaultClient = defaultApi()
    const individual: PresenceUpdate[] = []
    const batches: PresenceUpdateBulk[] = []
    defaultClient.on("presenceUpdate", (presence) => {
        individual.push(presence)
    })
    defaultClient.on("presenceUpdateBulk", (batch) => {
        batches.push(batch)
    })
    const pull = defaultClient.subscribe("presenceUpdateBulk")
    await settle(defaultClient.connect())
    defaultServer.dispatch("PRESENCE_UPDATE_BULK", presenceBulkWire())
    await vi.waitFor(() => expect(batches).toHaveLength(1))
    const expected = {
        guildId: "40",
        presences: [
            {
                guildId: "40",
                userId: "30",
                status: "online",
                mobile: false,
                afk: true,
                customStatus: { text: null, expiresAt: null, emoji: { id: null, name: "🎉", animated: false } },
            },
        ],
    }
    expect(batches[0]).toEqual(expected)
    expect(await settle(pull.next())).toEqual(expected)
    expect(individual).toEqual([])
    expect(Object.isFrozen(batches[0])).toBe(true)
    expect(Object.isFrozen(batches[0]!.presences)).toBe(true)
    expect(Object.isFrozen(batches[0]!.presences[0])).toBe(true)

    const nativeServer = await fixture()
    const received: PresenceUpdateBulk[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    gateway: { onMalformedDispatch: "terminate" as const },
                })
                yield* client.on("presenceUpdateBulk", (batch) =>
                    Effect.sync(() => {
                        received.push(batch)
                    }),
                )
                const stream = yield* Effect.forkScoped(
                    Stream.runCollect(client.subscribe("presenceUpdateBulk").pipe(Stream.take(1))),
                )
                yield* client.connect()
                nativeServer.dispatch("PRESENCE_UPDATE_BULK", presenceBulkWire())
                expect(yield* Fiber.join(stream)).toEqual([expected])
                yield* Effect.promise(() => vi.waitFor(() => expect(received).toEqual([expected])))
            }),
        ),
    )
})

test("the provider's 500-entry presence batch retains context through the public event boundary", async () => {
    const server = await fixture()
    const client = defaultApi()
    const pull = client.subscribe("presenceUpdateBulk")
    await settle(client.connect())
    server.dispatch(
        "PRESENCE_UPDATE_BULK",
        presenceBulkWire({
            presences: Array.from({ length: 500 }, (_, index) =>
                directPresenceWire({ user: { id: String(index + 1) } }),
            ),
        }),
    )
    const batch = (await settle(pull.next()))!
    expect(batch.presences).toHaveLength(500)
    expect(batch.presences[499]).toMatchObject({ guildId: "40", userId: "500" })
    expect(Object.isFrozen(batch.presences[499])).toBe(true)
})

test("voice decoders distinguish an explicit empty initial snapshot and reject sparse or cross-guild states", () => {
    expect(decodeVoiceStateSnapshot(guildSnapshotWire([]))).toEqual({ guildId: "40", voiceStates: [] })
    expect(decodeVoiceStateSnapshot(guildSnapshotWire())).toBeUndefined()
    expect(decodeVoiceStateSnapshot(guildSnapshotWire([voiceStateWire({ guild_id: "41" })]))).toBeUndefined()
    expect(decodeVoiceState({ ...voiceStateWire(), self_mute: undefined })).toBeUndefined()
    expect(decodeVoiceState({ ...voiceStateWire(), connection_id: "" })).toBeUndefined()
    expect(decodeVoiceState(voiceStateWire({ session_id: null }))).not.toHaveProperty("sessionId")
})

test("voice decoders read the video, stream, watched-stream and member fields as frozen copies", () => {
    const state = decodeVoiceState(voiceStateWire())!
    expect(state).toMatchObject({
        isSelfVideoOn: true,
        isSelfStreaming: true,
        viewerStreamKeys: ["40:41:remote-connection"],
        member: voiceMember,
    })
    expect(
        Object.isFrozen(state.viewerStreamKeys) &&
            Object.isFrozen(state.member) &&
            Object.isFrozen(state.member!.roleIds),
    ).toBe(true)
    expect(decodeVoiceState(voiceStateWire({ self_video: false, self_stream: false }))).toMatchObject({
        isSelfVideoOn: false,
        isSelfStreaming: false,
    })
})

test.each([
    ["omitted", undefined],
    ["null", null],
])("voice decoders accept %s optional media and member fields as their empty values", (_name, absent) => {
    const state = decodeVoiceState(
        voiceStateWire({ self_video: undefined, self_stream: undefined, viewer_stream_keys: absent, member: absent }),
    )
    expect(state).toMatchObject({ isSelfVideoOn: false, isSelfStreaming: false, viewerStreamKeys: [] })
    expect(state).not.toHaveProperty("member")
})

test.each([
    ["a non-boolean video flag", { self_video: "yes" }],
    ["a non-boolean stream flag", { self_stream: 1 }],
    ["watched streams that are not a list", { viewer_stream_keys: "40:41:remote-connection" }],
    ["a watched stream key that is not text", { viewer_stream_keys: ["40:41:remote-connection", 7] }],
    ["a member without its roles and join time", { member: { user: { id: "30", username: "voice-member" } } }],
    ["a member that is not an object", { member: "30" }],
])("a voice state with %s is rejected whole", (_name, overrides) => {
    expect(decodeVoiceState(voiceStateWire(overrides))).toBeUndefined()
})

test("default voice subscriptions expose the initial visible snapshot and subsequent move phases with their video, stream and member fields", async () => {
    const server = await fixture(guildSnapshotWire([voiceStateWire()]))
    const client = defaultApi()
    const snapshots: VoiceStateSnapshot[] = []
    const updates: VoiceState[] = []
    client.on("voiceStateSnapshot", (snapshot) => {
        snapshots.push(snapshot)
    })
    client.on("voiceStateUpdate", (state) => {
        updates.push(state)
    })
    const initial = client.subscribe("voiceStateSnapshot")
    const transitions = client.subscribe("voiceStateUpdate")
    await settle(client.connect())

    const snapshot = (await settle(initial.next()))!
    const expectedInitial = {
        guildId: "40",
        channelId: "41",
        userId: "30",
        connectionId: "voice-connection",
        sessionId: "voice-session",
        isMuted: false,
        isDeafened: true,
        isSelfMuted: true,
        isSelfDeafened: false,
        isMobile: true,
        isSuppressed: false,
        isSelfVideoOn: true,
        isSelfStreaming: true,
        viewerStreamKeys: ["40:41:remote-connection"],
        member: voiceMember,
    }
    expect(snapshot).toEqual({ guildId: "40", voiceStates: [expectedInitial] })
    expect(
        Object.isFrozen(snapshot) && Object.isFrozen(snapshot.voiceStates) && Object.isFrozen(snapshot.voiceStates[0]),
    ).toBe(true)

    server.dispatch("VOICE_STATE_UPDATE", voiceStateWire({ channel_id: null }))
    server.dispatch(
        "VOICE_STATE_UPDATE",
        voiceStateWire({ channel_id: "42", connection_id: "replacement-connection", mute: true, deaf: false }),
    )
    expect(await settle(transitions.next())).toMatchObject({ channelId: null, connectionId: "voice-connection" })
    expect(await settle(transitions.next())).toMatchObject({
        channelId: "42",
        connectionId: "replacement-connection",
        isMuted: true,
        isDeafened: false,
    })
    await vi.waitFor(() => expect([snapshots.length, updates.length]).toEqual([1, 2]))
    expect(server.requests).toBe(0)
})

test("native voice callbacks and streams deliver an explicit empty initial collection", async () => {
    const server = await fixture(guildSnapshotWire([]))
    const snapshots: VoiceStateSnapshot[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    gateway: { onMalformedDispatch: "terminate" as const },
                })
                const callback = yield* client.on("voiceStateSnapshot", (snapshot) =>
                    Effect.sync(() => {
                        snapshots.push(snapshot)
                    }),
                )
                const stream = yield* Effect.forkScoped(
                    Stream.runCollect(client.subscribe("voiceStateSnapshot").pipe(Stream.take(1))),
                )
                yield* client.connect()
                expect(yield* Fiber.join(stream)).toEqual([{ guildId: "40", voiceStates: [] }])
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(snapshots).toEqual([{ guildId: "40", voiceStates: [] }])),
                )
                yield* callback.close()
                yield* callback.waitForClose()
            }),
        ),
    )
    expect(server.requests).toBe(0)
})

test("native voice streams deliver the video, stream and member fields", async () => {
    const server = await fixture(guildSnapshotWire([voiceStateWire()]))
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    gateway: { onMalformedDispatch: "terminate" as const },
                })
                const stream = yield* Effect.forkScoped(
                    Stream.runCollect(client.subscribe("voiceStateSnapshot").pipe(Stream.take(1))),
                )
                yield* client.connect()
                const [snapshot] = yield* Fiber.join(stream)
                expect(snapshot?.voiceStates[0]).toMatchObject({
                    isSelfVideoOn: true,
                    isSelfStreaming: true,
                    viewerStreamKeys: ["40:41:remote-connection"],
                    member: voiceMember,
                })
            }),
        ),
    )
    expect(server.requests).toBe(0)
})

test("a malformed supplied initial voice collection closes the gateway instead of emitting a partial snapshot", async () => {
    const server = await fixture(
        guildSnapshotWire([voiceStateWire(), voiceStateWire({ connection_id: "voice-connection" })]),
    )
    const client = defaultApi()
    const guilds: unknown[] = []
    const snapshots: VoiceStateSnapshot[] = []
    client.on("guildCreate", (guild) => {
        guilds.push(guild)
    })
    client.on("voiceStateSnapshot", (snapshot) => {
        snapshots.push(snapshot)
    })
    const closed = client.waitForClose()
    await settle(client.connect())
    const outcome = await closed
    expect(outcome.isErr() && outcome.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
    expect(guilds).toEqual([])
    expect(snapshots).toEqual([])
    expect(server.requests).toBe(0)
})

test("private-call voice updates are ignored without interrupting guild voice observations", async () => {
    const server = await fixture()
    const client = defaultApi()
    const transitions = client.subscribe("voiceStateUpdate")
    await settle(client.connect())

    server.dispatch("VOICE_STATE_UPDATE", voiceStateWire({ guild_id: null, member: null }))
    server.dispatch("VOICE_STATE_UPDATE", voiceStateWire())
    expect(await settle(transitions.next())).toMatchObject({ guildId: "40", connectionId: "voice-connection" })
    expect(client.state).toBe("Connected")
})

test("REST edit/delete acknowledgements do not synthesize gateway events", async () => {
    const server = await fixture()
    const client = defaultApi()
    const update = client.subscribe("messageUpdate", { maxPendingMessages: 1 })
    const deletion = client.subscribe("messageDelete", { maxPendingMessages: 1 })
    await settle(client.messages.edit({ id: "10", channelId: "20" }, { content: "REST only" }))
    await settle(client.messages.delete({ id: "10", channelId: "20" }))
    await settle(client.connect())
    server.dispatch("MESSAGE_UPDATE", wire("gateway only"))
    server.dispatch("MESSAGE_DELETE", { id: "11", channel_id: "20" })
    expect((await settle(update.next()))?.content).toBe("gateway only")
    expect((await settle(deletion.next()))?.id).toBe("11")
})

test("bulk batches count as one queued payload but consume their full source bytes and isolate overflow", async () => {
    const server = await fixture()
    const client = defaultApi()
    const one = client.subscribe("messageDeleteBulk", { maxPendingMessages: 1 })
    const bytes = client.subscribe("messageDeleteBulk", { maxPendingBytes: 1 })
    const other = client.subscribe("messageUpdate")
    await settle(client.connect())
    const ids = Array.from({ length: 100 }, (_, index) => String(index + 1))
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids })
    const tooLarge = await bytes.waitForClose()
    expect(tooLarge.isErr() && tooLarge.error).toMatchObject({ _tag: "EventOverflowError", limit: "bytes" })
    expect((await settle(one.next()))?.ids).toEqual(ids)
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["1"] })
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["2"] })
    const overflow = await one.waitForClose()
    expect(overflow.isErr() && overflow.error).toMatchObject({
        _tag: "EventOverflowError",
        limit: "messages",
        capacity: 1,
    })
    server.dispatch("MESSAGE_UPDATE", wire())
    expect((await settle(other.next()))?.content).toBe("changed")
    expect(client.state).toBe("Connected")
})

test("new-event handlers remain sequential by default, report the matching name and release active native work", async () => {
    const server = await fixture()
    let started = 0
    let cleaned = 0
    const reports: string[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    gateway: { onMalformedDispatch: "terminate" as const },
                })
                const failure = yield* client.on("messageDelete", () => Effect.fail("fixture private failure"), {
                    onError: (report) =>
                        Effect.sync(() => {
                            reports.push(report.event!)
                            // Application failures reach the hook unchanged
                            expect(report.error).toBe("fixture private failure")
                        }),
                })
                yield* client.on("messageUpdate", () =>
                    Effect.sync(() => {
                        started++
                    }).pipe(
                        Effect.andThen(Effect.never),
                        Effect.ensuring(
                            Effect.sync(() => {
                                cleaned++
                            }),
                        ),
                    ),
                )
                yield* client.connect()
                server.dispatch("MESSAGE_UPDATE", wire())
                server.dispatch("MESSAGE_UPDATE", wire())
                server.dispatch("MESSAGE_DELETE", { id: "10", channel_id: "20" })
                yield* Effect.promise(() => vi.waitFor(() => expect(reports).toEqual(["messageDelete"])))
                expect(started).toBe(1)
                yield* failure.close()
                yield* failure.waitForClose()
                yield* client.shutdown()
                expect(cleaned).toBe(1)
            }),
        ),
    )
})

test.each(["default", "native"] as const)(
    "%s rejects malformed deletion guild context without delivery",
    async (mode) => {
        for (const [event, body] of [
            ["MESSAGE_DELETE", { id: "10", channel_id: "20", guild_id: null }],
            ["MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["10"], guild_id: "invalid" }],
        ] as const) {
            const server = await fixture()
            const received = vi.fn()
            if (mode === "default") {
                const client = defaultApi()
                client.on("messageDelete", received)
                client.on("messageDeleteBulk", received)
                await settle(client.connect())
                server.dispatch(event, body)
                const closed = await client.waitForClose()
                expect(closed.isErr() && closed.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
            } else {
                await Effect.runPromise(
                    Effect.scoped(
                        Effect.gen(function* () {
                            const client = yield* createNative({
                                token: "fixture-only-not-a-credential",
                                gateway: { onMalformedDispatch: "terminate" as const },
                            })
                            yield* client.on("messageDelete", () => Effect.sync(received))
                            yield* client.on("messageDeleteBulk", () => Effect.sync(received))
                            yield* client.connect()
                            server.dispatch(event, body)
                            expect(yield* typedResult(client.waitForClose())).toMatchObject({
                                _tag: "Failure",
                                failure: { _tag: "ConnectionError", reason: "protocol" },
                            })
                        }),
                    ),
                )
            }
            expect(received).not.toHaveBeenCalled()
            expect(server.requests).toBe(0)
        }
    },
)

test.each([
    ["MESSAGE_UPDATE", { id: "10", channel_id: "20", content: "partial" }],
    ["MESSAGE_DELETE", { channel_id: "20" }],
    ["MESSAGE_DELETE", { id: "10", channel_id: "20", content: 42 }],
    ["MESSAGE_DELETE", { id: "10", channel_id: "20", author_id: null }],
    ["MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["1", 2] }],
    ["PRESENCE_UPDATE", { guild_id: "40", user: { id: "30" }, status: "online", mobile: true }],
    ["PRESENCE_UPDATE", { guild_id: null, user: { id: "30" }, status: "online", mobile: true, afk: false }],
    ["PRESENCE_UPDATE", { guild_id: "40", user: { id: "invalid" }, status: "online", mobile: true, afk: false }],
    ["PRESENCE_UPDATE", { guild_id: "40", user: { id: "30" }, status: "", mobile: true, afk: false }],
    ["PRESENCE_UPDATE", { guild_id: "40", user: { id: "30" }, status: "online", mobile: "true", afk: false }],
    ["PRESENCE_UPDATE_BULK", { guild_id: "40", presences: [] }],
    ["PRESENCE_UPDATE_BULK", presenceBulkWire({ presences: Array.from({ length: 501 }, () => directPresenceWire()) })],
    ["PRESENCE_UPDATE_BULK", { guild_id: "40", presences: [{ user: { id: "30" }, status: "online", mobile: true }] }],
    [
        "PRESENCE_UPDATE_BULK",
        {
            guild_id: "40",
            presences: [{ guild_id: "41", user: { id: "30" }, status: "online", mobile: true, afk: false }],
        },
    ],
] as const)(
    "malformed %s closes with a typed protocol failure instead of emitting invented data",
    async (event, body) => {
        const server = await fixture()
        const client = defaultApi()
        await settle(client.connect())
        server.dispatch(event, body)
        const result = await client.waitForClose()
        expect(result.isErr() && result.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
        expect(client.state).toBe("Closed")
    },
)
