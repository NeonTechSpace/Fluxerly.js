---
title: React to events and collect replies
navTitle: Events & collectors
description: Handle gateway events, detect community joins, wait for one event and collect replies or reactions for a limited time
---

Fluxer sends live [events](/docs/{{version}}/glossary/#event), such as new messages, community joins and reactions, over the [gateway](/docs/{{version}}/glossary/#gateway) connection. A [handler](/docs/{{version}}/glossary/#handler) registered for an event name runs each time that event arrives. In a `runBot` bot, handlers go in the `events` option, as the [last section](/docs/{{version}}/events-and-collectors/#wire-it-up) shows

The helpers below take the `client` from the [first bot example](/docs/{{version}}/quick-start/). Register handlers before connecting so they also receive startup events. Unlike sending or fetching messages, waiting for future events needs a connected gateway

## Distinguish a join from community availability

The `guildCreate` event arrives when the bot joins a community, and also when a community's data becomes available at startup or after an outage. Check `isNewJoin` when a handler should react only to a new join

```ts
import type { Client } from "@neontechspace/fluxerly"

export function observeGuildJoins(client: Client, rememberGuild: (id: string) => void) {
    return client.on("guildCreate", (guild) => {
        if (!guild.isNewJoin) return
        rememberGuild(guild.id)
    })
}
```

The `client.on` method returns a subscription. Call its `close()` method when the handler is no longer needed

<details>
<summary>How reliable is isNewJoin?</summary>

The `isNewJoin` flag requires a Fluxer gateway that distinguishes new joins from startup community data. It does not guess from timing, readiness or an empty cache, and communities the bot already belonged to when it connected are not reported as new joins.
A replayed event can run the handler again, so check whether a welcome or onboarding action already ran before repeating it

A successful `connect()` means Fluxer accepted the session, not that every community or resource has finished arriving

</details>

<details>
<summary>What else does a handler receive?</summary>

A `client.on` handler receives the event, an `AbortSignal` that is aborted when the subscription closes or the client shuts down, and an event context. The context's `shardId` names the shard that received the event, and `receivedBytes` is the size of the gateway message that carried it.
Pass the signal to SDK operations inside the handler so they stop with it. To run code around every handler, such as timing or tracing, register event [middleware](/docs/{{version}}/glossary/#middleware) with `client.use`

A handler runs one event at a time by default, and later events wait in a queue of up to 256 events. When the queue is full, the oldest waiting event is dropped and a Warn record is logged, while the handler keeps running. Pass `{ overflow: "stop" }` as the third argument of `client.on` to close the subscription instead

To handle several events at a time and still keep related events in order, pass a `partition` option. The value `"channel"` keys each event by its channel, `"guild"` by its community, and a function returns a key of its own. Events with different keys run side by side, up to eight at a time unless `concurrency` says otherwise, while events with the same key run one after another in the order they arrived

</details>

## Wait for one future event

Use `waitFor` to get the next matching event. The filter runs synchronously, so keep it small and do not make requests inside it

```ts
import { describeError, type Client } from "@neontechspace/fluxerly"

export async function waitForTyping(client: Client, channelId: string, userId: string) {
    const result = await client.waitFor("typingStart", {
        filter: (event) => event.channelId === channelId && event.userId === userId,
        timeoutMs: 10_000,
    })
    if (result.isErr()) {
        console.error(describeError(result.error))
        return
    }
    return result.value
}
```

If no matching event arrives within 10 seconds, `waitFor` returns a failed Result. Only a future event counts, not one that already happened. To send a prompt and then wait for the answer, use a collector as shown next, because it starts listening before the prompt is sent

## Ask a question without missing a fast reply

A [collector](/docs/{{version}}/glossary/#collector) gathers matching messages or reactions for a limited time. Create the collector first, then send the question. This helper collects one person's next message in the channel, waiting at most 30 seconds

```ts
import { orThrow, type Client } from "@neontechspace/fluxerly"

export async function askPreferredName(client: Client, channelId: string, userId: string) {
    await using collector = client.messages.collect(channelId, {
        filter: (message) => message.author.id === userId && !message.author.isBot,
        maxMessages: 1,
        timeoutMs: 30_000,
    })
    orThrow(await client.messages.send(channelId, "What name should the bot use?"))

    const answer = orThrow(await collector.result())
    return answer.messages[0]?.content
}
```

The helper returns the reply's text, or `undefined` when no one answers in time, because a collector that times out still succeeds, possibly with no messages. The `orThrow` helper returns a successful value or throws the failure

The `await using` declaration closes the collector when the helper returns or throws, including when sending fails, and waits for its cleanup

<details>
<summary>When does a collector fail?</summary>

A [gateway gap](/docs/{{version}}/glossary/#gateway-gap), such as a lost connection, fails collection because messages may have been missed, and so does a client that shuts down while the collector runs. A per-message or per-reaction callback that throws fails collection with a `CollectorError` whose reason is `handler`.
Do not shut the client down or await the same collector's `result()` from inside its own callbacks

</details>

## Accept a confirmation reaction

Use an existing bot message as the target. Start this helper before inviting the person to react, and keep the client connected

```ts
import { orThrow, type Client, type MessageReference } from "@neontechspace/fluxerly"

export async function waitForConfirmation(client: Client, message: MessageReference, userId: string) {
    await using collector = client.messages.collectReactions(message, {
        emoji: "✅",
        filter: (reaction) => reaction.userId === userId,
        maxReactions: 1,
        timeoutMs: 20_000,
    })
    const result = orThrow(await collector.result())
    return result.reactions.length > 0
}
```

The helper returns `true` when the person adds ✅ within 20 seconds. It watches for new reactions, not reactions already on the message. Removing a reaction does not undo a collected one, and repeated additions are not a count of unique voters, so keep a poll's votes in application state

For a community channel, pass its known `guildId` in the collector options so recovery is limited to that community's [shard](/docs/{{version}}/glossary/#shard). Do not assume a channel is private merely because an event omitted community context. See the [collector reference](/docs/{{version}}/api/interfaces/js-ts.Messages/#collectreactions) for buffer limits and subscription ownership

## Show pages with reactions

Fluxer has no buttons, so a long list can be shown as pages that people flip with ◀ and ▶ reactions. The `messages.paginate` method sends the first page, adds both arrows as the bot and shows the previous or next page on each click, wrapping around at the ends. Pass `users` to choose who may flip, such as `[userId]`, or `() => true` for anyone

```ts
import type { Client } from "@neontechspace/fluxerly"

export function showRules(client: Client, channelId: string, userId: string) {
    return client.messages.paginate(channelId, ["Rules 1 to 5", "Rules 6 to 10"], { users: [userId] })
}
```

The returned Result settles when listening ends, after `idleMs` without a click, 60 seconds by default, or `timeoutMs` after the first page, 5 minutes by default. The bot then removes its own arrows, and the current page stays shown. A page is text or an object with `content` and `embeds`. Adding or removing an arrow both turn the page, so the bot needs only Add Reactions and Read Message History. With `removeClicks: true`, only additions count and the bot removes each click, which needs Manage Messages. Like a collector, pages need a connected gateway

In a command, the context's `paginate(pages)` lets the command's author flip by default, and `sendHelp()` sends the help pages this way. See [help in Commands](/docs/{{version}}/commands/#add-help-from-the-registered-commands)

## Wire it up

In a `runBot` bot, event handlers go in `events` and receive the event and the client. A collector can run inside a command, which provides the client and the incoming message. This bot logs new community joins and answers `!ask`

```ts
import { orThrow, runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    onError: (report) => console.error(report.describe()),
    events: {
        guildCreate: ({ event }) => {
            if (event.isNewJoin) console.info(`Joined guild ${event.id}`)
        },
    },
    commands: {
        prefix: "!",
        commands: {
            ask: {
                description: "Ask for a preferred name",
                execute: async ({ client, message, reply }) => {
                    await using collector = client.messages.collect(message.channelId, {
                        filter: (answer) => answer.author.id === message.author.id,
                        maxMessages: 1,
                        timeoutMs: 30_000,
                    })
                    orThrow(await reply("What name should the bot use?"))
                    const answer = orThrow(await collector.result()).messages[0]
                    return reply(answer ? `Hello, ${answer.content}!` : "No answer in time")
                },
            },
        },
    },
})
```

A failing handler or command does not stop the bot. The `onError` hook receives its report with the original error, and without the hook the SDK logs it in full at Error. By default, `messageCreate` handlers and commands run up to eight at a time and other events one at a time. The [`events` option reference](/docs/{{version}}/api/interfaces/js-ts.BotOptions/#events) explains how to change that per event
