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
     * Stop new deliveries, drop queued events and stop running handlers, without waiting for the handler that called close.
     * When queued events are dropped, one events.discarded Debug record reports how many, and
     * diagnostics().counters.eventsDropped.closed counts them
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

/** Set event-handler queue limits, concurrency, ordering, overflow policy, an optional failure hook and an optional partition readiness hook.
 * Reporting and the readiness hook use the services available when the handler is registered.
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
    /**
     * Hold the events of a partition key until that key is ready, without using a handler slot.
     * Valid only together with partition, otherwise registration dies with ConfigurationError.
     * Before the first waiting event of a key starts, the SDK calls this hook with the key.
     * The key's events stay in the queue until the hook's Effect completes, while events of other keys keep starting.
     * A held event does not use one of the concurrency slots, but it counts toward maxPendingMessages and maxPendingBytes, so a
     * bot that waits for many keys at once needs a larger maxPendingMessages than the default 256.
     * Held events also count as waiting work for a draining shutdown, so a hook that never completes makes the drain wait
     * until its limit.
     * The hook returns an Effect, which the SDK runs with the services available when the handler is registered.
     * An Effect that completes without waiting marks the key ready at once, and one that waits holds the key until it completes.
     * The SDK remembers that a key is ready only while it has waiting or running events.
     * After the key went idle, its next event calls the hook again, so memory stays bounded by the keys with queued work.
     * Hooks for different keys run at the same time, and every burst of events after an idle period calls the hook again.
     * Keep it a cheap, idempotent check that answers at once when the key is already ready, such as an Effect that
     * succeeds at once.
     * Events without a key share the key "", and the hook receives "".
     * With partition "guild", a direct message has no community, so its key is its channel ID. A hook should treat keys it
     * does not know as ready.
     * A hook that fails or dies reports every waiting event of that key as a failure of that event's handler,
     * as a throwing partition function does, and those handlers do not run.
     * The key is then forgotten, so a later event calls the hook again.
     * The hook is interrupted when the subscription stops, which includes closing it, client shutdown and a draining
     * shutdown that reaches its drain limit
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function afterServerSetup(client: Client, setups: Map<string, Effect.Effect<void>>) {
     *     // A server whose setup is unknown, such as a direct message channel, is ready at once
     *     return client.on("messageCreate", (message) => Effect.sync(() => void message.content), {
     *         partition: "guild",
     *         partitionReady: (key) => setups.get(key) ?? Effect.void,
     *     })
     * }
     * ```
     */
    readonly partitionReady?: (key: string) => Effect.Effect<unknown, E, R>
}

/**
 * Event middleware for the Effect API, run around each client.on handler invocation that starts after registration.
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
