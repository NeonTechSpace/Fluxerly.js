import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import type { EventSource } from "#sdk/internal/events"
import { EventOverflowError } from "#sdk/message-errors"
import type { EventInvocation, HandlerOptions } from "#sdk/events"
import type { Message, MessageCore } from "#sdk/messages"
import { type FailureReport } from "./failures.js"

/**
 * An event subscription registered in a Scope, independent of the client's connection.
 * Use close to request a stop and waitForClose to wait for handler cleanup
 *
 * @category Events and collectors
 */
export interface Subscription {
    /** Identifier of this subscription, such as messageCreate#3, used in failure reports and log records */
    readonly id: string
    /**
     * Stop new deliveries, drop queued events and stop running handlers, without waiting for the handler that called close
     *
     * @remarks
     * Stops the subscription when the Effect executes and interrupts its handlers
     */
    close(): Effect.Effect<void>
    /**
     * Wait until this subscription has closed and the SDK has released its queue and listeners.
     * Normal closure succeeds with no value, and overflow fails with EventOverflowError, even for a later waiter.
     * Cancelling this wait affects only the waiter, not the subscription or other waiters.
     * Later waits see the same subscription outcome.
     * Do not await this subscription's own closure from inside its handler
     *
     * @remarks
     * Handlers or finalizers that disable interruption can delay completion.
     * Unexpected faults remain in the Cause
     */
    waitForClose(): Effect.Effect<void, EventOverflowError>
}

/** Set event-handler queue limits, concurrency, ordering, overflow policy and an optional failure hook.
 * Reporting uses the services available when the handler is registered.
 * The type parameter T is the event payload that a partition function receives
 *
 * @category Events and collectors
 */
export interface EventHandlerOptions<E = never, R = never, T = unknown> extends HandlerOptions<T> {
    /** Receive this subscription's failures instead of the client-level onError, with the original error and its full Cause
     *
     * A failure only queues its report, so the hook never holds a handler slot. One worker with the services available at
     * registration delivers reports one at a time in order, with up to 64 waiting while the hook is busy. Later ones
     * are logged instead, with fields.reportOutcome "queueFull", and counted in diagnostics().counters.reportsDropped.
     * A failed or defective hook is logged together with the original failure and is never retried.
     * Reports already queued when the subscription closes are still delivered. Client shutdown interrupts a running
     * hook and waits at most one second for its cleanup, then logs the interrupted and queued reports at Error
     * with fields.reportOutcome "interrupted" or "subscriptionClosed". A hook that interrupts itself also logs its report
     * with "interrupted", and later reports still reach the hook
     */
    readonly onError?: (report: FailureReport) => Effect.Effect<unknown, E, R>
}

/**
 * Event middleware for the Effect API, run around every later on handler invocation.
 * It receives the invocation and a next Effect that runs the rest of the chain and the handler.
 * The next Effect completes when the rest of the chain has finished, whether or not it failed, and never fails.
 * Failures after next are reported by the SDK where they occur, so middleware can time or trace a handler but cannot hide its failure.
 * A failed or defective middleware Effect is reported like a handler failure, with its full Cause
 *
 * @category Events and collectors
 */
export type EventMiddleware<M extends MessageCore = Message, E = never, R = never> = (
    invocation: EventInvocation<M>,
    next: Effect.Effect<void>,
) => Effect.Effect<unknown, E, R>

/**
 * Remove event middleware registered with client.use before its registration Scope closes
 *
 * @category Events and collectors
 */
export interface MiddlewareRegistration {
    /** Stop applying the middleware to invocations that start later. Invocations already running keep their chain. Repeated calls do nothing */
    close(): Effect.Effect<void>
}

export function nativeSubscription(source: Pick<EventSource, "stop" | "closed" | "id">): Subscription {
    return Object.freeze({
        id: source.id,
        close: () => Effect.sync(() => source.stop()),
        waitForClose: () => Deferred.await(source.closed),
    })
}
