import { Effect, Exit, Fiber, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Client, EventSubscription } from "../../src/index.js"
import type { CallCreate, CallDelete, CallUpdate, EntranceSoundPlay, EventName } from "../../src/events.js"
import type { Client as NativeClient } from "../../src/effect.js"
import {
    decodeCallCreate,
    decodeCallDelete,
    decodeCallUpdate,
    decodeEntranceSoundPlay,
} from "../../src/internal/calls.js"
import { setup } from "../support/both-apis.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => vi.unstubAllGlobals())

// Wire shapes follow Fluxer's gateway events documentation, including the call voice-state routing fields clients ignore
const voiceStateWire = (userId: string, extra: Record<string, unknown> = {}) => ({
    guild_id: null,
    channel_id: "20",
    user_id: userId,
    connection_id: `connection-${userId}`,
    session_id: `session-${userId}`,
    member: null,
    mute: false,
    deaf: false,
    self_mute: true,
    self_deaf: false,
    self_video: false,
    self_stream: false,
    is_mobile: false,
    suppress: false,
    viewer_stream_keys: [],
    e2ee_capable: true,
    version: 3,
    region_id: "internal-region",
    server_id: "internal-server",
    ...extra,
})

const callWire = (extra: Record<string, unknown> = {}) => ({
    channel_id: "20",
    message_id: "70",
    region: "eu-west",
    ringing: ["31", "32"],
    voice_states: [voiceStateWire("30")],
    ...extra,
})

const soundWire = (extra: Record<string, unknown> = {}) => ({
    user_id: "30",
    channel_id: "20",
    guild_id: null,
    sound_id: "90",
    hash: "abc123",
    url: "https://media.fluxer.app/sounds/90.ogg",
    duration_ms: 1_250,
    content_type: "audio/ogg",
    ...extra,
})

const voiceState = (userId: string) => ({
    channelId: "20",
    userId,
    connectionId: `connection-${userId}`,
    sessionId: `session-${userId}`,
    isMuted: false,
    isDeafened: false,
    isSelfMuted: true,
    isSelfDeafened: false,
    isMobile: false,
    isSuppressed: false,
})

const update: CallUpdate = {
    channelId: "20",
    messageId: "70",
    region: "eu-west",
    ringingUserIds: ["31", "32"],
    voiceStates: [voiceState("30")],
}

test("call and entrance-sound decoders project frozen camelCase copies without routing fields", () => {
    const created = decodeCallCreate(callWire({ recipients: ["30", "31", "32"], created_at: 1_760_000_000_000 }))
    expect(created).toEqual({
        ...update,
        recipientIds: ["30", "31", "32"],
        createdAtMs: 1_760_000_000_000,
    } satisfies CallCreate)
    expect(
        Object.isFrozen(created) &&
            Object.isFrozen(created!.ringingUserIds) &&
            Object.isFrozen(created!.voiceStates) &&
            Object.isFrozen(created!.voiceStates[0]) &&
            Object.isFrozen(created!.recipientIds),
    ).toBe(true)
    // Initial state fields are optional on create, and an update never carries them
    expect(decodeCallCreate(callWire({ region: null, ringing: [], voice_states: [] }))).toEqual({
        ...update,
        region: null,
        ringingUserIds: [],
        voiceStates: [],
    })
    expect(decodeCallUpdate(callWire({ recipients: ["30"], created_at: 1 }))).toEqual(update)
    expect(decodeCallUpdate(callWire({ voice_states: [voiceStateWire("30", { guild_id: undefined })] }))).toEqual(
        update,
    )
    expect(decodeCallDelete({ channel_id: "20" })).toEqual({ channelId: "20", unavailable: false } satisfies CallDelete)
    expect(decodeCallDelete({ channel_id: "20", unavailable: true })).toEqual({ channelId: "20", unavailable: true })
    const sound = decodeEntranceSoundPlay(soundWire())
    expect(sound).toEqual({
        userId: "30",
        channelId: "20",
        guildId: null,
        soundId: "90",
        hash: "abc123",
        url: "https://media.fluxer.app/sounds/90.ogg",
        durationMs: 1_250,
        contentType: "audio/ogg",
    } satisfies EntranceSoundPlay)
    expect(Object.isFrozen(sound)).toBe(true)
    expect(decodeEntranceSoundPlay(soundWire({ guild_id: "4" }))).toMatchObject({ guildId: "4" })
})

