---
title: Read history and use the message cache
navTitle: History & cache
description: Scan bounded history and treat cached messages as local observations
---

After your first reply bot works, use bounded history scans, indexed search and cached observations to read channel messages. This guide uses the default API, with switchable JavaScript and TypeScript examples

## Scan until you find one message

Find the first recent message that satisfies a rule. Add this reusable helper to a module where your bot already has a [`Client`](/docs/{{version}}/api/interfaces/js-ts.Client/)

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

The helper returns a Result containing the matching message or an iteration failure, or `undefined` after examining at most 200 messages

The [`iterateHistory`](/docs/{{version}}/api/interfaces/js-ts.Messages/#iteratehistory) method reads newest first and requests later pages only as needed. Breaking after a match releases the buffered page. Older or inaccessible messages can remain outside this bounded result

## Search the message index

When you know the text to find, ask Fluxer's search index for one page. Indexed search can lag behind recent messages and may report that the index is still being prepared

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function searchChannel(client: Client, channelId: string, text: string) {
    const result = await client.messages.search({ channelId }, { content: text, limit: 10 })
    if (result.isErr()) return result
    if (result.value.indexing) return undefined
    return result.value.messages
}
```

This returns matching snapshots, an expected failure, or `undefined` while indexing. It does not poll or populate the cache. The SDK uses numbered pages. For another page, increase `page` while keeping `limit` unchanged

Use [`iterateSearch`](/docs/{{version}}/api/interfaces/js-ts.Messages/#iteratesearch) with an explicit `maxItems` when you want bounded multi-page traversal. Index changes can shift results while you scan

## Give the cache a small, explicit budget

Retain a recent working set for local lookups. Create a client with a token supplied by your application

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

Caching is opt-in and memory-only. The client-wide entry and byte bounds exclude runtime overhead and copies your application still holds. Eviction, expiry, conflicting reads, and gateway gaps can all produce a miss

See [`ClientOptions.cache.messages`](/docs/{{version}}/api/interfaces/js-ts.ClientOptions/#cache) and [`MessageCacheSettings`](/docs/{{version}}/api/interfaces/js-ts.MessageCacheSettings/) for the complete cache contract

## Use a local hit, then fetch when you need a remote read

Avoid a request when an acceptable local observation is available, while still having a clear remote path. Pass a message reference with its `channelId` and `id`

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
