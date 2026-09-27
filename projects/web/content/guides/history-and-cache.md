---
title: Read history and use the message cache
navTitle: History & cache
description: Read recent messages with fetchHistory and iterateHistory, search the index and use locally cached copies
---

After the [first reply bot](/docs/{{version}}/quick-start/) works, read earlier messages from a channel, search them or keep recent ones in a local [cache](/docs/{{version}}/glossary/#cache). Reading history is a request to Fluxer and does not need the [gateway](/docs/{{version}}/glossary/#gateway) connection

## Scan for one message

Find the first recent message that matches a rule. Add this helper to a module that already has a bot [`Client`](/docs/{{version}}/api/interfaces/js-ts.Client/)

```ts
import type { Client, Message } from "@neontechspace/fluxerly"

export async function findRecentMessage(
    client: Client,
    channelId: string,
    matches: (message: Message) => boolean,
) {
    for await (const item of client.messages.iterateHistory(channelId, { maxItems: 200 })) {
        if (item.isErr()) return item
        if (matches(item.value)) return item
    }
    return undefined
}
```

The helper returns a [Result](/docs/{{version}}/glossary/#result) with the matching message or the failure that stopped the read. It returns `undefined` if none of the 200 newest messages match

The [`iterateHistory`](/docs/{{version}}/api/interfaces/js-ts.Messages/#iteratehistory) method reads newest first and requests the next page only when the loop needs it, so stopping early saves requests. The required `maxItems` bounds the scan, so older messages can remain unread. To read a single page of up to 100 messages instead, use [`fetchHistory`](/docs/{{version}}/api/interfaces/js-ts.Messages/#fetchhistory), as the [last section](/docs/{{version}}/history-and-cache/#wire-it-up) shows

## Search the message index

When the text to look for is known, ask Fluxer's search index for one page of results. The index can lag behind the newest messages

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function searchChannel(client: Client, channelId: string, text: string) {
    const result = await client.messages.search({ channelId }, { content: text, limit: 10 })
    if (result.isErr()) return result
    if (result.value.indexing) return undefined
    return result.value.messages
}
```

The helper returns the matching messages, a failed Result, or `undefined` while Fluxer is still preparing its search index. It does not wait for the index or add results to the cache. To read the next page, increase `page` and keep `limit` unchanged

To search several pages, use [`iterateSearch`](/docs/{{version}}/api/interfaces/js-ts.Messages/#iteratesearch) with `maxItems` as the limit. Results can shift while the index changes during the scan

## Limit the message cache

The message cache keeps recent messages in memory so they can be read without a request. It is off until configured. Create a client with a token supplied by the application

```ts
import { createClient } from "@neontechspace/fluxerly"

export function createCachedClient(token: string) {
    return createClient({
        token,
        cache: {
            messages: {
                maxEntries: 500,
                maxBytes: 2_000_000,
                maxAgeMs: 60_000,
            },
        },
    })
}
```

This client keeps up to 500 messages from sends, reads, history pages and gateway events, within about two megabytes and for at most one minute each. Without these settings, an enabled message cache keeps up to 1,000 messages in 8 MiB with no age limit. The same `cache` option works in `runBot`

<details>
<summary>Why can a message be missing from the cache?</summary>

The cache stores data only in memory. A message may be missing because it was removed to make room, expired or conflicted with another observation of the same message. A lost gateway connection also clears the messages cached before it, even when the connection recovers, because changes during the gap may have been missed.
The entry and byte limits do not count runtime overhead or copies held elsewhere in the application. To react to cache changes, register a listener with `client.cache.onChange`, which reports each stored, deleted or cleared entry

See [`ClientOptions.cache`](/docs/{{version}}/api/interfaces/js-ts.ClientOptions/#cache) and [`MessageCacheSettings`](/docs/{{version}}/api/interfaces/js-ts.MessageCacheSettings/) for the complete cache contract

</details>

## Use the cache, then fetch if needed

Use a cached message when a recent copy is good enough, and fetch it from Fluxer otherwise. Pass a message reference with its `channelId` and `id`

```ts
import { orThrow, type Client, type MessageReference } from "@neontechspace/fluxerly"

export async function readCachedOrFetch(client: Client, message: MessageReference) {
    const cached = client.messages.get(message)
    if (cached !== undefined) return cached

    return orThrow(await client.messages.fetch(message, { timeoutMs: 5_000 }))
}
```

A cached copy returns immediately without a request. Otherwise the helper [fetches](/docs/{{version}}/api/interfaces/js-ts.Messages/#fetch) the message with a five-second deadline, and `orThrow` throws if that fails

The [`get`](/docs/{{version}}/api/interfaces/js-ts.Messages/#get) method returns `undefined` when the client has no usable copy. A cached copy is a [frozen snapshot](/docs/{{version}}/glossary/#frozen-snapshot) of the message as it was when observed, so use `fetch` when the task needs its current state

## Wire it up

In a `runBot` bot, cache settings sit beside the token, and commands read history through the `client` in their context. This bot answers `!recent` with the people who spoke in the channel's 20 newest messages

```ts
import { runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    cache: { messages: { maxEntries: 500, maxAgeMs: 600_000 } },
    commands: {
        prefix: "!",
        commands: {
            recent: {
                description: "List recent speakers",
                execute: async ({ client, message, reply, signal }) => {
                    const page = await client.messages.fetchHistory(message.channelId, { limit: 20 }, { signal })
                    if (page.isErr()) return page
                    const people = page.value.filter((item) => !item.author.isBot)
                    const names = new Set(people.map((item) => item.author.username))
                    return reply(`Recent speakers: ${[...names].join(", ") || "none"}`)
                },
            },
        },
    },
})
```

Passing the command's `signal` stops the read when the bot shuts down. A failed read is returned from `execute`, so the router reports it with the command name. With the cache enabled, the page read can also store those messages for later `client.messages.get` lookups
