import { Effect, Exit, Scope } from "effect"
import { describe, expect, onTestFinished, test, vi } from "vitest"
import { ChannelType, type GuildChannel, type MessageReactionBatch } from "../../src/index.js"
import { createTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { Opcode, opcodeName, reservedClientOpcodes } from "../../src/internal/protocol/gateway.js"
import { modes, type Mode } from "../support/both-apis.js"

const channelWire = (id: string, type: number, extra: Record<string, unknown> = {}) => ({
    id,
    guild_id: "40",
    type,
    name: `channel-${id}`,
    position: 1,
    parent_id: null,
    permission_overwrites: [],
    ...extra,
})

const threadWire = (id: string, parentId: string, extra: Record<string, unknown> = {}) => ({
    id,
    guild_id: "40",
    type: ChannelType.PublicThread,
    parent_id: parentId,
    owner_id: "30",
    name: `thread-${id}`,
    thread_metadata: {
        archived: false,
        locked: false,
        auto_archive_duration: 4320,
        archive_timestamp: "2026-01-01T00:00:00.000Z",
        create_timestamp: "2026-01-01T00:00:00.000Z",
    },
    ...extra,
})

const messageWire = (id: string, channelId: string, extra: Record<string, unknown> = {}) => ({
    id,
    channel_id: channelId,
    guild_id: "40",
    content: `Message ${id}`,
    author: { id: "30", username: "author" },
    ...extra,
})

const memberWire = (userId: string, username: string, extra: Record<string, unknown> = {}) => ({
    user: { id: userId, username },
    roles: ["500"],
    joined_at: "2026-01-01T00:00:00.000Z",
    ...extra,
})

async function setupClient(
    mode: Mode,
    options: Pick<NonNullable<Parameters<typeof createTestClient>[0]>, "cache" | "gateway"> = {},
) {
    if (mode === "default") {
        const harness = createTestClient(options)
        onTestFinished(() => harness.shutdown())
        return {
            emit: async (type: string, body: unknown) => {
                harness.emit(type, body)
            },
            ready: () => harness.ready(),
            onDelete: (handler: (channel: GuildChannel, previous: GuildChannel | undefined) => void) => {
                harness.client.on("guildChannelDelete", (channel, _signal, context) => {
                    handler(channel, context.previous)
                })
            },
            onReactionBatch: (handler: (batch: MessageReactionBatch) => void) => {
                harness.client.on("messageReactionAddMany", (batch) => {
                    handler(batch)
                })
            },
            getChannel: async (id: string) => harness.client.channels.get(id),
            getMessage: async (channelId: string, id: string) => harness.client.messages.get({ channelId, id }),
            getMember: async (guildId: string, userId: string) => harness.client.members.get({ guildId, userId }),
            state: () => harness.client.state,
            counters: () => harness.counters(),
            logs: () => harness.logs(),
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const harness = await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
    return {
        emit: (type: string, body: unknown) => Effect.runPromise(harness.emit(type, body)),
        ready: () => Effect.runPromise(harness.ready()),
        onDelete: async (handler: (channel: GuildChannel, previous: GuildChannel | undefined) => void) => {
            await Effect.runPromise(
                harness.client
                    .on("guildChannelDelete", (channel, context) =>
                        Effect.sync(() => handler(channel, context.previous)),
                    )
                    .pipe(Scope.provide(scope)),
            )
        },
        onReactionBatch: async (handler: (batch: MessageReactionBatch) => void) => {
            await Effect.runPromise(
                harness.client
                    .on("messageReactionAddMany", (batch) => Effect.sync(() => handler(batch)))
                    .pipe(Scope.provide(scope)),
            )
        },
        getChannel: (id: string) => Effect.runPromise(harness.client.channels.get(id)),
        getMessage: (channelId: string, id: string) =>
            Effect.runPromise(harness.client.messages.get({ channelId, id })),
        getMember: (guildId: string, userId: string) =>
            Effect.runPromise(harness.client.members.get({ guildId, userId })),
        state: () => harness.client.state,
        counters: () => harness.counters(),
        logs: () => harness.logs(),
    }
}

describe("synthesized CHANNEL_DELETE without type", () => {
    test.each(modes)(
        "%s decodes synthesized CHANNEL_DELETE as unknown with rawType null, evicts channel, threads and unplaced messages, and keeps sibling caches intact",
        async (mode) => {
            const client = await setupClient(mode, {
                cache: { channels: true, messages: true },
                gateway: { onMalformedDispatch: "terminate" },
            })
            const deleted: { channel: GuildChannel; previous: GuildChannel | undefined }[] = []
            await client.onDelete((channel, previous) => {
                deleted.push({ channel, previous })
            })
            await client.ready()

            // Seed two text channels, a child thread under channel 100, a sibling thread under 101, and messages
            await client.emit("CHANNEL_CREATE", channelWire("100", ChannelType.Text))
            await client.emit("CHANNEL_CREATE", channelWire("101", ChannelType.Text))
            await client.emit("THREAD_CREATE", threadWire("200", "100"))
            await client.emit("THREAD_CREATE", threadWire("201", "101"))
            await client.emit("MESSAGE_CREATE", messageWire("300", "100"))
            await client.emit("MESSAGE_CREATE", messageWire("301", "200"))
            await client.emit("MESSAGE_CREATE", messageWire("302", "101"))
            await client.emit("MESSAGE_CREATE", messageWire("303", "201"))
            // An unplaced message whose channel was never cached in channelCache
            await client.emit("MESSAGE_CREATE", messageWire("304", "299"))

            // Fluxer's visibility.gleam delete_payload emits only id and guild_id when a session loses ViewChannel
            await client.emit("CHANNEL_DELETE", { id: "100", guild_id: "40" })

            await vi.waitFor(() => expect(deleted).toHaveLength(1))
            expect(client.state()).toBe("Connected")
            expect(client.counters()).toMatchObject({ protocolFailures: 0, eventsDropped: { malformed: 0 } })
            expect(deleted[0]!.channel).toEqual({ id: "100", guildId: "40", type: "unknown", rawType: null })
            expect(Object.isFrozen(deleted[0]!.channel)).toBe(true)
            expect(deleted[0]!.previous).toMatchObject({ id: "100", type: ChannelType.Text })

            // Channel 100 and its child thread 200 are evicted; sibling 101 and its thread 201 remain
            expect(await client.getChannel("100")).toBeUndefined()
            expect(await client.getChannel("200")).toBeUndefined()
            expect(await client.getChannel("101")).toMatchObject({ id: "101", type: ChannelType.Text })
            expect(await client.getChannel("201")).toMatchObject({ id: "201", parentId: "101" })

            // Messages in deleted channel 100, evicted child thread 200, and unplaced channel 299 are evicted;
            // messages in still-cached channels 101 and 201 stay
            expect(await client.getMessage("100", "300")).toBeUndefined()
            expect(await client.getMessage("200", "301")).toBeUndefined()
            expect(await client.getMessage("299", "304")).toBeUndefined()
            expect(await client.getMessage("101", "302")).toMatchObject({ id: "302" })
            expect(await client.getMessage("201", "303")).toMatchObject({ id: "303" })
        },
    )

    test.each(modes)(
        "%s evicts child threads when an uncached parent receives synthesized CHANNEL_DELETE, and evicts guild channels when a cached category does",
        async (mode) => {
            const client = await setupClient(mode, { cache: { channels: true } })
            await client.ready()

            // Parent 150 is NOT in channelCache, while its child thread 250 IS cached alongside sibling channel 151
            await client.emit("THREAD_CREATE", threadWire("250", "150"))
            await client.emit("CHANNEL_CREATE", channelWire("151", ChannelType.Text))
            await client.emit("CHANNEL_DELETE", { id: "150", guild_id: "40" })
            expect(await client.getChannel("250")).toBeUndefined()
            expect(await client.getChannel("151")).toMatchObject({ id: "151" })

            // A cached voice channel receiving synthesized CHANNEL_DELETE evicts only itself, keeping siblings
            await client.emit("CHANNEL_CREATE", channelWire("160", ChannelType.Voice))
            await client.emit("CHANNEL_DELETE", { id: "160", guild_id: "40" })
            expect(await client.getChannel("160")).toBeUndefined()
            expect(await client.getChannel("151")).toMatchObject({ id: "151" })

            // A cached category receiving synthesized CHANNEL_DELETE evicts every cached channel in that guild
            await client.emit("CHANNEL_CREATE", channelWire("170", ChannelType.Category))
            await client.emit("CHANNEL_DELETE", { id: "170", guild_id: "40" })
            expect(await client.getChannel("170")).toBeUndefined()
            expect(await client.getChannel("151")).toBeUndefined()
        },
    )

    test.each(modes)(
        "%s still rejects CHANNEL_CREATE and CHANNEL_UPDATE without type, and CHANNEL_DELETE with null type, as malformed",
        async (mode) => {
            const client = await setupClient(mode, { gateway: { onMalformedDispatch: "skip" } })
            await client.ready()

            await client.emit("CHANNEL_CREATE", { id: "100", guild_id: "40" })
            await client.emit("CHANNEL_UPDATE", { id: "100", guild_id: "40" })
            await client.emit("CHANNEL_DELETE", { id: "100", guild_id: "40", type: null })

            const rejected = client
                .logs()
                .filter((record) => record.code === "gateway.dispatchRejected")
                .map((record) => ({ dispatch: record.fields?.dispatch, field: record.fields?.field }))
            expect(rejected).toEqual([
                { dispatch: "CHANNEL_CREATE", field: "type" },
                { dispatch: "CHANNEL_UPDATE", field: "type" },
                { dispatch: "CHANNEL_DELETE", field: "type" },
            ])
        },
    )
})

describe("MESSAGE_REACTION_ADD_MANY per-entry member decoding and cache intake", () => {
    test.each(modes)(
        "%s decodes per-entry member on guild batches, populates member cache, completes nameless members, and isolates malformed members",
        async (mode) => {
            const client = await setupClient(mode, { cache: { members: true } })
            const batches: MessageReactionBatch[] = []
            await client.onReactionBatch((batch) => {
                batches.push(batch)
            })
            await client.ready()

            // Seed cached members for user 32 (for nameless completion) and user 33 (for malformed-member eviction)
            await client.emit("GUILD_MEMBER_ADD", {
                guild_id: "40",
                ...memberWire("32", "existing-32", { nick: "old" }),
            })
            await client.emit("GUILD_MEMBER_ADD", { guild_id: "40", ...memberWire("33", "existing-33") })
            expect(await client.getMember("40", "32")).toMatchObject({ username: "existing-32", nickname: "old" })
            expect(await client.getMember("40", "33")).toMatchObject({ username: "existing-33" })

            await client.emit("MESSAGE_REACTION_ADD_MANY", {
                channel_id: "20",
                message_id: "10",
                guild_id: "40",
                reactions: [
                    { user_id: "30", emoji: { name: "👍" }, member: memberWire("30", "alice", { nick: "Ali" }) },
                    { user_id: "31", emoji: { name: "🔥" } },
                    {
                        user_id: "32",
                        emoji: { name: "🎉" },
                        member: {
                            user: { id: "32" },
                            roles: ["501"],
                            joined_at: "2026-01-01T00:00:00.000Z",
                            nick: "new",
                        },
                    },
                    {
                        user_id: "33",
                        emoji: { name: "👀" },
                        member: {
                            user: { id: "33", username: "bad" },
                            roles: "not-an-array",
                            joined_at: "2026-01-01T00:00:00.000Z",
                        },
                    },
                ],
            })

            await vi.waitFor(() => expect(batches).toHaveLength(1))
            const [batch] = batches
            expect(batch).toMatchObject({
                id: "10",
                channelId: "20",
                guildId: "40",
            })
            expect(batch!.reactions).toHaveLength(4)
            expect(batch!.reactions[0]).toMatchObject({
                userId: "30",
                emoji: { name: "👍" },
                member: { guildId: "40", userId: "30", username: "alice", nickname: "Ali", roleIds: ["500"] },
            })
            expect(batch!.reactions[1]).toEqual({ userId: "31", emoji: { name: "🔥" } })
            expect(batch!.reactions[2]).toEqual({ userId: "32", emoji: { name: "🎉" } })
            expect(batch!.reactions[3]).toEqual({ userId: "33", emoji: { name: "👀" } })

            // Member 30 is stored; nameless 32 is completed from cache and updated; malformed 33 is evicted with warning
            expect(await client.getMember("40", "30")).toMatchObject({ username: "alice", nickname: "Ali" })
            expect(await client.getMember("40", "32")).toMatchObject({
                username: "existing-32",
                nickname: "new",
                roleIds: ["501"],
            })
            expect(await client.getMember("40", "33")).toBeUndefined()
            expect(client.logs().filter((record) => record.code === "gateway.memberSkipped")).toEqual([
                expect.objectContaining({
                    level: "warn",
                    fields: { dispatch: "MESSAGE_REACTION_ADD_MANY", guildId: "40" },
                }),
            ])

            // DM batch without guild_id decodes cleanly without attaching members or touching member cache
            await client.emit("MESSAGE_REACTION_ADD_MANY", {
                channel_id: "90",
                message_id: "91",
                reactions: [{ user_id: "30", emoji: { name: "👍" } }],
            })
            await vi.waitFor(() => expect(batches).toHaveLength(2))
            expect(batches[1]).toEqual({
                id: "91",
                channelId: "90",
                reactions: [{ userId: "30", emoji: { name: "👍" } }],
            })

            // A malformed batch that carried a member evicts that user from the member cache
            await client.emit("MESSAGE_REACTION_ADD_MANY", {
                channel_id: "20",
                message_id: "10",
                guild_id: "40",
                reactions: [{ user_id: "30", emoji: { name: 123 }, member: memberWire("30", "alice") }],
            })
            expect(await client.getMember("40", "30")).toBeUndefined()
            expect(await client.getMember("40", "32")).toMatchObject({ username: "existing-32" })
        },
    )
})

describe("gateway opcode table parity", () => {
    test("defines voiceStateUpdate (4) and voiceSignal (13) with log names and keeps them sendable", () => {
        expect(Opcode.voiceStateUpdate).toBe(4)
        expect(Opcode.voiceSignal).toBe(13)
        expect(opcodeName(Opcode.voiceStateUpdate)).toBe("VOICE_STATE_UPDATE")
        expect(opcodeName(Opcode.voiceSignal)).toBe("VOICE_SIGNAL")
        expect(opcodeName(28)).toBe("REQUEST_FORUM_UNREADS")
        expect(reservedClientOpcodes.has(Opcode.voiceStateUpdate)).toBe(false)
        expect(reservedClientOpcodes.has(Opcode.voiceSignal)).toBe(false)
    })
})
