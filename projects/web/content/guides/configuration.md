---
title: Configure a bot
navTitle: Configuration
description: Choose the token, events, logging, cache, gateway and connection options for a bot
---

A bot is configured with one options object passed to [`runBot`](/docs/{{version}}/api/modules/js-ts/#runbot). The same client options also work with [`createClient`](/docs/{{version}}/api/modules/js-ts/#createclient) when an application manages the client itself. Only `token` is required. Every other option has a default that suits a small bot, so add options when the bot needs them

## A typical production configuration

This bot reads its token from the environment, stops cleanly on SIGTERM, prints JSON log lines, keeps the community data that permission checks need in memory and asks Fluxer to skip events it does not use

```ts
import { runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    logging: { format: "json" },
    cache: {
        guilds: true,
        channels: true,
        roles: true,
        members: { maxEntries: 5_000 },
        messages: { maxEntries: 2_000, maxAgeMs: 60 * 60 * 1_000 },
    },
    gateway: {
        ignoredEvents: "auto",
        presence: { status: "online", customStatus: { text: "Type !help" } },
    },
    rest: { defaultTimeoutMs: 15_000 },
    commands: {
        prefix: "!",
        commands: {
            ping: {
                description: "Check that the bot replies",
                execute: ({ reply }) => reply("Pong!"),
            },
        },
    },
})
```

Invalid options throw `ConfigurationError` from `runBot` before anything connects. The error names the field, and a misspelled option name gets the closest known name as a suggestion. A failure that stops the running bot, such as a rejected token, is logged once and sets `process.exitCode` to 1, so the process ends with a failure status. Set `reportFailure: false` only when the application handles the returned [Result](/docs/{{version}}/glossary/#result) and the exit status itself

## Options at a glance

| Option | What it controls |
| --- | --- |
| [`token`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#token) | The bot token. Pass `process.env.FLUXER_BOT_TOKEN` directly: An unset variable fails with a hint that points at it |
| [`events`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#events) | One [handler](/docs/{{version}}/glossary/#handler) per event name, as a function or an object with its own delivery settings |
| [`commands`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#commands) | Prefix commands, guards and cooldowns, as described in [commands](/docs/{{version}}/commands/) |
| [`setup`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#setup) | Startup work that runs after handlers are registered and before the bot connects |
| [`onError`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#onerror) | Receives every handler, command and callback failure. Without it, each failure is logged in full at Error |
| [`processSignals`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#processsignals) | Set `true` to stop cleanly on Ctrl+C (SIGINT) and SIGTERM. Off by default |
| [`signal`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#signal) | An `AbortSignal` that stops the bot from application code |
| [`reportFailure`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#reportfailure) | Whether a failed run is logged and sets `process.exitCode`. On by default |
| [`logging`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#logging) | Level, per-category levels, output format and custom sinks. See [logging](/docs/{{version}}/logging/) |
| [`cache`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#cache) | Which resources the client keeps in memory for local lookups. Nothing is cached by default. See [history and cache](/docs/{{version}}/history-and-cache/) |
| [`gateway`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#gateway) | Events Fluxer should not send, session flags, the initial presence and what to do with malformed events |
| [`sharding`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#sharding) | Split the bot across several gateway connections, called [shards](/docs/{{version}}/glossary/#shard). See [sharding](/docs/{{version}}/sharding/) |
| [`connection`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#connection) | Startup deadline, startup attempts and reconnect timing |
| [`rest`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#rest) | How many HTTP requests run and wait at once, and the default request deadline |
| [`transport`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#transport) | Replace the HTTP and WebSocket implementations or the User-Agent, for proxies, instrumentation and tests |
| [`instance`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#instance) | Connect to a self-hosted Fluxer instance instead of hosted Fluxer |
| [`messageFields`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#messagefields) | Build only the message fields the bot reads |
| [`uploads`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#uploads) | The byte budget reserved by queued and active attachment uploads |

The reference for [`BotOptions`](/docs/{{version}}/api/interfaces/js-ts.BotOptions/) lists every nested setting with its default and allowed range

## Token

Keep the token out of source files and images. Read it from an environment variable and start the bot with `node --env-file=.env bot.js` during development, or let the process manager set the variable in production, as shown in [deploying](/docs/{{version}}/deploying/). The SDK never writes the token to logs or error messages

The SDK removes surrounding spaces and one pair of matching quotes, which `.env` files often add. It adds the `Bot` scheme itself, so a token that starts with `Bot ` or `Bearer ` is rejected with `ConfigurationError`

## Events and the gateway

Fluxer's [gateway](/docs/{{version}}/glossary/#gateway) has no [intents](/docs/{{version}}/glossary/#intent) setting to request. Each connection receives every event type unless `gateway.ignoredEvents` lists it, so registering a handler is enough to receive its event

Setting `ignoredEvents: "auto"` asks Fluxer to skip every event type that no registered handler, enabled cache or SDK feature needs, which saves bandwidth and decoding on busy bots. The list is computed when the bot connects, so register handlers before that, as `runBot` does

<details>
<summary>Limits of automatic event filtering</summary>

A handler registered after the bot connected receives the skipped types only after that shard starts a new session. A connection that resumes its session keeps the old list.
A `raw` event subscriber turns automatic filtering off.
Enabled cache categories keep the event types they need, so large caches reduce the savings.
Fluxer still delivers a message that mentions the bot, @here or @everyone.
An explicit array of upper-case dispatch names, such as `["TYPING_START"]`, is also accepted. The [`GatewayOptions`](/docs/{{version}}/api/interfaces/js-ts.GatewayOptions/) reference lists the names that cannot be skipped

</details>

Each event handler has a small queue. By default `messageCreate` runs up to eight handlers at a time and other events one at a time, and a full queue drops the oldest waiting event with a Warn record instead of stopping the bot. Pass `{ handler, concurrency, maxPendingMessages, overflow }` instead of a function to change this for one event. The `overflow` setting is `"dropOldest"` by default, `"dropNewest"` to drop the arriving event instead, or `"stop"` to close that handler's subscription. See [bot lifetime](/docs/{{version}}/starter-lifetime/) for how the runner treats handlers

Running several handlers at a time can finish events out of order. The `partition` setting keeps related events in order: With `partition: "channel"`, the messages of one channel run one after another while other channels run beside them, and `partition: "guild"` does the same for each community, which the API calls a guild. A partitioned handler runs up to eight events at a time unless `concurrency` says otherwise

## Logging and errors

The client prints startup, readiness, lost connections, long rate-limit waits, shutdown and every application error by default. Set `logging.level` or per-category levels to change what appears, and `logging.sink` to forward records to an existing logger. Set the `FLUXERLY_DEBUG` environment variable to turn on Debug records without changing code. The [logging guide](/docs/{{version}}/logging/) shows the output and every setting

Pass `onError` to send handler and command failures to an error tracker. Each [`FailureReport`](/docs/{{version}}/api/interfaces/js-ts.FailureReport/) holds the original error and the IDs involved, and `report.describe()` returns readable text. See [reliability](/docs/{{version}}/reliability/) for failures that do return a Result

## Cache

The client keeps no [cache](/docs/{{version}}/glossary/#cache) unless asked. Enable a category with `true`, or pass `{ maxEntries, maxBytes, maxAgeMs }` to bound it. Caching communities, channels, roles and members lets permission checks such as `guards.requirePermissions` answer without extra requests. Enabled community, role, channel, emoji and sticker caches fill from the community data Fluxer sends when the bot connects. The [history and cache guide](/docs/{{version}}/history-and-cache/) explains what a cached value can and cannot prove

Each category keeps at most 1,000 entries and 4 MiB by default, and messages 1,000 entries and 8 MiB. The limits apply to the whole client, not per community. When a category is full, its least recently used entry is removed, so lookups start to miss. Size each category for the communities this process serves:

- Communities (`guilds`): At least the number of communities
- Roles and channels: About the number of communities times the average roles or channels per community
- Members: The members the bot actually looks up, such as recently active users, not every member

Under a [supervisor](/docs/{{version}}/glossary/#supervisor), each child process sizes its caches for its own shards. This helper logs how full each enabled category is

```ts
import type { Client } from "@neontechspace/fluxerly"

export function logCacheUsage(client: Client) {
    for (const [kind, cache] of Object.entries(client.diagnostics().caches)) {
        if (!cache.configured) continue
        console.info(
            `${kind}: ${cache.retainedEntries} of ${cache.maxEntries} entries, ${cache.accountedBytes} of ${cache.maxBytes} bytes`,
        )
    }
}
```

<details>
<summary>When cached entries are cleared</summary>

After a lost connection, community, member, role, channel, emoji and sticker entries stay when the session resumes, and are cleared when the shard has to start a new session.
A lost connection clears the message, user and direct-message entries it could have changed, even when the session resumes.
A process that resumes a session saved before a restart refills the community, role and channel caches through REST once every shard is ready, unless `sharding.refillCaches` is `false`.
Byte counts measure the stored JSON, not process memory

</details>

## Connection and requests

The defaults suit most bots: Startup may take 30 seconds with up to 3 attempts per [shard](/docs/{{version}}/glossary/#shard). A process with several shards starts them one second apart and adds that second to the deadline for each shard after the first. After that, a lost connection is retried with a growing random delay, capped at 30 seconds unless Fluxer asks for a longer wait, and transient failures never make the bot give up. The `connection` option changes those values. The `rest` option sets how many API requests run at once (by default 4 for each shard, up to 64), how many may wait (default 256) and the default deadline for each request (30 seconds). When the queue is full, a new request fails with reason `busy` and the SDK logs `rest.busy` at Warn. Raising `rest.concurrency` does not raise Fluxer's [rate limits](/docs/{{version}}/glossary/#rate-limit), which still apply per route

The `transport` option is for advanced cases, such as sending traffic through a proxy or recording requests. The [testing entry point](/docs/{{version}}/testing/) uses it to connect a real client to an in-memory Fluxer

## Effect configuration

The [Effect `runBot`](/docs/{{version}}/api/modules/Effect/#runbot) accepts the same options, with Effect handlers and an Effect `setup`. The Effect API also accepts a `connection.recovery.schedule` that decides reconnect delays. See the [Effect first bot](/docs/{{version}}/effect-first-bot/) guide
