import { FluxerlyError, operationDetails } from "./errors.js"
import type { EventBufferOptions } from "./events.js"
import type { ClientClosedError, ConfigurationError } from "./errors.js"
import type { Message, MessageCore } from "./messages.js"
import type { MessageReaction, ReactionEmojiInput } from "./reactions.js"

/** Message collector limits shared by both entry points' collector options, which document each field. Not exported by an entry point */
export interface CollectorLimits<M extends MessageCore = Message> extends EventBufferOptions {
    readonly guildId?: string
    readonly maxMessages?: number
    readonly timeoutMs?: number
    readonly idleMs?: number
    readonly maxBytes?: number
    readonly filter?: (message: M) => boolean
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

/** Reaction collector limits shared by both entry points' collector options, which document each field. Not exported by an entry point */
export interface ReactionCollectorLimits extends EventBufferOptions {
    readonly guildId?: string
    readonly emoji?: ReactionEmojiInput
    readonly maxReactions?: number
    readonly timeoutMs?: number
    readonly idleMs?: number
    readonly maxBytes?: number
    readonly filter?: (reaction: MessageReaction) => boolean
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
