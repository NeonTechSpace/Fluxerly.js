import { Deferred, Effect, Scope, type Stream } from "effect"
import type { ClientState, ClientOptions, ConnectionState } from "./client.js"
import type { ConfigurationError, ConnectError, ConnectionFailure } from "./errors.js"
import { makeClient } from "#sdk/internal/client"
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
 * Lazy message operations that preserve caller context and interruption, callable without a gateway connection.
 * Closing/Closed reject new work. Calls share four active HTTP slots and 256 queued requests or 4 MiB of queued JSON bodies.
 * Each call defaults to a 30,000 ms total deadline, including admission and rate waits, with cleanup awaited afterward.
 * Only confirmed rate-limit rejections retry within that deadline, with route-specific and client-global rate waits.
 * Typed failures, defects and interruption retain native channels, including combined cleanup causes.
 * Interruption or client closure awaits owned cleanup but cannot undo a dispatched mutation
 */
export interface Messages {
    /**
     * Send text without requiring a connected gateway. Closing/Closed reject new work
     *
     * Returns the created snapshot after an API response, not gateway delivery or recipient acknowledgement.
     * Notifications default off. Deadline defaults to 30,000 ms across admission, rate waits and HTTP.
     * Shared admission allows four active requests and 256 pending bodies or 4 MiB of pending JSON.
     * Only confirmed rate-limit rejections retry within the deadline. Ambiguous sends never retry automatically
     *
     * Interruption awaits owned HTTP cleanup but cannot undo a server-side creation.
     * Typed failures, defects and interruption retain native channels, including cleanup causes
     */
    send(channelId: string, input: MessageInput, options?: SendOptions): Effect.Effect<Message, SendError>
    /** Lazy reply helper over send. Missing references fail, without unreferenced fallback or default author notification */
    reply(message: MessageReference, input: ReplyInput, options?: SendOptions): Effect.Effect<Message, SendError>
    /**
     * Fetch a frozen message snapshot from Fluxer, never from a cache. Accepts a reference or an existing Message.
     * Returns after decoding the API response and checking its message/channel IDs against the requested target.
     * Missing targets fail with MessageOperationError reason notFound rather than returning an empty value.
     * Interrupting the Effect releases only this request and awaits its cleanup
     */
    fetch(message: MessageReference, options?: MessageOperationOptions): Effect.Effect<Message, MessageOperationFailure>
    /**
     * Lazily fetch one remote history page for a decimal channel ID without a gateway connection or cache lookup.
     * Defaults to the latest 50 messages. Query limit is 1 through 100 with at most one before, after or around cursor
     *
     * Each execution returns after HTTP 200 and whole-page validation as a frozen array of frozen Message snapshots, newest first.
     * Empty and short arrays describe currently accessible results, not complete history. Pages are not a shared point-in-time snapshot.
     * No prefetch, automatic traversal, gateway notifications or retained history. Use the oldest returned ID as before for an older page
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
     * Fluxer preserves custom embeds but may regenerate text-derived link previews.
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
     * A lost response or timeout after dispatch may leave the target deleted. Uncertain deletes never retry automatically.
     * Native interruption awaits owned cleanup but cannot undo a dispatched deletion
     */
    delete(message: MessageReference, options?: MessageOperationOptions): Effect.Effect<void, MessageOperationFailure>
}

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
    /** Message operations using this client's credentials, bounded admission and rate-limit state */
    readonly messages: Messages
    /**
     * Lazily register one EventMap event in the caller's scope and context, before or after connect.
     * No cache or REST-generated events. Bulk deletions do not also invoke messageDelete handlers.
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
     * When invoked inside an owned message handler, the client scope performs shutdown and interrupts that handler.
     * Such a handler does not resume after shutdown. This avoids waiting on its own cleanup.
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
            messages: Object.freeze({
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
