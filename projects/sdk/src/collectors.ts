import { FluxerlyError, operationDetails } from "./errors.js"
import type { OperationOptions } from "./client.js"
import type { EventBufferOptions } from "./events.js"
import type { ClientClosedError, ConfigurationError } from "./errors.js"
import type { Message, MessageCore } from "./messages.js"
import type { MessageReaction, ReactionEmojiInput } from "./reactions.js"

/** Choose which new messages to collect in one channel and when to stop.
 * Connect the client before registering. Collection does not read history or connect automatically.
 * Only messageCreate observations are collected, using this client's selected message fields.
 * Each accepted message ID is counted once. Later edits and deletions do not revise the result.
 * Reaching the count or a listening deadline can finish successfully. Filter, handler, budget and connection failures return no partial result.
 * For sharded clients, a shard is one gateway connection assigned to a group of communities
 *
 * @category Events and collectors
 */
export interface CollectorOptions<M extends MessageCore = Message> extends EventBufferOptions {
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
}

/** Collection settings for the Promise and Result API, with an optional callback and collection-wide AbortSignal.
 * The Effect entry point instead accepts an Effect handler and owns collection through its registration scope
 *
 * @category Events and collectors
 */
export interface DefaultCollectorOptions<M extends MessageCore = Message> extends CollectorOptions<M> {
    /** Process accepted messages one at a time, after filtering and acceptance into the retained-byte budget.
     * Return the asynchronous work so collection can wait for it. Inspect Result errors in the callback, because they do not throw automatically.
     * A throw or rejected Promise fails collection with CollectorError reason handler, whose cause is the thrown value. The callback is not retried.
     * The failure is also reported to the client-level onError with kind collector and the message IDs, or logged at Error.
     * Terminal completion aborts the callback's signal and waits for its returned Promise, including on stop, timeout and shutdown.
     * Work that ignores the signal can hold completion open indefinitely. Do not await this collector's completion or client shutdown here.
     * Requests already dispatched by the callback are not rolled back
     */
    readonly onMessage?: (message: M, signal: AbortSignal) => unknown
    /** Cancel the entire collection. An already-aborted signal rejects registration, a later abort returns CancelledError without partial messages */
    readonly signal?: OperationOptions["signal"]
}

/** Messages collected before the count, total deadline, idle deadline or explicit stop ended collection.
 * The frozen messages are past observations, not current server state or the complete conversation
 *
 * @category Events and collectors
 */
export interface CollectorResult<M extends MessageCore = Message> {
    /** Accepted snapshots in receive order, with each message ID included once. Later changes do not alter this array */
    readonly messages: readonly M[]
    /** Why collection finished successfully: The count was met, total time expired, idle time expired, or stop was called.
     * The reason limit waits for the final accepted callback. Other reasons can return an empty array or a message whose callback was cancelled
     */
    readonly reason: "limit" | "timeout" | "idle" | "stopped"
}

/** Choose which new reaction additions to collect on one message and when to stop.
 * This listens to single additions and server batches, not existing reactions, removals or current vote totals.
 * Repeated user and emoji pairs count as separate additions. No unique-user count is maintained.
 * Connect before registering. Registration does not fetch the message, check existing reactors or connect automatically.
 * A shard is one gateway connection assigned to a group of communities, and guildId can restrict collection to its owning shard
 *
 * @category Events and collectors
 */
export interface ReactionCollectorOptions extends EventBufferOptions {
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
}

/** Reaction collection settings for the Promise and Result API.
 * The signal cancels the collection, while the signal passed to onReaction controls its active callback
 *
 * @category Events and collectors
 */
export interface DefaultReactionCollectorOptions extends ReactionCollectorOptions {
    /** Process accepted additions sequentially before accepting the next addition.
     * Return asynchronous work so collection can await it. Handle Result errors in the callback.
     * Throws and rejected Promises fail with CollectorError reason handler, whose cause is the thrown value, without retrying the callback.
     * The failure is also reported to the client-level onError with kind collector and the message IDs, or logged at Error.
     * Stop, deadlines, cancellation, recovery and shutdown abort the callback signal and wait for its returned Promise.
     * Ignoring the signal can delay completion indefinitely. Do not await collection completion or client shutdown here.
     * Callback requests already dispatched are not rolled back
     */
    readonly onReaction?: (reaction: MessageReaction, signal: AbortSignal) => unknown
    /** Cancel the whole collection. Already-aborted signals reject registration, later abort returns CancelledError without partial additions */
    readonly signal?: OperationOptions["signal"]
}

