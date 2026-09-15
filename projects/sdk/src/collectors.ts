import type { OperationOptions } from "./client.js"
import type { EventBufferOptions } from "./events.js"
import type { ClientClosedError, ConfigurationError } from "./errors.js"
import type { Message, MessageCore } from "./messages.js"
import type { MessageReaction, ReactionEmojiInput } from "./reactions.js"

/** Choose which future messages to collect in one channel and when to stop.
 * Connect the client before registering. Collection does not read history or connect automatically.
 * Only messageCreate observations are collected, using this client's selected message fields.
 * Each accepted message ID is counted once. Later edits and deletions do not revise the result.
 * Count and listening deadlines can finish successfully. Filter, handler, budget and connection failures return no partial result.
 * For sharded clients, a shard is one gateway connection assigned to a group of servers
 */
export interface CollectorOptions<M extends MessageCore = Message> extends EventBufferOptions {
    /**
     * Server owning this channel, as a positive decimal ID within the unsigned 64-bit range.
     * Supply the correct server yourself. The SDK does not fetch the channel to verify membership.
     * Its assigned gateway shard must be connected. Recovery of that shard ends collection, while unrelated shards do not.
     * Events with a different supplied guildId are discarded. Missing guild context does not prove the channel is private.
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
    /** Maximum UTF-8 bytes of JSON for accepted message snapshots. Positive safe integer, default 4,194,304, not a total memory cap */
    readonly maxBytes?: number
    /**
     * Return true to accept a message, or false to skip it. Omit to accept all messages in the channel, including bots.
     * Runs synchronously in receive order, after channel selection. Do not return a Promise or perform blocking work.
     * Throwing or returning anything except a boolean fails this collector with reason filter, without exposing your error.
     * Asynchronous work returned by mistake is neither awaited nor cancelled, and its rejection is discarded.
     * A slow filter blocks JavaScript. The collector checks its deadlines again after the filter returns
     */
    readonly filter?: (message: M) => boolean
}

/** Collection settings for the Promise and Result API, with an optional callback and collection-wide AbortSignal.
 * The Effect entry point instead accepts an Effect handler and owns collection through its registration scope
 */
export interface DefaultCollectorOptions<M extends MessageCore = Message> extends CollectorOptions<M> {
    /** Process accepted messages one at a time, after filtering and acceptance into the retained-byte budget.
     * Return your asynchronous work so collection can wait for it. Inspect Result errors yourself, they do not throw automatically.
     * A throw or rejected Promise fails collection with CollectorError reason handler. The callback is not retried.
     * Terminal completion aborts the callback's signal and waits for its returned Promise, including on stop, timeout and shutdown.
     * Work that ignores the signal can hold completion open indefinitely. Do not await this collector's completion or client shutdown here.
     * Requests already dispatched by your callback are not rolled back
     */
    readonly onMessage?: (message: M, signal: NonNullable<OperationOptions["signal"]>) => void | Promise<void>
    /** Cancel the entire collection. An already-aborted signal rejects registration, a later abort returns CancelledError without partial messages */
    readonly signal?: OperationOptions["signal"]
}

/** Successful collection result, including early timeout, idle expiry or explicit stop.
 * The frozen messages are past observations, not current server state or the complete conversation
 */
export interface CollectorResult<M extends MessageCore = Message> {
    /** Accepted snapshots in receive order, with each message ID included once. Later changes do not alter this array */
    readonly messages: readonly M[]
    /** Why collection finished successfully: The count was met, total time expired, idle time expired, or stop was called.
     * limit waits for the final accepted callback. Other reasons can return an empty array or a message whose callback was cancelled
     */
    readonly reason: "limit" | "timeout" | "idle" | "stopped"
}

/** Choose which future reaction additions to collect on one message and when to stop.
 * This listens to single additions and server batches, not existing reactions, removals or current vote totals.
 * Repeated user and emoji pairs count as separate additions. No unique-user count is maintained.
 * Connect before registering. Registration does not fetch the message, check existing reactors or connect automatically.
 * A shard is one gateway connection assigned to a group of servers, and guildId can restrict collection to its owning shard
 */
