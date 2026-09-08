import { Deferred, Effect, Scope, type Stream } from "effect"
import type { Logger } from "effect"
import type { LoggingOptions, DefaultLogger } from "./logging.js"
import { adaptLogger } from "#sdk/internal/logging"
export type { LoggingOptions, DefaultLogger } from "./logging.js"

/**
 * Adapt an Effect logger for the default API without exposing Effect types to default consumers.
 * Pass the returned value as logging.logger to default createClient.
 * Delivery is synchronous. Thrown logger failures are swallowed without retry, while a blocking logger can delay SDK work.
 * No queue, sink flushing or persistence guarantee is added. Native callers use their own Effect logger directly.
 * The SDK supplies safe messages and empty causes, but caller-owned context and sink behavior remain the caller's responsibility
 * @throws ConfigurationError with field logger when the value is not an Effect logger
 * @example
 * ```ts
 * import { Logger } from "effect"
 * import { createClient } from "@neontechspace/fluxerly"
 * import { fromEffectLogger } from "@neontechspace/fluxerly/effect"
 * export function loggingExample(token: string, logger: Logger.Logger<unknown, unknown>) {
 *     return createClient({ token, logging: { development: true, logger: fromEffectLogger(logger) } })
 * }
 * ```
 */
export function fromEffectLogger(logger: Logger.Logger<unknown, unknown>): DefaultLogger {
    return adaptLogger(logger)
}
import type { ClientState, ClientOptions as SharedClientOptions, ConnectionState } from "./client.js"
import type { CachePolicyErrorReport, MessageCacheSettings } from "./cache.js"
export type { CachePolicyErrorReport, MessageCacheSettings } from "./cache.js"

/** Native cache controls, with a scoped reporter in the client's creation context */
export interface MessageCacheOptions<E = never, R = never> extends MessageCacheSettings {
    /**
     * Safe policy reporting in the creation context, independent of REST/event delivery.
     * One custom report at a time. Further failures while busy use the shared operational logger.
     * Reporter failure attempts one safe fallback log. No recursive hook invocation or policy retry.
     * Shutdown interrupts report work and awaits finalizers. Uninterruptible user work can delay closure
     */
    readonly onError?: (report: CachePolicyErrorReport) => Effect.Effect<unknown, E, R>
}

/** Creation-time native settings. Reporting services are captured when creation executes */
export interface ClientOptions<E = never, R = never> extends Omit<SharedClientOptions, "cache" | "logging"> {
    /**
     * Explicit SDK development-log opt-in. Logger, level and tracing remain owned by the executing Effect context.
     * Connection work inherits connect/run context, handler work inherits registration context and cache reports inherit creation context.
     * Shutdown diagnostics use shutdown's execution context. No detached native runtime or logger replacement is installed.
     * Default-only logger/minimumLevel settings are rejected. A throwing logger cannot fail connection diagnostics
     */
    readonly logging?: LoggingOptions
    /** Optional resource retention. Omission retains no resource snapshots */
    readonly cache?: {
        /**
         * Omitted/false disables caching. True or an options object enables global bounded memory-only message snapshots.
         * Eligible REST/events populate, deletes/uncertain writes evict, and gateway gaps clear even after successful resume.
         * Conflicts can produce misses. No automatic history retrieval. Shutdown releases cached references
         */
        readonly messages?: boolean | MessageCacheOptions<E, R>
    }
}
import type { ConfigurationError, ConnectError, ConnectionFailure } from "./errors.js"
import { makeClient } from "#sdk/internal/client"
import { collect, type MessageCollector } from "#sdk/internal/collector"
import type { CollectorOptions, CollectorResult, CollectorFailure, CollectorRegistrationError } from "./collectors.js"
export { CollectorError } from "./collectors.js"
export type { CollectorOptions, CollectorResult, CollectorFailure, CollectorRegistrationError } from "./collectors.js"
import { replyInput } from "#sdk/internal/message"
import type { EventSource } from "#sdk/internal/events"
import {
    MessageError,
    type MessageOperationFailure,
    type EventOverflowError,
    type RegistrationError,
    type SendError,
} from "./message-errors.js"
import type {
    EditMessageInput,
    MessageHistoryQuery,
    Message,
    MessageReference,
    MessageInput,
    MessageOperationOptions,
    ReplyInput,
    SendOptions,
} from "./messages.js"
import type { EventBufferOptions, HandlerOptions, HandlerErrorReport, EventMap, EventName } from "./events.js"

