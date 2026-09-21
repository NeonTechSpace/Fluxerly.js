import { createServer } from "node:http"
import { once } from "node:events"
import { Effect, Fiber, References, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import {
    createClient,
    type Message,
    type MessageDeletion,
    type MessageBulkDeletion,
    type PresenceUpdate,
    type PresenceUpdateBulk,
    type VoiceState,
    type VoiceStateSnapshot,
} from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { decodeVoiceState, decodeVoiceStateSnapshot } from "../src/internal/guilds.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const transport = vi.hoisted(() => ({ url: "" }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(url: string, options: import("ws").ClientOptions) {
                expect(url).toBe("wss://gateway.fluxer.app/?v=1&encoding=json")
                super(transport.url, options)
            }
        },
    }
})
const realFetch = globalThis.fetch
afterEach(() => vi.unstubAllGlobals())
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
const presenceWire = (overrides: Record<string, unknown> = {}) => ({
    guild_id: "40",
    user: { id: "30", username: "fixture" },
    status: "idle",
    mobile: true,
    afk: false,
    custom_status: { text: "not part of the public projection" },
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
            custom_status: { text: "not part of the public projection" },
        },
    ],
    ...overrides,
})
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
    viewer_stream_keys: ["ignored-media-field"],
    e2ee_capable: true,
    member: { user: { id: "30", username: "not projected" } },
    ...overrides,
})
const guildSnapshotWire = (voiceStates?: readonly unknown[]) => ({
    id: "40",
    properties: { id: "40", owner_id: "30", name: "fixture", features: [] },
    ...(voiceStates === undefined ? {} : { voice_states: voiceStates }),
})

async function fixture(initialGuild?: unknown) {
    const sockets: import("ws").WebSocket[] = []
    let sequence = 1
    let requests = 0
    const server = createServer(async (request, response) => {
        requests++
        if (request.url?.endsWith("/gateway/bot")) {
            response.end(JSON.stringify({ url: "wss://gateway.fluxer.app" }))
            return
        }
        let text = ""
        for await (const chunk of request) text += chunk.toString()
        if (request.method === "DELETE") response.writeHead(204).end()
        else response.end(JSON.stringify(wire(text ? JSON.parse(text).content : undefined)))
    })
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const packet = JSON.parse(data.toString())
            if (packet.op === 2) {
                socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fixture-session" } }))
                if (initialGuild !== undefined)
                    socket.send(JSON.stringify({ op: 0, s: ++sequence, t: "GUILD_CREATE", d: initialGuild }))
            }
            if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture port")
    transport.url = `ws://127.0.0.1:${address.port}`
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) =>
        realFetch(url.replace("https://api.fluxer.app", `http://127.0.0.1:${address.port}`), init),
    )
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
        get requests() {
            return requests
        },
        dispatch(event: string, body: unknown) {
            for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: event, d: body }))
        },
    }
}

function value<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}
function defaultApi() {
    const client = value(createClient({ token: "fixture-only-not-a-credential" }))
    onTestFinished(async () => {
        await client.shutdown()
    })
    return client
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
    value(
        client.on("messageCreate", () => {
            creates++
        }),
    )
    value(
        client.on("messageUpdate", (message) => {
            updates.push(message)
        }),
    )
    value(
        client.on("messageDelete", (message) => {
            deletions.push(message)
        }),
    )
    value(
        client.on("messageDeleteBulk", (batch) => {
            batches.push(batch)
        }),
    )
    const pull = value(client.events("messageDelete"))
    value(await client.connect())
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
    for (const expected of deletions) expect(value(await pull.next())).toEqual(expected)
    const controller = new AbortController()
    const waiting = pull.next({ signal: controller.signal })
    controller.abort()
    expect((await waiting).isErr()).toBe(true)
    expect(server.requests).toBe(0)
    value(await client.shutdown())
    expect(value(await pull.next())).toBeNull()
})