test.each([
    ["a call without a message ID", () => decodeCallUpdate(callWire({ message_id: undefined }))],
    ["a non-string region", () => decodeCallUpdate(callWire({ region: 4 }))],
    ["a ringing entry that is not an ID", () => decodeCallUpdate(callWire({ ringing: ["31", 32] }))],
    ["a missing voice-state list", () => decodeCallUpdate(callWire({ voice_states: undefined }))],
    [
        "a call voice state scoped to a server",
        () => decodeCallUpdate(callWire({ voice_states: [voiceStateWire("30", { guild_id: "4" })] })),
    ],
    [
        "a call voice state without a connection ID",
        () => decodeCallUpdate(callWire({ voice_states: [voiceStateWire("30", { connection_id: null })] })),
    ],
    ["recipients that are not IDs", () => decodeCallCreate(callWire({ recipients: "30" }))],
    ["a fractional creation time", () => decodeCallCreate(callWire({ created_at: 1.5 }))],
    ["a non-boolean unavailable flag", () => decodeCallDelete({ channel_id: "20", unavailable: "yes" })],
    ["a sound without a guild field", () => decodeEntranceSoundPlay(soundWire({ guild_id: undefined }))],
    ["a negative sound duration", () => decodeEntranceSoundPlay(soundWire({ duration_ms: -1 }))],
    ["an empty sound URL", () => decodeEntranceSoundPlay(soundWire({ url: "" }))],
])("decoders reject %s", (_name, decode) => {
    expect(decode()).toBeUndefined()
})

async function gateway() {
    const fixture = await startGatewayServer()
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    return fixture
}

test("default subscriptions receive dispatched call and entrance-sound events, skipping malformed ones", async () => {
    const server = await gateway()
    const client = (await setup("default")) as Client
    const created = client.subscribe("callCreate")
    const updated = client.subscribe("callUpdate")
    const deleted = client.subscribe("callDelete")
    const sounds = client.subscribe("entranceSoundPlay")
    expect((await client.connect()).isOk()).toBe(true)
    server.dispatch("CALL_CREATE", callWire({ voice_states: [voiceStateWire("30", { guild_id: "4" })] }))
    server.dispatch("CALL_UPDATE", callWire({ ringing: "31" }))
    server.dispatch("CALL_DELETE", { channel_id: "twenty" })
    server.dispatch("ENTRANCE_SOUND_PLAY", soundWire({ hash: null }))
    server.dispatch("CALL_CREATE", callWire())
    server.dispatch("CALL_UPDATE", callWire())
    server.dispatch("CALL_DELETE", { channel_id: "20", unavailable: true })
    server.dispatch("ENTRANCE_SOUND_PLAY", soundWire())
    const next = async <K extends EventName>(subscription: EventSubscription<K>) => {
        const result = await subscription.next()
        if (result.isErr()) throw result.error
        return result.value
    }
    expect(await next(created)).toEqual(update)
    expect(await next(updated)).toEqual(update)
    expect(await next(deleted)).toEqual({ channelId: "20", unavailable: true })
    expect(await next(sounds)).toMatchObject({ soundId: "90", guildId: null })
    expect(client.diagnostics().counters.eventsDropped.malformed).toBe(4)
    expect(client.state).toBe("Connected")
})

test("native handlers and streams receive call events with their delivery context", async () => {
    const server = await gateway()
    const client = (await setup("native")) as NativeClient
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const deletions: [CallDelete, number][] = []
    const sounds = await Effect.runPromise(
        Effect.gen(function* () {
            yield* client.on("callDelete", (event, context) =>
                Effect.sync(() => void deletions.push([event, context.shardId])),
            )
            const sounds = yield* Effect.forkScoped(
                Stream.runCollect(client.subscribe("entranceSoundPlay").pipe(Stream.take(1))),
            )
            yield* client.connect()
            return sounds
        }).pipe(Scope.provide(scope)),
    )
    server.dispatch("CALL_DELETE", { channel_id: "20" })
    server.dispatch("ENTRANCE_SOUND_PLAY", soundWire({ guild_id: "4" }))
    expect(await Effect.runPromise(Fiber.join(sounds))).toEqual([expect.objectContaining({ guildId: "4" })])
    await vi.waitFor(() => expect(deletions).toEqual([[{ channelId: "20", unavailable: false }, 0]]))
})

test("a malformed call or entrance-sound dispatch leaves unrelated caches intact", async () => {
    const server = await gateway()
    const client = (await setup("default", { cache: { users: true } })) as Client
    const users = client.subscribe("userUpdate")
    const deleted = client.subscribe("callDelete")
    expect((await client.connect()).isOk()).toBe(true)
    server.dispatch("USER_UPDATE", {
        id: "30",
        username: "fixture",
        discriminator: "0001",
        global_name: null,
        avatar: null,
        avatar_color: null,
        flags: 0,
    })
    expect((await users.next()).isOk()).toBe(true)
    expect(client.users.get("30")).toMatchObject({ id: "30" })
    server.dispatch("CALL_CREATE", callWire({ region: 4 }))
    server.dispatch("ENTRANCE_SOUND_PLAY", soundWire({ guild_id: "4", duration_ms: -1 }))
    server.dispatch("CALL_DELETE", { channel_id: "20" })
    expect((await deleted.next()).isOk()).toBe(true)
    expect(client.diagnostics().counters.eventsDropped.malformed).toBe(2)
    expect(client.users.get("30")).toMatchObject({ id: "30" })
})
