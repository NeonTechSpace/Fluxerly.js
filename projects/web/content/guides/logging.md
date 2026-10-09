---
title: See what a bot is doing
navTitle: Logging & debugging
description: Read the default log output, adjust levels and categories, and send records to an existing logger
---

Every client prints what it is doing by default: Startup, each [shard](/docs/{{version}}/glossary/#shard) (gateway connection) becoming ready, lost connections with their close code and next step, long rate-limit waits, shutdown, and every application error in full. Adjust the level for the whole client or one area, turn on Debug records while investigating, or send records to an existing logger. Records never contain tokens or other credentials

## Read the default output

On a terminal the client prints one readable line per record: Time, level, category, the record's code in brackets, a message and its facts. Warnings and errors go to standard error, everything else to standard output. A two-shard bot that starts, loses one connection and stops prints lines like these

```text
2026-09-27 03:14:20.850 INFO  lifecycle  [lifecycle.starting] Starting Fluxerly 1000.0.0-rc.0 for fluxer.app with 2 shards version=1000.0.0-rc.0 instance=fluxer.app shards=2 totalShards=2
2026-09-27 03:14:20.853 INFO  lifecycle  [lifecycle.startupDeadline] Startup of 2 shards may take up to 31.0 s: The configured 30.0 s (connection.startupTimeoutMs) plus 1 s per additional shard, because the SDK starts shard sessions 1 s apart startupTimeoutMs=31000 configuredMs=30000 shards=2
2026-09-27 03:14:20.891 INFO  lifecycle  [lifecycle.ready] Shard 0 is ready shardId=0 attempt=1 durationMs=36 mode=identify shards=2
2026-09-27 03:14:21.890 INFO  lifecycle  [lifecycle.ready] Shard 1 is ready shardId=1 attempt=1 durationMs=1033 mode=identify shards=2
2026-09-27 03:14:21.891 INFO  lifecycle  [lifecycle.connected] Connected to Fluxer as MyBot in 1520 communities communities=1520 shards=2
2026-09-27 03:14:22.233 WARN  lifecycle  [lifecycle.connectionLost] Shard 1 lost its connection. Close code 4000 (UNKNOWN_ERROR): The gateway reported an unspecified error. Reconnecting and resuming the session in 755 ms shardId=1 closeCode=4000 attempt=1 delayMs=755 reason=closed classification=closed next=resume
2026-09-27 03:14:22.999 INFO  lifecycle  [lifecycle.ready] Shard 1 resumed its session after 766 ms offline shardId=1 attempt=2 durationMs=1 mode=resume shards=2
2026-09-27 03:14:23.737 INFO  lifecycle  [lifecycle.stopRequested] The signal passed to runBot was aborted, so the bot is shutting down
2026-09-27 03:14:23.739 INFO  lifecycle  [lifecycle.shutdown] Shutting down
2026-09-27 03:14:23.742 INFO  lifecycle  [lifecycle.shutdownComplete] Shutdown complete in 3 ms durationMs=3
```

When a stream is not a terminal, such as under a process manager or in a container, its records are printed as one JSON object per line instead. Standard output and standard error decide separately. Set `format` to choose explicitly, or set the `FLUXERLY_LOG_FORMAT` environment variable to `pretty` or `json` for a client without `format`. A [supervisor](/docs/{{version}}/glossary/#supervisor) passes its own choice to the children whose output it forwards

Readable output is colored on a terminal. Set `FLUXERLY_LOG_COLOR` to `1`, `true`, `yes` or `on` to force color, or to `0`, `false`, `no` or `off` to turn it off. The `NO_COLOR` variable also turns color off

A failed handler is printed at Error with its message, stack and cause chain, because the error came from the bot's own code. Credentials are masked in names, application error codes, messages and stacks, including causes. Stack frames inside the SDK and Effect collapse into one line, so the bot's own frames stand out

```text
2026-09-26 21:27:52.689 ERROR events     [events.handlerFailed] The messageCreate handler failed: Cannot read properties of undefined (reading 'content') event=messageCreate subscriptionId=messageCreate#1 messageId=1456074443980800005 channelId=1456074443980800002 guildId=1456074443980800001
    TypeError: Cannot read properties of undefined (reading 'content')
      at messageCreate (file:///srv/bot/bot.js:3:78)
      ... 9 SDK and Effect frames hidden
```

An expected SDK error, such as a rejected request, prints its code, hint and details instead of stack frames. Here a handler returned a failed reply because the bot lacks permission in the channel. For a missing permission, the hint and `requiredPermissions` name the permissions Fluxer checks for the operation, because Fluxer does not report which one is missing

```text
2026-09-26 21:27:52.804 ERROR events     [events.handlerFailed] The messageCreate handler failed: Message send failed: Fluxer reports that the bot lacks a required permission (MISSING_PERMISSIONS, HTTP 403) event=messageCreate subscriptionId=messageCreate#1 messageId=1456074443980800006 channelId=1456074443980800002 guildId=1456074443980800001
    MessageError [message.send.rejected]: Message send failed: Fluxer reports that the bot lacks a required permission (MISSING_PERMISSIONS, HTTP 403)
      Hint: The bot needs View Channel and Send Messages for this operation. Grant them to the bot's role in the community settings or the channel's permission overrides. Embeds also need Embed Links, files need Attach Files, and a forward needs View Channel in its source channel
      Details: operation=send reason=rejected outcome=rejected status=403 apiError=MISSING_PERMISSIONS requiredPermissions=["ViewChannel","SendMessages"]
```

A 401 or 403 rejection waits up to one second for its handler to finish. If the handler fails with that same rejection, directly or in its cause chain, and no `onError` hook receives it, only the handler's failure record appears. A handler that fails more than one second later also logs its failure, because the `rest.rejected` Warn has already appeared. Different requests with the same status and code remain separate rejections

When the handler handles such a rejection itself, or passes it to an `onError` hook, the `rest.rejected` Warn still appears, because it usually points at a token or permission problem that persists. Repeats of it [collapse](/docs/{{version}}/logging/#collapse-repeated-errors) like other Warn records

```text
2026-09-26 21:27:52.802 WARN  rest       [rest.rejected] POST /channels/:id/messages was rejected for channel 1456074443980800002: Fluxer reports that the bot lacks a required permission (MISSING_PERMISSIONS, HTTP 403) route=/channels/:id/messages status=403 method=POST apiError=MISSING_PERMISSIONS hint="Grant the bot's role View Channel and Send Messages in this channel, plus Embed Links or Attach Files when the message has them, in the community settings or the channel's permission overrides"
```

## Look up a record code

Every record has a stable code, shown in brackets in readable output. The [error and log codes](/docs/{{version}}/error-and-log-codes/) page lists every code with its meaning and next step. These Warn records often surprise a new bot:

| Code | Meaning |
| --- | --- |
| `rest.rejected` | Fluxer rejected a request with HTTP 401 or 403, usually a token or permission problem. It is logged even when the application handles the Result. A handler that fails with the rejection within one second and has no `onError` hook logs only its own failure record. A later failure logs both. A bot that expects these rejections can set the `rest` [category](/docs/{{version}}/logging/#choose-levels-and-categories) to `error` |
| `rest.responseRejected` | A successful response to an SDK operation did not match the expected shape. The failing field is in `fields.field` |
| `sdk.unknownEnvironmentValue` | The `FLUXERLY_LOG_FORMAT` or `FLUXERLY_LOG_COLOR` variable has a value the SDK does not recognize, so it is ignored |

## Choose levels and categories

The default level is `info`. Set `level` for the whole client and `categories` for single areas. The categories are `lifecycle`, `gateway`, `rest`, `ratelimit`, `cache`, `events`, `commands`, `collectors`, `supervisor` and `sdk`

```ts
import { createClient } from "@neontechspace/fluxerly"

export function createQuietClient(token: string) {
    return createClient({
        token,
        logging: {
            level: "warn",
            categories: { lifecycle: "info", rest: "debug" },
        },
    })
}
```

| Level | What appears |
| --- | --- |
| `error` and `fatal` | Application errors, failed hooks, connections that cannot continue and cleanup failures |
| `warn` | Lost connections, session resets, rate-limit waits of one second or more, rejected requests and responses, skipped malformed gateway events and dropped events |
| `info` | Startup, shard readiness and shutdown with its duration |
| `debug` | Every REST request with its route template, status and duration, retries, gateway dispatch summaries, rejected and unmatched commands |
| `trace` | Heartbeats and every gateway opcode |

The `silent` level turns a category or the whole client off, including application errors that have no `onError` hook and unsafe payload records

To change levels while the bot runs, for example to investigate a problem without a restart, pass new `level` and `categories` settings to `client.logging.configure`. Omitted `level` and `categories` return to their defaults. A `debug` setting there replaces the current Debug categories, as described in [Turn on debug output without changing code](/docs/{{version}}/logging/#turn-on-debug-output-without-changing-code), and an omitted one keeps them. The other `logging` settings stay as the client was created

```ts
import type { Client } from "@neontechspace/fluxerly"

export function traceRequests(client: Client) {
    client.logging.configure({ level: "warn", categories: { rest: "debug" } })
}
```

## Turn on debug output without changing code

Set the `FLUXERLY_DEBUG` environment variable before starting the bot. `1` enables Debug records for every category, while a comma-separated list such as `gateway,rest` enables only those. The variable is read when the client is created

```text
FLUXERLY_DEBUG=rest,ratelimit node bot.js
```

The `debug` option does the same from code, with `true` or a list of categories. Debug settings only lower a threshold, so `level: "silent"` with `FLUXERLY_DEBUG=rest` still prints REST Debug records

To change Debug output while the bot runs, pass `debug` to `client.logging.configure`. It replaces the categories chosen at creation, including those from `FLUXERLY_DEBUG`, and `debug: false` turns them all off

```ts
import type { Client } from "@neontechspace/fluxerly"

export function stopDebugOutput(client: Client) {
    client.logging.configure({ debug: false })
}
```

## Handle failures in one place

Pass `onError` to receive every failure that has no returned result: Handler and command failures, [collector](/docs/{{version}}/glossary/#collector) callbacks and filters, cleanup progress callbacks, subscriptions closed by a full queue with `overflow: "stop"`, message cache callbacks and failed state observers. The report holds the original error and the IDs of the message involved, never its content. With a hook in place the SDK keeps those failures at Debug instead of printing them again

```ts
import { runBot } from "@neontechspace/fluxerly"

export function runReportedBot(token: string | undefined, report: (text: string) => void) {
    return runBot({
        token,
        onError: (failure) => report(failure.describe()),
        events: {
            messageCreate: ({ message, reply }) => {
                if (message.content !== "!ping") return undefined
                return reply("Pong!")
            },
        },
    })
}
```

A subscription's own `onError` takes precedence for that subscription. The [reliability guide](/docs/{{version}}/reliability/#report-failures-that-have-no-result) explains which failures produce reports

<details>
<summary>How reports are delivered</summary>

A failure only queues its report, so a slow hook never holds up event handlers.
Reports are delivered one at a time in order. Up to 256 wait while the hook is busy, and later ones are logged instead and counted in `diagnostics().counters.reportsDropped`.
A hook that throws or rejects is logged together with the original failure and is not retried.
Shutdown does not wait for a hook that never finishes, and logs the reports it had not delivered with a note.
The record's `fields.reportOutcome` names why a report was logged instead of delivered: `queueFull`, `interrupted`, `clientClosed` or `subscriptionClosed`

</details>

## Send records to an existing logger

The `sink` option replaces the console output. It receives frozen `LogRecord` objects with a stable `code`, a readable `message` and optional facts such as `shardId`, `route`, `status`, `closeCode` and `error`. Other facts are in `fields`, such as `next` on `lifecycle.retry` and `lifecycle.connectionLost` records, which is `resume` when the next attempt resumes the session and `identify` when it starts a new one. Match on `code` and these facts, because message wording can change between releases

Many loggers have one method per level that takes an object of fields and a message. This sink passes each record to such a logger

```ts
import { createClient, type LogRecord } from "@neontechspace/fluxerly"

/** A logger with one method per level, each taking fields and a message */
interface LevelLogger {
    trace(fields: object, message: string): void
    debug(fields: object, message: string): void
    info(fields: object, message: string): void
    warn(fields: object, message: string): void
    error(fields: object, message: string): void
    fatal(fields: object, message: string): void
}

export function createLevelLoggerClient(token: string, logger: LevelLogger) {
    return createClient({
        token,
        logging: {
            sink: (record: LogRecord) => {
                const { level, message, ...fields } = record
                logger[level](fields, message)
            },
        },
    })
}
```

Other loggers take one entry with the level inside it. This sink passes the whole record and maps `fatal` to `error` for loggers without a fatal level

```ts
import { createClient } from "@neontechspace/fluxerly"

/** A logger with one log method that reads the level from the entry */
interface EntryLogger {
    log(entry: { level: string; message: string; [key: string]: unknown }): void
}

export function createEntryLoggerClient(token: string, logger: EntryLogger) {
    return createClient({
        token,
        logging: {
            sink: (record) => logger.log({ ...record, level: record.level === "fatal" ? "error" : record.level }),
        },
    })
}
```

A sink runs synchronously and its return value is ignored. A sink that throws or returns a rejected Promise is counted in `diagnostics().counters.sinkFailures` and reported once on standard error, and SDK work continues. Pass an array to use several sinks

## Collapse repeated errors

Identical Warn, Error and Fatal records within one minute are printed once. Records about different shards or subscriptions are not identical, so each one's first occurrence is printed. The next identical record after the window says how many were hidden, as in `(repeated 12× since last shown)`, and shutdown prints any remainder. A sink finds that count in `fields.repeated`. Change the window with `dedupe: { windowMs: 10_000 }` or turn collapsing off with `dedupe: false`. Counters in `diagnostics().counters` still include every occurrence

## Count what happened

The `client.diagnostics().counters` object keeps running totals since the client was created: Handler and hook failures, dropped events by reason, rejected gateway messages, unknown dispatches and opcodes, REST retries, rate-limit waits, reconnects, resumes, sink failures, cleanup failures and command rejections

```ts
import type { Client } from "@neontechspace/fluxerly"

export function healthSnapshot(client: Client) {
    const { counters, state } = client.diagnostics()
    return {
        state,
        reconnects: counters.reconnects,
        droppedEvents: counters.eventsDropped.overflow + counters.eventsDropped.malformed,
        handlerFailures: counters.handlerFailures,
    }
}
```

## Debug payloads safely

The setting `unsafe: { payloads: true }` adds Trace records with gateway and REST payload bodies, for all categories or the listed ones. Payloads can contain private message content, so the client prints a Warn banner once, at startup or before the first payload record, even when the level hides warnings. A category set to `silent` prints no payloads, and a received REST body shows at most its first 64 KiB. Tokens, Authorization headers, client secrets, passwords, cookies, invite codes and the user name and password in a URL such as `https://user:password@host/path` stay masked even then, including credential-key values in truncated JSON text. Leave it off in production

```ts
import { createClient } from "@neontechspace/fluxerly"

export function createPayloadDebugClient(token: string) {
    return createClient({ token, logging: { unsafe: { payloads: true, categories: ["gateway"] } } })
}
```

## Use the Effect logger in native programs

A native client, created from the [Effect](/docs/{{version}}/glossary/#effect) entry point `@neontechspace/fluxerly/effect`, sends records through the running program's Effect logger with `Effect.logWithLevel`. Each record carries a `Cause` with the original structure, whose errors are masked copies with credentials removed, and `fluxerly.*` annotations such as `fluxerly.code`, `fluxerly.category` and `fluxerly.shardId`, so any Effect logger, span and tracer applies. A record with an SDK error also carries `fluxerly.error.code`, `fluxerly.error.hint` and one `fluxerly.error.<detail>` annotation per safe detail, such as `fluxerly.error.status`. Each error in its cause chain adds the same annotations with one more `cause.` in the prefix, such as `fluxerly.error.cause.code`, `fluxerly.error.cause.hint` and `fluxerly.error.cause.<detail>`. Native clients accept the same `logging` settings. A `sink` or an explicit `format` replaces the Effect logger with SDK output

```ts
import { Effect, Logger } from "effect"
import { createClient } from "@neontechspace/fluxerly/effect"

export function runNativeBot(token: string, signal: AbortSignal) {
    const program = Effect.scoped(
        Effect.gen(function* () {
            const client = yield* createClient({ token, logging: { categories: { rest: "debug" } } })
            yield* client.run()
        }).pipe(Effect.withLogger(Logger.consoleJson), Effect.annotateLogs("bot", "gateway")),
    )
    return Effect.runPromise(program, { signal })
}
```

Debug and Trace records chosen by the SDK settings bypass the Effect minimum log level, while Info and higher records still respect it

## Export metrics and traces with OpenTelemetry

Pass an `observe` function to the client to receive a measurement each time the SDK finishes a piece of work: A REST request attempt with its method, route template, status and duration, a rate-limit wait, a reconnection attempt, a resumed session, and a handler or command run with its duration and outcome. Each measurement is an `Observation` whose `type` field says which kind it is. Observations never contain tokens, payloads or message content, so they can go to any monitoring system. Both entry points accept the same option

A command router emits one handler observation per message, including event and command middleware in its duration. A matched command supplies its canonical name in `command`, even when a guard denies it or middleware stops it. A reported failure gives `outcome: "failure"` even if middleware recovers, interruption gives `"cancelled"`, and other completions give `"success"`. Messages with no command match still produce an observation without `command`

This example records durations and reconnection attempts with an OpenTelemetry meter. The `Meter` interface lists only the methods the example calls, so the code needs no extra package, and the meter from `metrics.getMeter("bot")` in `@opentelemetry/api` fits it

```ts
import { runBot, type Observation } from "@neontechspace/fluxerly"

type Attributes = Record<string, string | number>

/** The parts of an OpenTelemetry Meter this bot uses */
interface Meter {
    createHistogram(name: string, options?: { unit?: string }): {
        record(value: number, attributes?: Attributes): void
    }
    createCounter(name: string): { add(value: number, attributes?: Attributes): void }
}

export function meterObserver(meter: Meter) {
    const requests = meter.createHistogram("bot.rest.duration", { unit: "ms" })
    const handlers = meter.createHistogram("bot.handler.duration", { unit: "ms" })
    const reconnects = meter.createCounter("bot.gateway.reconnects")
    return (observation: Observation) => {
        if (observation.type === "rest")
            requests.record(observation.durationMs, {
                method: observation.method,
                route: observation.route,
                status: observation.status ?? "none",
            })
        else if (observation.type === "handler")
            handlers.record(observation.durationMs, {
                event: observation.event,
                ...(observation.command === undefined ? {} : { command: observation.command }),
                outcome: observation.outcome,
            })
        else if (observation.type === "reconnect") reconnects.add(1, { shard: observation.shardId })
    }
}

export function runObservedBot(token: string | undefined, meter: Meter) {
    return runBot({ token, observe: meterObserver(meter), events: {} })
}
```

The SDK calls `observe` while it finishes the measured work, so the function should only record values and leave sending them to the exporter. An `observe` function that throws does not change what the bot does, and each throw is counted in `diagnostics().counters.sinkFailures`

In a native program, the SDK also opens spans named `fluxerly.gateway.connect`, `fluxerly.rest.request`, `fluxerly.event.handle` and `fluxerly.command.execute`, and updates the metrics `fluxerly_rest_duration_ms`, `fluxerly_ratelimit_wait_ms`, `fluxerly_gateway_reconnects_total`, `fluxerly_events_dropped_total` and `fluxerly_handler_failures_total`. A command span covers its middleware, guards, argument conversion, cooldown and execution. Command failure metrics use the canonical command name. Without a tracer or metric exporter they cost almost nothing. Provide the Layer from `@effect/opentelemetry`, the Effect value that supplies the exporter, to the native program to export them

```ts
import { Effect, type Layer } from "effect"
import { runBot } from "@neontechspace/fluxerly/effect"

/** Pass the tracing Layer built with @effect/opentelemetry, such as its NodeSdk layer */
export function runTracedBot(token: string | undefined, telemetry: Layer.Layer<never>) {
    return runBot({ token, processSignals: true, events: {} }).pipe(Effect.provide(telemetry))
}
```

Use [`client.diagnostics()`](/docs/{{version}}/api/interfaces/js-ts.Client/#diagnostics) for a current snapshot of connection state, request counts and cache accounting, and the [troubleshooting guide](/docs/{{version}}/troubleshooting/) to match common log lines with fixes