export { EventOverflowError, EventReadBusyError, MessageError, MessageOperationError } from "./message-errors.js"
export type { EventReadError, RegistrationError, SendError, MessageOperationFailure } from "./message-errors.js"
export type {
    Message,
    MessageHistoryQuery,
    MessageDeletion,
    MessageBulkDeletion,
    MessageReference,
    MessageInput,
    ReplyInput,
    AllowedMentions,
    SendOptions,
    EditMessageInput,
    MessageOperationOptions,
} from "./messages.js"
export type { EventBufferOptions, HandlerOptions, HandlerErrorReport, EventMap, EventName } from "./events.js"

/** Scoped subscription controls, separate from client ownership */
export interface Subscription {
    /** Lazy stop request: Discard pending events and interrupt owned handlers without waiting on the invoking handler */
    unsubscribe(): Effect.Effect<void>
    /**
     * Observe retained closure/overflow after native handler cleanup. Interruption cancels only this wait.
     * Defects retain native Cause. Uninterruptible handlers/finalizers can delay closure.
     * Do not await your own completed closure inside a handler
     */
    waitForClose(): Effect.Effect<void, EventOverflowError>
}

/** Native reporting runs in the registration caller's context, not an SDK-owned runtime */
export interface EventHandlerOptions<E = never, R = never> extends HandlerOptions {
    /** Safe handler/overflow reporting. Failure invokes one safe fallback log without retrying the handler */
    readonly onError?: (report: HandlerErrorReport) => Effect.Effect<unknown, E, R>
}

/**
 * Lazy message operations preserving caller context and interruption. REST/local lookup work without a gateway. Collection requires Connected.
 * Closing/Closed reject new work. Remote calls share four active HTTP slots and 256 queued requests or 4 MiB of queued JSON bodies.
 * Each remote call defaults to a 30,000 ms total deadline, including admission and rate waits, with cleanup awaited afterward.
 * Only confirmed rate-limit rejections retry within that deadline, with route-specific and client-global rate waits.
 * Typed failures, defects and interruption retain native channels, including combined cleanup causes.
 * Interruption or client closure awaits owned cleanup but cannot undo a dispatched mutation
 */
