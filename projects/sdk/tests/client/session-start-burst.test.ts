import { EventEmitter } from "node:events"
import { afterEach, expect, test, vi } from "vitest"
import type { Client, WebSocketLike } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { createFixtures } from "../../src/testing.js"
import { describeBothApis, setup, type Mode } from "../support/both-apis.js"
import { driveSdkTime, hostTurnsUntil, sdkClock } from "../support/client-clock.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { settle } from "../support/settle.js"

afterEach(() => vi.restoreAllMocks())

type AnyClient = Client | NativeClient
type Frame = { readonly op: number; readonly d?: unknown }

/**
 * A scripted transport socket with no I/O or host timers. Frames delivered in one call reach the SDK on the same turn,
 * as ws emits the frames of one read
 */
class ScriptSocket extends EventEmitter implements WebSocketLike {
    readyState = 1
    constructor(private readonly command: (socket: ScriptSocket, frame: Frame) => void) {
        super()
        queueMicrotask(() => this.deliver({ op: 10, d: { heartbeat_interval: 60_000 } }))
    }
    send(data: string, callback: (error?: Error) => void) {
        const frame = JSON.parse(data) as Frame
        queueMicrotask(() => callback())
        if (frame.op === 1) queueMicrotask(() => this.deliver({ op: 11 }))
        else this.command(this, frame)
    }
    deliver(...frames: unknown[]) {
        for (const frame of frames)
            if (this.readyState === 1) this.emit("message", Buffer.from(JSON.stringify(frame)), false)
    }
    close(code: number) {
        if (this.readyState !== 1) return
        this.readyState = 3
        queueMicrotask(() => this.emit("close", code))
    }
    terminate() {
        this.close(1006)
    }
}

const fixtures = createFixtures()
/** A community on shard 1 of 2, since a snowflake's timestamp above bit 22 picks its shard */
const otherGuildId = String(BigInt(fixtures.ids.guild) + (1n << 22n))
const otherChannelId = String(BigInt(fixtures.ids.channel) + (1n << 22n))

/** READY and the community snapshot Fluxer sends right after it, back to back */
function startBurst(shard: readonly [number, number], guildId: string, name: string) {
    const channelId = guildId === fixtures.ids.guild ? fixtures.ids.channel : otherChannelId
    return [
        { op: 0, s: 1, t: "READY", d: { session_id: `session-${name}`, shard, user: fixtures.botUser(), guilds: [] } },
        {
            op: 0,
            s: 2,
            t: "GUILD_CREATE",
            d: fixtures.guildCreate({
                guild: { id: guildId, name, system_channel_id: channelId },
                channels: [fixtures.channel({ id: channelId, guild_id: guildId })],
            }),
        },
    ]
}

async function cached(client: AnyClient, guildId: string) {
    // Settling runs a native lookup and passes a default lookup's value through
    const lookups = client as Client
    const channelId = guildId === fixtures.ids.guild ? fixtures.ids.channel : otherChannelId
    return {
        guild: (await settle(lookups.guilds.get(guildId)))?.name,
        roles: (await settle(lookups.roles.getAll(guildId)))?.map((role) => role.id),
        self: (await settle(lookups.members.getSelf(guildId)))?.userId,
        channel: (await settle(lookups.channels.get(channelId)))?.id,
    }
}

const expected = (guildId: string, name: string) => ({
    guild: name,
    roles: [guildId],
    self: fixtures.ids.bot,
    channel: guildId === fixtures.ids.guild ? fixtures.ids.channel : otherChannelId,
})

function burstClient(mode: Mode, totalShards: number, script: (socket: ScriptSocket, frame: Frame) => void) {
    return setup(mode, {
        logging: { level: "silent" },
        cache: { guilds: true, roles: true, channels: true, members: true },
        sharding: { totalShards },
        transport: {
            fetch: async () => Response.json(hostedDiscoveryDocument),
            webSocket: () => new ScriptSocket(script),
        },
    }) as Promise<AnyClient>
}

describeBothApis("communities sent in the same read as READY", (mode) => {
    test("the first session keeps the startup snapshot", async () => {
        const client = await burstClient(mode, 1, (socket, { op }) => {
            if (op === 2) socket.deliver(...startBurst([0, 1], fixtures.ids.guild, "first"))
        })
        await settle(client.connect())
        expect(client.shards.map((shard) => shard.sessionEpoch)).toEqual([1])
        expect(await cached(client, fixtures.ids.guild)).toEqual(expected(fixtures.ids.guild, "first"))
    })

    test("a later new session keeps the snapshot it receives", async () => {
        const clock = sdkClock()
        const sockets: ScriptSocket[] = []
        const client = await burstClient(mode, 1, (socket, { op }) => {
            if (op !== 2) return
            sockets.push(socket)
            socket.deliver(...startBurst([0, 1], fixtures.ids.guild, `session ${sockets.length}`))
        })
        await settle(client.connect())
        expect(await cached(client, fixtures.ids.guild)).toEqual(expected(fixtures.ids.guild, "session 1"))

        // Fluxer refuses the session, so the shard identifies again and receives each community after the new READY
        sockets[0]!.deliver({ op: 9, d: false })
        await hostTurnsUntil(() => client.state === "Recovering")
        // Move SDK time through the recovery wait in steps, bounded so a hang fails in SDK time
        for (let elapsed = 0; client.state !== "Connected"; elapsed += 50) {
            expect(elapsed).toBeLessThan(10_000)
            await clock.advance(50)
        }
        expect(sockets).toHaveLength(2)
        expect(client.shards.map((shard) => shard.sessionEpoch)).toEqual([2])
        expect(await cached(client, fixtures.ids.guild)).toEqual(expected(fixtures.ids.guild, "session 2"))
    })

    test("staggered shards each keep their own snapshot", async () => {
        const clock = sdkClock()
        const client = await burstClient(mode, 2, (socket, { op, d }) => {
            if (op !== 2) return
            const [shardId] = (d as { shard: [number, number] }).shard
            socket.deliver(
                ...startBurst([shardId, 2], shardId === 0 ? fixtures.ids.guild : otherGuildId, `shard ${shardId}`),
            )
        })
        expect(client.shardIdForGuild(otherGuildId)).toBe(1)
        expect(client.shardIdForGuild(fixtures.ids.guild)).toBe(0)
        await driveSdkTime(clock, settle(client.connect()))
        expect(client.shards.map((shard) => shard.sessionEpoch)).toEqual([1, 2])
        expect(await cached(client, fixtures.ids.guild)).toEqual(expected(fixtures.ids.guild, "shard 0"))
        expect(await cached(client, otherGuildId)).toEqual(expected(otherGuildId, "shard 1"))
    })
})
