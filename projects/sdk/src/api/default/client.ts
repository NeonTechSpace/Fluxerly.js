import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import { ok, ResultAsync } from "neverthrow"
import { causeReasons, defectReason, suspendInput } from "#sdk/internal/defects"
import { shutdownDrainMs } from "#sdk/internal/client/drain"
import { promiseHook, throwIfErr } from "#sdk/internal/failures"
import { fiberRejectionScope, inRejectionScope } from "#sdk/internal/rejection-scope"
import { registerClientOwner } from "#sdk/internal/client-registry"
import type {
    ClientDiagnostics,
    ClientState,
    ClientOptions,
    ConnectionState,
    OperationOptions,
    ShutdownOptions,
} from "#sdk/client"
import {
    CancelledError,
    ClientClosedError,
    ConfigurationError,
    SdkDefect,
    type ConnectError,
    type ConnectionFailure,
} from "#sdk/errors"
import { makeClient } from "#sdk/internal/client"
import { defaultMiddleware, type EventSource, waitForEvent } from "#sdk/internal/events"
import { type EventWaitFailure } from "#sdk/message-errors"
import type { Message, MessageCore, MessageFields, SelectedMessage } from "#sdk/messages"
import type { EventBufferOptions, EventContext, EventInvocation, EventMap, EventName } from "#sdk/events"
import {
    type Subscription,
    type EventSubscription,
    type EventHandlerOptions,
    type DefaultEventWaitOptions,
    type EventMiddleware,
    type MiddlewareRegistration,
    type StateObserver,
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
import { type Threads } from "./threads.js"
import { type Members } from "./members.js"
import { type PermissionHelpers } from "./permissions.js"
import { type Roles } from "./roles.js"
import { type Webhooks } from "./webhooks.js"
import { type ClientCache } from "./cache.js"
import { type RestRequests } from "./rest.js"
import { type GatewayCommands } from "./gateway.js"
import { type ClientLogging } from "./logging.js"
import { type Instance } from "./instance.js"
import { bindDefault, defaultContext } from "#sdk/internal/binding/default"
import { fromExit } from "#sdk/internal/binding/execute"
import { type Presence } from "./presence.js"
import { type CurrentBotApplication } from "./application.js"
import { type Users } from "./users.js"
import { type DirectMessages } from "./direct-messages.js"

/**
 * Use a bot client for messages, community resources, HTTP requests and gateway events.
 * Call methods directly.
 * Network and other I/O operations start immediately and return ResultAsync. Await it to receive Ok or Err.
 * If isErr() is true, read error.
 * Otherwise, read value, or call orThrow to get the value and throw the error instead.
 * Expected failures are Err values, and an Err returned from a handler is reported like a thrown error.
 * Local registration and cache lookups return their value directly and throw ConfigurationError when misused.
 * Subscriptions and collectors registered after shutdown began return already-closed handles, because a still-running
 * handler can register during shutdown, while middleware registration on a closing client throws ClientClosedError.
 * Unexpected SDK or cleanup failures reject with SdkDefect.
 * Use run for a connection lifetime controlled by its signal.
 * Alternatively, connect for startup, waitForClose for terminal failure, and shutdown for final cleanup.
 * Use `await using` to shut the client down when the enclosing block ends
 *
 * @remarks
 * A malformed options.signal returns ConfigurationError for signal before work starts.
 * A valid aborted signal returns CancelledError.
 * Cleanup failure stops retries and preserves safe details of an accompanying failure or cancellation.
 * Shared REST success JSON is limited to 16 MiB before parsing, not total memory.
 * Upload-plan and completion responses have a separate 1 MiB limit
 *
 * Confirmed HTTP 429 responses with a valid retry delay pause all of this client's API routes when
 * X-RateLimit-Global is true, X-RateLimit-Scope is global, or the bounded JSON body has global: true.
 * A valid global assertion wins over conflicting local metadata. Malformed scope values are ignored.
 * A global header with a valid Retry-After starts the pause before body inspection, including when
 * the body is missing, malformed, oversized or too slow. Body inspection stays bounded to 8 KiB and 100 ms before awaited cleanup.
 * Without global metadata, only requests in the same rate-limit group wait. Without a usable delay, the rejection fails instead of guessing how long to wait.
 * Waits remain within each call's original deadline. Cancelling a queued call removes only that call, not the shared pause.
 * A call whose known pause outlasts its deadline fails at once with reason rateLimit and the remaining wait as retryAfterMs instead of waiting.
 * Separate clients do not coordinate these waits. Attachment downloads do not wait for API rate limits.
 * Writes retry only confirmed rate-limit rejection, never an uncertain outcome
 *
 * Valid X-RateLimit-Bucket metadata tells the client which requests share a rate limit, without application configuration.
 * For known Fluxer routes, requests remain grouped by their channel, community, user, webhook or invite resource.
 * Unknown routes reporting the same bucket identifier share one rate-limit group within this client.
 * Initial requests can still receive 429 before the server's grouping is learned.
 * Each client tracks at most 2,048 route aliases and 2,048 rate-limit groups. Unused aliases expire after five minutes unless a pause is still active.
 * An older response cannot replace a newer grouping or lift a rate-limit pause early. Regrouping preserves an existing pause until it expires.
 * When tracking is full, the client discards groups without active pauses first. If active pauses fill capacity or a request cannot be grouped safely,
 * the client waits rather than ignoring a known limit. Closing the client clears this temporary tracking data
 *
 * Each gateway connection accepts complete uncompressed text messages up to 100 MiB (104,857,600 bytes), including fragments combined.
 * The transport enforces this fixed receive ceiling before UTF-8 decoding and JSON parsing. It preserves the previous transport default.
 * This is not a Fluxer server-to-client maximum, an outbound command limit, a subscription budget or a JavaScript heap bound.
 * Larger messages fail with ConnectionError, phase gateway, reason protocol and status 1009. Invalid UTF-8 uses status 1007.
 * Neither rejection retries automatically. Standalone connect failure awaits cleanup and permits another explicit connect,
 * while a managed run or an established connection ends the client lifetime. Later failures are observable through waitForClose
 *
 * @category Client and lifecycle
 */
export interface Client<M extends MessageCore = Message> extends ClientState, AsyncDisposable {
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
     * Create threads and forum posts, change, list and search threads, and manage thread members
     */
    readonly threads: Threads<M>
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
     * The handler receives the event payload, a signal requesting cancellation on close or shutdown, and the EventContext.
     * Return or await asynchronous handler work. Other return values are ignored.
     * The SDK cannot stop promises that ignore the signal or manage work the handler did not return.
     * Registration returns the Subscription synchronously.
     * Invalid arguments throw ConfigurationError, and unexpected failures throw SdkDefect.
     * Registration after shutdown began, such as from a handler still running during shutdown, is not misuse: It returns
     * an already-closed Subscription whose handler never runs and whose waitForClose succeeds, and writes a Warn log
     * record with code events.registeredAfterShutdown
     *
     * @example
     * ```ts
     * import { describeError, type Client, type Message } from "@neontechspace/fluxerly"
     * export function debugHandlerExample(
     *     client: Client,
     *     handle: (message: Message) => Promise<void>,
     *     inspectFailure: (text: string) => void,
     * ) {
     *     return client.on("messageCreate", (event) => handle(event), {
     *         // The report holds the original error and the message IDs, never its content
     *         onError: (report) => inspectFailure(`${report.describe()}\n${describeError(report.error)}`),
     *     })
     * }
     * ```
     */
    on<K extends EventName>(
        event: K,
        handler: (event: EventMap<M>[K], signal: AbortSignal, context: EventContext) => unknown,
        options?: EventHandlerOptions<EventMap<M>[K]>,
    ): Subscription
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
     * The middleware receives the invocation, a next function returning a promise and the handler's cancellation signal.
     * Registration returns synchronously. The returned registration's close stops applying the middleware to later invocations.
     * A middleware that is not a function throws ConfigurationError, a closing or closed client throws ClientClosedError, and unexpected failures throw SdkDefect
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function timingMiddlewareExample(client: Client, record: (event: string, durationMs: number) => void) {
     *     return client.use(async (invocation, next) => {
     *         const startedAt = performance.now()
     *         await next()
     *         record(invocation.event, performance.now() - startedAt)
     *     })
     * }
     * ```
     */
    use(middleware: EventMiddleware<M>): MiddlewareRegistration
    /**
     * Receive future events of one type in receive order through a bounded buffer.
     * No history is replayed and bulk events are not split into individual events.
     * Enabled cache changes happen before delivery and remain independent of this subscription and its overflow.
     * Overflow fails this subscription rather than silently dropping events.
     * Options govern the source buffer only
     *
     * @remarks
     * Returns a subscription synchronously.
     * Call next for each payload and close when finished, or use `await using`.
     * Invalid arguments throw ConfigurationError, and unexpected failures throw SdkDefect.
     * Registration after shutdown began is not misuse: It returns an already-closed subscription whose next returns
     * Ok(null) and whose waitForClose succeeds, and writes a Warn log record with code events.registeredAfterShutdown
     */
    subscribe<K extends EventName>(event: K, options?: EventBufferOptions): EventSubscription<K, M>
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
     * Observation starts when called.
     * Abort returns CancelledError after subscription cleanup.
     * Unexpected SDK or cleanup failures reject with SdkDefect
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
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
        options?: DefaultEventWaitOptions<K, M>,
    ): ResultAsync<EventMap<M>[K], EventWaitFailure | CancelledError | ConfigurationError>
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
     * After success, the startup signal no longer affects the session.
     * Unexpected SDK or cleanup failures reject with SdkDefect
     */
    connect(options?: OperationOptions): ResultAsync<void, ConnectError | CancelledError | ConfigurationError>
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
     * The returned ResultAsync stays pending while connected or recovering, and one AbortSignal controls the whole lifetime.
     * Cancellation returns CancelledError.
     * Unexpected SDK or cleanup failures reject with SdkDefect, including failures during cancellation cleanup
     *
     * @example
     * ```ts
     * import { createClient } from "@neontechspace/fluxerly"
     *
     * export async function runClient(token: string | undefined, signal: AbortSignal): Promise<void> {
     *     await using client = createClient({ token })
     *     const result = await client.run({ signal })
     *     if (result.isErr() && result.error._tag !== "CancelledError") console.error(result.error.message)
     * }
     * ```
     */
    run(options?: OperationOptions): ResultAsync<void, ConnectError | CancelledError | ConfigurationError>
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
     * Unexpected background or cleanup failures reject with SdkDefect
     */
    waitForClose(options?: OperationOptions): ResultAsync<void, ConnectionFailure | CancelledError | ConfigurationError>
    /**
     * Permanently close this client and wait for startup, recovery, sockets and request cleanup.
     * Credentials, cached references, presence intent and expiry timers are released.
     * Active handlers and message and reaction collector callbacks are cancelled.
     * Pass drainMs to first stop accepting events and let running handlers and REST requests finish for up to that many
     * milliseconds, as runBot does when asked to stop. See ShutdownOptions.
     * Events still waiting in a subscription's queue are discarded, with one events.discarded Info record for each
     * subscription that had any, and a drain records the events it refused in one events.refused Info record.
     * Both kinds are counted in diagnostics().counters.eventsDropped.closed.
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
     * Handlers and callbacks receive cancellation through their signal, and returned collector callback promises are awaited.
     * Application reporter promises are not awaited.
     * No signal is accepted.
     * Invalid options throw ConfigurationError before shutdown starts.
     * Success is Ok(undefined) after cleanup.
     * Unexpected SDK or cleanup failures reject with SdkDefect, whose reasons keep every interruption and fault value
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function stopGracefully(client: Client) {
     *     // Let running handlers finish their replies for up to 10 seconds
     *     return client.shutdown({ drainMs: 10_000 })
     * }
     * ```
     */
    shutdown(options?: ShutdownOptions): ResultAsync<void, never>
    /**
     * Shut down this client and wait for cleanup, as `await using` does at the end of a block.
     * Unexpected cleanup failures reject with SdkDefect, as shutdown does
     */
    [Symbol.asyncDispose](): Promise<void>
    /**
     * Receive the current connection state, then later state updates.
     * While a subscriber is busy, only the newest pending state is kept.
     * Slow subscribers can miss intermediate states without delaying recovery.
     * Ending the subscription drops pending delivery without stopping the client.
     * Use waitForClose, not state changes, to observe the client's terminal failure
     *
     * @remarks
     * The listener runs asynchronously, one call at a time per subscriber, awaiting a returned promise.
     * A listener that throws, rejects or returns an Err result goes to the client-level onError as an observer failure, or is logged at Error, and does not close the client.
     * The returned observer's close ends delivery, but cannot cancel listener code already running
     */
    observeState(listener: (state: ConnectionState) => unknown): StateObserver
}

/**
 * Create a bot client from a token, initially Disconnected
 *
 * Use `run` or `connect` to receive gateway events. HTTP requests work without connecting.
 * Always finish with `shutdown` unless an accepted `run` already manages the client's full lifetime
 *
 * @remarks
 * **Creation and configuration**
 *
 * Creation validates configuration synchronously without authenticating the token or opening sockets.
 * No timers or process signal handlers are started.
 * Invalid options throw `ConfigurationError` without the rejected value.
 * An unsupported option key, such as a misspelled `logging`, throws with a hint naming the closest supported key.
 * A missing or blank token, such as an unset environment variable, throws `ConfigurationError` with a hint naming that likely cause.
 * Unexpected creation failures throw `SdkDefect`. An option getter that throws produces code `application.defect` with the thrown value as the cause
 *
 * **Instance and caching**
 *
 * Hosted Fluxer is selected by default.
 * For a self-hosted instance, pass its root and let the SDK discover API, gateway and URL endpoints when first needed.
 * HTTPS and WSS are required unless that explicit instance enables allowInsecure for HTTP and WS
 *
 * Caching is disabled by default.
 * Cache settings are copied and validated without calling retention policies or reporters.
 * Unknown cache or message-cache keys fail validation.
 * The messageFields option selects received message fields once for this client's lifetime
 *
 * **Connection and sharding**
 *
 * Gateway startup defaults to a 30,000 ms overall budget and three total attempts per assigned shard.
 * An explicit sharding plan fixes this client's assigned IDs for its lifetime, while automatic sharding may move to a
 * larger plan when Fluxer asks for more shards.
 * Shard zero receives direct-message gateway traffic.
 * Request and cache limits still apply across the whole client, not separately to each shard
 *
 * @example
 * ```ts
 * import { createClient } from "@neontechspace/fluxerly"
 *
 * export function shardingExample(token: string) {
 *     return createClient({ token, sharding: { totalShards: 4, shardIds: [0, 2] } })
 * }
 * ```
 *
 * @category Client and lifecycle
 */
export function createClient<const F extends MessageFields | undefined = undefined>(
    options: ClientOptions<F>,
): Client<SelectedMessage<F>> {
    type M = SelectedMessage<F>
    const scope = Scope.makeUnsafe()
    const exit = Effect.runSyncExit(makeClient<F>(options, scope))
    if (Exit.isFailure(exit)) {
        if (Cause.hasDies(exit.cause)) throw new SdkDefect("createClient", causeReasons(exit.cause))
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag === "Fail") {
            // The configuration error was created inside validation, so its stack starts at the caller's line instead
            Error.captureStackTrace(failure.error, createClient)
            throw failure.error
        }
        throw new SdkDefect("createClient", causeReasons(exit.cause))
    }
    const owner = exit.value
    const context = defaultContext(owner)
    const { execute } = context
    const subscription = (source: Pick<EventSource, "stop" | "closed" | "id">): Subscription => {
        const waitForClose = (options?: OperationOptions) =>
            execute(Deferred.await(source.closed), "subscription.waitForClose", options)
        return Object.freeze({
            id: source.id,
            close: () => source.stop(),
            waitForClose,
            [Symbol.asyncDispose]: async () => {
                source.stop()
                // The overflow outcome stays readable through waitForClose, so disposal only awaits cleanup
                await waitForClose()
            },
        })
    }
    // Registration misuse throws its ConfigurationError, as other local misuse does. A closing client is not misuse: the
    // event bus returns an already-closed source for it
    const register = <A, E>(effect: Effect.Effect<A, E>, operation: "on" | "subscribe"): A => {
        const exit = Effect.runSyncExit(owner.logging.provide(effect))
        if (Exit.isSuccess(exit)) return exit.value
        if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
            throw new SdkDefect(operation, causeReasons(exit.cause))
        const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (reason?._tag === "Fail") throw reason.error
        throw new SdkDefect(operation, causeReasons(exit.cause))
    }
    const shutdown = (options?: ShutdownOptions) => {
        let drainMs: number | ConfigurationError
        try {
            drainMs = shutdownDrainMs(options)
        } catch (error) {
            // A throwing option getter is an application fault, reported like other default-API input faults
            throw new SdkDefect("shutdown", [defectReason(error, "application")])
        }
        if (drainMs instanceof ConfigurationError) {
            Error.captureStackTrace(drainMs, shutdown)
            throw drainMs
        }
        return new ResultAsync<void, never>(
            Effect.runPromiseExit(
                owner.logging.provide(owner.shutdown(drainMs).pipe(Effect.ensuring(Scope.close(scope, Exit.void)))),
            ).then((exit) => {
                const result = fromExit(exit, "shutdown")
                if (result.isErr())
                    throw new SdkDefect("shutdown", Exit.isFailure(exit) ? causeReasons(exit.cause) : [])
                return ok(undefined)
            }),
        )
    }
    const namespaces = bindDefault(context)
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
            threads: namespaces.threads,
            members: namespaces.members,
            permissions: namespaces.permissions,
            roles: namespaces.roles,
            attachments: namespaces.attachments,
            messages: namespaces.messages,
            rest: namespaces.rest,
            gateway: namespaces.gateway,
            logging: namespaces.logging,
            on: <K extends EventName>(
                event: K,
                handler: (event: EventMap<M>[K], signal: AbortSignal, context: EventContext) => unknown,
                options?: EventHandlerOptions<EventMap<M>[K]>,
            ) => {
                return register(
                    suspendInput(() => {
                        if (typeof handler !== "function")
                            return Effect.fail(
                                new ConfigurationError("handler", "The event handler must be a function"),
                            )
                        const reporter = options?.onError
                        if (reporter !== undefined && typeof reporter !== "function")
                            return Effect.fail(
                                new ConfigurationError("onError", 'The option "onError" must be a function'),
                            )
                        return owner.events
                            .on(
                                event,
                                (message, context) =>
                                    Effect.withFiber((fiber) => {
                                        // Operations the handler starts hold their rejection records for its outcome
                                        const rejections = fiberRejectionScope(fiber.context)
                                        return Effect.tryPromise({
                                            try: (signal) =>
                                                Promise.resolve(
                                                    inRejectionScope(rejections, () =>
                                                        handler(message, signal, context),
                                                    ),
                                                ).then(throwIfErr),
                                            // Keep the thrown or rejected value itself for the failure report
                                            catch: (error) => error,
                                        })
                                    }),
                                options,
                                reporter ? promiseHook(reporter) : undefined,
                                scope,
                            )
                            .pipe(Effect.map(subscription))
                    }),
                    "on",
                )
            },
            use: (middleware: EventMiddleware<M>): MiddlewareRegistration => {
                if (typeof middleware !== "function")
                    throw new ConfigurationError("middleware", "Event middleware must be a function")
                if (owner.events.closed) throw new ClientClosedError()
                const remove = owner.events.addMiddleware(
                    defaultMiddleware(
                        middleware as (
                            invocation: EventInvocation<MessageCore>,
                            next: () => Promise<void>,
                            signal: AbortSignal,
                        ) => unknown,
                    ),
                )
                return Object.freeze({ close: remove, [Symbol.dispose]: remove })
            },
            subscribe: <K extends EventName>(event: K, options?: EventBufferOptions) =>
                register(
                    owner.events.open(event, options).pipe(
                        Effect.map((source): EventSubscription<K, M> =>
                            Object.freeze({
                                ...subscription(source),
                                next: (options?: OperationOptions) => execute(source.next(), "next", options),
                            }),
                        ),
                    ),
                    "subscribe",
                ),
            waitFor: <K extends EventName>(event: K, options?: DefaultEventWaitOptions<K, M>) =>
                execute(waitForEvent(owner.events, event, options, true), "waitFor", options),
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
            connect: (options?: OperationOptions) => execute(owner.connect(), "connect", options),
            run: (options?: OperationOptions) => execute(owner.run(), "run", options),
            waitForClose: (options?: OperationOptions) => execute(owner.waitForClose(), "waitForClose", options),
            shutdown,
            [Symbol.asyncDispose]: async () => {
                await shutdown()
            },
            observeState: (listener: (state: ConnectionState) => unknown) => {
                let active = true
                let busy = false
                let pending: ConnectionState | undefined
                const deliver = (state: ConnectionState) => {
                    if (!active) return
                    if (busy) {
                        if (pending !== undefined)
                            owner.logging.log({
                                level: "debug",
                                category: "lifecycle",
                                code: "lifecycle.observerCoalesced",
                                message: `A state observer was still running, so it skips the ${pending} state and receives ${state} next`,
                                fields: { skipped: pending, next: state },
                            })
                        pending = state
                        return
                    }
                    busy = true
                    Promise.resolve()
                        .then(() => (active ? listener(state) : undefined))
                        .then(throwIfErr)
                        .catch((error: unknown) => {
                            // The report goes to onError or the log, never back into this observer
                            owner.failures.report({ kind: "observer", error })
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
                const close = () => {
                    active = false
                    pending = undefined
                    unsubscribe()
                }
                return Object.freeze({ close, [Symbol.dispose]: close })
            },
        }),
        owner,
    )
}
