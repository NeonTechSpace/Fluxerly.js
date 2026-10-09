---
title: Shard and supervise a bot
navTitle: Sharding
description: Split a large bot across gateway connections and processes, and resume sessions after a restart
---

A [shard](/docs/{{version}}/glossary/#shard) is one [gateway](/docs/{{version}}/glossary/#gateway) connection that carries the events of part of the bot's communities, which Fluxer's API calls [guilds](/docs/{{version}}/glossary/#guild). A bot starts with one connection, which is enough for about 2,000 communities. Fluxer allows at most 2,500 communities per shard and refuses to start a new session, the gateway login of one shard, above that with close code 4011 (sharding required)

## Let the SDK choose the shard count

Set `sharding: "auto"` and keep everything else the same. At the first connect, the SDK counts the bot's communities and opens one shard for every 2,000, all in this process. The lower target leaves room below Fluxer's ceiling, because communities do not split evenly across shards

```ts
import { runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    sharding: "auto",
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.content !== "!ping") return undefined
            return reply("Pong!")
        },
    },
})
```

Handlers and commands work the same on every shard. The `client.shards` list shows the shards this client owns, and a handler registered with `client.on` receives an `EventContext` third argument whose `shardId` names the shard that delivered the event. When the bot outgrows its plan while it runs, Fluxer closes a shard with close code 4011 and the SDK moves every shard to a larger plan in the same process, so the bot keeps running

<details>
<summary>Details of automatic sizing</summary>

The count pages through the bot's community list under its own deadline, as long as `connection.startupTimeoutMs`, and supports 1 through 16,384 shards.
The shards then start one second apart, and the startup deadline grows by one second for each shard after the first.
Until the count completes, `client.shards` and `diagnostics().shards` are empty.
A failed count fails startup like a connection failure.
When Fluxer closes a shard with 4011 while the client runs, the SDK counts again and moves every shard to the plan for the new count, or to one more shard when the count still fits the old plan.
Every shard then starts a new session, so events sent during the move are missed, and the community caches fill again from the new sessions.
The move is logged once at Warn with code `lifecycle.resharded` and the old and new totals.
After 3 moves within an hour, or at 16,384 shards, the next 4011 closure ends the client with a `ConnectionError`, as it does for an explicit `totalShards`.
Automatic sizing suits one process that owns every shard. Processes that split shards between them need an explicit total, unless the [supervisor](/docs/{{version}}/sharding/#run-shards-in-several-processes) sizes the plan for them

</details>

## Command pacing across reconnects

Outgoing presence, member requests, counts and `gateway.send` commands share a rolling send budget on each shard. A Resume within the same running client retains that send history, so reconnecting does not allow a second burst in the same window. A fresh Identify starts a new session and clears the history. Heartbeats, Identify and Resume bypass ordinary command pacing

Waiting custom commands fail when the connection is lost and are not replayed. Retained presence intent is published on the next ready connection using its latest value. Send history is kept in memory only and is not part of a saved session snapshot

## Resume after a restart

A restarted bot normally starts new sessions and misses the events sent while it was down. Fluxer keeps a disconnected session for 60 seconds. A session store saves each shard's session at shutdown and offers it at the next startup, so a quick restart, such as a deploy, resumes and receives the missed events within Fluxer's replay limits

```ts
import { fileSessionStore, runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    sharding: { totalShards: "auto", sessions: fileSessionStore("sessions") },
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.content !== "!ping") return undefined
            return reply("Pong!")
        },
    },
})
```

The `fileSessionStore` function keeps each shard's snapshot in its own file in the given folder, relative to the current working directory, and replaces a file only once its new contents are fully written. A snapshot contains the session ID, which lets the token resume the session, so keep the folder out of version control and readable only by the bot's account. Separate processes need separate folders unless their shard IDs never overlap. The store works with one shard as well: Pass `{ totalShards: 1, sessions: fileSessionStore("sessions") }`. To keep snapshots elsewhere, such as in a database, pass an object with `load` and `save` methods instead, as the [`SessionStore`](/docs/{{version}}/api/interfaces/js-ts.SessionStore/) reference describes

<details>
<summary>When a saved session is not used</summary>

Snapshots are saved only during a clean shutdown, after each socket has closed, so a crash leaves no fresh snapshot.
A snapshot older than 60 seconds, a malformed one or one for another gateway address is ignored and logged at Warn.
A failed `load` or `save`, or one that takes longer than 5 seconds, is logged in full at Error.
In every case the shard starts a new session, so a store problem never stops the bot.
If Fluxer no longer holds the session, the resume fails and the shard starts a new session as it would after any lost connection. If only part of the saved session's replay arrived first, the shard clears those cached community observations and their dependent resources before starting the new session. Reads cached during that wait are cleared again at READY. A successful resume retains the replayed observations.
Resume replays missed dispatches but sends no fresh community snapshot. Once every shard is ready, the SDK refills the enabled community, role and channel caches through REST, one request at a time, and logs `lifecycle.cacheRefill`. Set `sharding.refillCaches` to `false` to keep only observations from replay, later events and requests

</details>

## Choose the shards explicitly

A fixed plan splits shards between processes or hosts. Each process uses the same `totalShards` and its own non-overlapping `shardIds`

```ts
import { runBot } from "@neontechspace/fluxerly"

const shardIds = (process.env.SHARD_IDS ?? "0,1").split(",").map(Number)

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    sharding: { totalShards: 4, shardIds },
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.content !== "!ping") return undefined
            return reply("Pong!")
        },
    },
})
```

Start this file twice, once with `SHARD_IDS=0,1` and once with `SHARD_IDS=2,3`. Shard 0 also receives direct messages, so only the process that owns it sees them. Omit `shardIds` to own every shard in one process

To find the process that owns a community, pass its guild ID and the total to `snowflakes.shardFor(guildId, totalShards)`, which returns the shard Fluxer routes it to. Inside a process, `client.shardIdForGuild(guildId)` returns the local shard for that community, or `undefined` when another process owns it

<details>
<summary>Coordinate new sessions across processes</summary>

Fluxer limits how quickly a bot may start new sessions: 300 Identify commands, the command that starts a session, per IP address in each 60 seconds. One client spaces its own shards' Identify commands by one second, but separate processes do not know about each other.
Pass `sharding.identify` with a `permit(shardId, totalShards, signal)` function, backed for example by a shared lock service, to make every process wait for its turn.
The SDK calls it before each new session, never before a resume, and sends Identify as soon as the permit resolves. The coordinator then owns the pacing, so it should space its permits. A rejected permit is logged at Error and retried like a connection failure.
The [`IdentifyCoordinator`](/docs/{{version}}/api/interfaces/js-ts.IdentifyCoordinator/) reference describes the timing.
Children of the [supervisor](/docs/{{version}}/sharding/#run-shards-in-several-processes) below are paced by their parent and cannot set `sharding.identify`. To share the budget with other hosts, pass the same coordinator to the supervisor's `identify.coordinator` option, and the parent asks it before each child's new session

</details>

## Run shards in several processes

The [supervisor](/docs/{{version}}/glossary/#supervisor) starts several Node.js child processes, gives each its shards, restarts children that crash and stops them all on shutdown. Use it when one process is not enough, for example to spread a large bot over several CPU cores. One process can already own several shards, so smaller bots do not need it

Save the parent as `supervisor.js`. With `totalShards: "auto"` it counts the bot's communities at start, as `sharding: "auto"` does, and splits the shards evenly across `processes` children. The count needs the bot token in the parent too

```ts
import { describeError, supervisor } from "@neontechspace/fluxerly"

const workers = supervisor.create({
    entry: new URL("./shard-worker.js", import.meta.url),
    token: process.env.FLUXER_BOT_TOKEN,
    totalShards: "auto",
    processes: 2,
})

const stop = () => {
    workers.shutdown().then(undefined, (defect: unknown) => {
        console.error(describeError(defect))
        process.exitCode = 1
    })
}
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

const started = await workers.start()
const closed = started.isOk() ? await workers.waitForClose() : started
process.removeListener("SIGINT", stop)
process.removeListener("SIGTERM", stop)
if (closed.isErr()) {
    console.error(describeError(closed.error))
    process.exitCode = 1
}
```

The supervisor, unlike `runBot`, does not set the exit status, so the parent sets `process.exitCode` itself when the supervisor fails

Save each child as `shard-worker.js`. It creates its client through `supervisor.child.run`, registers the bot's commands and handlers in `configure`, and runs until the parent stops it. It sets a failing exit status too, so the parent can see that the child crashed

```ts
import { commands, describeError, supervisor } from "@neontechspace/fluxerly"

const result = await supervisor.child.run({
    token: process.env.FLUXER_BOT_TOKEN,
    configure: ({ client }) => {
        commands
            .create({ prefix: "!" })
            .registerMany({
                ping: { execute: ({ reply }) => reply("Pong!") },
            })
            .attach(client)
    },
})
if (result.isErr()) {
    console.error(describeError(result.error))
    process.exitCode = 1
}
```

Start the parent with `node --env-file=.env supervisor.js`. Children inherit its environment and Node.js flags, so they read the same token. With TypeScript, point `entry` at `shard-worker.ts`

The supervisor installs no signal handlers of its own, which is why the parent handles SIGINT and SIGTERM and calls `shutdown()`. That asks every child to stop, waits for them to exit and force-terminates a child that takes longer than 5 seconds. In both APIs, a child stopped by the parent first lets running handlers, queued handler events and REST requests finish for up to 4 seconds, one second less than `shutdownTimeoutMs`. The same drain applies to children stopped while an automatic plan grows. A child stopped by its own failure or a lost parent message channel cancels running work without draining. Each child's output appears in the parent's output with a `[shard N]` or `[child id]` label, and the parent logs child starts, exits, crashes and restarts. Under systemd, add `KillMode=mixed` as described in [deploying](/docs/{{version}}/deploying/)

A successful `start()` means every child accepted its shards and finished `configure`, not that every gateway session is ready. Use `workers.waitForReady()` to wait for connected sessions and `workers.status()` for a snapshot of each child. The Effect entry point exports a `supervisor` with the same options

Unknown keys in supervisor creation, assignment, restart, Identify and child-run options fail with `ConfigurationError`, with a suggested name when one is close. Child-run options are checked before waiting for the parent. The default API also checks the options passed to `waitForReady`, which accepts only `signal`. The Effect wait is cancelled by interruption instead

To resume sessions across a deploy, give each child the [session store](/docs/{{version}}/sharding/#resume-after-a-restart) from above through `clientOptions: { sharding: { sessions } }` in `supervisor.child.run`. The parent still assigns the shards, so `sessions` is the only sharding setting a child accepts

The SDK limits member requests for each client separately. Fluxer accepts 12 member requests per bot account in 10 seconds across all processes and drops the rest without an answer, so a dropped request ends with reason `timeout` after its deadline. When several children request members, keep their combined rate under that limit

<details>
<summary>Choose the plan yourself</summary>

A numeric `totalShards` fixes the total. Use `processes` for a number of children, `shardsPerProcess` for a number of shards per child, or `assignments` to name each child and its shards, such as `[{ id: "a", shardIds: [0, 1] }, { id: "b", shardIds: [2, 3] }]`.
Children created by `processes` or `shardsPerProcess` are named `process-0`, `process-1` and so on, and each owns a contiguous block of shards.
An automatic plan is counted at `start()`, and restarts keep it. A failed count fails `start()` with `SupervisorError` reason `shardCount`.
When Fluxer closes a child's shard with 4011 because the bot outgrew the plan, the supervisor stops every child, counts again and starts children for a larger plan, logging a `supervisor.resharded` record. After 3 such moves within an hour the supervisor fails instead.
With `totalShards: "auto"`, the `instance` and `transport` options select the Fluxer instance and HTTP implementation for the count, as they do for a client

</details>

<details>
<summary>Restart limits and timeouts</summary>

A child that exits unexpectedly is replaced by default, up to `maxAttempts` times in a row (default 3), with a delay that starts at `minDelayMs` (default 1 second) and doubles up to `maxDelayMs` (default 30 seconds). Adjust them with `restart: { maxAttempts: 5 }`, for example.
A child that ran for `healthyResetMs` (default 60 seconds) after finishing `configure` gets its full budget and the first delay back, so only a crash loop uses up the attempts.
When a child uses up its attempts, the supervisor fails and stops the other children. With `restart: false`, the first unexpected exit does the same.
Each child has `startupTimeoutMs` (default 30 seconds) to accept its assignment and finish `configure`, and `shutdownTimeoutMs` (default 5 seconds) to exit after a stop request.
A replacement is a new process with a new client. A crash leaves no saved session, so the replacement starts new sessions.
The [`SupervisorOptions`](/docs/{{version}}/api/interfaces/js-ts.SupervisorOptions/) reference lists every setting, including `childOutput`, `childEnvironment` and `execArgv`

</details>

## Watch the bot's health

A connected shard can still have a stopped subscription. The [application supervision guide](/docs/{{version}}/application-supervision/) shows how to watch the connection and a critical subscription together, and how to decide between failing and restarting. Across processes, `workers.status()` reports each child's process state, its latest connection state and its latest `diagnostics`: The child client's gateway latency, shard states, REST queue, cache use and counters, sent every 5 seconds by default (`diagnosticsIntervalMs`). The `restart` option replaces a child process that exits
