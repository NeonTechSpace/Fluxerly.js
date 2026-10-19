import type { ResultAsync } from "neverthrow"
import type { OperationOptions } from "#sdk/client"
import type { CancelledError, ConfigurationError } from "#sdk/errors"
import type { EventOverflowError, EventReadError } from "#sdk/message-errors"
import type { Message, MessageCore } from "#sdk/messages"
import type { EventInvocation, EventWaitOptions, HandlerOptions, EventMap, EventName } from "#sdk/events"
import type { FailureReport } from "#sdk/failures"

/**
 * Control one event subscription returned by on or subscribe.
 * Closing this subscription leaves the client and its other subscriptions running.
 * Use `await using` to close the subscription and wait for its cleanup when the enclosing block ends
 *
 * @category Events and collectors
 */
export interface Subscription {
    /** Identifier of this subscription, such as messageCreate#3, used in failure reports and log records */
    readonly id: string
    /**
     * Stop new deliveries, drop queued events and stop running handlers, without waiting for the handler that called close.
     * When queued events are dropped, one events.discarded Debug record reports how many, and
     * diagnostics().counters.eventsDropped.closed counts them
     *
     * @remarks
     * Returns immediately and signals running handlers to stop.
     * JavaScript promises that ignore the signal cannot be forcibly stopped
     */
    close(): void
    /**
     * Wait until this subscription has closed and the SDK has released its queue and listeners.
     * Normal closure succeeds with no value, and overflow fails with EventOverflowError, even for a later waiter.
     * Cancelling this wait affects only the waiter, not the subscription or other waiters.
     * Later waits see the same subscription outcome.
     * Do not await this subscription's own closure from inside its handler
     *
     * @remarks
     * This does not wait for arbitrary application promises.
     * Unexpected cleanup failures reject with SdkDefect
     */
    waitForClose(
        options?: OperationOptions,
    ): ResultAsync<void, EventOverflowError | CancelledError | ConfigurationError>
    /**
     * Close this subscription and wait for its cleanup, as `await using` does at the end of a block.
     * An overflow outcome is not rethrown here. Read it from waitForClose when it matters
     */
    [Symbol.asyncDispose](): Promise<void>
}

/**
 * Read future events one at a time with next, then end the subscription with close.
 * Each subscription receives the event type chosen in client.subscribe and keeps no previously delivered history.
 * The default event type is messageCreate
 *
 * @category Events and collectors
 */
export interface EventSubscription<
    K extends EventName = "messageCreate",
    M extends MessageCore = Message,
> extends Subscription {
    /**
     * Wait for the next event, returning Ok(payload), or Ok(null) after normal closure.
     * Only one pending next call is allowed.
     * Another call returns EventReadBusyError.
     * Aborting options.signal cancels this read without closing the subscription.
     * Overflow discards the queue and remains an Err.
     * Unexpected SDK failures reject with SdkDefect
     */
    next(
        options?: OperationOptions,
    ): ResultAsync<EventMap<M>[K] | null, EventReadError | CancelledError | ConfigurationError>
}

/**
 * Configure how client.on schedules handlers and reports their failures.
 * The type parameter T is the event payload that a partition function receives
 *
 * @category Events and collectors
 */
