import type { OperationOptions } from "./client.js"
import type { EventBufferOptions } from "./events.js"
import type { ClientClosedError, ConfigurationError } from "./errors.js"
import type { Message } from "./messages.js"
import type { MessageReaction, ReactionEmojiInput } from "./reactions.js"

/** Settings for one bounded, future-message collection in one channel. No history or automatic connection */
export interface CollectorOptions extends EventBufferOptions {
    /** Accepted message count that completes successfully. Positive safe integer, default 1 */
    readonly maxMessages?: number
    /** Total listening lifetime in milliseconds, not renewed by replies. Integer 1 through 2,147,483,647, default 30,000 */
    readonly timeoutMs?: number
    /** Retained canonical Message JSON budget in UTF-8 bytes. Positive safe integer, default 4,194,304, not a heap cap */
    readonly maxBytes?: number
    /**
     * Synchronous selection after channel admission, in receive order. Omission accepts bots too.
     * Throwing or returning a non-boolean fails only this collector, without exposing the original error.
     * No async/database checks or retries. Slow code blocks JavaScript. Deadlines are checked again after return
     */
    readonly filter?: (message: Message) => boolean
}

/** Default collection settings. The signal controls the collection, not just one observer */
export interface DefaultCollectorOptions extends CollectorOptions {
    /** Run once per accepted message ID, sequentially, after filtering and retained-byte admission.
     * Return/await work and inspect Result errors yourself. Throws/rejections fail with CollectorError handler.
     * Stop, timeout, cancellation, recovery and shutdown abort the signal and await the returned promise.
     * Ignoring cancellation can delay completion indefinitely. Do not await this collector's completion or client shutdown here.
     * Already-dispatched effects are not rolled back. Callbacks are never retried
     */
    readonly onMessage?: (message: Message, signal: NonNullable<OperationOptions["signal"]>) => void | Promise<void>
    /** Already-aborted signals reject registration. Later abort fails collection with CancelledError, without partial replies */
    readonly signal?: OperationOptions["signal"]
}

/** Frozen successful observations, not current server state or a complete conversation */
export interface CollectorResult {
    /** Frozen snapshots in receive order, counting accepted IDs once. Later edits/deletions do not change them */
    readonly messages: readonly Message[]
    /** Limit meets the requested count after callback completion. Timeout/stopped may be empty or include a message whose callback was cancelled */
    readonly reason: "limit" | "timeout" | "stopped"
}

/** Future addition observations for one message, not existing reactors or current vote totals */
export interface ReactionCollectorOptions extends EventBufferOptions {
    /** Select one emoji before filter and onReaction; omission permits any emoji.
     * Uses addReaction's literal Unicode or { name, id } input, copied at registration.
     * Unicode matches exact text with no custom ID, without variation-selector or skin-tone normalization.
     * Custom emoji match by ID only, even after a rename; the input still requires a valid name.
     * Selection follows pending-queue admission, so unrelated emoji can still consume pending capacity.
     * No remote existence check or request. Invalid input fails registration with ConfigurationError field emoji
     */
    readonly emoji?: ReactionEmojiInput
    /** Accepted addition count, including repeated user/emoji pairs. Positive safe integer, default 1 */
    readonly maxReactions?: number
    /** Total registration lifetime in milliseconds, never renewed. Integer 1 through 2,147,483,647, default 30,000 */
    readonly timeoutMs?: number
    /** Retained canonical MessageReaction JSON budget in UTF-8 bytes. Positive safe integer, default 4,194,304, not a heap cap */
    readonly maxBytes?: number
    /**
     * Synchronous selection after message admission and optional emoji matching, in receive and batch order.
     * Omission accepts any addition passing the emoji selector; when both are provided, both must match.
     * Throwing or returning a non-boolean fails only this collector without exposing the original error.
     * No async checks or retries. Slow filters block JavaScript; the deadline is checked again after return
     */
    readonly filter?: (reaction: MessageReaction) => boolean
}

/** Default reaction collection settings, with collection-level cancellation */
export interface DefaultReactionCollectorOptions extends ReactionCollectorOptions {
    /** Run once per accepted addition, sequentially, before continuing collection.
     * Return/await work and inspect Result errors yourself. Throws/rejections fail with CollectorError handler.
     * Stop, timeout, cancellation, recovery and shutdown abort the signal and await the returned promise.
     * Ignoring cancellation can delay completion indefinitely. Do not await this collector's completion or client shutdown here.
     * Already-dispatched effects are not rolled back; callbacks are never retried
     */
    readonly onReaction?: (
        reaction: MessageReaction,
        signal: NonNullable<OperationOptions["signal"]>,
    ) => void | Promise<void>
    /** Already-aborted signals reject registration. Later abort returns CancelledError without partial observations */
    readonly signal?: OperationOptions["signal"]
}

/** Frozen addition observations, unaffected by later removals, clears or message deletion */
export interface ReactionCollectorResult {
    /** Receive order, then batch order. Repeated user/emoji pairs count separately; this is not a unique-reactor list */
    readonly reactions: readonly MessageReaction[]
    /** Limit meets the accepted count; timeout and stopped may return partial or empty observations */
    readonly reason: "limit" | "timeout" | "stopped"
}

/** Identifiable collector failure with no message bodies, partial results or original filter/handler errors */
export class CollectorError extends Error {
    /** Stable discriminator for collector-local failures */
    readonly _tag = "CollectorError"
    constructor(
        /** Registration requires Connected. Any later recovery ends collection. Filter and budget failures are permanent */
        readonly reason: "notConnected" | "connectionLost" | "filter" | "handler" | "overflow",
        /** Exceeded budget, or null for a non-budget failure */
        readonly limit: "maxBytes" | "maxPendingMessages" | "maxPendingBytes" | null = null,
        /** Configured capacity in pending payloads or UTF-8 JSON bytes, or null when no budget failed */
        readonly capacity: number | null = null,
    ) {
        super(`Collector failed (${reason})`)
        this.name = this._tag
    }
}

/** Expected terminal failures. Default observation adds CancelledError. Native interruption stays in Cause */
export type CollectorFailure = CollectorError | ClientClosedError
/** Local validation, unavailable connection or closed client. No network request is made to repair registration */
export type CollectorRegistrationError = ConfigurationError | CollectorFailure
