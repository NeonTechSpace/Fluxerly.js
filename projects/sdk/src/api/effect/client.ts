import { bindNative } from "#sdk/internal/binding/native"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { registerClientOwner } from "#sdk/internal/client-registry"
import type { LoggingOptions } from "#sdk/logging"
import type {
    ClientDiagnostics,
    ClientState,
    ClientOptions as SharedClientOptions,
    ConnectionRecoveryOptions,
    ConnectionState,
    ShutdownOptions,
} from "#sdk/client"
import type { MessageCacheOptions } from "#sdk/cache"
import { ClientClosedError, ConfigurationError, type ConnectError, type ConnectionFailure } from "#sdk/errors"
import { makeClient } from "#sdk/internal/client"
import { shutdownDrainMs } from "#sdk/internal/client/drain"
import { suspendInput } from "#sdk/internal/defects"
import { nativeMiddleware, waitForEvent } from "#sdk/internal/events"
import { EventOverflowError, type EventWaitFailure } from "#sdk/message-errors"
import type { Message, MessageCore, MessageFields, SelectedMessage } from "#sdk/messages"
import type { EventBufferOptions, EventContext, EventWaitOptions, EventMap, EventName } from "#sdk/events"
import { type Instance } from "./instance.js"
import { type FailureReport } from "./failures.js"
import {
    type Subscription,
    type EventHandlerOptions,
    type EventMiddleware,
    type MiddlewareRegistration,
    nativeSubscription,
} from "./events.js"
import { type Attachments } from "./attachments.js"
import { type Messages } from "./messages.js"
import { type AuditLogs } from "./audit-logs.js"
import { type Invites } from "./invites.js"
import { type Emojis } from "./emojis.js"
import { type Stickers } from "./stickers.js"
import { type Discovery } from "./discovery.js"
import { type Guilds } from "./guilds.js"
import { type Channels } from "./channels.js"
import { type Members } from "./members.js"
import { type PermissionHelpers } from "./permissions.js"
import { type Roles } from "./roles.js"
import { type Webhooks } from "./webhooks.js"
import { type ClientCache } from "./cache.js"
import { type RestRequests } from "./rest.js"
import { type GatewayCommands } from "./gateway.js"
import { type ClientLogging } from "./logging.js"
import { type Presence } from "./presence.js"
import { type CurrentBotApplication } from "./application.js"
import { type Users } from "./users.js"
import { type DirectMessages } from "./direct-messages.js"

/**
 * Choose the client's connection, logging, message fields, failure hook and optional caches.
 * The createClient function reads these options when its Effect executes, not when the Effect is built.
 * Required services for the onError hook are captured at that time.
 * The sharding option chooses which gateway shards this client owns, and automatic sharding may move them to a larger
 * plan while the client runs. Shard zero receives direct-message traffic.
 * HTTP and cache budgets apply to the whole client, not separately to each shard.
 * The messageFields option chooses which optional message fields are returned, including nested results, callbacks and cached messages.
 * Omission returns full Message objects. The selection cannot change after client creation.
 * TypeScript usually infers the type parameters from these options.
 * If supplying error and service types E and R explicitly with messageFields, also supply the selected-field tuple as F
 *
 * @category Options
 */
export interface ClientOptions<E = never, R = never, F extends MessageFields | undefined = undefined> extends Omit<
    SharedClientOptions<F>,
    "cache" | "logging" | "onError" | "connection"
