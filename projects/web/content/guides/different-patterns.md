---
title: Patterns that work differently
navTitle: Patterns that work differently
description: Common bot habits that Fluxerly handles in its own way, each with the call to use instead
---

Some habits from other bot code do not apply to Fluxerly. Each section names one and shows what to write instead

## Start the bot with runBot

There is no `new Client()` and `client.login(token)`. Pass the token and everything else to `runBot({ token, ... })`:

```ts
import { runBot } from "@neontechspace/fluxerly"

await runBot({ token: process.env.FLUXER_BOT_TOKEN, events: { messageCreate: () => {} } })
```

When the application controls the connection itself, call `createClient({ token })` and then `client.run()`:

```ts
import { createClient, orThrow } from "@neontechspace/fluxerly"

await using client = createClient({ token: process.env.FLUXER_BOT_TOKEN })
orThrow(await client.run())
```

## Receive events without intents

Fluxer has no intents, so nothing needs to be enabled to receive events, except presence updates for chosen members, which need [`client.presence.setMembers`](/docs/api/js-ts/client-and-lifecycle/#presence-setmembers). Register a handler, and Fluxer's own permissions and visibility decide what arrives. The [configuration guide](/docs/configuration/#events-and-the-gateway) explains how to skip events the bot does not use

## Use prefix commands

There are no slash commands or interactions. Commands are prefix commands such as `!ping`, set up through the `commands` option of `runBot`:

```ts
import { runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    commands: { prefix: "!", commands: { ping: { description: "Check the bot", execute: ({ reply }) => reply("Pong!") } } },
})
```

## Act through the client, not the message

Messages are plain data without methods, so `message.reply()`, `message.delete()` and `channel.send()` do not exist. Use the `reply` passed to a handler, or `client.messages.send(channelId, content)` and the other client methods:

```ts
import type { Client, Message } from "@neontechspace/fluxerly"

export async function answerAndClean(client: Client, message: Message) {
    const sent = await client.messages.send(message.channelId, "Noted")
    if (sent.isErr()) return sent
    return client.messages.delete(message)
}
```

## Read the handler's context object

A `runBot` event handler receives a context object such as `({ message, reply })`, not the message itself:

```ts
import { runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    events: { messageCreate: ({ message, reply }) => (message.content === "hi" ? reply("Hello") : undefined) },
})
```

## Check isBot for bot authors

A bot author is detected with `message.author.isBot`. There is no `message.author.bot`, and `runBot` already skips messages from bots unless `ignoreBots` is false

## Communities are guilds

Fluxer calls servers communities, and the SDK names them guilds, as in `guildId` and `client.guilds`