test("default and native message subscriptions preserve supplied metadata without hydration or recursive message graphs", async () => {
    const defaultServer = await fixture()
    const defaultClient = defaultApi()
    const defaultEvents = value(defaultClient.events("messageCreate"))
    value(await defaultClient.connect())
    defaultServer.dispatch("MESSAGE_CREATE", metadataWire())
    expectMetadata(value(await defaultEvents.next())!)
    expect(defaultServer.requests).toBe(0)

    const nativeServer = await fixture()
    const nativeEvents: Message[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const subscription = yield* client.on("messageCreate", (message) =>
                    Effect.sync(() => {
                        nativeEvents.push(message)
                    }),
                )
                yield* client.connect()
                nativeServer.dispatch("MESSAGE_CREATE", metadataWire())
                yield* Effect.promise(() => vi.waitFor(() => expect(nativeEvents).toHaveLength(1)))
                yield* subscription.unsubscribe()
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
    const updates = value(client.events("messageUpdate"))
    const closed = client.waitForClose()
    value(await client.connect())
    server.dispatch("MESSAGE_UPDATE", {
        ...wire("partial"),
        edited_timestamp: null,
        mention_channels: null,
        reactions: null,
        message_reference: null,
        referenced_message: null,
    })
    const partial = value(await updates.next())!
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

test("native callbacks preserve caller context and streams route single and bulk deletions", async () => {
    const server = await fixture()
    const received: unknown[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const update = yield* client.on("messageUpdate", (message) =>
                    Effect.gen(function* () {
                        expect((yield* References.CurrentLogAnnotations).fixture).toBe("events")
                        received.push(message)
                    }),
                )
                const deleted = yield* Effect.forkScoped(
                    Stream.runCollect(client.events("messageDelete").pipe(Stream.take(2))),
                )
                const bulk = yield* Effect.forkScoped(
                    Stream.runCollect(client.events("messageDeleteBulk").pipe(Stream.take(2))),
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
                yield* update.unsubscribe()
                yield* update.waitForClose()
                expect(server.requests).toBe(0)
            }),
        ).pipe(Effect.annotateLogs("fixture", "events")),
    )
})

test("default presence callbacks and pull subscriptions project one frozen guild observation without a cache", async () => {
    const server = await fixture()
    const client = defaultApi()
    const callbacks: PresenceUpdate[] = []
    value(
        client.on("presenceUpdate", (presence) => {
            callbacks.push(presence)
        }),
    )
    const pull = value(client.events("presenceUpdate"))
    value(await client.connect())
    server.dispatch("PRESENCE_UPDATE", presenceWire())
    await vi.waitFor(() => expect(callbacks).toHaveLength(1))
    const expected = { guildId: "40", userId: "30", status: "idle", mobile: true, afk: false }
    expect(callbacks[0]).toEqual(expected)
    expect(value(await pull.next())).toEqual(expected)
    expect(Object.isFrozen(callbacks[0])).toBe(true)
    expect(callbacks[0]).not.toHaveProperty("customStatus")
})

test("default presence subscriptions preserve a valid relationship or group-DM observation without guild scope", async () => {
    const server = await fixture()
    const client = defaultApi()
    const pull = value(client.events("presenceUpdate"))
    value(await client.connect())
    server.dispatch("PRESENCE_UPDATE", directPresenceWire())
    const presence = value(await pull.next())
    expect(presence).toEqual({ userId: "30", status: "idle", mobile: true, afk: false })
    expect(presence).not.toHaveProperty("guildId")
    expect(Object.isFrozen(presence)).toBe(true)
})

test("native presence callbacks retain caller context and streams route the same frozen observation", async () => {
    const server = await fixture()
    const callbacks: PresenceUpdate[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const subscription = yield* client.on("presenceUpdate", (presence) =>
                    Effect.gen(function* () {
                        expect((yield* References.CurrentLogAnnotations).fixture).toBe("presence")
                        callbacks.push(presence)
                    }),
                )
                const stream = yield* Effect.forkScoped(
                    Stream.runCollect(client.events("presenceUpdate").pipe(Stream.take(1))),
                )
                yield* client.connect()
                server.dispatch("PRESENCE_UPDATE", presenceWire({ status: "online", mobile: false, afk: true }))
                const expected = { guildId: "40", userId: "30", status: "online", mobile: false, afk: true }
                expect(yield* Fiber.join(stream)).toEqual([expected])
                yield* Effect.promise(() => vi.waitFor(() => expect(callbacks).toEqual([expected])))
                yield* subscription.unsubscribe()
                yield* subscription.waitForClose()
            }),
        ).pipe(Effect.annotateLogs("fixture", "presence")),
    )
})

