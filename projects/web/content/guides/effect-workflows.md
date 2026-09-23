---
title: Build workflows with Effect
navTitle: Effect workflows
description: Handle expected failures, collect replies and limit concurrent reads
---

After the [first Effect bot](/docs/{{version}}/effect-first-bot/), these examples use a native `Client` that stays open in the scope where it was created. Each helper returns an Effect. Call it with `yield*` inside the application program

## Handle success and expected failure

Use `Effect.match` to turn either success or an expected failure into a value. For example, a status panel can report whether a notice was sent without storing its content or a raw error

```ts
import { Effect } from "effect"
import type { Client } from "@neontechspace/fluxerly/effect"

export function sendNotice(client: Client, channelId: string) {
    return client.messages.send(channelId, { content: "The event starts in ten minutes" }).pipe(
        Effect.match({
            onSuccess: message => ({ status: "confirmed" as const, messageId: message.id }),
            onFailure: error => ({ status: "failed" as const, error }),
        }),
    )
}
```

The failure branch retains the expected SDK error for the caller. A message error's `delivery` field identifies whether dispatch was ruled out or the outcome needs reconciliation before another send attempt. Defects and interruption still propagate to the caller

## Collect replies and clean up

A nested scope can clean up a short conversation's collector while the bot stays open. Unlike the [default collector example](/docs/{{version}}/events-and-collectors/), this code does not need a `finally` block to stop the collector

```ts
import { Effect } from "effect"
import type { Client } from "@neontechspace/fluxerly/effect"

export function askPreferredName(client: Client, channelId: string, userId: string) {
    return Effect.scoped(
        Effect.gen(function* () {
            const collector = yield* client.messages.collect(channelId, {
                filter: message => message.author.id === userId && !message.author.isBot,
                maxMessages: 1,
                timeoutMs: 30_000,
            })
            yield* client.messages.send(channelId, { content: "What name should the bot use?" })
            const result = yield* collector.waitForClose()
            return result.messages[0]?.content
        }),
    )
}
```

The client must already be connected. The `yield*` expression finishes registration before sending the prompt, so a fast reply can be observed. Success, prompt failure and interruption all release the collector before this helper completes. The outer client stays open

A timeout can return `undefined`. A gateway gap fails collection because replies may have been missed. The prompt remains posted after collection ends

## Run independent reads together

Fetch independent data at the same time, with a limit on concurrent requests. This example fetches a guild and its channels without opening the gateway

```ts
import { Effect } from "effect"
import type { Client } from "@neontechspace/fluxerly/effect"

export function readGuildOverview(client: Client, guildId: string) {
    return Effect.all({
        guild: client.guilds.fetch(guildId),
        channels: client.channels.fetchAll(guildId),
    }, { concurrency: 2 })
}
```

On success, the result has `guild` and `channels` properties. A failure interrupts unfinished sibling work and waits for its finalizers. The SDK's request limits and rate-limit handling still apply. Concurrent reads can observe different remote revisions

## Count messages without storing them all

A Stream describes values processed as they arrive. A remote scan can run without collecting every result in an array

```ts
import { Stream } from "effect"
import type { Client } from "@neontechspace/fluxerly/effect"

export function countRecentHumanMessages(client: Client, channelId: string) {
    return client.messages.iterateHistory(channelId, { maxItems: 200, pageSize: 50 }).pipe(
        Stream.runFold(() => 0, (count, message) => count + (message.author.isBot ? 0 : 1)),
    )
}
```

The returned Effect counts human-authored observations among at most 200 messages, newest first. Requests begin when the Stream is consumed, page failures remain failures, and interruption waits for in-flight cleanup

## Read history and post a summary

Keep reusable work as Effects and run the completed program at the application entry point. This example creates one scoped client, reads at most 200 messages, sends a summary and then closes the client

```ts
import { Effect, Stream } from "effect"
import { createClient } from "@neontechspace/fluxerly/effect"

export function postActivitySummary(token: string, channelId: string) {
    return Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({ token })
            const count = yield* client.messages.iterateHistory(channelId, {
                maxItems: 200,
                pageSize: 50,
            }).pipe(Stream.runFold(() => 0, total => total + 1))

            return yield* client.messages.send(channelId, {
                content: `Scanned ${count} recent messages`,
            })
        }),
    )
}
```

Run the returned Effect with `Effect.runPromise` from the application entry point, or `yield*` it inside a larger program. A failed history scan skips the summary. Reconcile an uncertain summary delivery before rerunning the job, which can otherwise post a duplicate

For the next step, learn [Effect resource management](https://effect.website/docs/v4/resource-management/introduction) and [expected errors versus defects](https://effect.website/docs/v4/error-management/two-error-types). Use services and Layers to supply shared application dependencies
