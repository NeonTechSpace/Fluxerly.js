import type { OperationOptions } from "./client.js"
import type { EventBufferOptions } from "./events.js"
import type { ClientClosedError, ConfigurationError } from "./errors.js"
import type { Message } from "./messages.js"

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
    /** Already-aborted signals reject registration. Later abort fails collection with CancelledError, without partial replies */
    readonly signal?: OperationOptions["signal"]
}

/** Frozen successful observations, not current server state or a complete conversation */
export interface CollectorResult {
    /** Frozen snapshots in receive order, counting accepted IDs once. Later edits/deletions do not change them */
    readonly messages: readonly Message[]
    /** The limit reason meets the requested count. Timeout and stopped results can contain partial or empty arrays */
    readonly reason: "limit" | "timeout" | "stopped"
}

/** Identifiable collector failure with no message bodies, partial results or original filter errors */
export class CollectorError extends Error {
    /** Stable discriminator for collector-local failures */
    readonly _tag = "CollectorError"
    constructor(
        /** Registration requires Connected. Any later recovery ends collection. Filter and budget failures are permanent */
        readonly reason: "notConnected" | "connectionLost" | "filter" | "overflow",
        /** Exceeded budget, or null for a non-budget failure */
        readonly limit: "maxBytes" | "maxPendingMessages" | "maxPendingBytes" | null = null,
        /** Configured capacity in messages or UTF-8 JSON bytes, or null when no budget failed */
        readonly capacity: number | null = null,
    ) {
        super(`Message collector failed (${reason})`)
        this.name = this._tag
    }
}

/** Expected terminal failures. Default observation adds CancelledError. Native interruption stays in Cause */
export type CollectorFailure = CollectorError | ClientClosedError
/** Local validation, unavailable connection or closed client. No network request is made to repair registration */
export type CollectorRegistrationError = ConfigurationError | CollectorFailure