export interface Messages {
    /**
     * Lazily register future messageCreate collection in one decimal channel ID within the execution caller's scope.
     * Each execution returns a ready handle before subsequent sends. No history, cache reads, implicit connect or prompt correlation
     *
     * Defaults: One accepted message, 30,000 ms total lifetime, 4 MiB retained Message JSON.
     * Pending intake separately allows 256 payloads or 4 MiB source JSON after channel selection, before synchronous filtering.
     * Options are copied when executed. Budgets are positive safe integers. The timeoutMs maximum is 2,147,483,647
     *
     * The deadline starts when registered, never resets, and excludes messages processed at or after it, including slow filter returns.
     * Count accepted IDs once and retain frozen received snapshots, unaffected by later edits/deletions
     *
     * Filter/overflow failures return no partial messages. Recovery fails with CollectorError connectionLost, without auto restart or resend.
     * Require Connected or fail with CollectorError notConnected. Closing/Closed use ClientClosedError. Invalid settings use ConfigurationError
     *
     * The registration scope stops its collector with partial replies. Client shutdown fails it with ClientClosedError.
     * Interrupting a waiter does not stop collection. Closing its registration scope does. No AbortSignal option or detached runtime.
     * Defects retain native Cause. Slow synchronous filters block JavaScript and cannot be preempted or have their side effects undone
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     *
     * export const askName = (client: Client, channelId: string, userId: string) => Effect.scoped(
     *     Effect.gen(function* () {
     *         const collector = yield* client.messages.collect(channelId, { filter: message => message.author.id === userId })
     *         yield* client.messages.send(channelId, { content: "What should I call you?" })
     *         return yield* collector.waitForClose()
     *     }),
     * )
     * ```
     * The caller supplies a connected client and handles empty timeout results and client lifetime separately
     */
    collect(
        channelId: string,
        options?: CollectorOptions,
    ): Effect.Effect<Collector, CollectorRegistrationError, Scope.Scope>
    /**
     * Lazily read a frozen local observation when executed, never making a request.
     * Disabled, absent, evicted, expired or wrong-channel entries yield undefined, not proof of server absence.
     * Hits update LRU recency without renewing age and do not guarantee current server state.
     * Invalid references fail with MessageOperationError operation get, reason input, outcome notDispatched.
     * Closing/Closed fail with ClientClosedError. Defects and interruption retain native channels
     */
    get(message: MessageReference): Effect.Effect<Message | undefined, MessageOperationFailure>
    /**
     * Send text without requiring a connected gateway. Closing/Closed reject new work
     *
     * Returns the created snapshot after an API response, not gateway delivery or recipient acknowledgement.
     * Notifications default off. Deadline defaults to 30,000 ms across admission, rate waits and HTTP.
     * Enabled caching retains eligible created snapshots without changing send completion or delivery.
     * Shared admission allows four active requests and 256 pending bodies or 4 MiB of pending JSON.
     * Only confirmed rate-limit rejections retry within the deadline. Ambiguous sends never retry automatically
     *
     * Interruption awaits owned HTTP cleanup but cannot undo a server-side creation.
     * Typed failures, defects and interruption retain native channels, including cleanup causes
     */
    send(channelId: string, input: MessageInput, options?: SendOptions): Effect.Effect<Message, SendError>
    /**
     * Lazy reply helper over send. Missing references fail, without unreferenced fallback or default author notification.
     * The returned reply is eligible for the same cache intake as send
     */
    reply(message: MessageReference, input: ReplyInput, options?: SendOptions): Effect.Effect<Message, SendError>
    /**
     * Fetch a frozen message snapshot from Fluxer, never from a cache. Accepts a reference or an existing Message.
     * Returns after decoding the API response and checking its message/channel IDs against the requested target.
     * Missing targets fail with MessageOperationError reason notFound rather than returning an empty value.
     * Enabled caching retains eligible responses, but the returned result does not depend on cache admission.
     * Interrupting the Effect releases only this request and awaits its cleanup
     */
    fetch(message: MessageReference, options?: MessageOperationOptions): Effect.Effect<Message, MessageOperationFailure>
    /**
     * Lazily fetch one remote history page for a decimal channel ID without a gateway connection or cache lookup.
     * Defaults to the latest 50 messages. Query limit is 1 through 100 with at most one before, after or around cursor
     *
     * Each execution returns after HTTP 200 and whole-page validation as a frozen array of frozen Message snapshots, newest first.
     * Empty and short arrays describe currently accessible results, not complete history. Pages are not a shared point-in-time snapshot.
     * No prefetch, automatic traversal or gateway notifications. Use the oldest returned ID as before for an older page
     *
     * Enabled caching admits eligible page members oldest first, so tight limits retain the newest members
     *
     * Invalid input, malformed pages and HTTP rejections are typed MessageOperationError failures with operation fetchHistory. HTTP 404 remains notFound.
     * Shares REST admission and the 30,000 ms default total deadline. Only confirmed rate-limit rejections retry within that budget.
     * Runs in caller context. Interruption releases only this call and awaits cleanup. Closing/Closed fail with ClientClosedError.
     * Defects and interruption retain native causes rather than becoming typed message-operation failures
     */
    fetchHistory(
        channelId: string,
        query?: MessageHistoryQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<readonly Message[], MessageOperationFailure>
    /**
     * Replace text and return the frozen updated snapshot after the API response, without waiting for a gateway event.
     * Required content is sent without trimming. Empty text requests clearing, subject to Fluxer validation.
     * Mentions default off. The SDK omits attachments, embeds and unrelated fields rather than editing them.
     * Fluxer preserves custom embeds but may regenerate text-derived link previews
     *
     * Enabled caching retains eligible responses. An uncertain dispatched edit evicts the old local copy.
     * Missing targets are typed notFound failures. A lost response or timeout after dispatch may leave the edit applied.
     * Uncertain edits never retry automatically. Native interruption cannot undo a dispatched edit
     */
    edit(
        message: MessageReference,
        input: EditMessageInput,
        options?: MessageOperationOptions,
    ): Effect.Effect<Message, MessageOperationFailure>
    /**
     * Delete the target and complete without a value after HTTP 204, without waiting for a gateway event.
     * Missing targets fail with MessageOperationError reason notFound, including a repeated delete.
     * Confirmed deletion and uncertain dispatched deletion evict the local cached copy.
     * A lost response or timeout after dispatch may leave the target deleted. Uncertain deletes never retry automatically.
     * Native interruption awaits owned cleanup but cannot undo a dispatched deletion
     */
    delete(message: MessageReference, options?: MessageOperationOptions): Effect.Effect<void, MessageOperationFailure>
}

/** A scoped native collection, separate from each caller observing it */
export interface Collector {
    /** Lazy idempotent stop, retaining accepted partial replies and releasing collector-owned work */
    stop(): Effect.Effect<void>
    /**
     * Lazily observe the retained frozen result/error after queue, timer, filter and listener cleanup.
     * Multiple/late callers share the first outcome. Interruption affects only this waiter and defects retain Cause.
     * Timeout and stop can return empty/partial replies. Failures carry no partial message bodies.
     * Application-held handles/results retain successful snapshots until released
     */
    waitForClose(): Effect.Effect<CollectorResult, CollectorFailure>
}

export type { ConnectionState } from "./client.js"
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
    /** REST, local lookup and live collection owned by this client */
    readonly messages: Messages
    /**
     * Lazily register one EventMap event in the caller's scope and context, before or after connect.
     * No cache or REST-generated events. Bulk deletions do not also invoke messageDelete handlers.
     * Enabled cache changes happen before user dispatch, independently of subscriptions and their overflow.
     * Defaults: One active invocation, 256 queued payloads, 4 MiB queued source JSON per registration.
     * A bulk payload counts once, including its full bytes. Ordering is per subscription, not across event types.
     * Explicit concurrency permits out-of-order completion. No history or exactly-once delivery is promised
     *
     * Handler failures are isolated and reported without retrying the invocation
     *
     * Overflow stops only this subscription and remains observable through the returned handle.
     * Client or registration-scope closure interrupts handlers and awaits native cleanup.
     * Observe subscription failure alongside client.run/waitForClose. No detached native runtime is created
     */
    on<E, R, E2 = never, R2 = never, K extends EventName = "messageCreate">(
        event: K,
        handler: (message: EventMap[K]) => Effect.Effect<unknown, E, R>,
        options?: EventHandlerOptions<E2, R2>,
    ): Effect.Effect<Subscription, RegistrationError, R | R2 | Scope.Scope>
    /**
     * Lazy bounded stream for one event type in receive order. Each execution owns a subscription without history or bulk fan-out.
     * Enabled cache changes happen before delivery, independently of this subscription and its overflow.
     * Stream scope releases its subscription. Overflow fails this stream rather than silently dropping events.
     * Consumers choose stream concurrency and supervision. Options govern source buffers only
     */
    events<K extends EventName>(
        event: K,
        options?: EventBufferOptions,
    ): Stream.Stream<EventMap[K], RegistrationError | EventOverflowError>
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
     * Release cached references and expiry timers, interrupt the cache reporter and await its finalizers.
     * Uninterruptible reporter work can delay closure.
     * Inside an owned message handler or cache reporter, the client scope performs shutdown and interrupts that invocation.
     * Such an invocation does not resume after shutdown. This avoids waiting on its own cleanup.
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
 * Cache settings are copied and validated here without invoking retention policies or reporters.
 * Unknown cache or message-cache option keys fail validation. Caching is disabled by default
 *
 * Each execution creates a separate client in the caller's owning scope.
 * Cache reporters capture this creation context, including their required services.
 * Closing that scope permanently shuts down the client and releases its credential reference
 *
 * @returns A scoped, lazy creation Effect with ConfigurationError for invalid input.
 * Unexpected creation defects retain their native cause
 */
export function createClient<E = never, R = never>(
    options: ClientOptions<E, R>,
): Effect.Effect<Client, ConfigurationError, Scope.Scope | R> {
    return Effect.gen(function* () {
        // One client-owned scope lets shutdown mark Closing before interrupting its worker
        const scope = Scope.makeUnsafe()
        const owner = yield* makeClient(options, scope, true)
        yield* Effect.addFinalizer((exit) => owner.shutdown().pipe(Effect.ensuring(Scope.close(scope, exit))))
        return Object.freeze({
            messages: Object.freeze({
                collect: (channelId: string, options?: CollectorOptions) =>
                    Effect.uninterruptible(
                        Effect.gen(function* () {
                            const callerScope = yield* Effect.scope
                            const source = yield* collect(owner, channelId, options)
                            // A scoped waiter releases its registration when done, rather than retaining every completed collector until scope closure
                            yield* Effect.forkIn(
                                Deferred.await(source.closed).pipe(
                                    Effect.asVoid,
                                    Effect.interruptible,
                                    Effect.onExit(() => Effect.sync(() => source.stop())),
                                    Effect.catchCause(() => Effect.void),
                                ),
                                callerScope,
                                { uninterruptible: true },
                            )
                            return nativeCollector(source)
                        }),
                    ),
                get: (target: MessageReference) => owner.get(target),
                send: (channelId: string, input: MessageInput, options?: SendOptions) =>
                    owner.send(channelId, input, options),
                reply: (target: MessageReference, input: ReplyInput, options?: SendOptions) =>
                    Effect.suspend(() => {
                        const data = replyInput(target, input)
                        return data instanceof MessageError
                            ? Effect.fail(data)
                            : owner.send(target.channelId, data, options)
                    }),
                fetch: (target: MessageReference, options?: MessageOperationOptions) => owner.fetch(target, options),
                fetchHistory: (channelId: string, query?: MessageHistoryQuery, options?: MessageOperationOptions) =>
                    owner.fetchHistory(channelId, query, options),
                edit: (target: MessageReference, input: EditMessageInput, options?: MessageOperationOptions) =>
                    owner.edit(target, input, options),
                delete: (target: MessageReference, options?: MessageOperationOptions) => owner.delete(target, options),
            }),
            on: <E, R, E2 = never, R2 = never, K extends EventName = "messageCreate">(
                event: K,
                handler: (message: EventMap[K]) => Effect.Effect<unknown, E, R>,
                options?: EventHandlerOptions<E2, R2>,
            ) =>
                Effect.gen(function* () {
                    const callerScope = yield* Effect.scope
                    const source = yield* owner.events.on(event, handler, options, options?.onError, callerScope)
                    return nativeSubscription(source)
                }),
            events: <K extends EventName>(event: K, options?: EventBufferOptions) =>
                owner.events.stream(event, options),
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

function nativeSubscription(source: Pick<EventSource, "stop" | "closed">): Subscription {
    return Object.freeze({
        unsubscribe: () => Effect.sync(() => source.stop()),
        waitForClose: () => Deferred.await(source.closed),
    })
}

function nativeCollector(source: MessageCollector): Collector {
    return Object.freeze({
        stop: () => Effect.sync(() => source.stop()),
        waitForClose: () => Deferred.await(source.closed),
    })
}