test("presence recovery batches stay frozen and distinct from individual observations through both entry points", async () => {
    const defaultServer = await fixture()
    const defaultClient = defaultApi()
    const individual: PresenceUpdate[] = []
    const batches: PresenceUpdateBulk[] = []
    value(
        defaultClient.on("presenceUpdate", (presence) => {
            individual.push(presence)
        }),
    )
    value(
        defaultClient.on("presenceUpdateBulk", (batch) => {
            batches.push(batch)
        }),
    )
    const pull = value(defaultClient.events("presenceUpdateBulk"))
    value(await defaultClient.connect())
    defaultServer.dispatch("PRESENCE_UPDATE_BULK", presenceBulkWire())
    await vi.waitFor(() => expect(batches).toHaveLength(1))
    const expected = {
        guildId: "40",
        presences: [{ guildId: "40", userId: "30", status: "online", mobile: false, afk: true }],
    }
    expect(batches[0]).toEqual(expected)
    expect(value(await pull.next())).toEqual(expected)
    expect(individual).toEqual([])
    expect(Object.isFrozen(batches[0])).toBe(true)
    expect(Object.isFrozen(batches[0]!.presences)).toBe(true)
    expect(Object.isFrozen(batches[0]!.presences[0])).toBe(true)

    const nativeServer = await fixture()
    const received: PresenceUpdateBulk[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                yield* client.on("presenceUpdateBulk", (batch) =>
                    Effect.gen(function* () {
                        expect((yield* References.CurrentLogAnnotations).presence).toBe("bulk")
                        received.push(batch)
                    }),
                )
                const stream = yield* Effect.forkScoped(
                    Stream.runCollect(client.events("presenceUpdateBulk").pipe(Stream.take(1))),
                )
                yield* client.connect()
                nativeServer.dispatch("PRESENCE_UPDATE_BULK", presenceBulkWire())
                expect(yield* Fiber.join(stream)).toEqual([expected])
                yield* Effect.promise(() => vi.waitFor(() => expect(received).toEqual([expected])))
            }),
        ).pipe(Effect.annotateLogs("presence", "bulk")),
    )
})

test("presence subscriptions use the normal source-byte budget without interrupting unrelated subscriptions", async () => {
    const server = await fixture()
    const client = defaultApi()
    const presence = value(client.events("presenceUpdate", { maxPendingBytes: 256 }))
    const messages = value(client.events("messageUpdate"))
    value(await client.connect())
    server.dispatch("PRESENCE_UPDATE", presenceWire({ custom_status: { text: "ignored".repeat(100) } }))
    const overflow = await presence.waitForClose()
    expect(overflow.isErr() && overflow.error).toMatchObject({ _tag: "EventOverflowError", limit: "bytes" })
    server.dispatch("MESSAGE_UPDATE", wire("unrelated"))
    expect(value(await messages.next())?.content).toBe("unrelated")
    expect(client.state).toBe("Connected")
})

