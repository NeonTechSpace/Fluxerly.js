import { Effect, Scope, type Stream } from "effect"
import type { ClientState, ClientOptions, ConnectionState } from "./client.js"
import type { ConfigurationError, ConnectError, ConnectionFailure } from "./errors.js"
import { makeClient } from "#sdk/internal/client"

export type { ClientOptions, ConnectionState } from "./client.js"
export {
    AuthenticationError,
    ClientBusyError,
    ClientClosedError,
    ConfigurationError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
} from "./errors.js"
export type { ConnectError, ConnectionFailure } from "./errors.js"

/**
 * Native client with lazy operations in the caller's Effect context.
 * The scope that creates the client owns its connection work and permanent cleanup.
 * Expected errors use the typed failure channel, while defects and interruption remain in the native cause
 */
export interface Client extends ClientState {
    /**
     * Connect when this Effect executes and complete after authentication and the required READY event.
     * Readiness does not mean every guild or resource has loaded
     *
     * Owns startup only, using the client's connection settings.
     * Startup interruption waits for cleanup and permits reuse while the owning scope stays open.
     * After success the connection and recovery remain owned by that scope, not by this completed operation.
     * Observe waitForClose for later terminal failures
     *
     * @returns A lazy Effect with connection, busy or closed failures.
     * An already connected unmanaged client succeeds without opening another socket.
     * Competing calls fail without taking ownership, and defects retain the native cause
     */
    connect(): Effect.Effect<void, ConnectError>
    /**
     * Own startup, lifetime observation and permanent cleanup in one lazy Effect.
     * Remains pending through established operation and transient recovery.
     * An accepted run leaves the client Closed when it ends, including failure or interruption
     *
     * Accepts only a Disconnected client without competing work.
     * Rejection before admission leaves existing work untouched.
     * Interruption controls the accepted run's whole lifetime and waits for cleanup
     *
     * @returns Success after normal shutdown, with connection, busy or closed typed failures.
     * Interruption and defects remain native, including combined operation and cleanup causes
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import { createClient } from "@neontechspace/fluxerly/effect"
     *
     * export const runBot = (token: string) => Effect.scoped(
     *     Effect.gen(function* () {
     *         const client = yield* createClient({ token })
     *         yield* client.run()
     *     }),
     * )
     * ```
     * The application executes this Effect and handles its typed failures and native cause
     */
    run(): Effect.Effect<void, ConnectError>
    /**
     * Observe the retained terminal outcome without starting or owning the connection.
     * Transient recovery keeps the Effect pending, and late observers receive the retained outcome.
     * Interrupting this wait releases only its observation, not the client or other waiters.
     * Closing the client's owning scope still shuts down the connection
     *
     * @returns Success after normal shutdown or the retained permanent connection failure.
     * Unexpected background and cleanup defects retain their native cause
     */
    waitForClose(): Effect.Effect<void, ConnectionFailure>
    /**
     * Permanently stop startup and recovery and await owned-resource cleanup.
     * This lazy Effect is uninterruptible once shutdown starts, so callers cannot abandon cleanup.
     * Repeated and concurrent calls observe the same shutdown outcome.
     * Explicit shutdown makes pending connect fail with ClientClosedError rather than interruption
     *
     * Established sockets get up to 5,000 ms for graceful closure, then termination and an awaited close event.
     * Pending handshakes terminate immediately, and forced termination may discard unsent data.
     * Credentials are released, the client cannot restart, and the consumer process is not terminated
     *
     * @returns An Effect without expected failures, while cleanup defects remain native defects
     */
    shutdown(): Effect.Effect<void>
    /**
     * Stream the current state first, then retain only the newest pending update.
     * Subscription setup and its initial snapshot are coordinated, with bounded buffering per subscriber.
     * Slow consumers may miss intermediate states, and Closed ends the stream
     *
     * The stream's scope releases its subscription without stopping the client.
     * The client's owning scope remains responsible for connection cleanup.
     * Use waitForClose rather than this status stream to observe terminal failure
     */
    observeState(): Stream.Stream<ConnectionState>
}

/**
 * Create a Disconnected client when this Effect executes, without networking or background activity
 *
 * Validate configuration locally without authenticating the token
 *
 * Each execution creates a separate client in the caller's owning scope.
 * Closing that scope permanently shuts down the client and releases its credential reference
 *
 * @returns A scoped, lazy creation Effect with ConfigurationError for invalid input.
 * Unexpected creation defects retain their native cause
 */
export function createClient(options: ClientOptions): Effect.Effect<Client, ConfigurationError, Scope.Scope> {
    return Effect.gen(function* () {
        // One client-owned scope lets shutdown mark Closing before interrupting its worker
        const scope = Scope.makeUnsafe()
        const owner = yield* makeClient(options, scope)
        yield* Effect.addFinalizer((exit) => owner.shutdown().pipe(Effect.ensuring(Scope.close(scope, exit))))
        return Object.freeze({
            get state() {
                return owner.state
            },
            get gatewayLatencyMs() {
                return owner.gatewayLatencyMs
            },
            connect: () => owner.connect(),
            run: () => owner.run(),
            waitForClose: () => owner.waitForClose(),
            shutdown: () => owner.shutdown(),
            observeState: () => owner.observeState(),
        })
    })
}
