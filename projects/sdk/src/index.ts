import { Cause, Deferred, Effect, Exit, Scope } from "effect"
export type {
    EmbedInput,
    EmbedAuthorInput,
    EmbedFooterInput,
    EmbedMediaInput,
    EmbedFieldInput,
    Embed,
    EmbedChild,
    EmbedAuthor,
    EmbedFooter,
    EmbedMedia,
    EmbedField,
} from "./embeds.js"
export type { MessageBody } from "./messages.js"
export type { Attachment, AttachmentInput, AttachmentReference } from "./attachments.js"
import { err, ok, ResultAsync, type Result } from "neverthrow"
export type { LoggingOptions, DefaultLoggingOptions, DefaultLogger } from "./logging.js"
export type { CachePolicyErrorReport, MessageCacheSettings, MessageCacheOptions } from "./cache.js"
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
import { collect, type MessageCollector } from "#sdk/internal/collector"
import {
    type CollectorError,
    type CollectorFailure,
    type CollectorRegistrationError,
    type CollectorResult,
    type DefaultCollectorOptions,
} from "./collectors.js"
export { CollectorError } from "./collectors.js"
export type {
    CollectorOptions,
    DefaultCollectorOptions,
    CollectorResult,
    CollectorFailure,
    CollectorRegistrationError,
} from "./collectors.js"
import { replyInput } from "#sdk/internal/message"
import type { EventSource } from "#sdk/internal/events"
import {
    MessageError,
    MessageOperationError,
    type MessageOperationFailure,
    type EventOverflowError,
    type EventReadError,
    type RegistrationError,
    type SendError,
} from "./message-errors.js"
import type {
    EditMessageInput,
    MessageHistoryQuery,
    Message,
    MessageReference,
    MessageInput,
    ReplyInput,
    DefaultMessageOperationOptions,
    DefaultSendOptions,
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
    DefaultSendOptions,
    EditMessageInput,
    MessageOperationOptions,
    DefaultMessageOperationOptions,
} from "./messages.js"
export type { EventBufferOptions, HandlerOptions, HandlerErrorReport, EventMap, EventName } from "./events.js"

/** Subscription-local controls. Closing a subscription does not close the client */
export interface Subscription {
    /** Stop new deliveries, discard pending events and signal active callbacks. Cannot forcibly stop application promises */
    unsubscribe(): void
    /**
     * Observe retained closure or overflow after SDK cleanup, not completion of arbitrary application promises.
     * Cancelling this wait affects only the wait. Late observers retain the same outcome.
     * Unexpected cleanup defects reject with SdkDefect
     */
    waitForClose(options?: OperationOptions): ResultAsync<void, EventOverflowError | CancelledError>
}

/** Live subscription for one event type without subscription history. The default type preserves existing messageCreate annotations */
export interface EventSubscription<K extends EventName = "messageCreate"> extends Subscription {
    /**
     * Read the next payload for this event name, or null after normal closure. Only one pending read is accepted.
     * Concurrent reads return EventReadBusyError. Cancellation releases only this read.
     * Overflow remains a typed failure after the queue is discarded. SDK defects reject with SdkDefect
     */
    next(options?: OperationOptions): ResultAsync<EventMap[K] | null, EventReadError | CancelledError>
}

/** Default callback scheduling and optional safe error reporting */
export interface EventHandlerOptions extends HandlerOptions {
    /**
     * Report failures without payloads. Reporter failure produces one safe fallback log, never a retry.
     * At most one custom report is outstanding per registration. Further reports use the default logger while it is busy.
     * Reporter promises remain application-owned and do not delay subscription closure
     */
    readonly onError?: (report: HandlerErrorReport) => void | Promise<void>
}

/**
 * Client-owned message operations. REST and local lookup work without a gateway connection. Collection requires Connected.
 * Remote calls share four active HTTP slots and at most 256 queued requests or 4 MiB of queued JSON bodies.
 * Each remote call defaults to a 30,000 ms total deadline, including admission and rate waits, with cleanup awaited afterward.
 * Only confirmed rate-limit rejections retry within that deadline, with route-specific and client-global rate waits.
 * Expected failures use Err. SDK/cleanup defects reject remote calls with SdkDefect and throw from synchronous get.
 * Cancellation fails this operation with CancelledError. Client closure fails pending/new operations with ClientClosedError.
 * Neither failure proves that a dispatched mutation was undone
 */
