import assert from "node:assert/strict"
import { Recorder, startLoopback } from "./loopback.js"

const kind = process.argv[2]
assert.ok(kind === "default" || kind === "effect", "Select default or effect sharding workflow")

// This installed-package loopback verifies that the packed sharding modules are wired. Shard routing rules stay with
// tests/client/sharding and tests/live/sharding.js remains the provider proof
const totalShards = 2
const guildIds = ["1", "4194304"]
const identifies = []
const countRequests = new Recorder()
const remote = await startLoopback({
    command(command, connection) {
        if (command.op === 2) {
            identifies.push(command.d.shard)
            remote.dispatch(connection, "READY", {
                session_id: `fixture-${command.d.shard[0]}`,
                shard: command.d.shard,
            })
        }
        if (command.op === 15) countRequests.record({ connection, command })
    },
})

let client
let runtime
let scope
const run = (operation) =>
    kind === "default" ? operation.then((result) => result._unsafeUnwrap()) : runtime.Effect.runPromise(operation)
try {
    const settings = {
        token: "fixture-only",
        instance: { url: remote.origin, allowInsecure: true },
        sharding: { totalShards },
    }
    if (kind === "default") {
        const { createClient } = await import("@neontechspace/fluxerly")
        client = createClient(settings)
    } else {
        runtime = await import("effect")
        const { createClient } = await import("@neontechspace/fluxerly/effect")
        scope = runtime.Scope.makeUnsafe()
        client = await runtime.Effect.runPromise(createClient(settings).pipe(runtime.Scope.provide(scope)))
    }
    await run(client.connect())
    assert.equal(client.state, "Connected")
    assert.deepEqual(
        client.shards.map(({ shardId, state }) => ({ shardId, state })),
        [
            { shardId: 0, state: "Connected" },
            { shardId: 1, state: "Connected" },
        ],
    )
    assert.deepEqual(
        identifies.toSorted(([left], [right]) => left - right),
        [
            [0, totalShards],
            [1, totalShards],
        ],
    )

    // One guild on each shard, so the count request reaches both gateway connections
    const counts = run(client.guilds.fetchCounts(guildIds))
    for (const { connection, command } of await countRequests.reach(totalShards))
        remote.dispatch(connection, "GUILD_COUNTS_UPDATE", {
            nonce: command.d.nonce,
            counts: command.d.guild_ids.map((guildId) => ({ guild_id: guildId, member_count: 1, online_count: 1 })),
        })
    const result = await counts
    assert.deepEqual(
        result.counts.map((count) => count.guildId),
        guildIds,
    )
    assert.equal(new Set(countRequests.items.map(({ connection }) => connection)).size, totalShards)

    await run(client.shutdown())
    assert.equal(client.state, "Closed")
    await remote.closed()
} finally {
    try {
        if (client && client.state !== "Closed") await run(client.shutdown())
        if (scope) await runtime.Effect.runPromise(runtime.Scope.close(scope, runtime.Exit.void))
    } finally {
        await remote.close()
    }
}
console.log(`${kind} packed sharding workflow passed`)
