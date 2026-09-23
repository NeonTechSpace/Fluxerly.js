---
title: Make bot operations reliable
navTitle: Reliability
description: Handle expected failures, cancellation, shutdown, and uncertain writes deliberately
---

The default API puts expected failures, such as permission or network errors, in `Result` values. Unexpected SDK or cleanup defects reject the Promise instead. Handle these separately so routine failures do not look like programming defects

## Handle an expected reply failure without hiding defects

Report an expected reply failure while allowing an unexpected defect to reach the application's top-level error handler. Call this helper from the bot's message handler

```ts
import type { Client, Message } from "@neontechspace/fluxerly"

export async function replyToPing(client: Client, message: Message) {
    const reply = await client.messages.reply(message, { content: "Pong!" })
    if (reply.isErr()) {
        console.warn("Reply could not be completed", { kind: reply.error._tag })
        return reply
    }

    return reply
}
```

An expected operational failure is returned and logs only its typed kind. A successful reply returns a Result containing the created message

A rejected `SdkDefect` represents an unexpected SDK or cleanup failure. Handle it in the application's top-level error handler, where the application can alert, restart or record safe diagnostic details

## Set a request deadline and allow cancellation

Stop waiting for a remote message if the caller cancels or the request takes too long. Create an `AbortController` for that task and pass its `signal` to this helper

```ts
import type { Client, MessageReference } from "@neontechspace/fluxerly"

export async function fetchUntilCancelled(
    client: Client,
    message: MessageReference,
    signal: AbortSignal,
) {
    return await client.messages.fetch(message, {
        signal,
        timeoutMs: 5_000,
    })
}
```

The remote read's Result contains a message or a typed error. Aborting the signal produces `CancelledError`. The five-second deadline also stops the request and waits for SDK cleanup

Cancellation waits for SDK cleanup. A provider can still complete work it already received. Keep the controller with the operation that owns the user request

Global HTTP 429 rejections pause unrelated API routes on the same client, including when a valid global header accompanies an unreadable error body. Waiting still counts toward each operation's deadline, and cancelling one queued operation does not clear the shared pause. The [client contract](/docs/{{version}}/api/interfaces/js-ts.Client/) explains scope metadata and retry boundaries

Server-provided bucket identifiers also refine request grouping automatically, so bot code does not need to configure rate-limit groups. Matching limits share a wait, while known independently limited resources stay separate. Initial requests can still receive a 429 before the server's grouping is learned

## Handle rejected gateway messages

Gateway receive protection is automatic and needs no bot configuration. A message beyond the fixed receive ceiling, or invalid UTF-8, stops the connection rather than repeatedly reconnecting to the same rejected data. The [client contract](/docs/{{version}}/api/interfaces/js-ts.Client/) documents the ceiling and failure codes. Subscription queue limits apply separately and do not bound JSON parsing memory

## Start, recover and stop the connection in one function

Use `run` when one signal should control startup, recovery and shutdown. Pass a disconnected client with its handlers already registered and an `AbortSignal` controlled by the application

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function runUntilStopped(client: Client, signal: AbortSignal) {
    return await client.run({ signal })
}
```

Once `run()` starts, it waits through connection startup and recovery. It finishes after a normal stop, permanent failure or cancellation, once SDK cleanup is done

The [`run`](/docs/{{version}}/api/interfaces/js-ts.Client/#run) method requires a disconnected client and closes it permanently once the accepted run ends. Alternatively, use `connect` for startup, `waitForClose` for later terminal failure and `shutdown` for final cleanup. Aborting `waitForClose` alone does not stop the client

## Send once, then inspect safe local diagnostics

Make one message attempt without blindly replaying an uncertain result, while recording local capacity evidence. Supply an application operation ID that is valid as a message nonce

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function sendOnceAndDiagnose(
    client: Client,
    channelId: string,
    content: string,
    operationId: string,
) {
    const sent = await client.messages.send(
        channelId,
        { content, nonce: operationId },
        { timeoutMs: 5_000 },
    )

    const diagnostics = client.diagnostics()
    console.info("Fluxerly client capacity", {
        state: diagnostics.state,
        activeRequests: diagnostics.rest.activeRequests,
        queuedRequests: diagnostics.rest.queuedRequests,
        retainedMessages: diagnostics.caches.messages.retainedEntries,
    })

    return sent
}
```

The helper makes one SDK send call, returns its `Result`, and logs only local state, request counts, and cache counts from [`diagnostics`](/docs/{{version}}/api/interfaces/js-ts.Client/#diagnostics)

A lost response, timeout, or cancellation after dispatch can leave the message posted. Do not call `send` again just because the result is uncertain. Reconcile through an authorized application workflow before deciding what to do next. A nonce has best-effort duplicate suppression for a limited window, not durable idempotency or exactly-once delivery