> {
    /** Set the startup deadline, retry limit and recovery timing, as in the default entry point.
     * Native recovery can also take an Effect Schedule that decides established-session recovery delays
     */
    readonly connection?: Omit<NonNullable<SharedClientOptions<F>["connection"]>, "recovery"> & {
        /** Recovery timing for established sessions, with the same settings as the default entry point plus schedule */
        readonly recovery?: ConnectionRecoveryOptions & {
            /**
             * Decide each established-session recovery delay instead of minDelayMs and maxDelayMs, which cannot be combined with it.
             * The schedule receives each ConnectionFailure. Its delay is used, but never shorter than a wait Fluxer requires.
             * When the schedule completes, recovery stops and the client ends with that failure.
             * The schedule restarts after the connection stays healthy for healthyResetMs. Startup retries keep their own timing.
             * A value that is not a Schedule makes creation die with a ConfigurationError, like other invalid settings
             */
            readonly schedule?: Schedule.Schedule<unknown, ConnectionFailure>
        }
    }
    /**
     * Configure what the SDK logs, with the same settings as the default entry point.
     * Without sink or format, records go through the caller's Effect logger with Effect.logWithLevel, the real Cause
     * and fluxerly.* annotations such as fluxerly.code and fluxerly.category, so any Effect Logger, span and tracer applies.
     * Debug and Trace records enabled by these settings bypass the Effect minimum log level, while Info and higher records respect it.
     * Connection records use connect or run's services, handler records use registration services and shutdown records use shutdown's services.
     * A sink or an explicit format replaces the Effect logger with the SDK's own output
     *
     * @example
     * ```ts
     * import { Effect, Logger } from "effect"
     * import { createClient } from "@neontechspace/fluxerly/effect"
     * export function loggingExample(token: string) {
     *     return createClient({ token, logging: { categories: { rest: "debug" } } }).pipe(
     *         Effect.withLogger(Logger.consoleJson),
     *     )
     * }
     * ```
     */
    readonly logging?: LoggingOptions
    /**
     * Receive every failure that has no returned result, with the original error and its complete Cause.
     * The hook runs with the services available when client creation executes, one report at a time in order.
     * Up to 256 reports wait while it is busy, and later ones are logged instead, with fields.reportOutcome "queueFull", and counted in
     * diagnostics().counters.reportsDropped.
     * A subscription's own onError takes precedence. Without a hook the SDK logs each failure at Error with its full Cause.
     * A failing hook is logged with the original failure and never retried.
     * Shutdown interrupts a running hook and waits at most one second for its cleanup, so a hook that ignores
     * interruption cannot hold shutdown open. The interrupted report and any queued ones are logged at Error, with
     * fields.reportOutcome "interrupted" for the report being handled and "clientClosed" for queued or later reports.
     * A hook that interrupts itself also logs its report with "interrupted", and later reports still reach the hook
     */
    readonly onError?: (report: FailureReport) => Effect.Effect<unknown, E, R>
    /** Optionally keep resource snapshots in memory. Omission keeps none.
     * Every configured budget applies across this client's locally owned shards.
     * A gateway gap invalidates known-scope snapshots from its affected shard. Unknown community scope invalidates conservatively because the SDK keeps no channel-to-community index
     */
    readonly cache?: Omit<NonNullable<SharedClientOptions<F>["cache"]>, "messages"> & {
        /**
         * Omit or pass false to disable caching. Pass true or an options object to keep bounded message snapshots in memory across the client.
         * Eligible HTTP responses and gateway events populate the cache.
         * Deletes and writes with unknown outcomes evict affected messages. Gateway gaps clear it even after successful resume.
         * Conflicts can produce misses. A response that differs from an overlapping event only by lacking its community ID keeps the event snapshot.
         * No automatic history retrieval. Shutdown releases cached references
         */
        readonly messages?: boolean | MessageCacheOptions<NoInfer<SelectedMessage<F>>>
    }
}

