---
title: React to events and collect replies
navTitle: Events & collectors
description: Detect guild joins, wait for an event and collect replies for a limited time
---

The gateway delivers live events from Fluxer. Register listeners before connecting to receive startup events. A successful `connect()` means authenticated READY, not that the guild roster or every resource has finished arriving

These helpers use the client from the [first bot example](/docs/{{version}}/quick-start/). Unlike REST reads and writes, collecting future messages requires a connected gateway

## Distinguish a join from guild availability

The `guildCreate` event also arrives when startup data becomes available or a guild recovers. Filter `isNewJoin` when a handler should react only to a new guild join

```ts
import type { Client } from "@neontechspace/fluxerly"

export function observeGuildJoins(client: Client, rememberGuild: (id: string) => void) {
    return client.on("guildCreate", (guild) => {
        if (!guild.isNewJoin) return
        rememberGuild(guild.id)
    })
}
```

Check the registration Result and keep the subscription. The `isNewJoin` flag requires a Fluxer gateway that distinguishes new joins from startup guild data. It does not guess from timing, readiness or an empty cache. A replayed event can trigger the handler again, so check whether a welcome or onboarding action already ran before repeating it. Guilds the bot already belonged to when it connected are not reported as new joins

## Wait for one future event

Use `waitFor` for one matching future event. The filter runs synchronously, so keep it small and do not make requests inside it

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function waitForTyping(client: Client, channelId: string, userId: string) {
    const result = await client.waitFor("typingStart", {
        filter: event => event.channelId === channelId && event.userId === userId,
        timeoutMs: 10_000,
    })
    if (result.isErr()) {
        console.error("Typing wait ended", result.error._tag)
        return
    }
    return result.value
}
```

`waitFor` reports a timeout as an expected failure. Only a future event can satisfy it, not a cached one. Use a collector to start listening before sending a prompt

## Ask a question without missing a fast reply

Register the collector first, then send the question. This collects one human user's next message in the selected channel, with a 30-second deadline

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function askPreferredName(client: Client, channelId: string, userId: string) {
    const opened = client.messages.collect(channelId, {
        filter: message => message.author.id === userId && !message.author.isBot,
        maxMessages: 1,
        timeoutMs: 30_000,
    })
    if (opened.isErr()) throw opened.error
    const collector = opened.value

    try {
        const prompt = await client.messages.send(channelId, { content: "What name should the bot use?" })
        if (prompt.isErr()) throw prompt.error

        const answer = await collector.waitForClose()
        if (answer.isErr()) throw answer.error
        return answer.value.messages[0]?.content
    } finally {
        collector.stop()
        await collector.waitForClose()
    }
}
```

Unlike `waitFor`, a collector that times out completes successfully, possibly with no replies. This helper returns `undefined` when no one replies. A gateway gap fails collection

The `finally` block stops intake if sending fails and waits for cleanup. Do not call client shutdown or await the same collector's completion from inside its progress callback

## Accept a confirmation reaction

Use an existing bot message as the target. Start this helper before inviting the selected user to react, and keep the client connected

```ts
import type { Client, MessageReference } from "@neontechspace/fluxerly"

export async function waitForConfirmation(client: Client, message: MessageReference, userId: string) {
    const opened = client.messages.collectReactions(message, {
        emoji: "✅",
        filter: reaction => reaction.userId === userId,
        maxReactions: 1,
        timeoutMs: 20_000,
    })
    if (opened.isErr()) throw opened.error

    try {
        const result = await opened.value.waitForClose()
        if (result.isErr()) throw result.error
        return result.value.reactions.length > 0
    } finally {
        opened.value.stop()
        await opened.value.waitForClose()
    }
}
```

This observes a future addition, not the current reaction state. Reaction removals do not undo collected additions, and repeated additions are not a unique-voter count. Use application-owned vote state when building a poll

For a guild channel, supply its known `guildId` in collector options to scope recovery to that guild's shard. Do not guess that a channel is private merely because an event omitted guild context. See [event and collector contracts](/docs/{{version}}/api/interfaces/js-ts.Client/) for buffer limits and subscription ownership
