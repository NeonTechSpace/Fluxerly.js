import type { EventName } from "./events.js"

/**
 * One finished REST request attempt. A retried request reports each attempt separately
 *
 * @category Logging and diagnostics
 */
export interface RestObservation {
    /** Discriminator for a finished REST request attempt */
    readonly type: "rest"
    /** HTTP method, such as GET or POST */
    readonly method: string
    /** Route template with IDs replaced by placeholders, such as /channels/:id/messages */
    readonly route: string
    /** HTTP status of the response, or null when no response arrived, such as after a network failure or timeout */
    readonly status: number | null
    /** Milliseconds from sending the request until its response headers arrived or it failed */
    readonly durationMs: number
    /** One-based attempt number. Values above 1 are automatic retries of the same request */
    readonly attempt: number
}

/**
 * A REST request that waits before retrying because Fluxer rate-limited it with HTTP 429
 *
 * @category Logging and diagnostics
 */
export interface RateLimitObservation {
    /** Discriminator for a rate-limit wait */
    readonly type: "rateLimit"
    /** HTTP method of the waiting request */
    readonly method: string
    /** Route template of the waiting request, with IDs replaced by placeholders */
    readonly route: string
    /** Milliseconds the request waits before its retry */
    readonly waitMs: number
    /** Whether the limit pauses every API route of this client rather than one rate-limit group */
    readonly global: boolean
}

/**
 * A shard begins a reconnection attempt after its established connection was lost
 *
 * @category Logging and diagnostics
 */
export interface ReconnectObservation {
    /** Discriminator for a reconnection attempt */
    readonly type: "reconnect"
    /** Local shard that reconnects */
    readonly shardId: number
}

/**
 * A shard resumed its session, so Fluxer replays the events it missed
 *
 * @category Logging and diagnostics
 */
export interface ResumeObservation {
    /** Discriminator for a resumed session */
    readonly type: "resume"
    /** Local shard that resumed */
    readonly shardId: number
    /** Milliseconds the shard was offline, when it was connected before in this process */
    readonly outageMs?: number
}

/**
 * One finished event handler or prefix command router invocation, including event and command middleware.
 * A router emits one observation for every handled message, even when it matches no command
 *
 * @category Logging and diagnostics
 */
export interface HandlerObservation {
    /** Discriminator for a finished handler invocation */
    readonly type: "handler"
    /** Event the handler received, such as messageCreate */
    readonly event: EventName
    /** Canonical prefix command name when the router matched one, including denied or middleware-stopped commands. Absent when no command matched */
    readonly command?: string
    /** Identifier of the subscription that ran the handler, such as messageCreate#3 */
    readonly subscriptionId: string
    /** Local shard that received the event */
    readonly shardId: number
    /** Milliseconds from the start of the invocation until it finished */
    readonly durationMs: number
    /**
     * How the invocation ended. The value success means it finished without a reported failure, including a command
     * denial or no command match. The value failure means a handler, command or middleware failure was reported to
     * onError or the log, even when middleware recovered from it. The value cancelled means interruption stopped the
     * invocation, such as shutdown or closing the subscription, and takes precedence over an earlier reported failure
     */
    readonly outcome: "success" | "failure" | "cancelled"
    /** Name of the failure's error, such as TypeError, for a failed invocation */
    readonly errorName?: string
    /** Stable code of the failure's error, when it has one */
    readonly errorCode?: string
}

/**
 * One structured measurement passed to the observe client option. Use the type field to tell them apart
 *
 * @category Logging and diagnostics
 */
export type Observation =
    RestObservation | RateLimitObservation | ReconnectObservation | ResumeObservation | HandlerObservation

/**
 * Receive structured measurements of this client's work, such as REST request durations, rate-limit waits,
 * reconnection attempts, resumed sessions and handler durations, to export as metrics or traces to any monitoring system.
 * Each observation is a frozen object with plain values. Route templates replace IDs with placeholders, and observations
 * never contain tokens, payloads or message content.
 * The SDK calls the observer synchronously when the measured work finishes, so keep it short and move slow work, such as
 * network export, elsewhere. Return values are ignored and promises are not awaited. A thrown error or rejected promise
 * is counted in diagnostics().counters.sinkFailures and reported once on standard error, without changing SDK work
 *
 * @category Logging and diagnostics
 */
export type Observer = (observation: Observation) => void