/**
 * A bot client whose asynchronous methods return descriptions of work as Effects or Streams.
 * Execute Effects with yield* inside Effect.gen or with an Effect runner. Consume Streams to start their work.
 * Each operation uses the caller's Effect services and cancellation.
 * The scope that creates the client owns its connection work and permanent cleanup.
 * Expected errors use Effect's error channel. Unexpected faults and cancellation remain in Cause.
 * Cleanup defects stop retries and preserve any operation failure or interruption alongside the defect in Cause.
 * Successful REST JSON responses are limited to 16 MiB before parsing. This is not a total memory limit. Upload planning and completion responses have a separate 1 MiB limit
 *
 * A confirmed HTTP 429 response with a valid retry delay pauses all API routes on this client when
 * X-RateLimit-Global is true, X-RateLimit-Scope is global, or the JSON body has global: true.
 * A valid global indicator takes priority over conflicting route-specific metadata. Malformed scope values are ignored.
 * A global header with a valid Retry-After starts the pause before body inspection, including when
 * the body is missing, malformed, oversized or too slow. Body inspection stays bounded to 8 KiB and 100 ms before awaited cleanup.
 * Without global metadata, only requests in the same rate-limit group wait. Without a usable delay, the call fails rather than guessing how long to wait.
 * Rate-limit waits count toward each call's original deadline. Interruption removes only that call from the queue, not the shared pause.
 * Separate clients do not coordinate these waits. Attachment downloads do not wait for API rate limits.
 * Writes retry only confirmed rate-limit rejection, never an uncertain outcome
 *
 * Valid X-RateLimit-Bucket metadata updates how this client groups rate-limited routes, without application configuration.
 * Known Fluxer templates retain their channel, community, user, webhook or invite resource partitions.
 * Unknown route templates share one rate-limit bucket when they report the same identifier, to avoid exceeding a possible shared limit.
 * Initial requests can still receive 429 before the server's grouping is learned.
 * Each client tracks at most 2,048 route aliases and 2,048 bucket states. Idle aliases expire after five minutes unless they preserve an active pause.
 * Old responses cannot undo newer mappings or reopen an exhausted window. A changed mapping preserves any known prior pause until it expires.
 * When tracking reaches capacity, the client drops observations that are not blocking requests first. If active pauses fill capacity or a route cannot be grouped safely,
 * the client waits rather than ignoring a known limit. Closing the client clears this temporary state
 *
 * Each gateway connection accepts uncompressed text messages up to 100 MiB (104,857,600 bytes), counting all fragments together.
 * The transport checks this size before decoding UTF-8 or parsing JSON. This keeps the previous transport default.
 * This is not a Fluxer server-to-client maximum, an outbound command limit, a subscription budget or a JavaScript heap bound.
 * Larger messages fail with ConnectionError, phase gateway, reason protocol and status 1009. Invalid UTF-8 uses status 1007.
 * Neither failure retries automatically. A failed standalone connect waits for cleanup and allows another explicit connect.
 * A failed managed run or established connection ends the client lifetime. Use waitForClose to observe later failures
 *
 * @category Client and lifecycle
 */
