---
title: Test a bot without Fluxer
navTitle: Testing a bot
description: Run commands and handlers against an in-memory Fluxer with the testing entry points, without a token or network
---

The `@neontechspace/fluxerly/testing` entry point creates a real client connected to an in-memory Fluxer. A test sends the bot a fake message or event and checks the requests the bot made. No token, network or Fluxer account is needed, and the events pass through the SDK's own decoding, [caches](/docs/{{version}}/glossary/#cache) and [handlers](/docs/{{version}}/glossary/#handler)

## Share the bot's options with its tests

A bot started with [`runBot`](/docs/{{version}}/starter-lifetime/) is tested with `createTestBot`, which takes the same options. The bot file that `fluxerly init` writes, shown in the [quick start](/docs/{{version}}/quick-start/), exports those options without the token as `bot` and starts the bot only when Node.js runs the file:

```js
{{starter:bot.js}}
```

A test imports `bot` from this file, so the bot and its tests run the same events, commands and setup. The `defineBot` function returns the options unchanged and keeps the types of command arguments, which an object annotated with `BotOptions` loses. A larger bot can keep its options in a module of their own instead, such as `bot-options.ts`, which both the bot file and the tests import

## Write a first test

This test uses `node:test`, the test runner built into Node.js, so nothing else needs installing. A project from `fluxerly init` already has a similar test as `bot.test.js`, or `bot.test.ts` for TypeScript, and runs it with `npm test`, `pnpm test` or `bun run test`

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { defineBot } from "@neontechspace/fluxerly"
import { createTestBot } from "@neontechspace/fluxerly/testing"

// In a project, import bot from ./bot.ts. It is repeated here so the example runs on its own
const bot = defineBot({
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

test("!ping replies Pong!", async () => {
    await using testBot = createTestBot(bot)
    await testBot.ready()

    const replies = await testBot.say("!ping")
    assert.deepEqual(
        replies.map((message) => message.content),
        ["Pong!"],
    )
})

test("other messages get no reply", async () => {
    await using testBot = createTestBot(bot)
    await testBot.ready()

    assert.deepEqual(await testBot.say("hello"), [])
})

test("a command that throws is reported", async () => {
    await using testBot = createTestBot({
        commands: {
            prefix: "!",
            commands: {
                broken: {
                    execute: () => {
                        throw new Error("Not implemented yet")
                    },
                },
            },
        },
    })
    await testBot.ready()
    testBot.emit("MESSAGE_CREATE", testBot.fixtures.message({ content: "!broken" }))

    await testBot.idle()
    assert.deepEqual(
        testBot.failures().map((record) => record.code),
        ["commands.failed"],
    )
})
```

Run every test file in the project:

```sh
node --test
```

Node.js finds test files such as `bot.test.js` and `bot.test.ts` and runs TypeScript directly

## What the test does

1. The `createTestBot` call creates a test client and registers the bot's events and commands on it, as `runBot` would. The unset token falls back to a test token, and `processSignals` is ignored. The `await using` declaration shuts the client down when the test ends, even after a failed assertion
2. The `ready()` call runs the bot's `setup`, if it has one, connects to the fake gateway and waits for READY
3. The `say` call delivers a message from a fake user, exactly as Fluxer would send it, waits until the bot has stopped working and returns the messages the bot sent meanwhile. The fake Fluxer API answers each message the bot sends with that message, so no response needs registering
4. The test checks the content of what the bot sent, and an empty list shows that the second test's message was ignored

For other events, the `emit` call delivers a Fluxer event built by `fixtures`, and `idle()` waits until the bot has stopped working, as the third test shows. To control how the fake Fluxer API answers a request, `rest.respond` registers a response and returns a route whose `next()` waits for the next request it answers. These waits have no deadline unless `timeoutMs` is passed, as in `bot.idle({ timeoutMs: 2_000 })`, so set a timeout in the test runner, such as `node --test --test-timeout=10000`, to fail a bot that never settles instead of hanging

<details>
<summary>Use fake timers in a test</summary>

A `timeoutMs` on `next()`, `idle()` or `say` uses real timers, so faking the global timers does not change it. The SDK runs its work on `setImmediate`, so fake timers must leave `setImmediate` real, as in Vitest's `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })`. When `setImmediate` is faked, no handler can run, and `idle()` rejects with `ConfigurationError` instead of settling

</details>

The third test passes its own options with a command that throws. Without an `onError` hook (see [handle failures in one place](/docs/{{version}}/logging/#handle-failures-in-one-place)), the failure is logged as `commands.failed`. The `failures()` method returns such unhandled failures and marks them as expected. When a handler or command throws or returns a failed Result without `onError` and the test never reads the failure from `failures()`, shutdown rejects with `UnhandledTestFailuresError`, so a broken handler fails the test even without an assertion

<details>
<summary>Requests without a registered response</summary>

A message send or edit that matches no `rest.respond` route receives the sent message back, as if Fluxer accepted it. Any other request without a route receives a 404 shaped like Fluxer's, and `logs()` gains a `testing.unmatchedRequest` Warn record. When a command returns a request that fails this way, the failure is logged as `commands.failed` and counts like a thrown error. The `failures()` method returns it, and shutdown rejects unless the test read it

</details>

## Test handlers registered with client.on

Code that registers handlers on a client with `client.on`, instead of through `runBot`, is tested with `createTestClient`. It creates the same test client without bot options. Unlike `runBot` handlers, `client.on` handlers receive the event itself and have no `reply`, so they send through client methods

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Client } from "@neontechspace/fluxerly"
import { createTestClient } from "@neontechspace/fluxerly/testing"

// The application passes its own client and welcome channel
export function installWelcome(client: Client, channelId: string) {
    return client.on("guildMemberAdd", (member) => client.messages.send(channelId, `Welcome, ${member.userId}!`))
}

test("new members are welcomed", async () => {
    await using bot = createTestClient()
    const sent = bot.rest.respond("POST /channels/:id/messages", { body: bot.fixtures.message() })
    installWelcome(bot.client, bot.fixtures.ids.channel)

    await bot.ready()
    bot.emit("GUILD_MEMBER_ADD", bot.fixtures.member())

    const request = await sent.next()
    assert.match(String((request.body as { content?: unknown }).content), /^Welcome/)
})
```

