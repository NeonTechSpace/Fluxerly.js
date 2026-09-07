import { Cause, Effect, Exit, Scope } from "effect"
import { err, ok, ResultAsync, type Result } from "neverthrow"
import type { ClientState, ClientOptions, ConnectionState, OperationOptions } from "./client.js"
import {
    CancelledError,
    ConfigurationError,
    SdkDefect,
    type ConnectError,
    type ConnectionFailure,
    type DefectReason,
    type Operation,
} from "./errors.js"
import { makeClient } from "#sdk/internal/client"

export type { ClientOptions, ConnectionState, OperationOptions } from "./client.js"
export {
    AuthenticationError,
    CancelledError,
    ClientBusyError,
    ClientClosedError,
    ConfigurationError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
    SdkDefect,
} from "./errors.js"
export type { ConnectError, ConnectionFailure, DefectReason } from "./errors.js"

/**
 * Default client with SDK-owned execution of asynchronous operations.
 * Expected failures use ResultAsync Err values, while SDK defects reject with SdkDefect.
 * Use run for a managed lifetime, or pair connect with waitForClose and shutdown
 */
export interface Client extends ClientState {
    /**
     * Connect and complete after authentication and the required READY event.
     * Readiness does not mean every guild or resource has loaded
     *
     * Owns startup only, using the client's connection settings.
     * Cancelling startup waits for cleanup and leaves the client Disconnected for reuse.
     * The signal becomes inert after success, while automatic recovery continues independently.
     * Use waitForClose to observe later terminal failures
     *
     * @returns Success if ready, or a connection, busy, closed or cancellation Err.
     * An already connected unmanaged client succeeds without opening another socket.
     * A competing call returns ClientBusyError without affecting the active operation
     * @throws SdkDefect as a rejection for an unexpected SDK or cleanup defect
     */
    connect(options?: OperationOptions): ResultAsync<void, ConnectError | CancelledError>
    /**
     * Own startup, connection, recovery and permanent cleanup as one operation.
     * Remains pending while the client is connected or recovering.
     * An accepted run leaves the client Closed on shutdown, failure or cancellation
     *
     * Accepts only a Disconnected client without competing work.
     * Rejection before admission does not acquire or close the client.
     * The signal controls the accepted run's full lifetime, with cleanup awaited before completion
     *
     * @returns Success after normal shutdown, or a connection, busy, closed or cancellation Err
     * @throws SdkDefect as a rejection, including when cancellation or failure also encounters a cleanup defect
     *
     * @example
     * ```ts
     * import { createClient } from "@neontechspace/fluxerly"
     *
     * export async function runBot(token: string, signal: AbortSignal): Promise<void> {
     *     const created = createClient({ token })
     *     if (created.isErr()) throw created.error
     *     try {
     *         const result = await created.value.run({ signal })
     *         if (result.isErr() && result.error._tag !== "CancelledError") {
     *             console.error(result.error.message)
     *         }
     *     } catch {
     *         console.error("Unexpected SDK failure")
     *     }
     * }
     * ```
     */
    run(options?: OperationOptions): ResultAsync<void, ConnectError | CancelledError>
    /**
     * Observe the retained terminal outcome without starting or owning a connection.
     * Recovery keeps this wait pending, and late observers receive the same terminal outcome.
     * Cancelling this wait releases only this caller, not the client or other waiters
     *
     * @returns Success after normal shutdown, a permanent connection failure, or CancelledError for this wait
     * @throws SdkDefect as a rejection for a retained unexpected background or cleanup defect
     */
    waitForClose(options?: OperationOptions): ResultAsync<void, ConnectionFailure | CancelledError>
    /**
     * Permanently stop startup and recovery, release credentials and await owned-resource cleanup.
     * Repeated and concurrent calls wait for the same shutdown outcome.
     * A pending connection call reports ClientClosedError rather than caller cancellation
     *
     * Established sockets get up to 5,000 ms for graceful closure, then forced termination and an awaited close event.
     * Pending handshakes terminate immediately, and forced termination may discard unsent data.
     * Accepts no cancellation signal that could abandon cleanup and never exits the application.
     * Create a new client to connect again
     *
     * @returns Success after cleanup, without an expected-error channel
     * @throws SdkDefect as a rejection if shutdown encounters an SDK or cleanup defect
     */
    shutdown(): ResultAsync<void, never>
    /**
     * Subscribe to the current state first, then only the newest pending update.
     * Callbacks run asynchronously and sequentially per subscriber, awaiting a returned promise.
     * Slow subscribers may miss intermediate states without delaying connection recovery.
     * Callback failures are reported without private error details and do not close the client
     *
     * @returns An unsubscribe function that drops pending delivery without stopping the client.
     * Unsubscription cannot cancel callback code that is already running.
     * Use waitForClose rather than state changes to observe terminal failure
     */
    observeState(listener: (state: ConnectionState) => void | Promise<void>): () => void
}

