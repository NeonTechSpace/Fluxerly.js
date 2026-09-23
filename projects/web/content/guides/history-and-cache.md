---
title: Read history and use the message cache
navTitle: History & cache
description: Search a limited number of messages and use locally cached copies
---

After the [first reply bot](/docs/{{version}}/quick-start/) works, scan a limited number of messages, search the index or read cached copies. This guide uses the default API, with switchable JavaScript and TypeScript examples

## Scan for one message

Find the first recent message that satisfies a rule. Add this helper to a module that already has a bot [`Client`](/docs/{{version}}/api/interfaces/js-ts.Client/)

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

The helper returns a Result with the matching message or an error from reading history. It returns `undefined` if none of the first 200 messages match

The [`iterateHistory`](/docs/{{version}}/api/interfaces/js-ts.Messages/#iteratehistory) method reads newest first and requests later pages only as needed. Breaking after a match releases the buffered page. Older or inaccessible messages can remain outside this bounded result

## Search the message index

When the search text is known, ask Fluxer's search index for one page. Indexed search can lag behind recent messages and may report that the index is still being prepared

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function searchChannel(client: Client, channelId: string, text: string) {
    const result = await client.messages.search({ channelId }, { content: text, limit: 10 })
    if (result.isErr()) return result
    if (result.value.indexing) return undefined
    return result.value.messages
}
```

This returns matching messages, an expected failure, or `undefined` while Fluxer prepares its search index. It does not keep checking the index or add results to the cache. To read another page, increase `page` and keep `limit` unchanged

Use [`iterateSearch`](/docs/{{version}}/api/interfaces/js-ts.Messages/#iteratesearch) with `maxItems` to limit a multi-page search. Index changes can shift results during the scan

## Limit the message cache

Keep recent messages in memory for local lookups. Create a client with a token supplied by the application

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

Eligible message reads, writes, history pages, and gateway events can retain up to 500 snapshots, subject to a two-megabyte accounted JSON budget and a one-minute age limit

The cache is disabled until configured, and stores data only in memory. Its entry and byte limits do not count runtime overhead or copies held elsewhere in the application. A message may be missing because it was removed to make room, expired, conflicted with another read or arrived during a gateway gap

See [`ClientOptions.cache.messages`](/docs/{{version}}/api/interfaces/js-ts.ClientOptions/#cache) and [`MessageCacheSettings`](/docs/{{version}}/api/interfaces/js-ts.MessageCacheSettings/) for the complete cache contract

## Use the cache, then fetch if needed

Use a cached message when it is recent enough for the task, and fetch it when a remote read is needed. Pass a message reference with its `channelId` and `id`

```ts
import type { Client, MessageReference } from "@neontechspace/fluxerly"

export async function readCachedOrFetch(client: Client, message: MessageReference) {
    const cached = client.messages.get(message)
    if (cached.isErr()) return cached
    if (cached.value !== undefined) return cached

    return await client.messages.fetch(message, { timeoutMs: 5_000 })
}
```

A cache hit returns immediately without a request. A miss starts a remote [`fetch`](/docs/{{version}}/api/interfaces/js-ts.Messages/#fetch) with a five-second deadline

The [`get`](/docs/{{version}}/api/interfaces/js-ts.Messages/#get) method returns `undefined` when this client has no usable local snapshot. A hit is a past frozen observation, so choose `fetch` when the task needs a current remote read
