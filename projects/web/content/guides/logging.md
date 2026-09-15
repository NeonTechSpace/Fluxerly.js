---
title: Log useful bot activity
navTitle: Logging
description: Follow connection lifecycle and report safe application failure metadata
---

Use client logging to follow connection lifecycle and operational reports. SDK records contain event and retry metadata while excluding credentials and event payloads

## Enable development logging

Enable lifecycle records on the client that needs them. This helper returns a disconnected client with logging ready before handlers or a gateway connection begin

```ts
import { createClient } from "@neontechspace/fluxerly"

export function createDevelopmentClient(token: string) {
    const created = createClient({
        token,
        logging: { development: true },
    })
    if (created.isErr()) throw created.error
    return created.value
}
```

Development logging writes Info-level records for connection attempts, readiness, connection loss, retry waits, session resets, and shutdown. Omit `development` to keep lifecycle records disabled. Use `minimumLevel` when a default client needs a different level threshold

## Report application failures safely

Report expected operation failures from their typed kind and safe metadata. Message failures expose a reason, delivery certainty, HTTP status and local validation detail. The optional `onError` callback receives an event name and failure kind after a callback or its queue fails

```ts
import type { Client } from "@neontechspace/fluxerly"

export function registerPing(client: Client) {
    const registered = client.on(
        "messageCreate",
        async (message, signal) => {
            if (message.author.isBot || message.content !== "!ping") return

            const reply = await client.messages.reply(message, { content: "Pong!" }, { signal })
            if (reply.isErr()) {
                const failure = reply.error
                if (failure._tag === "MessageError") {
                    console.warn("Reply failed", {
                        reason: failure.reason,
                        delivery: failure.delivery,
                        status: failure.status,
                        inputValidation: failure.inputValidation,
                    })
                } else {
                    console.warn("Reply stopped", { kind: failure._tag })
                }
            }
        },
        {
            onError: (report) => {
                console.error("Event callback failed", {
                    event: report.event,
                    kind: report.kind,
                })
            },
        },
    )
    if (registered.isErr()) throw registered.error
    return registered.value
}
```

The operation metadata identifies invalid inputs, permission rejections and transport failures without exposing message content. An unknown delivery result needs reconciliation before retrying. The error callback excludes the event payload and original exception. Catch an application error inside the handler when application-specific reporting needs more context, then choose only safe fields for that output

## Write JSON records to the console

Default API logging begins with Effect's readable logger. Create this adapter once, then pass `jsonConsoleLogger` as `logging.logger` beside `development: true` in `createClient`

```ts
import { Logger } from "effect"
import { fromEffectLogger } from "@neontechspace/fluxerly/effect"

export const jsonConsoleLogger = fromEffectLogger(Logger.consoleJson)
```

This application imports Effect directly, so install the exact peer version shown in [the Effect starter](/docs/{{version}}/effect-first-bot/). The logger runs synchronously. Keep output handling fast and provide application-owned buffering or delivery when needed

## Keep native logs in the application context

Native clients use the logger and context provided by the running Effect. Keep client creation and `run()` inside the same scoped program, then pass the application signal to `Effect.runPromise`

```ts
import { Effect, Logger } from "effect"
import { createClient } from "@neontechspace/fluxerly/effect"

export function runNativeBot(token: string, signal: AbortSignal) {
    const program = Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({
                token,
                logging: { development: true },
            })
            yield* client.run()
        }).pipe(
            Effect.withLogger(Logger.consoleJson),
            Effect.annotateLogs("bot", "gateway"),
            Effect.withSpan("bot-connection"),
        ),
    )

    return Effect.runPromise(program, { signal })
}
```

The returned Promise settles after terminal connection handling and scoped cleanup. Native logging accepts `development`. The executing Effect supplies its logger and minimum level

Use [`client.diagnostics()`](/docs/{{version}}/api/interfaces/js-ts.Client/#diagnostics) for a current frozen snapshot of connection state, request counts, and cache accounting. Follow [the reliability guide](/docs/{{version}}/reliability/) for retries, cancellation, and shutdown
