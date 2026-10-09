import type { EventName } from "./events.js"

/** What failed.
 * The kind handler is an event or command callback, and overflow is a subscription stopped by a full queue.
 * The kind collector is a message or reaction collector callback, and filter is a collector filter.
 * The kind progress is a message cleanup onProgress callback, cache is a cache maxAgeMs duration callback or a cache.onChange listener,
 * observer is a state observer and task is one run of a client.schedule task.
 * A failing onError hook is never reported to a hook again: It is logged with the original failure and counted in
 * diagnostics().counters.hookFailures
 *
 * @category Logging and diagnostics
 */
export type FailureKind = "handler" | "overflow" | "collector" | "filter" | "progress" | "cache" | "observer" | "task"

/**
 * IDs of the message involved in a failure, without its content
 *
 * @category Logging and diagnostics
 */
export interface FailureMessageReference {
    /** Message ID */
    readonly id: string
    /** Channel ID */
    readonly channelId: string
    /** Guild ID when the message belongs to a community */
    readonly guildId?: string
}

/**
 * A failure outside any returned result, delivered to an onError hook or logged at Error with its full error.
 * Reports delivered to a hook log at Debug without repeating the error. A handler failure caused by an HTTP 401 or 403
 * rejection replaces that rejection's Warn only when reported within one second, otherwise both records appear.
 * The error is the real value that the application callback threw or rejected with, or the SDK error that stopped the work.
 * The report holds IDs only, never message content
 *
 * @category Logging and diagnostics
 */
export interface FailureReport {
    /** What failed */
    readonly kind: FailureKind
    /** The original thrown, rejected or failed value */
    readonly error: unknown
    /** Event whose delivery failed, when the failure belongs to an event subscription */
    readonly event?: EventName
    /** Prefix command name, when a command callback failed */
    readonly command?: string
    /** Identifier of the subscription that owns the failed work, matching Subscription.id and log records */
    readonly subscriptionId?: string
    /** IDs of the message being handled, when there was one */
    readonly message?: FailureMessageReference
    /** Readable multi-line summary with the error's name, application code, message, stack and cause chain.
     * Credential patterns and the client's configured credentials are masked, without changing the original error
     */
    describe(): string
}
