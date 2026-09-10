import { Effect } from "effect"
import { expect, test } from "vitest"
import { CountOwner } from "../src/internal/counts.js"
import { GatewayRequestBudget } from "../src/internal/gateway-requests.js"
import { MemberChunkOwner } from "../src/internal/member-chunks.js"

interface GuildFrame {
    readonly shardId: number
    readonly guildIds: readonly string[]
    readonly nonce: string
}

interface ChannelFrame {
    readonly shardId: number
    readonly guildId: string
    readonly channelIds: readonly string[]
    readonly nonce: string
}

function attachCountShards(owner: CountOwner, guildFrames: GuildFrame[], channelFrames: ChannelFrame[]) {
    for (const shardId of [0, 1]) {
        owner.attach(
            (guildIds, nonce) => guildFrames.push({ shardId, guildIds, nonce }),
            (guildId, channelIds, nonce) => channelFrames.push({ shardId, guildId, channelIds, nonce }),
            shardId,
        )
    }
}

test("count requests scatter one logical lease across owning shards and preserve caller order", async () => {
    const budget = new GatewayRequestBudget()
    const guildFrames: GuildFrame[] = []
    const channelFrames: ChannelFrame[] = []
    const counts = new CountOwner(budget, (guildId) => (guildId === "30" ? 1 : guildId === "99" ? undefined : 0))
    attachCountShards(counts, guildFrames, channelFrames)

    const scattered = Effect.runPromise(counts.fetchGuilds(["30", "20", "10"]))
    const second = Effect.runPromise(counts.fetchGuilds(["11"]))
    const third = Effect.runPromise(counts.fetchGuilds(["12"]))
    const fourth = Effect.runPromise(counts.fetchGuilds(["13"]))
    await expect(Effect.runPromise(counts.fetchGuilds(["14"]))).rejects.toMatchObject({ reason: "busy" })

    expect(guildFrames.map(({ shardId, guildIds }) => ({ shardId, guildIds }))).toEqual([
        { shardId: 1, guildIds: ["30"] },
        { shardId: 0, guildIds: ["20", "10"] },
        { shardId: 0, guildIds: ["11"] },
        { shardId: 0, guildIds: ["12"] },
        { shardId: 0, guildIds: ["13"] },
    ])

    for (const frame of guildFrames) {
        const countsForFrame = frame.guildIds.includes("30")
            ? [{ guild_id: "30", member_count: 3, online_count: 2 }]
            : frame.guildIds.includes("20")
              ? [{ guild_id: "10", member_count: 1, online_count: 0 }]
              : []
        counts.receiveGuildCounts({ nonce: frame.nonce, counts: countsForFrame })
    }
    await expect(scattered).resolves.toEqual({
        counts: [
            { guildId: "30", memberCount: 3, onlineCount: 2 },
            { guildId: "10", memberCount: 1, onlineCount: 0 },
        ],
        omittedGuildIds: ["20"],
    })
    await expect(Promise.all([second, third, fourth])).resolves.toEqual([
        { counts: [], omittedGuildIds: ["11"] },
        { counts: [], omittedGuildIds: ["12"] },
        { counts: [], omittedGuildIds: ["13"] },
    ])

    const channels = Effect.runPromise(counts.fetchChannels("30", ["40"]))
    expect(channelFrames).toHaveLength(1)
    expect(channelFrames[0]).toMatchObject({ shardId: 1, guildId: "30", channelIds: ["40"] })
    counts.receiveChannelMemberCounts({
        nonce: channelFrames[0]!.nonce,
        counts: [{ guild_id: "30", channel_id: "40", member_count: 2, online_count: 1 }],
    })
    await expect(channels).resolves.toEqual({
        counts: [{ guildId: "30", channelId: "40", memberCount: 2, onlineCount: 1 }],
        omittedChannelIds: [],
    })

    await expect(Effect.runPromise(counts.fetchGuilds(["99"]))).rejects.toMatchObject({ reason: "notConnected" })
    expect(guildFrames).toHaveLength(5)
})

test("an unrelated shard detach leaves the shared member stream and healthy requests active", async () => {
    const budget = new GatewayRequestBudget()
    const countFrames: GuildFrame[] = []
    const counts = new CountOwner(budget, () => 0)
    attachCountShards(counts, countFrames, [])
    const memberFrames: {
        readonly shardId: number
        readonly payload: Readonly<Record<string, unknown>>
        readonly nonce: string
    }[] = []
    const members = new MemberChunkOwner(budget, () => 0)
    members.attach((payload, nonce) => memberFrames.push({ shardId: 0, payload, nonce }), 0)
    members.attach((payload, nonce) => memberFrames.push({ shardId: 1, payload, nonce }), 1)

    const first = Effect.runPromise(counts.fetchGuilds(["10"]))
    const second = Effect.runPromise(counts.fetchGuilds(["11"]))
    const third = Effect.runPromise(counts.fetchGuilds(["12"]))
    const source = await Effect.runPromise(members.open("20", { userIds: ["40"] }))
    await expect(Effect.runPromise(counts.fetchGuilds(["13"]))).rejects.toMatchObject({ reason: "busy" })

    expect(memberFrames).toEqual([
        {
            shardId: 0,
            payload: { guild_id: "20", user_ids: ["40"], presences: false },
            nonce: source.nonce,
        },
    ])
    counts.detach(1)
    members.detach(1)

    for (const frame of countFrames) counts.receiveGuildCounts({ nonce: frame.nonce, counts: [] })
    await expect(Promise.all([first, second, third])).resolves.toEqual([
        { counts: [], omittedGuildIds: ["10"] },
        { counts: [], omittedGuildIds: ["11"] },
        { counts: [], omittedGuildIds: ["12"] },
    ])

    const chunk = Effect.runPromise(source.next)
    members.receive(
        {
            nonce: source.nonce,
            guild_id: "20",
            members: [{ user: { id: "40", username: "fixture" }, roles: [], joined_at: "2026-09-10T00:00:00.000Z" }],
            chunk_index: 0,
            chunk_count: 1,
        },
        300,
    )
    await expect(chunk).resolves.toMatchObject({ guildId: "20", index: 0, count: 1 })
    await Effect.runPromise(source.close)
})

test("losing an owning shard cancels every fragment of its scattered count request", async () => {
    const guildFrames: GuildFrame[] = []
    const counts = new CountOwner(new GatewayRequestBudget(), (guildId) => (guildId === "30" ? 1 : 0))
    attachCountShards(counts, guildFrames, [])

    const request = Effect.runPromise(counts.fetchGuilds(["20", "30"]))
    expect(guildFrames).toHaveLength(2)
    counts.detach(1)
    await expect(request).rejects.toMatchObject({ reason: "connectionLost" })

    counts.receiveGuildCounts({
        nonce: guildFrames.find((frame) => frame.shardId === 0)!.nonce,
        counts: [{ guild_id: "20", member_count: 1, online_count: 1 }],
    })
    const next = Effect.runPromise(counts.fetchGuilds(["20"]))
    const nextFrame = guildFrames.at(-1)!
    counts.receiveGuildCounts({ nonce: nextFrame.nonce, counts: [] })
    await expect(next).resolves.toEqual({ counts: [], omittedGuildIds: ["20"] })
})
