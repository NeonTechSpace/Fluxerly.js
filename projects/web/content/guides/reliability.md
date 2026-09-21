---
title: Make bot operations reliable
navTitle: Reliability
description: Handle expected failures, cancellation, shutdown, and uncertain writes deliberately
---

The default API returns expected operational failures in `Result` values. Unexpected SDK or cleanup defects reject instead. Keep those two paths separate so a normal permission or network failure does not look like a programming defect

## Handle an expected reply failure without hiding defects

Report a normal reply failure while allowing an unexpected defect to reach your application's error boundary. Call this reusable helper from your bot's message handler

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

A normal operational failure is returned and logs only its typed kind. A successful reply returns a Result containing the created message

A rejected `SdkDefect` represents an unexpected SDK or cleanup failure. Handle it at the application's outer error boundary, where the application can alert, restart or record safe diagnostic details

## Give one request a deadline and a cancellation owner

Stop waiting for a remote message when your surrounding task ends or takes too long. The caller owns an `AbortController` and passes its `signal` to this reusable helper

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

The remote read returns a message, a typed operation failure, or `CancelledError` after the caller aborts the signal. The five-second deadline interrupts the request, then waits for required cleanup

Cancellation waits for SDK cleanup. A provider can still complete work it already received. Keep the controller with the operation that owns the user request

Global HTTP 429 rejections pause unrelated API routes on the same client, including when a valid global header accompanies an unreadable error body. Waiting still counts toward each operation's deadline, and cancelling one queued operation does not clear the shared pause. The [client contract](/docs/{{version}}/api/interfaces/js-ts.Client/) explains scope metadata and retry boundaries

## Let one function own connection lifetime

Use `run` when one signal should own startup, recovery and shutdown. Pass a disconnected client with its handlers already registered and an `AbortSignal` owned by your application

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function runUntilStopped(client: Client, signal: AbortSignal) {
    return await client.run({ signal })
}
```

After accepting the run, the helper stays pending through startup and recovery. Normal shutdown, permanent failure or caller cancellation ends the run only after owned cleanup

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