export interface EventHandlerOptions<T = unknown> extends HandlerOptions<T> {
    /**
     * Receive this subscription's failures instead of the client-level onError: A handler that threw or rejected,
     * with the original error and the IDs of the message being handled, or overflow that stopped the subscription.
     * A failure only queues its report, so the hook never holds a handler slot.
     * Reports are delivered one at a time in order, with up to 64 waiting while the hook is busy. Later ones are logged
     * instead, with fields.reportOutcome "queueFull", and counted in diagnostics().counters.reportsDropped.
     * A hook that throws or rejects is logged with the original failure and never retried.
     * Reports already queued when the subscription closes are still delivered.
     * Client shutdown does not wait for a pending hook promise. The report it was handling and any queued ones are logged
     * at Error instead, with fields.reportOutcome "interrupted" for the report being handled and "subscriptionClosed" for
     * queued or later reports
     */
    readonly onError?: (report: FailureReport) => unknown
    /**
     * Hold the events of a partition key until that key is ready, without using a handler slot.
     * Valid only together with partition, otherwise registration throws ConfigurationError.
     * Before the first waiting event of a key starts, the SDK calls this hook with the key.
     * The key's events stay in the queue until the hook settles, while events of other keys keep starting.
     * A held event does not use one of the concurrency slots, but it counts toward maxPendingMessages and maxPendingBytes, so a
     * bot that waits for many keys at once needs a larger maxPendingMessages than the default 256.
     * Held events also count as waiting work for a draining shutdown, so a hook that never settles makes the drain wait
     * until its limit.
     * A hook that returns a value other than a promise or thenable marks the key ready at once, with no extra turn.
     * A returned promise holds the key until it resolves.
     * The SDK remembers that a key is ready only while it has waiting or running events.
     * After the key went idle, its next event calls the hook again, so memory stays bounded by the keys with queued work.
     * Hooks for different keys run at the same time, and every burst of events after an idle period calls the hook again.
     * Keep it a cheap, idempotent check that answers at once when the key is already ready, such as returning an already
     * settled promise.
     * Events without a key share the key "", and the hook receives "".
     * With partition "guild", a direct message has no community, so its key is its channel ID. A hook should treat keys it
     * does not know as ready.
     * A hook that throws, rejects or fails reports every waiting event of that key as a failure of that event's handler,
     * as a throwing partition function does, and those handlers do not run.
     * The key is then forgotten, so a later event calls the hook again.
     * The hook receives a signal that aborts when the subscription stops, which includes unsubscribing, client shutdown and a
     * draining shutdown that reaches its drain limit.
     * An Err result returned or resolved by the hook counts as a failure with its error
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function afterServerSetup(client: Client, setups: Map<string, Promise<void>>) {
     *     // A server whose setup is unknown, such as a direct message channel, is ready at once
     *     return client.on("messageCreate", (message) => void message.content, {
     *         partition: "guild",
     *         partitionReady: (key) => setups.get(key),
     *     })
     * }
     * ```
     */
    readonly partitionReady?: (key: string, signal: AbortSignal) => unknown
}

/**
 * Configure a single client.waitFor call with a filter, limits and optional AbortSignal.
 * The signal cancels this event wait, not the client
 *
 * @category Events and collectors
 */
export interface DefaultEventWaitOptions<K extends EventName, M extends MessageCore = Message>
    extends EventWaitOptions<K, M>, OperationOptions {}

/**
 * Event middleware for the default API, run around each client.on handler invocation that starts after registration.
 * It receives the invocation, a next function that runs the rest of the chain and the handler, and the invocation's cancellation signal.
 * The promise returned by next resolves when the rest of the chain has finished, whether or not it failed, and never rejects.
 * Failures after next are reported by the SDK where they occur, so middleware can time or trace a handler but cannot hide its failure.
 * A middleware fails when it throws, rejects, or returns or resolves an Err result, and that failure is reported like a handler failure
 *
 * @category Events and collectors
 */
export type EventMiddleware<M extends MessageCore = Message> = (
    invocation: EventInvocation<M>,
    next: () => Promise<void>,
    signal: AbortSignal,
) => unknown

/**
 * Remove event middleware registered with client.use.
 * Use `using` to remove it when the enclosing block ends
 *
 * @category Events and collectors
 */
export interface MiddlewareRegistration {
    /** Stop applying the middleware to invocations that start later. Invocations already running keep their chain. Repeated calls do nothing */
    close(): void
    /** Remove the middleware, as `using` does at the end of a block */
    [Symbol.dispose](): void
}

/**
 * Stop receiving connection-state updates from client.observeState.
 * Use `using` to close the observer when the enclosing block ends
 *
 * @category Client and lifecycle
 */
export interface StateObserver {
    /** Stop delivering states and drop a pending one. Listener code already running is not cancelled. Repeated calls do nothing */
    close(): void
    /** Close this observer, as `using` does at the end of a block */
    [Symbol.dispose](): void
}
