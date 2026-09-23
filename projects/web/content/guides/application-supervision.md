---
title: Supervise a critical bot worker
navTitle: Application supervision
description: Keep gateway and worker health separate, then choose a fail or restart policy
---

A connected bot can still have a stopped event subscription. A failed handler does not stop later events, but a full subscription queue closes that subscription. Check both the connection and any subscription the bot needs to keep running

## Watch the connection and subscription

This example stops the bot if its `messageCreate` subscription stops. Health reports contain error types and counts, never event bodies or raw exceptions

```ts
import {
    createClient,
    type ClientDiagnostics,
    type ConnectionState,
} from "@neontechspace/fluxerly";

export interface BotHealth {
    readonly gateway: ConnectionState;
    readonly criticalWorker: "starting" | "running" | "failed" | "stopped";
    readonly handlerFailures: number;
}

export type SupervisedOutcome =
    | { readonly kind: "stopped" }
    | { readonly kind: "connection-failed"; readonly failure: string }
    | { readonly kind: "critical-worker-failed"; readonly failure: string };

export async function runSupervisedBot(
    token: string,
    signal: AbortSignal,
    reportHealth: (health: BotHealth, diagnostics: ClientDiagnostics) => void,
): Promise<SupervisedOutcome> {
    const created = createClient({ token });
    if (created.isErr()) throw created.error;
    const client = created.value;
    let criticalWorker: BotHealth["criticalWorker"] = "starting";
    let handlerFailures = 0;
    const lifetimes: PromiseLike<unknown>[] = [];
    let outcome: SupervisedOutcome | undefined;
    let primaryFailure: unknown;
    let hasPrimaryFailure = false;
    const localStop = new AbortController();

    const report = () =>
        reportHealth(
            { gateway: client.state, criticalWorker, handlerFailures },
            client.diagnostics(),
        );

    try {
        const registered = client.on(
            "messageCreate",
            async (message, handlerSignal) => {
                if (message.author.isBot || message.content !== "!ping") return;
                const reply = await client.messages.reply(
                    message,
                    { content: "Pong!" },
                    { signal: handlerSignal },
                );
                if (reply.isErr())
                    console.warn("Reply failed", { kind: reply.error._tag });
            },
            {
                maxPendingMessages: 64,
                onError: (failure) => {
                    if (failure.kind === "handler") handlerFailures += 1;
                    if (failure.kind === "overflow") criticalWorker = "failed";
                    report();
                },
            },
        );
        if (registered.isErr()) throw registered.error;

        criticalWorker = "running";
        report();
        const lifetime = AbortSignal.any([signal, localStop.signal]);
        const connection = client.run({ signal: lifetime });
        const observeConnection = new Promise<{
            readonly source: "connection";
            readonly result: Awaited<typeof connection>;
        }>(
            (resolve, reject) =>
                void connection.then(
                    (result) => resolve({ source: "connection", result }),
                    reject,
                ),
        );
        lifetimes.push(observeConnection);
        const worker = registered.value.waitForClose({ signal: lifetime });
        const observeWorker = new Promise<{
            readonly source: "worker";
            readonly result: Awaited<typeof worker>;
        }>(
            (resolve, reject) =>
                void worker.then(
                    (result) => resolve({ source: "worker", result }),
                    reject,
                ),
        );
        lifetimes.push(observeWorker);

        const first = await Promise.race([observeConnection, observeWorker]);
        const unexpectedWorkerStop =
            first.source === "worker" &&
            first.result.isOk() &&
            !signal.aborted &&
            client.state !== "Closing" &&
            client.state !== "Closed";
        if (
            first.source === "worker" &&
            first.result.isErr() &&
            first.result.error._tag === "EventOverflowError"
        ) {
            criticalWorker = "failed";
        }
        localStop.abort();

        const [connectionResult, workerResult] = await Promise.all([
            connection,
            worker,
        ]);
        if (criticalWorker === "failed" || unexpectedWorkerStop) {
            criticalWorker = "failed";
            report();
            outcome = {
                kind: "critical-worker-failed",
                failure: unexpectedWorkerStop
                    ? "CriticalWorkerStopped"
                    : "EventOverflowError",
            };
        } else {
            criticalWorker = "stopped";
            report();
            if (
                connectionResult.isErr() &&
                connectionResult.error._tag !== "CancelledError"
            ) {
                outcome = {
                    kind: "connection-failed",
                    failure: connectionResult.error._tag,
                };
            } else if (
                workerResult.isErr() &&
                workerResult.error._tag !== "CancelledError"
            ) {
                outcome = {
                    kind: "critical-worker-failed",
                    failure: workerResult.error._tag,
                };
            } else {
                outcome = { kind: "stopped" };
            }
        }
    } catch (failure) {
        primaryFailure = failure;
        hasPrimaryFailure = true;
    } finally {
        localStop.abort();
        const settled = await Promise.allSettled(lifetimes);
        const rejected = settled.flatMap((result) =>
            result.status === "rejected" &&
            (!hasPrimaryFailure || result.reason !== primaryFailure)
                ? [result.reason]
                : [],
        );
        try {
            await client.shutdown();
        } catch (failure) {
            rejected.push(failure);
        }
        if (hasPrimaryFailure && rejected.length > 0) {
            primaryFailure = new AggregateError(
                [primaryFailure, ...rejected],
                "Bot failed and cleanup also failed",
            );
        } else if (!hasPrimaryFailure && rejected.length === 1) {
            primaryFailure = rejected[0];
            hasPrimaryFailure = true;
        } else if (!hasPrimaryFailure && rejected.length > 1) {
            primaryFailure = new AggregateError(rejected, "Bot cleanup failed");
            hasPrimaryFailure = true;
        }
    }
    if (hasPrimaryFailure) throw primaryFailure;
    return outcome!;
}
```