export interface Client<M extends MessageCore = Message> extends ClientState {
    /**
     * Find this client's instance endpoints and get pure asset and link URL helpers for that instance
     */
    readonly instance: Instance
    /**
     * Search the public community directory and manage listings, without joining communities or finding instance endpoints
     */
    readonly discovery: Discovery
    /**
     * Set bot status or select member presence updates, restored after gateway reconnects but not stored across process restarts
     */
    readonly presence: Presence
    /**
     * Read documented fields for the authenticated bot's application, without owner details or management operations
     */
    readonly application: CurrentBotApplication
    /**
     * Fetch public account data or look up an account in the optional local cache
     */
    readonly users: Users
    /**
     * Open and manage one-to-one or group conversations, or send a direct message.
     * Use messages for other content operations once the channel IDs are known
     */
    readonly directMessages: DirectMessages<M>
    /**
     * Manage webhooks with the bot's permissions, returning metadata without tokens
     */
    readonly webhooks: Webhooks
    /**
     * Manage community roles or look up roles in an explicitly enabled local cache
     */
    readonly roles: Roles
    /**
     * Calculate permission flags locally or from fresh resource reads, without caching decisions
     */
    readonly permissions: PermissionHelpers
    /**
     * Read community data and memberships, or use the optional local community cache
     */
    readonly guilds: Guilds
    /**
     * Inspect, create, list and revoke invite codes, without using them to join or retaining codes
     */
    readonly invites: Invites
    /**
     * Read filtered audit pages or bounded entry scans, without retaining an audit cache
     */
    readonly auditLogs: AuditLogs
    /**
     * Manage custom emoji and optionally look up their cached metadata
     */
    readonly emojis: Emojis
    /**
     * Manage custom stickers and optionally look up their cached metadata
     */
    readonly stickers: Stickers
    /**
     * Read or change community channels and optionally look up cached channel data
     */
    readonly channels: Channels
    /**
     * Read, moderate and ban community members and change their assigned roles
     */
    readonly members: Members
    /**
     * Refresh signed attachment URLs explicitly or download from this instance's discovered media path with byte limits
     */
    readonly attachments: Attachments
    /**
     * Read, send, edit and delete messages, use the optional message cache, or collect future messages and reactions
     */
    readonly messages: Messages<M>
    /**
     * Enumerate or release locally cached data.
     * Caching is disabled unless enabled in ClientOptions.cache
     */
    readonly cache: ClientCache<M>
    /**
     * Send requests to Fluxer API routes without an SDK method, through this client's shared request scheduling
     */
    readonly rest: RestRequests
    /**
     * Send gateway commands without an SDK method on this client's ready shards
     */
    readonly gateway: GatewayCommands
    /**
     * Change the log level and per-category levels while the client runs
     */
    readonly logging: ClientLogging
    /**
     * Register a handler for future events of one type, before or after connecting the client.
     * Use the returned Subscription to close it and observe waitForClose.
     * No history is replayed and HTTP operations do not create events locally.
     * Bulk deletion events do not also call messageDelete handlers.
     * Enabled cache updates happen before handlers and do not depend on a subscription succeeding, including its overflow
     *
     * Handlers run one at a time by default.
     * Increasing concurrency keeps receive-order starts, but not completion order.
     * Each subscription has its own ordering and queue, with no ordering across event types and no exactly-once delivery.
     * Default pending limits are 256 payloads or 4 MiB of full source JSON, not total process memory.
     * A bulk payload counts once, including all its bytes.
     * A full queue drops its oldest waiting event by default, logs a Warn record and counts the drop, and the subscription keeps running.
     * Choose overflow stop to close only this subscription instead, observable through the returned handle
     *
     * A failed handler is isolated and not retried.
     * A default API handler fails when it throws, rejects, or returns or resolves an Err result, and a native handler fails when its Effect fails.
     * Its original failure, with the event name, subscription ID and message IDs, goes to this subscription's onError, else the client-level onError, else an Error log record with the full message, stack and cause chain.
     * Observe the subscription's outcome as well as the client's run or waitForClose outcome.
     * Registration misuse, such as an unknown event name, fails with a suggested correction
     *
     * Each invocation also receives an EventContext with the receiving shard and the received frame size.
     * Event middleware registered with use runs around every handler invocation, including those of subscriptions registered earlier
     *
     * @remarks
     * The handler receives the event payload and the EventContext, and returns the Effect to run.
     * The subscription belongs to the Scope and context that execute this Effect, without a separate SDK runtime.
     * Registration misuse is a defect carrying ConfigurationError.
     * Registration after shutdown began, such as from a handler still being interrupted by shutdown, is not misuse: It
     * returns an already-closed Subscription whose handler never runs and whose waitForClose succeeds, and writes a Warn
     * log record with code events.registeredAfterShutdown.
     * Handler failures are reported with their complete Cause through the Effect logger.
     * Client or registration-scope closure interrupts handlers and awaits handler cleanup
     *
     * @example
     * ```ts
     * import { Cause, Effect } from "effect"
     * import type { Client, Message } from "@neontechspace/fluxerly/effect"
     * export function debugHandlerExample<E, R>(
     *     client: Client,
     *     handle: (message: Message) => Effect.Effect<void, E, R>,
     *     inspectFailure: (cause: Cause.Cause<E>) => void,
     * ) {
     *     return client.on("messageCreate", (message) =>
     *         Effect.suspend(() => handle(message)).pipe(
     *             // Inspect locally. The failure still reaches onError or the log afterwards
     *             Effect.tapCause((cause) => Effect.sync(() => inspectFailure(cause))),
     *         ),
     *     )
     * }
     * ```
     */
    on<E, R, E2 = never, R2 = never, K extends EventName = "messageCreate">(
        event: K,
        handler: (event: EventMap<M>[K], context: EventContext) => Effect.Effect<unknown, E, R>,
        options?: EventHandlerOptions<E2, R2, EventMap<M>[K]>,
    ): Effect.Effect<Subscription, never, R | R2 | Scope.Scope>
    /**
     * Add event middleware that runs around every later on handler invocation, for every event and subscription, including
     * subscriptions registered before it, command routers and runBot handlers.
     * Middleware runs in registration order, the first registered outermost, and each invocation keeps the middleware registered when it started.
     * It receives the invocation's event name, payload, EventContext and subscription ID, and a next step that runs the rest of the chain and the handler.
     * Not calling next skips the handler for that invocation. Calling next again returns the same completion without running the handler twice,
     * and calling it after the middleware finished reports a ConfigurationError instead of running the handler.
     * The handler slot stays occupied until the middleware and any next it started have finished.
     * The next step completes whether or not the rest of the chain failed and never fails itself, so a handler failure is always reported.
     * A failing middleware is reported like a failed handler, with the event name, subscription ID and message IDs, to the subscription's onError, else the client-level onError, else an Error log record.
     * Middleware does not run for subscribe, waitFor, message collectors or reaction collectors.
     * Registration misuse, such as a middleware that is not a function, fails like other registration misuse
     *
     * @remarks
     * The middleware receives the invocation and a next Effect, and runs with the services available when this Effect executes,
     * except that its Scope stays the one of the handler invocation. The next Effect restores the handler's own services.
     * Registration lasts until the returned registration's close or the closing of the executing Scope.
     * Registration misuse, including a closing client, is a defect carrying ConfigurationError or ClientClosedError
     *
     * @example
     * ```ts
     * import { Clock, Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function timingMiddlewareExample(client: Client) {
     *     return client.use((invocation, next) =>
     *         Effect.gen(function* () {
     *             const startedAt = yield* Clock.currentTimeMillis
     *             yield* next
     *             const durationMs = (yield* Clock.currentTimeMillis) - startedAt
     *             yield* Effect.logDebug(`${invocation.event} took ${durationMs} ms`)
     *         }),
     *     )
     * }
     * ```
     */
    use<E = never, R = never>(
        middleware: EventMiddleware<M, E, R>,
    ): Effect.Effect<MiddlewareRegistration, never, R | Scope.Scope>
    /**
     * Receive future events of one type in receive order through a bounded buffer.
     * No history is replayed and bulk events are not split into individual events.
     * Enabled cache changes happen before delivery and remain independent of this subscription and its overflow.
     * Overflow fails this subscription rather than silently dropping events.
     * Options govern the source buffer only
     *
     * @remarks
     * Returns a Stream, and each execution owns a subscription released with the Stream's scope.
     * Consumers choose stream concurrency and supervision.
     * Registration misuse is a defect carrying ConfigurationError.
     * A Stream run after shutdown began is not misuse: It ends at once without events and writes a Warn log record with
     * code events.registeredAfterShutdown
     */
    subscribe<K extends EventName>(
        event: K,
        options?: EventBufferOptions,
    ): Stream.Stream<EventMap<M>[K], EventOverflowError>
    /**
     * Wait for the first future event of one type that passes the supplied synchronous filter.
     * Observation starts without connecting the client, reading history or cache, or making a remote request
     *
     * The default timeout is 30,000 ms from registration.
     * A timeout or invalid or throwing filter fails with EventWaitError without input or exception text.
     * Inspect a filter exception inside the filter before rethrowing if needed.
     * Buffer limits match subscribe.
     * Reconnection can miss events and does not reset the deadline.
     * Overflow, invalid configuration and client closure remain distinct failures
     *
     * Completion or cancellation releases the queue, filter, timer and subscription without shutting down the client.
     * This returns an event, not a registration handle.
     * Use subscribe, a scoped on subscription or a collector to confirm registration before triggering an action
     *
     * @remarks
     * Each execution owns a separate bounded subscription in its executing fiber, with no separate SDK runtime.
     * Creating or forking this Effect is not a registration barrier.
     * SDK and cleanup defects remain in the Cause
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function eventWaitExample(client: Client, channelId: string, userId: string) {
     *     return client.waitFor("typingStart", {
     *         filter: event => event.channelId === channelId && event.userId === userId,
     *         timeoutMs: 10_000,
     *     })
     * }
     * ```
     */
    waitFor<K extends EventName>(
        event: K,
        options?: EventWaitOptions<K, M>,
    ): Effect.Effect<EventMap<M>[K], EventWaitFailure>
    /**
     * Read a frozen local report of active work, queues and cache occupancy.
     * No request, telemetry or persistent record is created.
     * The report excludes tokens, routes, resource IDs and payloads.
     * Counts cover only this client's assigned shards and local work.
     * Event counts include open sources, message and reaction collectors and executing subscription handlers, not an enforced client-wide admission quota.
     * Accounted cache and queue bytes are not heap memory, process memory or remote storage.
     * After closure, configured limits remain visible and retained counts show cleanup progress.
     * These values do not prove remote completeness or gateway readiness.
     * This runs immediately and takes no signal
     */
    diagnostics(): ClientDiagnostics
    /**
     * Connect the gateway and complete when every shard assigned to this client has authenticated and received READY.
     * This does not wait for GUILD_CREATE, a full community roster or all resources to load.
     * Use connect when startup must finish separately from the client's lifetime.
     * After success, the connection and automatic recovery continue until shutdown or permanent failure, and waitForClose observes that later outcome
     *
     * The call controls startup only, using the client's connection settings.
     * Cancellation or an expected failure before initial readiness waits for shard cleanup and leaves the client Disconnected, so connect can be tried again.
     * An already-connected client not managed by run succeeds without opening another socket.
     * A competing call fails with ClientBusyError without disturbing active work, and closing clients fail with ClientClosedError.
     * After initial readiness, permanent failure of a required shard in a multi-shard plan closes the client.
     * The waitForClose method retains that failure as ShardConnectionError with shardId and failure
     *
     * @remarks
     * The gateway opens when this Effect executes.
     * Connection and recovery continue in the client's creation Scope after connect succeeds, and connect can be retried while that Scope remains open.
     * Unexpected faults and interruption remain in the Cause
     */
    connect(): Effect.Effect<void, ConnectError>
    /**
     * Start and maintain a gateway connection for the client's whole lifetime, including transient recovery, until shutdown, permanent failure or cancellation.
     * Use run when one owner should control startup, lifetime observation and permanent cleanup together.
     * Once run is accepted, its end always leaves the client Closed after cleanup.
     * Success means normal shutdown, not merely reaching READY.
     * A permanent required-shard failure after readiness closes a multi-shard client with ShardConnectionError
     *
     * The run method requires a Disconnected client with no competing connection work.
     * A rejected or pre-cancelled call does not take over or close the client.
     * Expected connection, busy and closed failures use ConnectError
     *
     * @remarks
     * The Effect stays pending for the client's lifetime, and interrupting an accepted run stops that lifetime and waits for cleanup.
     * Unexpected faults and interruption remain in the Cause, alongside any cleanup faults
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
     */
    run(): Effect.Effect<void, ConnectError>
    /**
     * Wait for this client's final shutdown or permanent connection failure, without starting or owning a connection.
     * Recovery keeps the wait pending.
     * An expected connect failure before initial readiness also leaves this wait pending, because the client can connect again.
     * Multiple or later waiters receive the same retained outcome.
     * Normal shutdown succeeds with no value, and a permanent connection failure fails with ConnectionFailure.
     * After initial readiness, required-shard failure in a multi-shard plan is retained as ShardConnectionError.
     * Cancelling this wait affects only this waiter, not the client or other waiters
     *
     * @remarks
     * Closing the client's creation Scope still shuts down the client.
     * Background and cleanup faults remain in the Cause, alongside any expected failure
     */
    waitForClose(): Effect.Effect<void, ConnectionFailure>
    /**
     * Permanently close this client and wait for startup, recovery, sockets and request cleanup.
     * Credentials, cached references, presence intent and expiry timers are released.
     * Active handlers and message and reaction collector callbacks are cancelled.
     * Pass drainMs to first stop accepting events and let running handlers and REST requests finish for up to that many
     * milliseconds, as runBot does when asked to stop. See ShutdownOptions.
     * Collector callback cleanup is awaited, so a collector callback that ignores cancellation can delay shutdown.
     * Repeated and concurrent calls share the shutdown outcome.
     * A pending connection call fails with ClientClosedError rather than cancellation.
     * Established sockets get up to 5,000 ms to close gracefully, then are terminated and their close events awaited.
     * Pending handshakes are terminated immediately, and forced termination can discard unsent data.
     * Cleanup cannot be abandoned, and this method never exits the application or undoes remote writes.
     * Create a new client to connect again.
     * Each failed cleanup step is also logged at Error in the lifecycle category and counted in diagnostics().counters.cleanupFailures
     *
     * @remarks
     * Once shutdown starts, it disables interruption so the caller cannot abandon cleanup.
     * Closing the client's creation Scope shuts down without a drain.
     * Handler and collector finalizers must finish before closure, so work that disables interruption can delay shutdown.
     * If an owned handler or collector callback calls shutdown, the client Scope performs shutdown and interrupts that invocation, which does not resume afterward.
     * No expected error is returned. Invalid options are a defect carrying ConfigurationError, before shutdown starts.
     * The drain time is measured with the Clock supplied when the client was created.
     * Cleanup faults remain defects in the Cause, and an interruption of an owned worker stays a separate Cause reason
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function stopGracefully(client: Client) {
     *     // Let running handlers finish their replies for up to 10 seconds
     *     return client.shutdown({ drainMs: 10_000 })
     * }
     * ```
     */
    shutdown(options?: ShutdownOptions): Effect.Effect<void>
    /**
     * Receive the current connection state, then later state updates.
     * While a subscriber is busy, only the newest pending state is kept.
     * Slow subscribers can miss intermediate states without delaying recovery.
     * Ending the subscription drops pending delivery without stopping the client.
     * Use waitForClose, not state changes, to observe the client's terminal failure
     *
     * @remarks
     * Returns a Stream in which each consumer gets a coordinated initial snapshot.
     * Closed ends the Stream
     */
    observeState(): Stream.Stream<ConnectionState>
}

