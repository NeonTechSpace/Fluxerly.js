---
title: Supervise a critical bot worker
navTitle: Application supervision
description: Keep gateway and worker health separate, then choose a fail or restart policy
---

A connected gateway does not prove that every event subscription is still working. Handler failures are isolated so later events can continue, while a full subscription queue closes only that subscription. Application health therefore needs both the client state and the critical worker state

## Run the client and critical worker together

This recipe treats a stopped `messageCreate` subscription as an application failure. It reports only typed failure kinds and counts, never event bodies or raw exceptions

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

The health callback can feed a readiness endpoint or process supervisor. `diagnostics.state` describes gateway lifetime, request pressure and local queues. It does not establish that a critical worker is alive, so the separate worker state remains necessary

`onError` counts an isolated handler failure while the subscription continues. Overflow changes the worker state to failed and `waitForClose` retains `EventOverflowError`. The recipe then aborts `client.run()` and awaits both lifetimes and final cleanup

## Choose the application policy

For a process-managed bot, return a failing exit status after `critical-worker-failed` and let the process manager create a fresh application. For an in-process restart policy, call `runSupervisedBot` again with a newly created client and an explicit bounded restart budget

A restart begins a new subscription from that point forward. It does not replay the failed handler invocation or events missed while no subscription was active. Durable jobs need an application-owned queue, idempotency rules and reconciliation rather than automatic event-handler replay

Noncritical subscriptions can keep their existing isolated-failure policy. Their handler failure does not close this critical subscription or the client. If a noncritical worker must affect readiness, supervise its `waitForClose()` explicitly too

## Bound dynamic worker admission

Each SDK subscription and collector has its own queue limits. Those limits are not a client-wide cap on the number of registrations, retained payloads or active handlers

Keep fixed startup workers in one reviewed inventory. If the application creates workers dynamically, route every such creation through one application-owned budget. Reserve capacity before registration and release it only after registration fails or the worker's `waitForClose()` and required cleanup finish. A wrapper cannot enforce the budget when other code can register directly, so keep raw client access behind the same application boundary

The `diagnostics.events` snapshot reports this client's open event sources, message collectors, reaction collectors and currently executing subscription callbacks. Use those payload-free counters to observe the policy and alert near its limits. They are not enforced caps, process-memory measurements or counts of collector filters and arbitrary application tasks. The application-owned reservation remains the admission authority

Default handlers receive an `AbortSignal`, but ordinary callback Promises remain application-owned even when they cooperate with cancellation. Subscription closure and client shutdown do not wait for their eventual settlement. Returning and awaiting work preserves handler sequencing and failure reporting, not a drain guarantee

Collector progress callbacks have a different ownership contract: Their completion waits for the returned callback work. Native Effect handlers use interruption and awaited scoped finalizers, as shown in the [Effect application testing recipe](/docs/{{version}}/effect-application-testing/)

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
