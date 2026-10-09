---
title: Add prefix commands to a bot
navTitle: Commands
description: Register prefix commands, convert arguments, add guards and cooldowns, and generate help from the same definitions
---

A [prefix command](/docs/{{version}}/glossary/#prefix-command) is a message such as `!ping` or `!greet Maya`. Fluxerly's [command router](/docs/{{version}}/glossary/#command-router) reads the name after the configured prefix and calls the matching handler. It uses the bot's existing client and does not open another connection. The SDK has no slash commands, buttons or other interaction components, so every command is a message the bot reads

These examples extend [the starter bot](/docs/{{version}}/quick-start/). Pass commands in the `commands` option of `runBot`, and remove the starter's `!ping` message handler so the bot does not reply twice

## Register commands

Each key of `commands` becomes a command name. The `reply` helper accepts a string or full message content and replies to the incoming message

```ts
import { runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    commands: {
        prefix: "!",
        commands: {
            ping: {
                description: "Check that the bot can reply",
                execute: ({ reply }) => reply("Pong!"),
            },
            about: {
                description: "Describe this bot",
                execute: ({ reply }) => reply("Built with Fluxerly"),
            },
        },
    },
})
```

Sending `!ping` now answers `Pong!`, and `!about` describes the bot. Returning the reply's [Result](/docs/{{version}}/glossary/#result) from `execute` is enough: If the reply fails, the router reports the failure with the command name without stopping other commands

<details>
<summary>When do command definitions fail?</summary>

An invalid definition, such as a duplicate name or an unknown argument type, throws `ConfigurationError` when `runBot` is called, before the bot connects.
A command failure happens later, when a matching message arrives. A handler that throws, rejects or returns an Err result has failed, and the router reports it to the `onError` hook, when one is set, or logs it in full at Error

Commands keep the order of the object's own string keys. Omit `arguments` to receive the raw `args` without conversion, and use `arguments: {}` when a command accepts no arguments. The `reply` helper also forwards the handler's cancellation `signal`, so stopping the bot cancels a pending reply

</details>

## Convert arguments before execution

The router converts the words after the command name into typed values before running it. This bot accepts `!greet "Ada Lovelace"` and `!remind 10m Stretch`. The quoted parser treats a quoted name as one argument

```ts
import { commands, runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    commands: {
        prefix: "!",
        parse: commands.parseQuoted,
        commands: {
            greet: {
                description: "Greet a name",
                arguments: { name: { type: "text" } },
                execute: ({ values, reply }) => reply(`Hello, ${values.name}!`),
            },
            remind: {
                description: "Repeat a note after a delay",
                arguments: {
                    delay: { type: "duration", min: 1_000, max: 3_600_000 },
                    note: { type: "text", rest: true },
                },
                execute: async ({ values, reply, signal }) => {
                    await new Promise((resolve) => setTimeout(resolve, values.delay))
                    if (!signal.aborted) return reply(values.note)
                },
            },
        },
    },
})
```

In TypeScript, `values.name` is a string and `values.delay` is a number of milliseconds. A missing, invalid or extra argument stops the command before `execute`, and `runBot` answers with the reason and the command's usage, such as `Missing name. Usage: !greet <name>`. That reply is the `onReject: "reply"` default of `runBot`. Set `onReject: "silent"` to send nothing, or pass a function for custom feedback. A router from `commands.create` gives no feedback unless `onReject` is set

A `duration` argument reads text such as `90s`, `5m` or `1h30m` and produces milliseconds. Add `wholeSeconds: true` to reject a millisecond part such as `1m500ms`, for a value that must be whole seconds, like the `durationMs` of a [ban](/docs/{{version}}/guilds-and-permissions/#moderate-members). Its `default`, when given, must then be whole seconds too

Other argument types include:

- Whole and decimal numbers, with `integer` and `number` and optional `min`, `max` and `default`
- One of a fixed list of strings, with `choice`
- A decimal [ID](/docs/{{version}}/glossary/#id), with `id`. Add `mention: "user"`, `"channel"` or `"role"` to also accept that kind of mention, as in `{ type: "id", mention: "user" }`. The value is the ID either way
- A member of the message's [community](/docs/{{version}}/glossary/#guild), with `member`, which turns a user ID or mention into a `{ guildId, userId }` reference
- One entry from a fixed list of candidates given at registration, with `userChoice`, `channelChoice` or `roleChoice`. For any user, channel or role, use `id` or `member` instead
- Any other format, with `custom` and a parse function of the application

Accepting an ID does not mean the user may act on that resource

<details>
<summary>How are ID and member arguments checked?</summary>

An `id` or `member` argument accepts a nonzero decimal ID without leading zeroes, up to `9223372036854775807`, and the same limit applies to IDs inside mentions. Any other value is rejected as invalid before the command runs. Use a `custom` argument for other formats.
A `member` argument produces a `{ guildId, userId }` reference in the message's community without checking that the user is still a member

</details>

## Guard, limit and wrap commands

A [guard](/docs/{{version}}/glossary/#guard) decides whether a matched command may run. A [cooldown](/docs/{{version}}/glossary/#cooldown) limits how often each user, channel or community can run it. [Middleware](/docs/{{version}}/glossary/#middleware) wraps every command, for example to measure how long it takes

```ts
import { guards, runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    commands: {
        prefix: "!",
        mentionPrefix: true,
        use: [
            async (context, next) => {
                const started = Date.now()
                await next()
                console.info(`${context.name} took ${Date.now() - started} ms`)
            },
        ],
        commands: {
            purge: {
                description: "Delete recent messages",
                guard: [guards.guildOnly(), guards.requirePermissions(["ManageMessages"])],
                cooldown: { durationMs: 30_000, per: "channel" },
                arguments: { count: { type: "integer", min: 1, max: 100, default: 10 } },
                execute: ({ values, reply }) => reply(`Would delete ${values.count} messages`),
            },
        },
    },
})
```

Here `!purge` runs only in a community, for a member with the Manage Messages permission, and at most once every 30 seconds in each channel. With `mentionPrefix`, a mention of the bot also works as a prefix. An unknown command name is ignored unless `onUnmatched` handles it, and its `suggestion` names the closest registered command when one is similar.
Each unmatched message is logged at Debug with the code `commands.unmatched` and the fields `reason`, `messageId`, `channelId` and, when there is one, `suggestion`

Only messages a person typed can run commands. Messages from bots are skipped by default, and the notices Fluxer posts with text of its own never run commands. For example, a thread named `!ping` makes Fluxer post a notice containing that name, and it does not run `!ping`

A guard returns `true` to allow the command, `false` to deny it without an automatic reply or `{ deny: "reason" }` to deny it with a reason that `onReject: "reply"` sends. A false verdict stays silent even with the `runBot` reply default, but still counts as a rejection, logs `commands.rejected` at Debug and reaches a custom `onReject` callback. Each built-in guard denies with a specific reason and covers one common check, allowing only:

- Messages sent in a community, with `guards.guildOnly()`
- Direct and group conversations, with `guards.dmOnly()`
- The owner of the bot's application, with `guards.ownerOnly()`
- Listed user IDs, with `guards.ownerOnly(ids)`
- Members who have every named permission in the channel, with `guards.requirePermissions(names)`

<details>
<summary>How the built-in guards read data</summary>

The `requirePermissions` guard reads the community, member, roles and channel from enabled caches first and fetches only what is missing, at most once each per command. In a thread, it also reads the parent channel the same way and decides from the parent's permissions as Fluxer does, with `SendMessages` granted exactly when `SendMessagesInThreads` is. A failed read fails the command, which is reported with the command name. In a channel of a type this SDK version does not know, the guard denies the command when it cannot confirm the channel's permissions. Its decision does not guarantee that Fluxer allows a later action.
The `dmOnly` guard denies a message that has a `guildId` without a request. Otherwise it confirms a private conversation from the direct-message cache or the channel cache, or reads the channel once. A cached or fetched community channel denies the command. A read that fails for any other reason, such as a network failure or timeout, leaves the channel unconfirmed and fails the command, which is reported with the command name. Enable `cache.directMessages` to avoid a read for each command in the same conversation.
The `ownerOnly()` guard reads the application's owner from Fluxer on the first command and keeps it for the client's lifetime. A failed read fails the command, and the next command reads again

</details>

<details>
<summary>How cooldowns are stored</summary>

A cooldown takes `durationMs` and `per`, which is `"user"` by default, `"channel"` or `"guild"`. Without a `store`, the router keeps cooldowns in memory in this process. That store holds 10,000 keys by default. Set the router's `cooldowns: { maxEntries }` option to change the limit, for example `cooldowns: { maxEntries: 50_000 }`.
A full store never turns a user away: It removes expired keys first, then the key that would expire soonest, which lets that key run again early. Pass a `store` to share cooldowns between processes

</details>

<details>
<summary>How often a rejected command is answered</summary>

So that repeated attempts do not make the bot repeat itself, the `"reply"` feedback answers an active cooldown once until it expires, and a guard denial with a reason once per user and command every 5 seconds. A guard returning `false` sends nothing. Argument errors are answered every time.
A skipped answer still counts as a rejection and is logged at Debug. An `onReject` function receives every rejection instead, so it can apply its own limit

</details>

## Use the Effect entry point

The [Effect](/docs/{{version}}/glossary/#effect) API accepts the same options. Each reply stops when the command handler is interrupted and keeps `SendError` in the Effect error channel. Services required by any command remain requirements of the returned program

```ts
import { Effect } from "effect"
import { runBot } from "@neontechspace/fluxerly/effect"

export const program = runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    commands: {
        prefix: "!",
        commands: {
            ping: { execute: ({ reply }) => reply("Pong!").pipe(Effect.asVoid) },
            about: { execute: ({ reply }) => reply("Built with Fluxerly").pipe(Effect.asVoid) },
        },
    },
})
```

## Attach commands to an existing client

To add commands to a client the application already manages, create a router, register commands and attach it to the client. Creation and registration throw `ConfigurationError` for invalid definitions. Close the returned subscription to detach the router, or wait for its cleanup with `waitForClose()`

```ts
import { commands, type Client } from "@neontechspace/fluxerly"

export function attachCommands(client: Client) {
    return commands
        .create({ prefix: "!" })
        .registerMany({
            ping: { execute: ({ reply }) => reply("Pong!") },
            about: { execute: ({ reply }) => reply("Built with Fluxerly") },
        })
        .attach(client)
}
```

## Add help from the registered commands

Each command receives a `help` function that builds help pages from the registered descriptions and arguments, and a `sendHelp` function that sends them

```ts
import { runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    commands: {
        prefix: "!",
        commands: {
            help: {
                description: "List the commands",
                execute: ({ sendHelp }) => sendHelp(),
            },
            ping: {
                description: "Check that the bot can reply",
                execute: ({ reply }) => reply("Pong!"),
            },
        },
    },
})
```

Sending `!help` lists each command with its description. Each page holds up to 2,000 characters, which fits one message. The `sendHelp` function sends a single page as a plain message, and several pages as reaction pages that the command's author flips with ◀ and ▶. The `help` function only builds the pages, for a bot that sends them its own way. A router created with `commands.create` has the same `help` method

The `paginate` function shows any list of pages the same way, as in `({ paginate }) => paginate(["Rules 1 to 5", "Rules 6 to 10"])`. Adding or removing an arrow turns the page, so the bot needs only Add Reactions and Read Message History. The pages stop listening after 60 seconds without a click or 5 minutes in total, and the bot then removes its arrows. Pass `users` to let other people flip them. [Reaction pages](/docs/{{version}}/events-and-collectors/#show-pages-with-reactions) explains the options

To keep a command out of help and out of unknown-command suggestions, for example an owner-only tool, register it with `hidden: true`. Hidden commands still run when someone types their name, so hiding does not restrict access. Protect each command that needs it with a guard

For a larger bot, split command definitions by feature and attach one combined router. [Groups](/docs/{{version}}/api/interfaces/js-ts.DefaultPrefixCommandRouter/) such as `admin` in `!admin inspect` add structure when needed. The `group` option of `help`, such as `help({ group: ["admin"] })`, describes one group. A group registered with `hidden: true` hides everything inside it, and selecting a hidden group throws `ConfigurationError` as for a missing one

## Wire it up

A complete bot places the router beside the other `runBot` options. This one adds a help command, a per-user cooldown, a larger cooldown store, its own failure hook and a hidden owner-only command

```ts
import { guards, runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    commands: {
        prefix: "!",
        cooldowns: { maxEntries: 50_000 },
        onError: (report) => console.error(report.describe()),
        commands: {
            help: {
                description: "List the commands",
                execute: ({ sendHelp }) => sendHelp(),
            },
            ping: {
                description: "Check that the bot can reply",
                cooldown: { durationMs: 5_000, per: "user" },
                execute: ({ reply }) => reply("Pong!"),
            },
            uptime: {
                hidden: true,
                guard: guards.ownerOnly(),
                execute: ({ reply }) => reply(`Running for ${Math.round(process.uptime())} s`),
            },
        },
    },
})
```

The `ownerOnly()` guard allows only the owner of the bot's application, as Fluxer reports it, so the owner's ID needs no configuration. The commands `onError` hook receives command failures instead of the client-level `onError`, and without either hook the SDK logs each failure in full. If the bot itself stops with a failure, such as a rejected token, `runBot` logs it once and sets `process.exitCode` to 1