function fromExit<E extends ConnectError | ConfigurationError>(
    exit: Exit.Exit<void, E>,
    operation: Operation,
): Result<void, E | CancelledError> {
    if (Exit.isSuccess(exit)) return ok(undefined)
    if (Cause.hasDies(exit.cause)) {
        const reasons: DefectReason[] = exit.cause.reasons.map((reason) =>
            reason._tag === "Fail"
                ? { kind: "Failure", failure: reason.error }
                : { kind: reason._tag === "Die" ? "Defect" : "Interruption" },
        )
        throw new SdkDefect(operation, reasons)
    }
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    return failure?._tag === "Fail" ? err(failure.error) : err(new CancelledError())
}

/**
 * Create a Disconnected client without sockets, timers or process-signal handlers
 *
 * Validate configuration locally without authenticating the token.
 * Connection settings default to a 30,000 ms overall startup budget and three total attempts
 *
 * @returns The client, or ConfigurationError without the rejected input value
 * @throws SdkDefect synchronously for an unexpected creation defect
 */
export function createClient(options: ClientOptions): Result<Client, ConfigurationError> {
    const scope = Scope.makeUnsafe()
    const exit = Effect.runSyncExit(makeClient(options, scope))
    if (Exit.isFailure(exit)) {
        if (Cause.hasDies(exit.cause)) throw new SdkDefect()
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag === "Fail") return err(failure.error)
        throw new SdkDefect()
    }
    const owner = exit.value
    const execute = <E extends ConnectError>(
        effect: Effect.Effect<void, E>,
        operation: Operation,
        options?: OperationOptions,
    ) => {
        const signal = options?.signal
        if (signal?.aborted)
            return new ResultAsync<void, E | CancelledError>(Promise.resolve(err(new CancelledError())))
        const controller = signal ? new AbortController() : undefined
        const abort = () => controller?.abort()
        if (signal?.aborted) abort()
        else signal?.addEventListener("abort", abort, { once: true })
        // Interrupt the operation itself rather than discarding a losing race's cleanup cause
        return new ResultAsync(
            Effect.runPromiseExit(effect, controller ? { signal: controller.signal } : undefined)
                .finally(() => signal?.removeEventListener("abort", abort))
                .then((exit) => fromExit(exit, operation)),
        )
    }
    return ok(
        Object.freeze({
            get state() {
                return owner.state
            },
            get gatewayLatencyMs() {
                return owner.gatewayLatencyMs
            },
            connect: (options?: OperationOptions) => execute(owner.connect(), "connect", options),
            run: (options?: OperationOptions) => execute(owner.run(), "run", options),
            waitForClose: (options?: OperationOptions) => execute(owner.waitForClose(), "waitForClose", options),
            shutdown: () =>
                new ResultAsync<void, never>(
                    Effect.runPromiseExit(owner.shutdown().pipe(Effect.ensuring(Scope.close(scope, Exit.void)))).then(
                        (exit) => {
                            const result = fromExit(exit, "shutdown")
                            if (result.isErr()) throw new SdkDefect("shutdown")
                            return ok(undefined)
                        },
                    ),
                ),
            observeState: (listener: (state: ConnectionState) => void | Promise<void>) => {
                let active = true
                let busy = false
                let pending: ConnectionState | undefined
                const deliver = (state: ConnectionState) => {
                    if (!active) return
                    if (busy) {
                        pending = state
                        return
                    }
                    busy = true
                    Promise.resolve()
                        .then(() => (active ? listener(state) : undefined))
                        .catch(() => {
                            // Diagnostic delivery can fail too; never recurse into the user callback
                            Effect.runSyncExit(Effect.logError("Fluxerly state observer failed"))
                        })
                        .finally(() => {
                            busy = false
                            if (pending !== undefined) {
                                const next = pending
                                pending = undefined
                                deliver(next)
                            }
                        })
                }
                const unsubscribe = owner.subscribe(deliver)
                return () => {
                    active = false
                    pending = undefined
                    unsubscribe()
                }
            },
        }),
    )
}