/**
 * Create a bot client from the supplied token when this Effect executes
 *
 * Use `Effect.scoped` to keep the client open while the bot works and shut it down when the Scope closes.
 * The client starts disconnected. Call `connect` or `run` to receive gateway events
 *
 * @remarks
 * **Client lifetime**
 *
 * Calling `createClient` does not create a client yet. Each execution creates a separate client in the caller's Scope and validates configuration locally, without authenticating the token
 *
 * Creation starts no networking or background work. HTTP operations work without `connect`.
 * Closing the scope permanently shuts down the client and releases its credential reference.
 * Cache-error callbacks capture the Effect services available when creation executes.
 * The Effect Clock supplied at creation controls this client's REST queue and deadlines, cache expiry, collectors,
 * presence pacing and gateway lifetime. Supplying a different Clock for a later operation does not replace it.
 * Operation-specific waits and utilities document which Clock they use. Logging durations never control deadlines
 *
 * **Instance and caching**
 *
 * Omit `instance` for hosted Fluxer. For a self-hosted instance, pass its root. The unauthenticated well-known document supplies HTTP, gateway, image and application addresses when needed.
 * HTTPS and WSS are required unless that explicit instance sets `allowInsecure: true` for HTTP and WS
 *
 * Caching is disabled by default. Cache settings are copied and validated without invoking retention policies or reporters.
 * Unknown cache or message-cache option keys fail validation
 *
 * **Connection and sharding**
 *
 * Connection settings default to a 30,000 ms overall startup budget and three total attempts per assigned shard.
 * A sharding plan fixes this client's local IDs for its lifetime. Shard zero receives direct-message gateway traffic.
 * REST and cache budgets apply across the whole client, not separately to each shard
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { createClient } from "@neontechspace/fluxerly/effect"
 *
 * export function shardingExample(token: string) {
 *     return Effect.scoped(Effect.gen(function* () {
 *         const client = yield* createClient({ token, sharding: { totalShards: 4, shardIds: [0, 2] } })
 *         yield* client.connect()
 *         return client.shards
 *     }))
 * }
 * ```
 *
 * @returns A scoped, lazy creation Effect. Invalid options, including a missing or blank token and an unsupported option
 * key, are misuse and die with ConfigurationError. Its hint names an unset environment variable as the likely cause of a
 * missing token, and the closest supported key for a misspelled option.
 * Unexpected creation defects retain their Cause
 *
 * @category Client and lifecycle
 */
