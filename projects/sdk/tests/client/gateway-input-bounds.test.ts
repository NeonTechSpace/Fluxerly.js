import { Stream } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import type { Client, MemberChunk, MemberChunkQuery } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { Opcode } from "../../src/internal/protocol/gateway.js"
import { modes, setup, type Mode } from "../support/both-apis.js"
import { startGatewayServer, type GatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { expectErr, settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const maximum = "9223372036854775807"
const oversized = "9223372036854775808"

async function fixture(mode: Mode) {
    const server: GatewayServer = await startGatewayServer({
        onCommand: ({ op, d }, socket) => {
            if (op === Opcode.requestGuildMembers)
                server.dispatch(
                    "GUILD_MEMBERS_CHUNK",
                    {
                        nonce: d.nonce,
                        guild_id: d.guild_id,
                        members: [],
                        chunk_index: 0,
                        chunk_count: 1,
                    },
                    socket,
                )
            if (op === Opcode.requestGuildCounts)
                server.dispatch("GUILD_COUNTS_UPDATE", { nonce: d.nonce, counts: [] }, socket)
            if (op === Opcode.requestChannelMemberCounts)
                server.dispatch("CHANNEL_MEMBER_COUNTS_UPDATE", { nonce: d.nonce, counts: [] }, socket)
        },
    })
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const client = (await setup(mode)) as Client
    await settle(client.connect())
    const chunks = async (guildId: string, query: MemberChunkQuery): Promise<readonly MemberChunk[]> => {
        if (mode === "native")
            return settle(
                (client as unknown as NativeClient).members.iterateChunks(guildId, query).pipe(Stream.runCollect),
            )
        const values: MemberChunk[] = []
        for await (const result of client.members.iterateChunks(guildId, query)) values.push(await settle(result))
        return values
    }
    return { server, client, chunks }
}

for (const mode of modes) {
    test(`${mode} gateway IDs accept the signed maximum and reject oversized inputs before sending or widening member selection`, async () => {
        const { server, client, chunks } = await fixture(mode)
        expect(await chunks(maximum, { userIds: [maximum] })).toMatchObject([
            { guildId: maximum, omittedUserIds: [maximum] },
        ])
        expect(await settle(client.guilds.fetchCounts([maximum]))).toMatchObject({ omittedGuildIds: [maximum] })
        expect(await settle(client.channels.fetchMemberCounts(maximum, [maximum]))).toMatchObject({
            omittedChannelIds: [maximum],
        })
        await settle(client.presence.setMembers(maximum, [maximum]))
        await vi.waitFor(() => expect(server.commandsWithOp(Opcode.memberSubscriptions)).toHaveLength(1), {
            interval: 5,
        })
        expect(server.commandsWithOp(Opcode.requestGuildMembers)[0]!.d).toMatchObject({
            guild_id: maximum,
            user_ids: [maximum],
        })
        expect(server.commandsWithOp(Opcode.requestGuildCounts)[0]!.d).toMatchObject({ guild_ids: [maximum] })
        expect(server.commandsWithOp(Opcode.requestChannelMemberCounts)[0]!.d).toMatchObject({
            guild_id: maximum,
            channel_ids: [maximum],
        })
        expect(server.commandsWithOp(Opcode.memberSubscriptions)[0]!.d).toMatchObject({
            subscriptions: { [maximum]: { members: [maximum] } },
        })
        const before = server.commands.length
        await expect(chunks(oversized, { all: true })).rejects.toMatchObject({
            _tag: "MemberChunkError",
            reason: "input",
        })
        await expect(chunks("20", { userIds: [oversized] })).rejects.toMatchObject({
            _tag: "MemberChunkError",
            reason: "input",
        })
        await expect(chunks("20", { userIds: ["30", oversized] })).rejects.toMatchObject({
            _tag: "MemberChunkError",
            reason: "input",
        })
        expect(await expectErr(client.guilds.fetchCounts([oversized]))).toMatchObject({
            _tag: "CountOperationError",
            reason: "input",
        })
        expect(await expectErr(client.channels.fetchMemberCounts(oversized, ["20"]))).toMatchObject({
            _tag: "CountOperationError",
            reason: "input",
        })
        expect(await expectErr(client.channels.fetchMemberCounts("20", [oversized]))).toMatchObject({
            _tag: "CountOperationError",
            reason: "input",
        })
        expect(await expectErr(client.presence.setMembers(oversized, ["30"]))).toMatchObject({
            _tag: "PresenceError",
            reason: "input",
        })
        expect(await expectErr(client.presence.setMembers("20", [oversized]))).toMatchObject({
            _tag: "PresenceError",
            reason: "input",
        })
        for (const id of ["0", "01", "-1", "1.0"]) {
            expect(await expectErr(client.presence.setMembers(id, ["30"]))).toMatchObject({ reason: "input" })
            expect(await expectErr(client.presence.setMembers("20", [id]))).toMatchObject({ reason: "input" })
        }
        expect(server.commands).toHaveLength(before)
        await settle(client.shutdown())
    })
}