The health callback can feed a readiness endpoint or process supervisor. `diagnostics.state` describes gateway state, request pressure and local queues. It does not establish that a critical worker is alive, so the separate worker state remains necessary

`onError` counts an isolated handler failure while the subscription continues. Overflow changes the worker state to failed and `waitForClose` retains `EventOverflowError`. The example then aborts `client.run()` and waits for the connection, worker and final cleanup

## Choose the application policy

If a process manager runs the bot, exit with a failure status after `critical-worker-failed` so it can start a new process. To restart within the same process, call `runSupervisedBot` again with a new client and a limit on restart attempts

A restart subscribes only to future events. It does not rerun the failed handler or recover events missed while the subscription was stopped. For work that must survive a restart, the application needs a durable queue, rules to prevent duplicate work and a way to check what already completed

Noncritical subscriptions can keep their existing isolated-failure policy. Their handler failure does not close this critical subscription or the client. If a noncritical worker must affect readiness, supervise its `waitForClose()` explicitly too

## Limit subscriptions created while the bot runs

Each SDK subscription and collector limits its own queue. These limits do not cap how many subscriptions, stored event payloads or active handlers the client can have in total

Keep a reviewed list of workers registered at startup. If the application creates workers dynamically, route every such creation through one application-owned budget. Reserve capacity before registration and release it only after registration fails or the worker's `waitForClose()` and required cleanup finish. A wrapper cannot enforce the budget if other code can register directly, so restrict direct client access to code that applies the same budget

The `diagnostics.events` snapshot reports this client's open event sources, message collectors, reaction collectors and currently executing subscription callbacks. Use those payload-free counters to monitor usage and alert near the budget's limits. They are not enforced caps, process-memory measurements or counts of collector filters and arbitrary application tasks. The application's reservations determine whether another worker can register

Default handlers receive an `AbortSignal`, but the application must still track its own Promises, even when they respond to cancellation. Closing a subscription or client does not wait for those Promises to finish. Returning a Promise lets the SDK wait for that handler's work and report its failure while events are being handled, but does not make shutdown wait for that work

Collector progress callbacks behave differently: Their completion waits for the returned callback work. Native Effect handlers use interruption and awaited scoped finalizers, as shown in the [Effect application testing guide](/docs/{{version}}/effect-application-testing/)

## Drain application-owned work

When an external operation must finish before process exit, retain its Promise in an application-owned set. Remove it on either settlement path without creating an unobserved rejected Promise. Stop intake first, then inspect the outcomes of the retained work

```ts
import type { Client, Message, OperationSignal } from "@neontechspace/fluxerly";

export function installTrackedHandler(
    client: Client,
    handle: (message: Message, signal: OperationSignal) => Promise<void>,
) {
    const active = new Set<Promise<void>>();
    const registered = client.on("messageCreate", (message, signal) => {
        const work = Promise.resolve().then(() => handle(message, signal));
        active.add(work);
        void work.then(() => active.delete(work), () => active.delete(work));
        return work;
    });
    if (registered.isErr()) throw registered.error;

    return {
        subscription: registered.value,
        async stopAndDrain() {
            registered.value.unsubscribe();
            const failures: unknown[] = [];
            try {
                const closed = await registered.value.waitForClose();
                if (closed.isErr()) failures.push(closed.error);
            } catch (failure) {
                failures.push(failure);
            }
            const pending = await Promise.allSettled([...active]);
            for (const result of pending) {
                if (result.status === "rejected") failures.push(result.reason);
            }
            if (failures.length) throw new AggregateError(failures, "Application work failed during drain");
        },
    };
}
```

The application calls `stopAndDrain()` outside the tracked handler to avoid joining itself. The returned function drains work still active after intake stops, not a history of earlier failures. The ordinary handler-error hook remains responsible for earlier failures

An operation that ignores cancellation can keep this drain pending. A chosen application deadline bounds waiting only if the underlying service also has a supported cancellation or recovery policy. A timeout alone cannot prove that an external write stopped or was rolled back
