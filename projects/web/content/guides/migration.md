---
title: Migrate from @fluxerjs/core
navTitle: Migration from core
description: Translate a non-voice bot to Fluxerly without hiding lifecycle or failure differences
---

This guide is for an application moving from `@fluxerjs/core` 3.1.0 to Fluxerly. It covers a non-voice bot with commands, an application database, moderation, bounded history, attachment URL refresh, health reporting and shutdown

The comparison uses the published [`@fluxerjs/core` 3.1.0 package](https://www.npmjs.com/package/@fluxerjs/core/v/3.1.0) and its [`v3.1.0` source](https://github.com/fluxerjs/core/tree/v3.1.0/packages/fluxer-core). Later releases may differ. Voice, Redis and framework integration are outside this fixture, so this guide makes no compatibility claim for them

## Change the ownership model first

`@fluxerjs/core` exposes mutable model objects, throws from asynchronous operations and lets `destroy()` reset a client for another login. Fluxerly exposes explicit client operations, returns `ResultAsync` from the default API and closes the client permanently on `shutdown()`

Keep the database, job queue and other application services outside either SDK. Migrate one application-owned handler at a time, then replace the client lifetime at the process boundary

| Concern       | `@fluxerjs/core` 3.1.0                               | Fluxerly default API                                                        |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Start         | `client.login(token, { signal })`                    | `client.run({ signal })` after `createClient({ token })`                    |
| Event handler | `client.on(Events.MessageCreate, handler)`           | `client.on("messageCreate", handler)` and check the registration result     |
| Reply         | `message.reply(input)`                               | `client.messages.reply(message, input, { signal })`                         |
| Remote read   | Manager or model `fetch()`                           | Explicit resource operation such as `client.messages.fetch(reference)`      |
| Local lookup  | Manager collections and `get()`                      | Explicit `get()` on a configured bounded cache                              |
| Failure       | Rejected promise or thrown `FluxerError`             | `Err` for expected failures and rejected `SdkDefect` for unexpected defects |
| Shutdown      | `client.destroy()`, then the client may log in again | `client.shutdown()`, then create a new client to restart                    |

## Move commands without moving the database into the SDK

Keep command inputs and database access in application code. Pass the handler's signal into SDK work, check every registration and operation result, and return the handler promise so shutdown can await it

```ts
import type { Client, Message } from "@neontechspace/fluxerly";

interface GreetingStore {
    greeting(userId: string): Promise<string>;
}

export function installGreeting(client: Client, store: GreetingStore) {
    return client.on("messageCreate", async (message: Message, signal) => {
        if (message.author.isBot || message.content !== "!hello") return;
        const content = await store.greeting(message.author.id);
        const replied = await client.messages.reply(
            message,
            { content },
            { signal },
        );
        if (replied.isErr()) throw replied.error;
    });
}
```

An application database failure is not an SDK transport failure. Decide whether that failure stops a critical worker, becomes a safe user response or enters an application-owned retry queue. Neither SDK can make a database write and a reply atomic

## Translate reads and cache use separately

In `@fluxerjs/core`, `channel.messages.fetch(id)` reads remotely while `channel.messages.get(id)` reads its cache. Fluxerly keeps the same remote-versus-local distinction through `client.messages.fetch(reference)` and `client.messages.get(reference)`, but its cache is disabled until configured

Do not replace a remote read with a cache lookup during migration. A miss is not evidence that the remote resource does not exist. Fluxerly cache diagnostics report retained snapshots and accounted bytes, not remote totals or process memory

For a bounded history scan, replace a manual `before` loop with `iterateHistory`:

```ts
import type { Client } from "@neontechspace/fluxerly";

export async function recentMessageIds(client: Client, channelId: string) {
    const ids: string[] = [];
    for await (const item of client.messages.iterateHistory(channelId, {
        maxItems: 500,
        pageSize: 100,
    })) {
        if (item.isErr()) throw item.error;
        ids.push(item.value.id);
    }
    return ids;
}
```

The iterator starts when consumed, applies a deadline per page and emits one terminal `Err`. Messages already yielded remain application-owned if a later page fails

## Preserve moderation uncertainty

Replace `guild.kick(userId, reason)` with an explicit member reference:

```ts
import type { Client } from "@neontechspace/fluxerly";

export async function kickMember(
    client: Client,
    guildId: string,
    userId: string,
    signal: AbortSignal,
) {
    const kicked = await client.members.kick(
        { guildId, userId },
        { auditReason: "Repeated spam", signal },
    );
    if (kicked.isErr()) {
        console.warn("Kick failed", {
            kind: kicked.error._tag,
            outcome:
                "outcome" in kicked.error
                    ? kicked.error.outcome
                    : "notDispatched",
        });
    }
}
```

Do not automatically replay a mutation whose failure has `outcome: "unknown"`. The server may have applied it before the response was lost. Reconcile current membership or require an operator decision instead

## Refresh expired attachment URLs explicitly

The compared `@fluxerjs/core` release exposes attachment expiry metadata but no high-level URL refresh operation. Fluxerly adds `client.attachments.refreshUrls()` and never invokes it automatically

Refresh the original URL, select the matching ordered result, then download with an explicit byte limit. A refresh does not prove the later download will succeed

```ts
import type { Attachment, Client } from "@neontechspace/fluxerly";

export async function downloadFresh(
    client: Client,
    attachment: Attachment,
    signal: AbortSignal,
) {
    if (!attachment.url) throw new Error("Attachment has no downloadable URL");
    const refreshed = await client.attachments.refreshUrls([attachment.url], {
        signal,
    });
    if (refreshed.isErr()) throw refreshed.error;
    const first = refreshed.value[0];
    if (!first) throw new Error("Attachment refresh returned no result");

    const downloaded = await client.attachments.download(
        { ...attachment, url: first.refreshed },
        { maxBytes: 8 * 1024 * 1024, signal },
    );
    if (downloaded.isErr()) throw downloaded.error;
    return downloaded.value;
}
```

Keep an explicit unsupported branch while the application still runs on both SDKs. Do not silently use an expired URL as the compatibility fallback

## Rebuild health and shutdown around the new lifetime

`@fluxerjs/core` provides cache sizes through `client.cache.stats()` and gateway latency through `client.ws.ping` after login. Fluxerly's `client.diagnostics()` returns a payload-free snapshot of gateway state, request pressure, event registrations and bounded cache accounting

These shapes are not equivalent. Normalize only the fields the application actually uses and keep the source visible. A local counter is not a cross-process total or an admission limit

On shutdown, abort the application lifetime, await the connection and critical workers, then call `client.shutdown()`. A Fluxerly client is closed after that call. An in-process restart must create a new client and new subscriptions, and it does not replay events missed between lifetimes. The [application supervision recipe](/docs/{{version}}/application-supervision/) shows that boundary

## Verify the migration contract

The repository fixture runs the same application contract for command and database behavior, bounded pagination, a single application call for each moderation request, attachment capability reporting, health normalization and idempotent cleanup

```sh
node projects/sdk/tests/migration/run-core-comparison.js
```

The comparison runner installs only the exact locked `@fluxerjs/core` fixture into an operating-system temporary directory. It uses the public npm registry, disables lifecycle scripts, checks the installed version, typechecks the core mapping, runs the behavior contract and removes the owned temporary directory. The Fluxerly variant runs against the packed public exports during the SDK package check

The Fluxerly fixture uses its HTTP boundary, while the core fixture replaces public REST methods and leaves channel, message and guild models intact. The moderation assertion proves that the application adapter makes one SDK call. It does not test either SDK's lower transport retry behavior. The fixture is not a live service test, performance benchmark or proof for features outside the stated scope
