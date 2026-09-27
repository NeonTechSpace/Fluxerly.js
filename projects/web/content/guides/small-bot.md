---
title: Build a small bot
navTitle: Build a small bot
description: Combine commands, arguments, embeds, events, guards, cooldowns and shutdown in one file
---

This bot fits in one file and combines what most bots need: Commands with an argument, a help command, an embed, a welcome message for new members, a permission check, a cooldown, error reporting and a clean stop. It builds on the [quick start](/docs/{{version}}/quick-start/), so start there if the SDK is not installed yet

## The complete bot

Save this as `bot.js`, or `bot.ts` for TypeScript, in the quick start's folder:

```ts
{{example:small-bot/bot.ts}}
```

## Run it

Start the bot with the `.env` file from [Create a bot](/docs/{{version}}/create-a-bot/):

```command
{"kind":"run","command":"node --env-file=.env bot.js"}
```

For welcome messages, add the ID of the channel that should receive them to `.env`. A channel's ID is the last number in its link, which has the form `https://fluxer.app/channels/<community ID>/<channel ID>`:

```text
FLUXER_BOT_TOKEN=paste-the-token-here
WELCOME_CHANNEL_ID=paste-the-channel-id-here
```

Without `WELCOME_CHANNEL_ID`, the bot prints a note at startup and runs everything else. Then try it in a channel the bot can read and reply to:

- Send `!help` to list the commands
- Send `!ping` to get **Pong!**
- Send `!greet Ada Lovelace` to get **Hello, Ada Lovelace!**
- Send `!greet` alone to see what is missing and how to use the command
- Send `!announce Movie night on Friday` to post an announcement card. Only members who can manage messages may use it
- A new member joining the community gets a welcome message in the configured channel

Press Ctrl+C to stop the bot

## How it works

The whole bot is one call to `runBot`, as in the quick start. Its options object holds the token, the handlers, the commands and the settings, and the call connects and runs until the bot stops

### Commands

The `commands` option of `runBot` turns messages that start with the prefix `!` into commands. Each key of the inner `commands` object is a command name, and `description` feeds generated help. The `reply` function answers the message that ran the command, and it accepts a plain string

Each command returns the result of its reply. If the reply fails, the SDK reports that failure to `onError`, the [error hook](/docs/{{version}}/small-bot/#error-reporting) described below, like a thrown error. The [commands guide](/docs/{{version}}/commands/) covers aliases, groups, help pages and more argument types

### Generated help

The `help` command calls `help()` from its context, which lists every command with its `description` and usage. It returns pages of at most 2,000 characters, so each page fits in one message, and this bot needs only the first one

### A typed argument

The `greet` command declares one argument, `name`, as text. With `rest: true`, it takes everything after the command name, so a name can contain spaces. The router converts the argument before `execute` runs, and in TypeScript `values.name` is a string

A command used wrongly gets a short explanation, such as `Missing name. Usage: !greet <name...>`. The `runBot` function answers rejected commands this way by default, and `onReject: "silent"` turns the answers off

Mentions in a reply do not notify anyone unless the message allows it, so `!greet @everyone` notifies nobody

### A cooldown

The `cooldown` setting lets each user run `greet` once every 5 seconds. A second attempt within that time is rejected, and the bot says once how long to wait. Use `per: "channel"` or `per: "guild"` to share the limit across a channel or a whole community

The router keeps cooldowns in memory, so they reset when the bot restarts. The [commands guide](/docs/{{version}}/commands/) explains how to share [cooldowns](/docs/{{version}}/glossary/#cooldown) between processes

### A permission guard

A [guard](/docs/{{version}}/glossary/#guard) decides whether a command may run. The `announce` command uses `guards.requirePermissions(["ManageMessages"])`, which allows it only for members who have the `ManageMessages` permission in that channel. It checks the person who sent the command, not the bot, and it denies the command in direct messages

The guard looks up the community, member, roles and channel, reading them from Fluxer when they are not cached. A denied member gets a reply such as `Using this command requires these permissions: ManageMessages`, at most once every 5 seconds. The [communities and permissions guide](/docs/{{version}}/guilds-and-permissions/) explains how permissions are calculated

### An embed reply

An embed is a formatted card with a title, text, color and footer. The `builders.embed()` chain sets its parts, and the finished builder goes into the `embeds` list of a reply. Building sends nothing, and limits such as the title length are checked when the message is sent. The bot needs the `EmbedLinks` permission in the channel, which new communities grant to everyone. Without it, Fluxer rejects the whole reply, and the failure reaches `onError`. The [messages guide](/docs/{{version}}/messages/) shows more message options

### A welcome message

The `events` option registers a handler for each event name. The `guildMemberAdd` event arrives when someone joins a community the bot is in, and its handler receives the member as `event`, the `client` and a cancellation `signal`

The handler skips bots. It then reads the welcome channel with `client.channels.fetch`. Like every request, it returns a [Result](/docs/{{version}}/core-concepts/#results): Either a success, whose `value` holds the channel, or a failure, whose `error` says what went wrong, and `isErr()` tells them apart. The handler uses the channel to check that it belongs to the community the member joined, so a bot in several communities never announces one community's members in another. Passing `signal` lets the SDK cancel these requests when the bot stops

The mention in the welcome text notifies the new member because `allowedMentions` lists them. If the channel read fails, the handler returns the failed Result, which the SDK reports to `onError`

### Error reporting

The `onError` function receives every failure that has no caller to return it to: A failed command, event handler or reply. The report names the command or event, and `describeError` prints the full error with its code, hint and causes, with credentials masked. The bot keeps running after a failure. Without `onError`, the SDK logs each failure itself

The [logging guide](/docs/{{version}}/logging/) shows how to change what the SDK prints

### Clean shutdown

With `processSignals: true`, Ctrl+C or a stop request from a process manager stops the bot. The SDK cancels running handlers, closes the connection and finishes its cleanup, and then `runBot` returns

When the bot could not connect or stopped for another reason, `runBot` logs that failure once and sets the process exit code to 1, so a shell or process manager sees a failed run. Invalid settings, such as a missing token, throw an error at once, before the bot connects. The [reliability guide](/docs/{{version}}/reliability/) covers what happens between start and stop

## The Effect version

The same bot with the [Effect](/docs/{{version}}/glossary/#effect) API returns an Effect from each handler and command. A failed channel read fails the handler's Effect, which the SDK reports to `onError`. With `processSignals: true`, Ctrl+C completes the program successfully. A failure that stops the bot is logged and sets a failing exit code, as with the default API

```ts
{{example:small-bot/bot-effect.ts}}
```

All three versions are in the [small-bot example folder](https://github.com/NeonTechSpace/Fluxerly.js/tree/main/projects/sdk/examples/small-bot). The [Effect learning path](/docs/{{version}}/effect-first-bot/) introduces the Effect concepts used here