test("presence recovery batches use the normal source-byte budget without flattening into individual intake", async () => {
    const server = await fixture()
    const client = defaultApi()
    const bulk = value(client.events("presenceUpdateBulk", { maxPendingBytes: 256 }))
    const individual = value(client.events("presenceUpdate"))
    value(await client.connect())
    server.dispatch(
        "PRESENCE_UPDATE_BULK",
        presenceBulkWire({
            presences: [presenceWire({ custom_status: { text: "ignored".repeat(100) } })],
        }),
    )
    const overflow = await bulk.waitForClose()
    expect(overflow.isErr() && overflow.error).toMatchObject({ _tag: "EventOverflowError", limit: "bytes" })
    expect(client.state).toBe("Connected")
    server.dispatch("PRESENCE_UPDATE", presenceWire())
    expect(value(await individual.next())?.userId).toBe("30")
})

test("the provider's 500-entry presence batch retains context through the public event boundary", async () => {
    const server = await fixture()
    const client = defaultApi()
    const pull = value(client.events("presenceUpdateBulk"))
    value(await client.connect())
    server.dispatch(
        "PRESENCE_UPDATE_BULK",
        presenceBulkWire({
            presences: Array.from({ length: 500 }, (_, index) =>
                directPresenceWire({ user: { id: String(index + 1) } }),
            ),
        }),
    )
    const batch = value(await pull.next())!
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

test("default voice subscriptions expose the initial visible snapshot and subsequent move phases without media fields", async () => {
    const server = await fixture(guildSnapshotWire([voiceStateWire()]))
    const client = defaultApi()
    const snapshots: VoiceStateSnapshot[] = []
    const updates: VoiceState[] = []
    value(
        client.on("voiceStateSnapshot", (snapshot) => {
            snapshots.push(snapshot)
        }),
    )
    value(
        client.on("voiceStateUpdate", (state) => {
            updates.push(state)
        }),
    )
    const initial = value(client.events("voiceStateSnapshot"))
    const transitions = value(client.events("voiceStateUpdate"))
    value(await client.connect())

    const snapshot = value(await initial.next())!
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
    }
    expect(snapshot).toEqual({ guildId: "40", voiceStates: [expectedInitial] })
    expect(
        Object.isFrozen(snapshot) && Object.isFrozen(snapshot.voiceStates) && Object.isFrozen(snapshot.voiceStates[0]),
    ).toBe(true)
    for (const omitted of ["selfVideo", "selfStream", "viewerStreamKeys", "e2eeCapable", "member"])
        expect(snapshot.voiceStates[0]).not.toHaveProperty(omitted)

    server.dispatch("VOICE_STATE_UPDATE", voiceStateWire({ channel_id: null }))
    server.dispatch(
        "VOICE_STATE_UPDATE",
        voiceStateWire({ channel_id: "42", connection_id: "replacement-connection", mute: true, deaf: false }),
    )
    expect(value(await transitions.next())).toMatchObject({ channelId: null, connectionId: "voice-connection" })
    expect(value(await transitions.next())).toMatchObject({
        channelId: "42",
        connectionId: "replacement-connection",
        isMuted: true,
        isDeafened: false,
    })
    await vi.waitFor(() => expect([snapshots.length, updates.length]).toEqual([1, 2]))
    expect(server.requests).toBe(0)
})

test("native voice callbacks preserve context and deliver an explicit empty initial collection", async () => {
    const server = await fixture(guildSnapshotWire([]))
    const snapshots: VoiceStateSnapshot[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const callback = yield* client.on("voiceStateSnapshot", (snapshot) =>
                    Effect.gen(function* () {
                        expect((yield* References.CurrentLogAnnotations).fixture).toBe("voice")
                        snapshots.push(snapshot)
                    }),
                )
                const stream = yield* Effect.forkScoped(
                    Stream.runCollect(client.events("voiceStateSnapshot").pipe(Stream.take(1))),
                )
                yield* client.connect()
                expect(yield* Fiber.join(stream)).toEqual([{ guildId: "40", voiceStates: [] }])
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(snapshots).toEqual([{ guildId: "40", voiceStates: [] }])),
                )
                yield* callback.unsubscribe()
                yield* callback.waitForClose()
            }),
        ).pipe(Effect.annotateLogs("fixture", "voice")),
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
    value(
        client.on("guildCreate", (guild) => {
            guilds.push(guild)
        }),
    )
    value(
        client.on("voiceStateSnapshot", (snapshot) => {
            snapshots.push(snapshot)
        }),
    )
    const closed = client.waitForClose()
    value(await client.connect())
    const outcome = await closed
    expect(outcome.isErr() && outcome.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
    expect(guilds).toEqual([])
    expect(snapshots).toEqual([])
    expect(server.requests).toBe(0)
})

