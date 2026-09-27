import * as Effect from "effect/Effect"
import type {
    ReactionCollectorOptions as SharedReactionCollectorOptions,
    ReactionCollectorResult,
    CollectorOptions as SharedCollectorOptions,
    CollectorResult,
    CollectorFailure,
} from "#sdk/collectors"
import type { Message, MessageCore } from "#sdk/messages"

/** Choose reaction collection limits and an optional callback for each accepted addition.
 * The callback executes with the services available when collection is registered
 *
 * @category Events and collectors
 */
export interface ReactionCollectorOptions<E = never, R = never> extends SharedReactionCollectorOptions {
    /** Run once per accepted addition, sequentially, before continuing collection.
     * Failures and defects while active fail collection with CollectorError handler, whose cause is the original failure or defect.
     * The failure is also reported to the client-level onError with kind collector, the message IDs and the full Cause, or logged at Error.
     * Stop, timeout, idle completion, scope closure, recovery and shutdown interrupt active work and await its finalizers.
     * Uninterruptible work can delay closure. Do not await this collector's completion inside its handler.
     * Already-dispatched effects are not rolled back. Callbacks are never retried
     */
    readonly onReaction?: (reaction: import("#sdk/reactions").MessageReaction) => Effect.Effect<unknown, E, R>
}

/** Choose message collection limits and an optional callback for each accepted message.
 * The callback executes with the services available when collection is registered
 *
 * @category Events and collectors
 */
export interface CollectorOptions<
    E = never,
    R = never,
    M extends MessageCore = Message,
> extends SharedCollectorOptions<M> {
    /** Run once per accepted message ID, sequentially, after filtering and stored-byte limit checks.
     * Failures and defects while active fail collection with CollectorError handler, whose cause is the original failure or defect.
     * The failure is also reported to the client-level onError with kind collector, the message IDs and the full Cause, or logged at Error.
     * Stop, timeout, idle completion, scope closure, recovery and shutdown interrupt active work and await its finalizers.
     * Uninterruptible work can delay closure. Do not await this collector's completion or client shutdown inside its handler.
     * Already-dispatched effects are not rolled back. Callbacks are never retried
     */
    readonly onMessage?: (message: M) => Effect.Effect<unknown, E, R>
}

/** A running message collector registered in a Scope.
 * Use close to end collection and result to receive its result after cleanup
 *
 * @category Events and collectors
 */
export interface Collector<M extends MessageCore = Message> {
    /**
     * Stop accepting messages now, keeping accepted replies for a successful partial result.
     * Repeated calls preserve whichever terminal outcome was recorded first.
     * Use result to await callback cleanup and read the collection
     *
     * @remarks
     * Stops collection when the Effect executes
     */
    close(): Effect.Effect<void>
    /**
     * Wait for the final frozen collection result after timer, queue, filter, listener and callback cleanup.
     * Idle, timeout or stop can succeed with no messages or a partial collection.
     * Collection cancellation, filter or callback failure, overflow, gateway loss and client closure fail without partial replies.
     * Multiple or later waiters receive the same collection outcome.
     * Cancelling this wait affects only the waiter, not collection.
     * Keeping the handle or successful result keeps its message snapshots in memory
     *
     * @remarks
     * Defects keep their Cause
     */
    result(): Effect.Effect<CollectorResult<M>, CollectorFailure>
}

/** A running reaction collector registered in a Scope.
 * Use close to end collection and result to receive its result after cleanup
 *
 * @category Events and collectors
 */
export interface ReactionCollector {
    /**
     * Stop accepting additions now and keep accepted observations for a successful partial result.
     * Repeated calls preserve the first recorded outcome.
     * Use result to await callback cleanup and read the observations
     *
     * @remarks
     * Stops collection when the Effect executes
     */
    close(): Effect.Effect<void>
    /**
     * Wait for the final frozen reaction result after queue, timer, filter, listener and callback cleanup.
     * Idle, timeout or stop can succeed with empty or partial observations.
     * Collection cancellation, filter or callback failure, overflow, gateway loss and client shutdown fail without partial observations.
     * Multiple or later waiters receive the same outcome.
     * Cancelling this wait affects only the waiter, not collection.
     * Keeping the handle or successful result retains its snapshots in memory
     *
     * @remarks
     * Defects keep their Cause
     */
    result(): Effect.Effect<ReactionCollectorResult, CollectorFailure>
}