## Match gateway event filtering

The test gateway keeps the `gateway.ignoredEvents` list sent at Identify. An `emit` call throws `ConfigurationError` instead of delivering a dispatch Fluxer would suppress, and the rejected dispatch consumes no sequence number. This catches tests that would pass only because the fake gateway delivered an event the real bot cannot receive

With `gateway.ignoredEvents: "auto"`, register handlers, waits and collectors before `ready()` so Identify sees them. A bot's handlers, commands and setup registrations are already installed at that point. A late registration cannot undo the current session's filtering, and Resume keeps that list. A new Identify recomputes automatic filtering. For an explicit list, remove the source dispatch type from the options before creating the client, or use `gateway.ignoredEvents: []` to disable suppression

Suppressed `MESSAGE_CREATE` still arrives for a direct bot mention, `@here` or `@everyone`, but not merely for a role mention, an unmentioned direct message or the bot's own message. Reaction batches use their source event's filter: Ignoring `MESSAGE_REACTION_ADD` prevents `MESSAGE_REACTION_ADD_MANY`, while ignoring `MESSAGE_REACTION_ADD_MANY` alone does not. Under automatic filtering, a `messageReactionAddMany` handler retains that source dispatch

## Inspect what the bot sent

The test client records everything, without the token or Authorization header:

- HTTP requests: The `requests()` method lists each one with its method, path, query, parsed JSON body and uploaded files
- Gateway commands: The `commands()` method lists what the client sent to the gateway, such as presence updates
- Logs: The `logs()` method returns the records the client produced, which are kept out of the console
- Failures: The `failures()` method returns the Error records of handler and command failures no `onError` hook received, even when the logging level or deduplication keeps them out of `logs()`
- Counters: The `counters()` method returns the same running totals as `client.diagnostics().counters`

Each `rest.respond` call returns a route whose `requests()` lists only the requests it answered, `next()` waits for the next one and `remove()` stops it. The newest matching response wins. A matcher can be a `"METHOD /path/:param"` string, a RegExp, an object or a function

<details>
<summary>Fixtures, shards and reconnects</summary>

Each test client has its own `fixtures`, whose builders return snake_case wire payloads for users, the bot user, guilds, `GUILD_CREATE` bodies, channels, roles, members and messages. Their defaults refer to one community, one channel and one author, and `fixtures.ids` holds those IDs. The IDs are deterministic, so the same calls produce the same IDs in every run.
The shared `fixtures` export and `createFixtures()` build payloads outside a test client.
Pass `{ shardId }` to `emit` to choose the receiving [shard](/docs/{{version}}/glossary/#shard) in a sharded client. Call `disconnect({ code })` to close a shard's connection from the gateway side and watch the client resume, or fail for a code that ends the session. Every recoverable code resumes the same session, including 4007, so `sessionEpoch` stays the same. Pass `endSession: true` to make the test gateway forget the session first, so the client identifies a new one and the next event's `context.sessionEpoch` is higher.
The `createTestClient` function accepts every `createClient` option except `transport` and `instance`, which the test transport owns. The `createTestBot` function accepts the bot's `runBot` options and ignores `signal`, `processSignals`, `reportFailure` and `drainMs`

</details>

## Test Effect programs

The `@neontechspace/fluxerly/effect/testing` entry point provides the same `createTestBot` and `createTestClient` for the Effect API. Its test clients are scoped: Closing the Scope shuts the client down, and `ready`, `emit`, `next` and `idle` are Effects. The [Effect application testing guide](/docs/{{version}}/effect-application-testing/) covers testing Effect bots, including time-based behavior

The reference lists every control and option: [Testing](/docs/{{version}}/api/modules/testing/) for the default API and [Effect testing](/docs/{{version}}/api/modules/Effect-testing/) for the Effect API
