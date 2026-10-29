import * as Effect from "effect/Effect"
import type { ReactionCollectorResult, CollectorResult, CollectorFailure } from "#sdk/collectors"
import type { EventBufferOptions } from "#sdk/events"
import type { Message, MessageCore } from "#sdk/messages"
import type { MessageReaction, ReactionEmojiInput } from "#sdk/reactions"

/** Choose which new reaction additions to collect on one message and when to stop.
 * This listens to single additions and server batches, not existing reactions, removals or current vote totals.
 * Repeated user and emoji pairs count as separate additions. No unique-user count is maintained.
 * Connect before registering. Registration does not fetch the message, check existing reactors or connect automatically.
 * A shard is one gateway connection assigned to a group of communities, and guildId can restrict collection to its owning shard
 *
 * The onReaction callback executes with the services available when collection is registered
 *
 * @category Events and collectors
 */
export interface ReactionCollectorOptions<E = never, R = never> extends EventBufferOptions {
    /**
     * Community that owns the target channel, as a positive decimal ID within the unsigned 64-bit range.
     * The caller must supply the correct community, because no channel lookup verifies it.
     * Its assigned gateway shard must be connected. Recovery of that shard ends collection, while unrelated shard recovery does not.
     * Events with a different supplied guildId are discarded. Missing community context does not prove private scope.
     * Omit for private or unknown scope, requiring a connected whole gateway and ending collection on any shard recovery
     */
    readonly guildId?: string
    /** Collect only this emoji, or omit to accept any emoji.
     * Use any ReactionEmojiInput, including Unicode, custom markup and parsed or received emoji. The SDK normalizes and copies it at registration.
     * Unicode text must match exactly, including skin tone and variation selectors. Custom emoji match by ID even after renaming.
     * A custom input still needs a valid name. Invalid input fails registration with ConfigurationError field emoji, without a request.
     * Matching runs before filter and onReaction, but after the event enters the queue, so other emoji can still fill the pending queue
     */
    readonly emoji?: ReactionEmojiInput
    /** Stop successfully after this many accepted additions and their callbacks. Repeated pairs count, positive safe integer, default 1 */
    readonly maxReactions?: number
    /** Stop successfully after this many milliseconds from registration. Activity does not extend it, integer 1 through 2,147,483,647, default 30,000 */
    readonly timeoutMs?: number
    /**
     * Stop successfully after this many milliseconds without an accepted addition. Omit to disable.
     * Integer 1 through 2,147,483,647. Starts at registration and resets before each accepted addition's callback.
     * Excluded emoji, rejected additions and unprocessed queue or batch entries do not reset it. Callback time counts as idle time.
     * Repeated pairs reset the interval when accepted. The earlier idle or total deadline wins, with timeout winning ties
     */
    readonly idleMs?: number
    /** Maximum UTF-8 JSON bytes kept for accepted MessageReaction values. Positive safe integer, default 4,194,304, not a total memory limit */
    readonly maxBytes?: number
    /**
     * Return true to accept an addition, or false to skip it. Runs after target and optional emoji matching.
     * With both emoji and filter supplied, both must match. Omission accepts every addition passing the emoji selector.
     * Runs synchronously in receive order, then batch order. A throw or non-boolean return fails only this collector with reason filter,
     * and is reported to the client-level onError with kind filter and the message IDs, or logged at Error.
     * Do not return a Promise. Mistaken asynchronous work is not awaited or cancelled, and its rejection is discarded.
     * Slow code blocks JavaScript. Deadlines are checked after the filter returns
     */
    readonly filter?: (reaction: MessageReaction) => boolean
    /** Run once per accepted addition, sequentially, before continuing collection.
     * Failures and defects while active fail collection with CollectorError handler, whose cause is the original failure or defect.
     * The failure is also reported to the client-level onError with kind collector, the message IDs and the full Cause, or logged at Error.
     * Stop, timeout, idle completion, scope closure, recovery and shutdown interrupt active work and await its finalizers.
     * Uninterruptible work can delay closure. Do not await this collector's completion inside its handler.
     * Already-dispatched effects are not rolled back. Callbacks are never retried
     */
    readonly onReaction?: (reaction: MessageReaction) => Effect.Effect<unknown, E, R>
}

/** Choose which new messages to collect in one channel and when to stop.
 * Connect the client before registering. Collection does not read history or connect automatically.
 * Only messageCreate observations are collected, using this client's selected message fields.
 * Each accepted message ID is counted once. Later edits and deletions do not revise the result.
 * Reaching the count or a listening deadline can finish successfully. Filter, handler, budget and connection failures return no partial result.
 * For sharded clients, a shard is one gateway connection assigned to a group of communities
 *
 * The onMessage callback executes with the services available when collection is registered
 *
 * @category Events and collectors
 */
export interface CollectorOptions<E = never, R = never, M extends MessageCore = Message> extends EventBufferOptions {
    /**
     * Community that owns this channel, as a positive decimal ID within the unsigned 64-bit range.
     * The caller must supply the correct community, because the SDK does not fetch the channel to verify membership.
     * Its assigned gateway shard must be connected. Recovery of that shard ends collection, while unrelated shards do not.
     * Events with a different supplied guildId are discarded. Missing community context does not prove the channel is private.
     * Omit this option for unknown or private scope. Then the whole gateway must be connected and any shard recovery ends collection
     */
    readonly guildId?: string
    /** Stop successfully after this many accepted messages and their callbacks. Positive safe integer, default 1 */
    readonly maxMessages?: number
    /** Stop successfully after this many milliseconds from registration, regardless of activity. Integer 1 through 2,147,483,647, default 30,000 */
    readonly timeoutMs?: number
    /**
     * Stop successfully after this many milliseconds without an accepted message. Omit to disable this deadline.
     * Integer 1 through 2,147,483,647. The interval starts at registration and resets before each accepted message's callback.
     * Rejected messages, duplicate IDs and messages still queued do not reset it. Callback time counts as idle time.
     * The earlier idle or total deadline wins. Equal deadlines produce reason timeout
     */
    readonly idleMs?: number
    /** Maximum UTF-8 JSON bytes kept for accepted messages. Positive safe integer, default 4,194,304, not a total memory limit */
    readonly maxBytes?: number
    /**
     * Return true to accept a message, or false to skip it. Omit to accept all messages in the channel, including bots.
     * Runs synchronously in receive order, after channel selection. Do not return a Promise or perform blocking work.
     * Throwing or returning anything except a boolean fails this collector with reason filter. A thrown value is the CollectorError cause.
     * The failure is also reported to the client-level onError with kind filter and the message IDs, or logged at Error.
     * Asynchronous work returned by mistake is neither awaited nor cancelled, and its rejection is discarded.
     * A slow filter blocks other JavaScript work. The collector checks its deadlines again after the filter returns
     */
    readonly filter?: (message: M) => boolean
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
     * Stop accepting messages now, keeping accepted messages for a successful partial result.
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
     * Collection cancellation, filter or callback failure, overflow, gateway loss and client closure fail without partial messages.
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