export interface ReactionCollectorOptions extends EventBufferOptions {
    /**
     * Server owning the target channel, as a positive decimal ID within the unsigned 64-bit range.
     * Supply the correct server yourself. No channel lookup verifies it.
     * Its assigned gateway shard must be connected. Recovery of that shard ends collection, while unrelated shard recovery does not.
     * Events with a different supplied guildId are discarded. Missing guild context does not prove private scope.
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
    /** Maximum UTF-8 JSON bytes of accepted MessageReaction observations. Positive safe integer, default 4,194,304, not a total memory cap */
    readonly maxBytes?: number
    /**
     * Return true to accept an addition, or false to skip it. Runs after target and optional emoji matching.
     * With both emoji and filter supplied, both must match. Omission accepts every addition passing the emoji selector.
     * Runs synchronously in receive order, then batch order. A throw or non-boolean return fails only this collector with reason filter.
     * Do not return a Promise. Mistaken asynchronous work is not awaited or cancelled, and its rejection is discarded.
     * Slow code blocks JavaScript. Deadlines are checked after the filter returns
     */
    readonly filter?: (reaction: MessageReaction) => boolean
}

/** Reaction collection settings for the Promise and Result API.
 * signal cancels the collection, while the signal passed to onReaction controls its active callback
 */
export interface DefaultReactionCollectorOptions extends ReactionCollectorOptions {
    /** Process accepted additions sequentially before accepting the next addition.
     * Return asynchronous work so collection can await it. Handle Result errors yourself.
     * Throws and rejected Promises fail with CollectorError reason handler, without retrying the callback.
     * Stop, deadlines, cancellation, recovery and shutdown abort the callback signal and wait for its returned Promise.
     * Ignoring the signal can delay completion indefinitely. Do not await collection completion or client shutdown here.
     * Callback requests already dispatched are not rolled back
     */
    readonly onReaction?: (
        reaction: MessageReaction,
        signal: NonNullable<OperationOptions["signal"]>,
    ) => void | Promise<void>
    /** Cancel the whole collection. Already-aborted signals reject registration, later abort returns CancelledError without partial additions */
    readonly signal?: OperationOptions["signal"]
}

/** Successful observations of reaction additions, not a final vote count.
 * Later removals, clears and message deletion do not change this frozen result
 */
export interface ReactionCollectorResult {
    /** Additions in receive order, then batch order. Repeated user and emoji pairs appear separately */
    readonly reactions: readonly MessageReaction[]
    /** Successful stop condition: Accepted count, total deadline, idle deadline, or an explicit stop.
     * limit waits for the last callback. Other reasons may return no additions or include an addition whose callback was cancelled
     */
    readonly reason: "limit" | "timeout" | "idle" | "stopped"
}

/** Expected collector failure, separate from successful count, timeout, idle and stopped results.
 * Contains no message bodies, partial observations or original filter and callback errors.
 * Unexpected defects, including cleanup defects, are not made into this expected failure
 */
export class CollectorError extends Error {
    /** Literal error tag for identifying CollectorError */
    readonly _tag = "CollectorError"
    /** Describe a collector failure, optionally identifying the budget and capacity that were exceeded.
     * Collector errors are normally received from a collector. Construction does not stop a collector
     */
    constructor(
        /** notConnected means registration lacked a connected gateway scope, connectionLost means that scope later recovered or disconnected.
         * filter or handler means application selection or callback failed, overflow means a retained or pending budget was exceeded
         */
        readonly reason: "notConnected" | "connectionLost" | "filter" | "handler" | "overflow",
        /** Name of the exceeded budget, or null when the failure was not overflow */
        readonly limit: "maxBytes" | "maxPendingMessages" | "maxPendingBytes" | null = null,
        /** Configured budget capacity, measured in queued payloads or UTF-8 JSON bytes, or null for other failures */
        readonly capacity: number | null = null,
    ) {
        super(`Collector failed (${reason})`)
        this.name = this._tag
    }
}

/** Expected terminal failures shared by both API styles.
 * Collection in the default API can additionally return CancelledError. Native interruption remains in the Effect Cause, outside this union
 */
export type CollectorFailure = CollectorError | ClientClosedError
/** Expected failures when registering: Invalid settings, an unavailable gateway scope, or a closed client.
 * Registration never makes a network request to repair these conditions
 */
export type CollectorRegistrationError = ConfigurationError | CollectorFailure
