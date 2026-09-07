/** Options accepted when creating a disconnected client */
export interface ClientOptions {
    /** Bot credential, checked locally for a non-blank string but not authenticated */
    readonly token: string
    /** Client-wide startup settings shared by connect and run, not per-call overrides */
    readonly connection?: {
        /**
         * Overall startup budget in milliseconds, including discovery, readiness and retry waits.
         * Must be a positive safe integer no greater than 2,147,483,647.
         * Expiry stops connection work, but returning still waits for owned-resource cleanup
         * @defaultValue 30000
         */
        readonly startupTimeoutMs?: number
        /**
         * Maximum total startup attempts, including the first, as a positive safe integer.
         * Only transient failures are retried, and the overall deadline can end startup sooner.
         * Does not set the established-session recovery attempt limit
         * @defaultValue 3
         */
        readonly maxStartupAttempts?: number
    }
}

/**
 * Current connection status, not an event history.
 * Disconnected permits startup, Connecting includes startup retries, and Connected means readiness completed.
 * Recovering means an established session is reconnecting, Closing means permanent cleanup, and Closed cannot restart
 */
export type ConnectionState = "Disconnected" | "Connecting" | "Connected" | "Recovering" | "Closing" | "Closed"

/** Properties shared by default and native clients */
export interface ClientState {
    /** Current connection state, controlled by the SDK rather than the consumer */
    readonly state: ConnectionState
    /**
     * Latest heartbeat round-trip time in milliseconds for the current connection.
     * Null before an acknowledgement and after connection loss or shutdown, including during recovery.
     * A new connection must receive its own acknowledgement before reporting a measurement.
     * Zero is a valid measurement, not a marker for unavailable data
     */
    readonly gatewayLatencyMs: number | null
}

/** Cancellation belongs to this operation, not the client's connection policy */
export interface OperationOptions {
    /**
     * A standard AbortSignal, expressed structurally to avoid requiring DOM declarations in consumer projects.
     * An already-aborted signal cancels without acquiring ownership.
     * Controls startup for connect, the full accepted lifetime for run, and only the observation for waitForClose.
     * No signal is accepted by shutdown, and completion is never undone by a later abort
     */
    readonly signal?: {
        readonly aborted: boolean
        addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void
        removeEventListener(type: "abort", listener: () => void): void
    }
}
