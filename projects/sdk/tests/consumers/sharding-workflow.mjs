import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"

const kind = process.argv[2]
assert.ok(kind === "default" || kind === "effect", "Select default or effect sharding workflow")

// This installed-package loopback verifies package wiring; tests/live/sharding.mjs remains the provider proof
const totalShards = 2
const guildIds = ["1", "4194304"]

function frame(payload, opcode = 1) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body])
    assert.ok(body.length < 65_536, "Fixture frame exceeded its bounded payload")
    const header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
    return Buffer.concat([header, body])
}

function websocketAccept(key) {
    return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
}

function shardForGuild(guildId) {
    return Number((BigInt(guildId) >> 22n) % BigInt(totalShards))
}

async function waitFor(predicate, message) {
    const deadline = Date.now() + 5_000
    while (!predicate()) {
        if (Date.now() >= deadline) throw Error(message)
        await sleep(5)
    }
}

async function fixture({ automaticReady }) {
    let origin = ""
    let sequence = 0
    const connections = new Set()
    const identifies = []
    const countRequests = []
    const memberRequests = []
    const server = createServer((request, response) => {
        const target = new URL(request.url ?? "/", origin)
        if (target.pathname === "/.well-known/fluxer") {
            response.setHeader("content-type", "application/json")
            response.end(
                JSON.stringify({
                    api_code_version: 1,
                    endpoints: {
                        api_public: `${origin}/api`,
                        gateway: origin.replace("http:", "ws:") + "/gateway",
                        media: `${origin}/media`,
                        static_cdn: `${origin}/static`,
                        webapp: `${origin}/web`,
                        invite: `${origin}/invite`,
                    },
                    features: { presigned_attachment_uploads: false },
                }),
            )
            return
        }
        response.statusCode = 404
        response.end()
    })
    server.on("upgrade", (request, socket) => {
        assert.equal(request.url, "/gateway?v=1&encoding=json")
        const key = request.headers["sec-websocket-key"]
        assert.equal(typeof key, "string")
        socket.write(
            [
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
                "",
                "",
            ].join("\r\n"),
        )
        const connection = { socket, shardId: undefined }
        connections.add(connection)
        socket.once("close", () => connections.delete(connection))
        socket.write(frame(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })))
        let pending = Buffer.alloc(0)
        socket.on("data", (chunk) => {
            pending = Buffer.concat([pending, chunk])
            while (pending.length >= 2) {
                let length = pending[1] & 0x7f
                let headerLength = 2
                if (length === 126) {
                    if (pending.length < 4) return
                    length = pending.readUInt16BE(2)
                    headerLength = 4
                }
                assert.notEqual(length, 127, "Fixture accepts only bounded client frames")
                const size = headerLength + 4 + length
                if (pending.length < size) return
                const opcode = pending[0] & 0x0f
                const mask = pending.subarray(headerLength, headerLength + 4)
                const payload = Buffer.from(pending.subarray(headerLength + 4, size))
                for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
                pending = pending.subarray(size)
                if (opcode === 8) {
                    socket.end(frame(payload, 8))
                    return
                }
                if (opcode !== 1) continue
                const command = JSON.parse(payload.toString())
                if (command.op === 1) socket.write(frame(JSON.stringify({ op: 11 })))
                if (command.op === 2) {
                    assert.ok(Array.isArray(command.d.shard))
                    assert.equal(command.d.shard.length, 2)
                    const [shardId, shards] = command.d.shard
                    assert.ok(Number.isSafeInteger(shardId) && shardId >= 0 && shardId < totalShards)
                    assert.equal(shards, totalShards)
                    connection.shardId = shardId
                    const identify = { connection, command }
                    identifies.push(identify)
                    if (automaticReady) ready(identify)
                }
                if (command.op === 8) {
                    assert.equal(typeof command.d.guild_id, "string")
                    assert.equal(connection.shardId, shardForGuild(command.d.guild_id))
                    assert.equal(typeof command.d.nonce, "string")
                    memberRequests.push({ connection, command })
                }
                if (command.op === 15) {
                    assert.ok(Array.isArray(command.d.guild_ids))
                    assert.ok(command.d.guild_ids.every((guildId) => typeof guildId === "string"))
                    assert.ok(command.d.guild_ids.every((guildId) => connection.shardId === shardForGuild(guildId)))
                    assert.equal(typeof command.d.nonce, "string")
                    countRequests.push({ connection, command })
                }
            }
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    assert.ok(address && typeof address !== "string", "Fixture has no TCP port")
    origin = `http://127.0.0.1:${address.port}`

    function dispatch(connection, event, data) {
        connection.socket.write(frame(JSON.stringify({ op: 0, s: ++sequence, t: event, d: data })))
    }

    function ready(identify) {
        const [shardId] = identify.command.d.shard
        dispatch(identify.connection, "READY", { session_id: `fixture-${shardId}`, shard: identify.command.d.shard })
    }

    return {
        origin,
        identifies,
        countRequests,
        memberRequests,
        ready,
        replyMembers(request) {
            const { guild_id: guildId, nonce } = request.command.d
            dispatch(request.connection, "GUILD_MEMBERS_CHUNK", {
                nonce,
                guild_id: guildId,
                chunk_index: 0,
                chunk_count: 1,
                members: [
                    {
                        user: { id: "30", username: "fixture" },
                        roles: [],
                        joined_at: "2026-01-01T00:00:00.000Z",
                        nick: null,
                        avatar: null,
                        banner: null,
                    },
                ],
            })
        },
        replyCounts(request) {
            dispatch(request.connection, "GUILD_COUNTS_UPDATE", {
                nonce: request.command.d.nonce,
                counts: request.command.d.guild_ids.map((guildId) => ({
                    guild_id: guildId,
                    member_count: 1,
                    online_count: 1,
                })),
            })
        },
        async waitClosed() {
            await waitFor(() => connections.size === 0, "Owned sharding sockets did not close")
        },
        async close() {
            for (const { socket } of connections) socket.destroy()
            await new Promise((resolve) => server.close(resolve))
        },
    }
}

async function membersOnEveryShard(client, remote, runtime) {
    for (const guildId of guildIds) {
        const requestCount = remote.memberRequests.length + 1
        const members =
            kind === "default"
                ? collectDefaultMembers(client, guildId)
                : runtime.Effect.runPromise(
                      client.members.iterateChunks(guildId, { userIds: ["30"] }).pipe(runtime.Stream.runCollect),
                  )
        await waitFor(() => remote.memberRequests.length === requestCount, "Member request was not sent")
        const request = remote.memberRequests.at(-1)
        assert.ok(request)
        assert.equal(request.connection.shardId, shardForGuild(guildId))
        remote.replyMembers(request)
        const chunks = Array.from(await members)
        assert.equal(chunks.length, 1)
        assert.equal(chunks[0].guildId, guildId)
        assert.equal(chunks[0].members[0]?.userId, "30")
    }
}

async function countsAcrossShards(client, remote, runtime) {
    const counts =
        kind === "default"
            ? client.guilds.fetchCounts(guildIds)
            : runtime.Effect.runPromise(client.guilds.fetchCounts(guildIds))
    await waitFor(
        () => remote.countRequests.length === totalShards,
        "Guild count requests were not sent to both shards",
    )
    for (const request of remote.countRequests) remote.replyCounts(request)
    const result = kind === "default" ? (await counts)._unsafeUnwrap() : await counts
    assert.deepEqual(
        result.counts.map((count) => count.guildId),
        guildIds,
    )
    assert.deepEqual(result.omittedGuildIds, [])
}

async function collectDefaultMembers(client, guildId) {
    const chunks = []
    for await (const result of client.members.iterateChunks(guildId, { userIds: ["30"] })) {
        assert.ok(result.isOk(), result.isErr() ? result.error.message : "")
        chunks.push(result.value)
    }
    return chunks
}

async function connectedWorkflow() {
    const remote = await fixture({ automaticReady: true })
    let client
    let scope
    let runtime
    try {
        runtime =
            kind === "default"
                ? undefined
                : await import("effect").then(({ Effect, Exit, Scope, Stream }) => ({ Effect, Exit, Scope, Stream }))
        if (kind === "default") {
            const { createClient } = await import("@neontechspace/fluxerly")
            client = createClient({
                token: "fixture-only",
                instance: { url: remote.origin, allowInsecure: true },
                sharding: { totalShards },
            })._unsafeUnwrap()
            ;(await client.connect())._unsafeUnwrap()
        } else {
            const { createClient } = await import("@neontechspace/fluxerly/effect")
            scope = runtime.Scope.makeUnsafe()
            client = await runtime.Effect.runPromise(
                createClient({
                    token: "fixture-only",
                    instance: { url: remote.origin, allowInsecure: true },
                    sharding: { totalShards },
                }).pipe(runtime.Scope.provide(scope)),
            )
            await runtime.Effect.runPromise(client.connect())
        }
        assert.equal(client.state, "Connected")
        assert.deepEqual(
            client.shards.map((shard) => ({ shardId: shard.shardId, state: shard.state })),
            [
                { shardId: 0, state: "Connected" },
                { shardId: 1, state: "Connected" },
            ],
        )
        assert.deepEqual(
            remote.identifies.map(({ connection }) => connection.shardId).sort((left, right) => left - right),
            [0, 1],
        )
        await countsAcrossShards(client, remote, runtime)
        await membersOnEveryShard(client, remote, runtime)
        if (kind === "default") (await client.shutdown())._unsafeUnwrap()
        else await runtime.Effect.runPromise(client.shutdown())
        assert.equal(client.state, "Closed")
        await remote.waitClosed()
    } finally {
        try {
            if (client && client.state !== "Closed") {
                if (kind === "default") (await client.shutdown())._unsafeUnwrap()
                else await runtime.Effect.runPromise(client.shutdown())
            }
        } finally {
            try {
                if (scope) await runtime.Effect.runPromise(runtime.Scope.close(scope, runtime.Exit.void))
            } finally {
                await remote.close()
            }
        }
    }
}

async function cancelledStartupWorkflow() {
    const remote = await fixture({ automaticReady: false })
    let client
    let scope
    let runtime
    try {
        runtime =
            kind === "default"
                ? undefined
                : await import("effect").then(({ Cause, Effect, Exit, Fiber, Scope }) => ({
                      Cause,
                      Effect,
                      Exit,
                      Fiber,
                      Scope,
                  }))
        let pending
        if (kind === "default") {
            const { createClient } = await import("@neontechspace/fluxerly")
            client = createClient({
                token: "fixture-only",
                instance: { url: remote.origin, allowInsecure: true },
                sharding: { totalShards },
            })._unsafeUnwrap()
            const controller = new AbortController()
            pending = { result: client.connect({ signal: controller.signal }), cancel: () => controller.abort() }
        } else {
            const { createClient } = await import("@neontechspace/fluxerly/effect")
            scope = runtime.Scope.makeUnsafe()
            client = await runtime.Effect.runPromise(
                createClient({
                    token: "fixture-only",
                    instance: { url: remote.origin, allowInsecure: true },
                    sharding: { totalShards },
                }).pipe(runtime.Scope.provide(scope)),
            )
            const fiber = runtime.Effect.runFork(client.connect())
            pending = {
                result: runtime.Effect.runPromiseExit(runtime.Fiber.join(fiber)),
                cancel: () => runtime.Effect.runPromise(runtime.Fiber.interrupt(fiber)),
            }
        }
        await waitFor(() => remote.identifies.length === 1, "First shard did not identify")
        remote.ready(remote.identifies[0])
        await waitFor(
            () => client.shards.some((shard) => shard.state === "Connected") && client.state === "Connecting",
            "First shard did not become ready before cancellation",
        )
        await pending.cancel()
        const result = await pending.result
        if (kind === "default") {
            assert.ok(result.isErr())
            assert.equal(result.error._tag, "CancelledError")
        } else {
            assert.ok(runtime.Exit.isFailure(result) && runtime.Cause.hasInterruptsOnly(result.cause))
        }
        assert.equal(client.state, "Disconnected")
        assert.ok(client.shards.every((shard) => shard.state === "Disconnected"))
        await remote.waitClosed()
    } finally {
        try {
            if (client && client.state !== "Closed") {
                if (kind === "default") (await client.shutdown())._unsafeUnwrap()
                else await runtime.Effect.runPromise(client.shutdown())
            }
        } finally {
            try {
                if (scope) await runtime.Effect.runPromise(runtime.Scope.close(scope, runtime.Exit.void))
            } finally {
                await remote.close()
            }
        }
    }
}

await connectedWorkflow()
await cancelledStartupWorkflow()
console.log(`${kind} packed sharding workflow passed`)
