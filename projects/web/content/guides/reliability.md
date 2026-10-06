---
title: Make bot operations reliable
navTitle: Reliability
description: Report failures, retry only when it is safe, set deadlines and handle uncertain writes
---

Most bots need little code for reliability. The SDK reconnects on its own, keeps running when a handler fails and reports callback failures with their full cause. A handler only has to return the Result of its reply, and retry only when the SDK confirms that retrying is safe

## Return the reply's Result

The default API returns expected failures, such as a missing permission or a network error, in a [`Result`](/docs/{{version}}/glossary/#result) instead of throwing. A handler that returns that Result hands a failure to the SDK. An HTTP 401 or 403 rejection is logged once unless the handler returns its failure more than one second after the rejection, when its `rest.rejected` Warn has already appeared. See [rejection logging](/docs/{{version}}/logging/#read-the-default-output)

```ts
import { errors, runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    events: {
        messageCreate: async ({ message, reply }) => {
            if (message.content !== "!ping") return undefined
            const first = await reply("Pong!")
            if (first.isOk() || !errors.isRetryable(first.error)) return first
            return reply("Pong!")
        },
    },
})
```

A successful reply returns its Result and nothing else happens. A failed reply is sent again only when `errors.isRetryable` confirms that the first attempt did not post a message, so the bot never answers twice. Any remaining failure is returned, and the SDK reports it to `onError` or logs it at Error with its message and suggested fix

Either return a failed Result or handle it in the handler, not both. A handler that logs a failure and then returns it reports the same failure twice

The bot itself follows the same rule. When a failure stops it, such as a rejected token, `runBot` logs that failure once and sets `process.exitCode` to 1, so the top-level code needs no error handling

## Report failures that have no Result

Some failures have no caller to return to: A throwing event handler or one that returns an Err, a failed command, a failing [collector](/docs/{{version}}/glossary/#collector) callback or filter, a message cache callback that throws or a subscription closed by a full queue with `overflow: "stop"`. The SDK sends each of them to the client's `onError` option with the original error and the IDs of the message involved, never its content. Without a hook it logs them at Error with the full message, stack and cause chain

```ts
import { createClient, type FailureReport } from "@neontechspace/fluxerly"

export function createReportedClient(token: string, track: (report: FailureReport) => Promise<void>) {
    return createClient({ token, onError: (report) => track(report) })
}
```

The `report.describe()` method returns readable text for an error tracker or a chat alert. A failing hook is logged together with the original failure and never retried

<details>
<summary>How reports are queued</summary>

Reports reach the hook one at a time in order. Up to 256 wait while the hook is busy.
Later reports are logged instead and counted in `diagnostics().counters.reportsDropped`, so none disappear silently.
Shutdown does not wait for a hook that never finishes

</details>

## Read an SDK error

Every SDK error extends `FluxerlyError` with a stable `code`, an optional fix `hint`, safe `details` and a standard `cause`:

- Readable text: The `describeError(error)` function prints the code, hint and cause chain
- Safe retries: The `errors.isRetryable(error)` function says whether repeating the same call is safe
- Fluxer's reason: The `errors.apiCode(error)` function returns Fluxer's error code name, such as `"missingPermissions"`, or `undefined`
- Missing permissions: For `"missingPermissions"`, `error.details.requiredPermissions` lists the permissions Fluxer checks for the failed operation, such as `ViewChannel` and `SendMessages`, when the SDK knows them
- Branching: The `errors.match(error, handlers)` function calls the handler named by the error's `_tag`

An unexpected SDK or cleanup failure is not an Err. It rejects the Promise with `SdkDefect`, whose `reasons` list every failure and whose `cause` is the first defect, or the first failure when there is no defect. In the example above, `await runBot(...)` lets it end the process with Node.js's error output and a failing exit code. An application with its own top-level `try`/`catch` can alert, restart or print `describeError(error)` there instead

## Set a request deadline and allow cancellation

Every request has a 30-second deadline by default. Pass `timeoutMs` for a shorter one, and a `signal` to stop waiting when the caller cancels. Create an `AbortController` for that task and pass its `signal` to this helper

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

The Result contains the message or a typed error. Aborting the signal produces `CancelledError`, and the five-second deadline also stops the request. Both wait for SDK cleanup before the Result arrives. A provider can still complete work it already received, so keep the controller with the operation that owns the user request

Handlers in `runBot` receive a `signal` that is aborted when the bot stops. The bound `reply` already uses it

## Send once when the outcome is uncertain

A lost response, timeout or cancellation after a message was sent can leave it posted. Such a failure is an [uncertain write](/docs/{{version}}/glossary/#uncertain-write), and `errors.isRetryable` returns false for it. Do not send again just because the result is uncertain. Supply an application operation ID as the message nonce, and reconcile through an application workflow before deciding what to do next

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

The helper makes one send call, returns its `Result`, and logs only local state, request counts and cache counts from [`diagnostics`](/docs/{{version}}/api/interfaces/js-ts.Client/#diagnostics). A nonce has best-effort duplicate suppression for a limited window, not durable idempotency or exactly-once delivery

## Start, recover and stop the connection in one function

Without `runBot`, use `client.run` when one signal should control startup, recovery and shutdown. Pass a disconnected client with its handlers already registered and an `AbortSignal` controlled by the application

```ts
import type { Client } from "@neontechspace/fluxerly"

export async function runUntilStopped(client: Client, signal: AbortSignal) {
    return await client.run({ signal })
}
```

Once `run()` starts, it waits through connection startup and recovery. It finishes after a normal stop, permanent failure or cancellation, once SDK cleanup is done

The [`run`](/docs/{{version}}/api/interfaces/js-ts.Client/#run) method requires a disconnected client and closes it permanently once the accepted run ends. Alternatively, use `connect` for startup, `waitForClose` for later terminal failure and `shutdown` for final cleanup. Aborting `waitForClose` alone does not stop the client

## Limits and retry rules

The SDK applies these rules automatically. They need no configuration, but explain behavior seen in logs and diagnostics

<details>
<summary>Automatic request retries</summary>

A read that fails with a network error or HTTP 500, 502, 503 or 504 is retried at most twice.
A write is sent again only after Fluxer confirms a rate limit with HTTP 429, so a write with an unknown outcome is never repeated automatically.
Each retry is counted in `diagnostics().counters.restRetries` and logged at Debug

</details>

<details>
<summary>Rate limits</summary>

The SDK waits for [rate limits](/docs/{{version}}/glossary/#rate-limit) on its own and logs waits of one second or more at Warn.
Waiting counts toward each operation's deadline. A wait that would pass the deadline fails at once with `ratelimit.deadline`.
A global HTTP 429 pauses unrelated API routes on the same client, including when a valid global header accompanies an unreadable error body. Cancelling one queued operation does not clear the shared pause.
Server-provided bucket identifiers refine request grouping automatically, so bot code does not configure rate-limit groups. Matching limits share a wait, while independently limited resources stay separate. The first requests can still receive a 429 before the grouping is learned.
The [client contract](/docs/{{version}}/api/interfaces/js-ts.Client/) explains scope metadata and retry boundaries

</details>

<details>
<summary>Request queue and capacity</summary>

By default, a client runs up to 4 API requests at a time per local shard, capped at 64 for the client, and lets 256 requests wait. An explicit `rest.concurrency` stays fixed instead of scaling with the shard count. A request that finds the queue full fails at once with reason `busy` and was never sent, so it is safe to retry later.
The `rest` client option changes these limits, as described in [configuration](/docs/{{version}}/configuration/#connection-and-requests)

</details>

<details>
<summary>Rejected gateway messages</summary>

Gateway receive protection is automatic. A message beyond the fixed receive ceiling, or invalid UTF-8, stops the connection rather than repeatedly reconnecting to the same rejected data.
A known event that fails validation is skipped instead: The SDK logs `gateway.dispatchRejected` at Warn with the event type and failing field, clears cache entries it could have changed and keeps the session running.
Set `gateway: { onMalformedDispatch: "terminate" }` to end the session instead.
The [client contract](/docs/{{version}}/api/interfaces/js-ts.Client/) documents the ceiling and failure codes. Subscription queue limits apply separately and do not bound JSON parsing memory

</details>

<details>
<summary>Reconnects</summary>

After a lost connection the SDK resumes the session when Fluxer allows it and otherwise starts a new one, waiting a growing random delay between attempts.
Transient failures never make it give up. A permanent failure, such as a rejected token, ends the run with a connection error.
The `connection.recovery` option changes the delays, as listed in [`ConnectionRecoveryOptions`](/docs/{{version}}/api/interfaces/js-ts.ConnectionRecoveryOptions/)

</details>