test("private-call voice updates are ignored without interrupting guild voice observations", async () => {
    const server = await fixture()
    const client = defaultApi()
    const transitions = value(client.events("voiceStateUpdate"))
    value(await client.connect())

    server.dispatch("VOICE_STATE_UPDATE", voiceStateWire({ guild_id: null, member: null }))
    server.dispatch("VOICE_STATE_UPDATE", voiceStateWire())
    expect(value(await transitions.next())).toMatchObject({ guildId: "40", connectionId: "voice-connection" })
    expect(client.state).toBe("Connected")
})

test("REST edit/delete acknowledgements do not synthesize gateway events", async () => {
    const server = await fixture()
    const client = defaultApi()
    const update = value(client.events("messageUpdate", { maxPendingMessages: 1 }))
    const deletion = value(client.events("messageDelete", { maxPendingMessages: 1 }))
    value(await client.messages.edit({ id: "10", channelId: "20" }, { content: "REST only" }))
    value(await client.messages.delete({ id: "10", channelId: "20" }))
    value(await client.connect())
    server.dispatch("MESSAGE_UPDATE", wire("gateway only"))
    server.dispatch("MESSAGE_DELETE", { id: "11", channel_id: "20" })
    expect(value(await update.next())?.content).toBe("gateway only")
    expect(value(await deletion.next())?.id).toBe("11")
})

test("bulk batches count as one queued payload but consume their full source bytes and isolate overflow", async () => {
    const server = await fixture()
    const client = defaultApi()
    const one = value(client.events("messageDeleteBulk", { maxPendingMessages: 1 }))
    const bytes = value(client.events("messageDeleteBulk", { maxPendingBytes: 1 }))
    const other = value(client.events("messageUpdate"))
    value(await client.connect())
    const ids = Array.from({ length: 100 }, (_, index) => String(index + 1))
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids })
    const tooLarge = await bytes.waitForClose()
    expect(tooLarge.isErr() && tooLarge.error).toMatchObject({ _tag: "EventOverflowError", limit: "bytes" })
    expect(value(await one.next())?.ids).toEqual(ids)
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["1"] })
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["2"] })
    const overflow = await one.waitForClose()
    expect(overflow.isErr() && overflow.error).toMatchObject({
        _tag: "EventOverflowError",
        limit: "messages",
        capacity: 1,
    })
    server.dispatch("MESSAGE_UPDATE", wire())
    expect(value(await other.next())?.content).toBe("changed")
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
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const failure = yield* client.on("messageDelete", () => Effect.fail("fixture private failure"), {
                    onError: (report) =>
                        Effect.sync(() => {
                            reports.push(report.event)
                            expect(JSON.stringify(report)).not.toContain("private")
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
                yield* failure.unsubscribe()
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
                value(client.on("messageDelete", received))
                value(client.on("messageDeleteBulk", received))
                value(await client.connect())
                server.dispatch(event, body)
                const closed = await client.waitForClose()
                expect(closed.isErr() && closed.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
            } else {
                await Effect.runPromise(
                    Effect.scoped(
                        Effect.gen(function* () {
                            const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                            yield* client.on("messageDelete", () => Effect.sync(received))
                            yield* client.on("messageDeleteBulk", () => Effect.sync(received))
                            yield* client.connect()
                            server.dispatch(event, body)
                            expect(yield* Effect.result(client.waitForClose())).toMatchObject({
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
        value(await client.connect())
        server.dispatch(event, body)
        const result = await client.waitForClose()
        expect(result.isErr() && result.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
        expect(client.state).toBe("Closed")
    },
)
