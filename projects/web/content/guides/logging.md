---
title: Log useful bot activity
navTitle: Logging
description: Route safe structured records and measure SDK work without adding a telemetry service
---

Use client logging to see connection changes, operation timings and errors without logging message contents. Each client logs separately. Its logger runs synchronously and is off by default except for handler, cache-policy and observer errors

## Enable development logging

Enable lifecycle records on the client that needs them. This helper returns a disconnected client with logging ready before handlers or a gateway connection begin

```ts
import { createClient } from "@neontechspace/fluxerly";

export function createDevelopmentClient(token: string) {
    const created = createClient({
        token,
        logging: { development: true },
    });
    if (created.isErr()) throw created.error;
    return created.value;
}
```

Development logging writes Info-level records for connection attempts, readiness, connection loss, retry waits, session resets and shutdown. Omit `development` to keep lifecycle records disabled. Use `minimumLevel` when a default client needs a different level threshold

## Route structured records

Use `fromStructuredLogger` to send SDK records to an existing JavaScript logger without importing Effect. This example writes JSON, but the callback can call a Pino, Winston or application-owned sink instead

```ts
import {
    createClient,
    fromStructuredLogger,
    type SdkLogRecord,
} from "@neontechspace/fluxerly";

function writeLog(record: SdkLogRecord) {
    console.log(JSON.stringify(record));
}

export function createLoggedClient(token: string) {
    const created = createClient({
        token,
        logging: {
            development: true,
            logger: fromStructuredLogger(writeLog),
        },
    });
    if (created.isErr()) throw created.error;
    return created.value;
}
```

Every record includes `source`, `timestamp`, `level`, `category` and `event`. Category-specific fields use stable SDK names and bounded values. Records exclude tokens, payloads, URLs, Effect causes and application annotations

The SDK calls the logging callback immediately and does not wait for a returned Promise. If the callback throws or returns a rejected Promise, the SDK operation keeps its original result. Slow callback work can still delay the bot. The application must handle queued log delivery, flushing and storage itself

## Measure SDK work

Set `measurements: true` to emit Info-level timing records through the same logger. The SDK reports REST queue, network and decode time, gateway connection time and event-handler time. Records include a stable operation, stage, duration, outcome and retry count when applicable

```ts
import { createClient, fromStructuredLogger } from "@neontechspace/fluxerly";

export function createMeasuredClient(token: string) {
    return createClient({
        token,
        logging: {
            measurements: true,
            logger: fromStructuredLogger((record) => {
                if (record.category === "measurement") console.log(record);
            }),
        },
    });
}
```

All stages use the executing Effect runtime's monotonic clock and stable low-cardinality names. The default API uses the runtime default, while a native program can provide its own `Clock` service. Measurements do not include request paths, resource IDs, signed URLs, audit reasons, OAuth values or payloads. Enabling measurements does not create an exporter, telemetry service, delivery queue or stored history

## Report application failures safely

Report expected operation failures from their typed kind and safe metadata. Message failures expose a reason, delivery certainty, HTTP status and local validation detail. The optional `onError` callback receives an event name and failure kind after a callback or its queue fails

```ts
import type { Client } from "@neontechspace/fluxerly";

export function registerPing(client: Client) {
    const registered = client.on(
        "messageCreate",
        async (message, signal) => {
            if (message.author.isBot || message.content !== "!ping") return;

            const reply = await client.messages.reply(
                message,
                { content: "Pong!" },
                { signal },
            );
            if (reply.isErr()) {
                const failure = reply.error;
                if (failure._tag === "MessageError") {
                    console.warn("Reply failed", {
                        reason: failure.reason,
                        delivery: failure.delivery,
                        status: failure.status,
                        inputValidation: failure.inputValidation,
                    });
                } else {
                    console.warn("Reply stopped", { kind: failure._tag });
                }
            }
        },
        {
            onError: (report) => {
                console.error("Event callback failed", {
                    event: report.event,
                    kind: report.kind,
                });
            },
        },
    );
    if (registered.isErr()) throw registered.error;
    return registered.value;
}
```

The error details distinguish invalid input, permission rejection and transport failure without exposing message content. If message delivery is uncertain, check what happened before retrying. The error callback omits the event payload and original exception. To report an application error with more context, catch it in the handler and log only fields safe to share

## Keep native logs in the application context

Native clients use the logger, minimum level, annotations, spans and clock provided by the running Effect. Keep client creation and `run()` inside the same scoped program, then pass the application signal to `Effect.runPromise`

```ts
import { Effect, Logger, References } from "effect";
import { createClient } from "@neontechspace/fluxerly/effect";

export function runNativeBot(token: string, signal: AbortSignal) {
    const program = Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({
                token,
                logging: { development: true, measurements: true },
            });
            yield* client.run();
        }).pipe(
            Effect.withLogger(Logger.consoleJson),
            Effect.provideService(References.MinimumLogLevel, "Info"),
            Effect.annotateLogs("bot", "gateway"),
            Effect.withSpan("bot-connection"),
        ),
    );

    return Effect.runPromise(program, { signal });
}
```

The returned Promise settles after terminal connection handling and scoped cleanup. Native logging accepts `development` and `measurements`. The native `logging` option rejects `logger` and `minimumLevel` because the executing Effect owns both. SDK records retain the caller's safe annotations and active span for a native logger, while the plain structured adapter deliberately excludes that context

Use [`client.diagnostics()`](/docs/{{version}}/api/interfaces/js-ts.Client/#diagnostics) for a current frozen snapshot of connection state, request counts, and cache accounting. Follow [the reliability guide](/docs/{{version}}/reliability/) for retries, cancellation, and shutdown