export interface Messages {
    /**
     * Start a bounded collection of future messageCreate observations in one decimal channel ID.
     * Returns a ready handle synchronously. Register before sending a prompt. No history, cache reads or implicit connection
     *
     * Defaults: One accepted message, 30,000 ms total lifetime, 4 MiB retained Message JSON.
     * Pending intake is separately bounded to 256 payloads or 4 MiB source JSON, after channel selection and before filtering.
     * Options are copied at registration. Positive safe integer budgets are required. The timeoutMs maximum is 2,147,483,647.
     * Timeout starts at registration, never resets, and excludes messages processed at or after the deadline
     *
     * Selection is synchronous and counts each accepted ID once. Edits/deletions leave received snapshots unchanged.
     * Filter failure or either byte/queue overflow ends only this collector, without partial messages in the error.
     * Recovery fails collection with CollectorError connectionLost even if the client later resumes. No automatic restart or resend
     *
     * Non-connected registration fails with CollectorError notConnected. Closing/Closed use ClientClosedError.
     * Invalid settings use ConfigurationError. The optional signal controls collection and abort returns CancelledError.
     * An already-aborted signal starts no collection. Unexpected registration defects throw SdkDefect
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     *
     * export async function askName(client: Client, channelId: string, userId: string) {
     *     const opened = client.messages.collect(channelId, { filter: message => message.author.id === userId })
     *     if (opened.isErr()) throw opened.error
     *     const collector = opened.value
     *     try {
     *         const sent = await client.messages.send(channelId, { content: "What should I call you?" })
     *         if (sent.isErr()) throw sent.error
     *         const result = await collector.waitForClose()
     *         if (result.isErr()) throw result.error
     *         return result.value
     *     } finally {
     *         collector.stop()
     *     }
     * }
     * ```
     * The caller supplies a connected client and handles empty timeout results and client lifetime separately
     */
    collect(
        channelId: string,
        options?: DefaultCollectorOptions,
    ): Result<Collector, CollectorRegistrationError | CancelledError>
    /**
     * Read this client's local retained snapshot synchronously, never making a request.
     * Disabled caching, absent/evicted/expired entries and a mismatched channel return Ok(undefined), not server absence.
     * Hits return frozen observations, not guaranteed current server state, and update LRU recency without renewing age.
     * Invalid references return MessageOperationError with operation get, reason input and outcome notDispatched.
     * Closing/Closed return ClientClosedError. Unexpected synchronous defects throw SdkDefect
     */
    get(message: MessageReference): Result<Message | undefined, MessageOperationFailure>
    /**
     * Send text, embeds and/or files and return the decoded message after HTTP, not gateway delivery or recipient acknowledgement
     *
     * File bytes are snapshotted on invocation, up to 50 MiB per file and the separate uploads.maxBytes client budget.
     * Full upload admission fails with busy before copying. No path access or downloads; servers may impose lower limits.
     * Cleanup releases owned bytes; failed uploads may leave temporary server data, with no physical-erasure guarantee
     *
     * Mentions are disabled by default. Total budget defaults to 30,000 ms including admission and rate waits.
     * Enabled caching retains eligible created snapshots without changing send completion or delivery
     *
     * One client admits four active HTTP requests and at most 256 pending bodies or 4 MiB of pending JSON.
     * Confirmed rate-limit rejections may retry within that budget. Uncertain sends never retry automatically
     *
     * Cancellation after dispatch may leave a created message. There is no rollback or exactly-once guarantee.
     * Expected failures use Err. SDK/cleanup defects reject with SdkDefect
     */
    send(
        channelId: string,
        input: MessageInput,
        options?: DefaultSendOptions,
    ): ResultAsync<Message, SendError | CancelledError>
    /**
     * Reference an existing message through send. Missing targets fail rather than falling back to an unreferenced send.
     * The returned reply is eligible for the same cache intake as send.
     * File inputs use send's snapshot, size, budget and cleanup rules
     */
    reply(
        message: MessageReference,
        input: ReplyInput,
        options?: DefaultSendOptions,
    ): ResultAsync<Message, SendError | CancelledError>
    /**
     * Fetch a frozen message snapshot from Fluxer, never from a cache. Accepts a reference or an existing Message.
     * Returns after the API response is decoded and its message/channel IDs match the requested target.
     * Missing targets fail with MessageOperationError reason notFound rather than returning an empty value.
     * Enabled caching retains eligible responses, but the returned result does not depend on cache admission.
     * Cancellation releases only this request and awaits its cleanup
     */
    fetch(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, MessageOperationFailure | CancelledError>
    /**
     * Fetch one remote history page for a decimal channel ID, without requiring a gateway connection or consulting a cache.
     * Defaults to the latest 50 messages. Query limit is 1 through 100 with at most one before, after or around cursor
     *
     * Returns after HTTP 200 and validation of the entire page as a frozen array of frozen Message snapshots, newest first.
     * Empty and short arrays describe currently accessible results, not complete history. Pages are not a shared point-in-time snapshot.
     * No prefetch, automatic traversal or gateway notifications. Use the oldest returned ID as before for an older page
     *
     * Enabled caching admits eligible page members oldest first, so tight limits retain the newest members
     *
     * Invalid input, malformed pages and HTTP rejections use MessageOperationError with operation fetchHistory. HTTP 404 remains notFound.
     * Shares REST admission and the 30,000 ms default total deadline. Only confirmed rate-limit rejections retry within that budget.
     * Cancellation affects only this call and awaits cleanup. Closing/Closed fail with ClientClosedError and defects reject with SdkDefect
     */
    fetchHistory(
        channelId: string,
        query?: MessageHistoryQuery,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<readonly Message[], MessageOperationFailure | CancelledError>
    /**
     * Replace text/embeds/files and return the frozen updated snapshot after the API response, without waiting for a gateway event.
     * Supplied values replace those fields; omitted values are not sent. No hidden fetch or cache merge
     *
     * List retained attachment IDs alongside new uploads; unknown IDs may be ignored by Fluxer
     *
     * Clear files with attachments: [] and nonempty text or embeds. Uploads use send's snapshot, budget and cleanup rules
     *
     * To remove embeds, send nonempty content alongside embeds: []; an empty edit alone is rejected by Fluxer.
     * Empty content requests clearing text, subject to Fluxer validation. Mentions default off.
     * Omitted rich embeds are preserved, but Fluxer may regenerate text-derived link previews
     *
     * Enabled caching retains eligible responses. An uncertain dispatched edit evicts the old local copy.
     * A lost response or timeout after dispatch may leave the edit applied. Uncertain edits never retry automatically.
     * Missing targets remain typed notFound failures. Cancellation/closure cannot undo a dispatched edit
     */
    edit(
        message: MessageReference,
        input: EditMessageInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, MessageOperationFailure | CancelledError>
    /**
     * Delete the target and complete without a value after HTTP 204, without waiting for a gateway event.
     * Missing targets fail with MessageOperationError reason notFound, including a repeated delete.
     * Confirmed deletion and uncertain dispatched deletion evict the local cached copy.
     * A lost response or timeout after dispatch may leave the target deleted. Uncertain deletes never retry automatically.
     * Cancellation/closure awaits owned cleanup but cannot undo a dispatched deletion
     */
    delete(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError>
}

/** One default collection, independent of observers and the client's connection lifetime */
export interface Collector {
    /** Stop synchronously, returning accepted partial replies through waitForClose. Repeated stops preserve the first outcome */
    stop(): void
    /**
     * Observe the retained frozen result after timer, queue, filter and listener cleanup.
     * Multiple and late observers share the same result/error. Cancelling this wait affects only this observer.
     * Timeout/stop may return empty results. Collection cancellation, filter/overflow/gap failure or client closure returns Err without partial replies.
     * Unexpected SDK defects reject with SdkDefect. Keeping the handle/result retains successful message snapshots in memory
     */
    waitForClose(options?: OperationOptions): ResultAsync<CollectorResult, CollectorFailure | CancelledError>
}

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
    /** REST, local lookup and live collection owned by this client */
    readonly messages: Messages
    /**
     * Register a callback for one EventMap event before or after connect. No cached history or REST-generated events.
     * Enabled cache changes happen before user dispatch, independently of subscriptions and their overflow.
     * Each subscription receives only its event type. Bulk deletions do not also invoke messageDelete handlers
     *
     * Default concurrency is 1. Receive-order starts do not imply completion order when concurrency is increased.
     * Buffer defaults are 256 pending event payloads and 4 MiB of source JSON, not a process heap cap.
     * A bulk payload counts once, including its full bytes. Ordering is per subscription, not across event types
     *
     * Overflow stops only this subscription. Handler failure is reported without retrying the invocation.
     * Return/await callback work and inspect send Err values. Unawaited application work is not owned by the SDK
     *
     * The second argument requests cooperative cancellation on unsubscribe or shutdown.
     * Observe the returned subscription's terminal outcome as well as the client's run/waitForClose outcome.
     * Local registration failures use Result. Unexpected synchronous defects throw SdkDefect
     */
    on<K extends EventName>(
        event: K,
        handler: (message: EventMap[K], signal: NonNullable<OperationOptions["signal"]>) => void | Promise<void>,
        options?: EventHandlerOptions,
    ): Result<Subscription, RegistrationError>
    /**
     * Open one event type's bounded pull subscription in receive order without subscription history or bulk fan-out.
     * Enabled cache changes happen before delivery, independently of this subscription and its overflow.
     * Local errors use Result and defects throw SdkDefect
     */
    events<K extends EventName>(event: K, options?: EventBufferOptions): Result<EventSubscription<K>, RegistrationError>
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
     * Release cached message references and expiry timers, without waiting for application-owned reporter promises.
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

const executeOperation = <
    A,
    E extends ConnectError | EventReadError | MessageError | MessageOperationError | CollectorError,
>(
    effect: Effect.Effect<A, E>,
    operation: Operation,
    options?: OperationOptions,
) => {
    const signal = options?.signal
    if (signal?.aborted) return new ResultAsync<A, E | CancelledError>(Promise.resolve(err(new CancelledError())))
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

function defaultCollector(source: MessageCollector): Collector {
    return Object.freeze({
        stop: () => source.stop(),
        waitForClose: (options?: OperationOptions) =>
            executeOperation(Deferred.await(source.closed), "collector.waitForClose", options),
    })
}

function fromExit<
    A,
    E extends
        ConnectError | ConfigurationError | EventReadError | MessageError | MessageOperationError | CollectorError,
>(exit: Exit.Exit<A, E>, operation: Operation): Result<A, E | CancelledError> {
    if (Exit.isSuccess(exit)) return ok(exit.value)
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
 * Validate configuration locally without authenticating the token
 *
 * Cache settings are copied and validated here without invoking retention policies or reporters.
 * Unknown cache or message-cache option keys fail validation. Caching is disabled by default.
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
    const execute = <
        A,
        E extends ConnectError | EventReadError | MessageError | MessageOperationError | CollectorError,
    >(
        effect: Effect.Effect<A, E>,
        operation: Operation,
        options?: OperationOptions,
    ) => executeOperation(owner.logging.provide(effect), operation, options)
    const subscription = (source: Pick<EventSource, "stop" | "closed">): Subscription =>
        Object.freeze({
            unsubscribe: () => source.stop(),
            waitForClose: (options?: OperationOptions) =>
                execute(Deferred.await(source.closed), "subscription.waitForClose", options),
        })
    const register = <A>(
        effect: Effect.Effect<A, RegistrationError>,
        operation: "on" | "events",
    ): Result<A, RegistrationError> => {
        const exit = Effect.runSyncExit(owner.logging.provide(effect))
        if (Exit.isSuccess(exit)) return ok(exit.value)
        if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) throw new SdkDefect(operation)
        const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (reason?._tag === "Fail") return err(reason.error)
        throw new SdkDefect(operation)
    }
    return ok(
        Object.freeze({
            messages: Object.freeze({
                collect: (
                    channelId: string,
                    options?: DefaultCollectorOptions,
                ): Result<Collector, CollectorRegistrationError | CancelledError> => {
                    const opened = fromExit(Effect.runSyncExit(collect(owner, channelId, options, true)), "collect")
                    return opened.map(defaultCollector)
                },
                get: (target: MessageReference): Result<Message | undefined, MessageOperationFailure> => {
                    const exit = Effect.runSyncExit(owner.get(target))
                    if (Exit.isSuccess(exit)) return ok(exit.value)
                    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) throw new SdkDefect("get")
                    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                    if (failure?._tag === "Fail") return err(failure.error)
                    throw new SdkDefect("get")
                },
                send: (channelId: string, input: MessageInput, options?: DefaultSendOptions) =>
                    execute(owner.send(channelId, input, options), "send", options),
                reply: (target: MessageReference, input: ReplyInput, options?: DefaultSendOptions) => {
                    const data = replyInput(target, input)
                    return execute(
                        data instanceof MessageError ? Effect.fail(data) : owner.send(target.channelId, data, options),
                        "reply",
                        options,
                    )
                },
                fetch: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.fetch(target, options), "fetch", options),
                fetchHistory: (
                    channelId: string,
                    query?: MessageHistoryQuery,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.fetchHistory(channelId, query, options), "fetchHistory", options),
                edit: (target: MessageReference, input: EditMessageInput, options?: DefaultMessageOperationOptions) =>
                    execute(owner.edit(target, input, options), "edit", options),
                delete: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.delete(target, options), "delete", options),
            }),
            on: <K extends EventName>(
                event: K,
                handler: (
                    message: EventMap[K],
                    signal: NonNullable<OperationOptions["signal"]>,
                ) => void | Promise<void>,
                options?: EventHandlerOptions,
            ) => {
                if (typeof handler !== "function")
                    return err(new ConfigurationError("handler", "Handler must be a function"))
                if (options?.onError !== undefined && typeof options.onError !== "function")
                    return err(new ConfigurationError("onError", "Error reporter must be a function"))
                const reporter = options?.onError
                let reporting = false
                const reportFailure = (kind: string) => {
                    Effect.runSyncExit(
                        owner.logging.provide(Effect.logError(`Fluxerly message subscription ${kind} failure`)),
                    )
                }
                return register(
                    owner.events
                        .on(
                            event,
                            (message) =>
                                Effect.tryPromise({
                                    try: (signal) => Promise.resolve(handler(message, signal)),
                                    catch: () => new Error("Event handler failed"),
                                }),
                            options,
                            reporter
                                ? (report) =>
                                      Effect.sync(() => {
                                          if (reporting) {
                                              reportFailure(report.kind)
                                              return
                                          }
                                          reporting = true
                                          void Promise.resolve()
                                              .then(() => reporter(report))
                                              .catch(() => reportFailure(`${report.kind}; reporter`))
                                              .finally(() => {
                                                  reporting = false
                                              })
                                      })
                                : undefined,
                            scope,
                        )
                        .pipe(Effect.map(subscription)),
                    "on",
                )
            },
            events: <K extends EventName>(event: K, options?: EventBufferOptions) =>
                register(
                    owner.events.open(event, options).pipe(
                        Effect.map((source): EventSubscription<K> =>
                            Object.freeze({
                                ...subscription(source),
                                next: (options?: OperationOptions) => execute(source.next(), "next", options),
                            }),
                        ),
                    ),
                    "events",
                ),
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
                    Effect.runPromiseExit(
                        owner.logging.provide(owner.shutdown().pipe(Effect.ensuring(Scope.close(scope, Exit.void)))),
                    ).then((exit) => {
                        const result = fromExit(exit, "shutdown")
                        if (result.isErr()) throw new SdkDefect("shutdown")
                        return ok(undefined)
                    }),
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
                            Effect.runSyncExit(owner.logging.provide(Effect.logError("Fluxerly state observer failed")))
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