/** Successful observations of reaction additions, not a final vote count.
 * Later removals, clears and message deletion do not change this frozen result
 *
 * @category Events and collectors
 */
export interface ReactionCollectorResult {
    /** Additions in receive order, then batch order. Repeated user and emoji pairs appear separately */
    readonly reactions: readonly MessageReaction[]
    /** Successful stop condition: Accepted count, total deadline, idle deadline, or an explicit stop.
     * The reason limit waits for the last callback. Other reasons may return no additions or include an addition whose callback was cancelled
     */
    readonly reason: "limit" | "timeout" | "idle" | "stopped"
}

/** Expected collector failure, separate from results that stop at the count, deadline, idle deadline or explicit stop.
 * Contains no message bodies or partial observations. A filter or callback failure keeps the application's thrown value as cause.
 * A filter or callback failure is also reported to the client-level onError as a filter or collector FailureReport with
 * the message IDs, or logged at Error without a hook. Other failures except connectionLost are logged at Warn in the collectors category.
 * Unexpected defects, including cleanup defects, are not made into this expected failure
 *
 * @category Errors
 */
export class CollectorError extends FluxerlyError {
    /** Literal error tag for identifying CollectorError */
    readonly _tag = "CollectorError"
    /** Describe a collector failure, optionally identifying the budget and capacity that were exceeded.
     * Collector errors are normally received from a collector. Construction does not stop a collector
     */
    constructor(
        /** The reason notConnected means registration lacked a connected gateway scope, connectionLost means that scope later recovered or disconnected.
         * The reason filter or handler means application selection or callback failed, overflow means a retained or pending budget was exceeded
         */
        readonly reason: "notConnected" | "connectionLost" | "filter" | "handler" | "overflow",
        /** Name of the exceeded budget, or null when the failure was not overflow */
        readonly limit: "maxBytes" | "maxPendingMessages" | "maxPendingBytes" | null = null,
        /** Configured budget capacity, measured in queued payloads or UTF-8 JSON bytes, or null for other failures */
        readonly capacity: number | null = null,
        /** Optional underlying failure retained as the error's cause */
        options?: { readonly cause?: unknown },
    ) {
        super(collectorMessage(reason, limit, capacity, options?.cause !== undefined), {
            code: `collector.${reason}`,
            hint: collectorHints[reason],
            cause: options?.cause,
            details: operationDetails({ reason, limit, capacity }),
        })
        this.name = this._tag
    }
}

function collectorMessage(
    reason: CollectorError["reason"],
    limit: CollectorError["limit"],
    capacity: number | null,
    caused: boolean,
): string {
    switch (reason) {
        case "notConnected":
            return "The collector could not start because its gateway connection to Fluxer is not ready"
        case "connectionLost":
            return "The collector stopped because its gateway connection was lost, so events may have been missed"
        case "filter":
            return caused
                ? "The collector filter threw, so the collector stopped. The thrown value is this error's cause"
                : "The collector filter did not return true or false synchronously, so the collector stopped"
        case "handler":
            return "The collector callback failed, so the collector stopped. The failure is this error's cause"
        case "overflow": {
            const bytes = capacity === null ? "its limit" : `${capacity} bytes`
            if (limit === "maxBytes")
                return `The collector stopped because its collected results would exceed ${bytes} (maxBytes)`
            if (limit === "maxPendingMessages")
                return `The collector stopped because more than ${capacity === null ? "the allowed number of events were" : `${capacity} ${capacity === 1 ? "event was" : "events were"}`} waiting to be filtered (maxPendingMessages)`
            return `The collector stopped because events waiting to be filtered exceeded ${bytes}${limit === null ? "" : ` (${limit})`}`
        }
    }
}

const collectorHints: Record<CollectorError["reason"], string> = {
    notConnected: "Start collectors after the client is ready, for example inside an event handler",
    connectionLost: "Start a new collector once the client is connected again",
    filter: "Make the filter return true or false synchronously without throwing",
    handler: "Fix the callback, or handle its failures inside the callback",
    overflow:
        "Raise the limit named in the message, or keep the collector callback short so waiting events are handled sooner",
}

/** Expected terminal failures shared by both API styles.
 * Collection in the default API can additionally return CancelledError. Native interruption remains in the Effect Cause, outside this union
 *
 * @category Errors
 */
export type CollectorFailure = CollectorError | ClientClosedError
/** Expected failures when registering: Invalid settings, an unavailable gateway scope, or a closed client.
 * Registration never makes a network request to repair these conditions
 *
 * @category Errors
 */
export type CollectorRegistrationError = ConfigurationError | CollectorFailure