export function createClient<E = never, R = never, const F extends MessageFields | undefined = undefined>(
    options: ClientOptions<E, R, F>,
): Effect.Effect<Client<SelectedMessage<F>>, never, Scope.Scope | R> {
    return openClient<E, R, F>(options).pipe(Effect.orDie)
}

/**
 * Create a scoped native client, keeping invalid configuration as a typed failure for runners that report it as their
 * own outcome, such as the supervisor child
 *
 * @internal
 */
export function openClient<E = never, R = never, const F extends MessageFields | undefined = undefined>(
    options: ClientOptions<E, R, F>,
): Effect.Effect<Client<SelectedMessage<F>>, ConfigurationError, Scope.Scope | R> {
    type M = SelectedMessage<F>
    return Effect.gen(function* () {
        // One client-owned scope lets shutdown mark Closing before interrupting its worker
        const scope = Scope.makeUnsafe()
        const owner = yield* makeClient<F>(options, scope, true)
        yield* Effect.addFinalizer((exit) => owner.shutdown().pipe(Effect.ensuring(Scope.close(scope, exit))))
        const namespaces = bindNative(owner)
        return registerClientOwner(
            Object.freeze({
                // Listing namespaces instead of spreading them keeps the accessors below in declaration order
                instance: namespaces.instance,
                presence: namespaces.presence,
                cache: namespaces.cache,
                application: namespaces.application,
                users: namespaces.users,
                directMessages: namespaces.directMessages,
                webhooks: namespaces.webhooks,
                emojis: namespaces.emojis,
                stickers: namespaces.stickers,
                auditLogs: namespaces.auditLogs,
                invites: namespaces.invites,
                discovery: namespaces.discovery,
                guilds: namespaces.guilds,
                channels: namespaces.channels,
                members: namespaces.members,
                permissions: namespaces.permissions,
                roles: namespaces.roles,
                attachments: namespaces.attachments,
                messages: namespaces.messages,
                rest: namespaces.rest,
                gateway: namespaces.gateway,
                logging: namespaces.logging,
                on: <E, R, E2 = never, R2 = never, K extends EventName = "messageCreate">(
                    event: K,
                    handler: (event: EventMap<M>[K], context: EventContext) => Effect.Effect<unknown, E, R>,
                    options?: EventHandlerOptions<E2, R2, EventMap<M>[K]>,
                ) =>
                    Effect.gen(function* () {
                        const callerScope = yield* Effect.scope
                        const source = yield* owner.events
                            .on(event, handler, options, options?.onError, callerScope)
                            .pipe(Effect.orDie)
                        return nativeSubscription(source)
                    }),
                use: <E = never, R = never>(middleware: EventMiddleware<M, E, R>) =>
                    Effect.gen(function* () {
                        if (typeof middleware !== "function")
                            return yield* Effect.die(
                                new ConfigurationError("middleware", "Event middleware must be a function"),
                            )
                        if (owner.events.closed) return yield* Effect.die(new ClientClosedError())
                        // Each invocation keeps its own handler Scope rather than the registration Scope
                        const services = Context.omit(Scope.Scope)(
                            (yield* Effect.context<R>()) as Context.Context<never>,
                        )
                        const remove = yield* Effect.acquireRelease(
                            Effect.sync(() =>
                                owner.events.addMiddleware(nativeMiddleware(middleware as never, services)),
                            ),
                            (remove) => Effect.sync(remove),
                        )
                        return Object.freeze({ close: () => Effect.sync(remove) }) satisfies MiddlewareRegistration
                    }),
                subscribe: <K extends EventName>(event: K, options?: EventBufferOptions) =>
                    // Registration misuse is a defect, while overflow stays the Stream's typed failure
                    owner.events.stream(event, options).pipe(
                        Stream.catchIf(
                            (error): error is Exclude<typeof error, EventOverflowError> =>
                                !(error instanceof EventOverflowError),
                            (error) => Stream.die(error),
                        ),
                    ),
                waitFor: <K extends EventName>(event: K, options?: EventWaitOptions<K, M>) =>
                    waitForEvent(owner.events, event, options),
                diagnostics: () => owner.diagnostics(),
                get state() {
                    return owner.state
                },
                get gatewayLatencyMs() {
                    return owner.gatewayLatencyMs
                },
                get shards() {
                    return owner.shards
                },
                shardIdForGuild: (guildId: string) => owner.ownedShardForGuild(guildId),
                connect: () => owner.connect(),
                run: () => owner.run(),
                waitForClose: () => owner.waitForClose(),
                shutdown: (options?: ShutdownOptions) =>
                    suspendInput(() => {
                        const drainMs = shutdownDrainMs(options)
                        return drainMs instanceof ConfigurationError ? Effect.die(drainMs) : owner.shutdown(drainMs)
                    }),
                observeState: () => owner.observeState(),
            }),
            owner,
        )
    })
}
