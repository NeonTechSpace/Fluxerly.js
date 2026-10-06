/**
 * Default adapters: The default API side of operation table entries that need more than execution, such as byte streams,
 * member chunk iterators, collectors, typing tasks and cache reads.
 * Invariant: Each adapter keeps the same shared Effect as its native counterpart, starts work as the default API documents,
 * and releases signal listeners and sources on every exit. Implements [SDK contracts: Public API model](/docs/SDK-CONTRACTS.md#public-api-model)
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { err, ok, type Result } from "neverthrow"
import {
    AttachmentDownloadError,
    type Attachment,
    type AttachmentDownloadFailure,
    type DefaultAttachmentStreamOptions,
} from "#sdk/attachments"
import type { CacheEntriesOptions, CachedResources, CacheKind, OperationOptions } from "#sdk/client"
import type {
    CollectorFailure,
    CollectorResult,
    DefaultCollectorOptions,
    DefaultReactionCollectorOptions,
    ReactionCollectorResult,
} from "#sdk/collectors"
import { ApplicationError, CancelledError, ConfigurationError, SdkDefect } from "#sdk/errors"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import {
    MemberChunkError,
    type DefaultMemberChunkOptions,
    type MemberChunk,
    type MemberChunkFailure,
    type MemberChunkQuery,
} from "#sdk/member-chunks"
import { MessageOperationError } from "#sdk/message-errors"
import type { DefaultMessageOperationOptions, MessageCore, MessageReference } from "#sdk/messages"
import type { Collector, ReactionCollector } from "#sdk/api/default/collectors"
import type { DefaultInstanceResolveOptions } from "#sdk/api/default/instance"
import { collect, type MessageCollector } from "#sdk/internal/collector"
import { defectReason, readCaller, readInput, suspendMarked } from "#sdk/internal/defects"
import { memberChunkIterationOptions } from "#sdk/internal/member-chunks"
import { operationSignalError } from "#sdk/internal/operation-signal"
import { collectReactions } from "#sdk/internal/reaction-collector"
import type { AttachmentDownloadSource } from "#sdk/internal/rest"
import type { DefaultRestRequest } from "#sdk/rest"
import { throwIfErr } from "#sdk/internal/failures"
import { executeOperation, fromExit, localValue, type DefaultContext } from "./execute.js"

/**
 * Open a default collector handle. Misuse, meaning invalid options, throws, while a runtime condition such as a gateway
 * that is not ready, a pre-aborted signal or a client that began shutting down becomes a closed handle whose result
 * returns that failure. Shutdown can race a still-running handler that registers, so a closing client is not misuse
 */
function openCollector<S, H>(
    exit: Exit.Exit<S, unknown>,
    operation: "collect" | "collectReactions",
    handle: (source: S) => H,
    failed: (failure: CollectorFailure | CancelledError) => H,
): H {
    const opened: Result<S, unknown> = fromExit(exit as Exit.Exit<S, never>, operation)
    if (opened.isOk()) return handle(opened.value)
    const error = opened.error
    if (error instanceof ConfigurationError) throw error
    return failed(error as CollectorFailure | CancelledError)
}

/** A collector that never started, whose result is the registration failure */
function failedCollector<A>(
    failure: CollectorFailure | CancelledError,
    operation: "collector.result" | "reactionCollector.result",
) {
    const result = (options?: OperationOptions) =>
        executeOperation(
            Effect.fail(failure) as Effect.Effect<A, CollectorFailure | CancelledError>,
            operation,
            options,
        )
    return Object.freeze({
        // Nothing started, so there is nothing to close
        close: () => undefined,
        result,
        [Symbol.asyncDispose]: async () => {},
    })
}

function defaultCollector<M extends MessageCore>(source: MessageCollector<M>): Collector<M> {
    const result = (options?: OperationOptions) =>
        executeOperation(Deferred.await(source.closed), "collector.result", options)
    return Object.freeze({
        close: () => source.stop(),
        result,
        [Symbol.asyncDispose]: async () => {
            source.stop()
            // The collection outcome stays readable through result, so disposal only awaits cleanup
            await result()
        },
    })
}

function collectorHandler<A>(handler: (item: A, signal: AbortSignal) => unknown) {
    return (item: A) =>
        Effect.suspend(() => {
            const controller = new AbortController()
            let settled: Promise<void> = Promise.resolve()
            return Effect.callback<void, unknown>((resume) => {
                settled = Promise.resolve()
                    .then(() => handler(item, controller.signal))
                    // An Err result from the callback fails collection like a throw of its error
                    .then(throwIfErr)
                    .then(
                        () => {
                            resume(Effect.void)
                        },
                        (error: unknown) => {
                            // The collector keeps this value as its CollectorError cause
                            resume(Effect.fail(error))
                        },
                    )
            }).pipe(
                Effect.ensuring(
                    Effect.promise(async () => {
                        controller.abort()
                        await settled
                    }),
                ),
            )
        })
}

function defaultTypingTask<A>(task: (signal: AbortSignal) => PromiseLike<A>) {
    return Effect.suspend(() => {
        const controller = new AbortController()
        let settled: Promise<A> = Promise.resolve(undefined as A)
        return Effect.callback<A>((resume) => {
            settled = Promise.resolve().then(() => task(controller.signal))
            void settled.then(
                (value) => resume(Effect.succeed(value)),
                (error: unknown) => resume(Effect.die(new ApplicationError("keepTyping task", error))),
            )
        }).pipe(
            Effect.onExit((exit) =>
                Effect.promise(async () => {
                    controller.abort()
                    // The callback already delivered a settled task rejection as this exit's defect
                    // Only a rejection that arrives while cancellation is cleaning up needs another Cause reason
                    if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) return
                    await settled
                }),
            ),
        )
    })
}

export const defaultMemberChunks =
    <M extends MessageCore>({ owner, execute }: DefaultContext<M>) =>
    (
        guildId: string,
        query: MemberChunkQuery,
        options?: DefaultMemberChunkOptions,
    ): AsyncIterable<Result<MemberChunk, MemberChunkFailure | CancelledError | ConfigurationError>> =>
        Object.freeze({
            async *[Symbol.asyncIterator]() {
                const operation = "members.iterateChunks"
                const opened = await execute(
                    Effect.gen(function* () {
                        // Read the caller options and signal once, where a throw is an application fault
                        const copied = yield* readInput(() => {
                            const signal = (options as { readonly signal?: OperationOptions["signal"] } | undefined)
                                ?.signal
                            return operationSignalError(signal) ?? memberChunkIterationOptions(options, signal)
                        })
                        if (copied instanceof ConfigurationError) return yield* Effect.fail(copied)
                        if (copied instanceof InputValidationFailure)
                            return yield* Effect.fail(
                                new MemberChunkError({ reason: "input", inputValidation: copied.detail }),
                            )
                        if (yield* readInput(() => copied.signal?.aborted)) return yield* Effect.interrupt
                        const source = yield* owner.memberChunks.open(guildId, query, copied.request)
                        if (copied.signal) source.bindSignal(copied.signal)
                        return source
                    }),
                    operation,
                )
                if (opened.isErr()) {
                    yield err(opened.error)
                    return
                }
                const source = opened.value
                try {
                    while (true) {
                        const result = await execute(source.next, operation)
                        if (result.isErr()) {
                            yield err(result.error)
                            return
                        }
                        if (result.value === undefined) return
                        yield ok(result.value)
                    }
                } finally {
                    await execute(source.close, operation)
                }
            },
        })
export const defaultAttachmentStream =
    <M extends MessageCore>({ owner }: DefaultContext<M>) =>
    (
        attachment: Attachment,
        options: DefaultAttachmentStreamOptions,
    ): AsyncIterable<Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>> => {
        let consumed = false
        return Object.freeze({
            [Symbol.asyncIterator](): AsyncIterator<
                Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
            > {
                if (consumed) {
                    let delivered = false
                    return {
                        async next() {
                            if (delivered) return { done: true, value: undefined }
                            delivered = true
                            return { done: false, value: err(new AttachmentDownloadError({ reason: "busy" })) }
                        },
                        async return() {
                            return { done: true, value: undefined }
                        },
                        async throw(
                            error?: unknown,
                        ): Promise<
                            IteratorResult<
                                Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
                            >
                        > {
                            throw error
                        },
                    }
                }
                consumed = true
                const controller = new AbortController()
                let removeSignal: (() => void) | undefined
                let source: AttachmentDownloadSource | undefined
                let opening:
                    | Promise<Exit.Exit<AttachmentDownloadSource, AttachmentDownloadFailure | ConfigurationError>>
                    | undefined
                let cleanup: Promise<Exit.Exit<void>> | undefined
                let closed = false
                let bound = false
                let pulling = false
                const releaseSignal = () => {
                    const remove = removeSignal
                    removeSignal = undefined
                    remove?.()
                }
                const open = () =>
                    (opening ??= Effect.runPromiseExit(
                        owner.logging.provide(
                            // Reading the caller options and calling the caller signal are marked as application input
                            suspendMarked<
                                AttachmentDownloadSource,
                                AttachmentDownloadFailure | ConfigurationError,
                                never
                            >(() => {
                                const signal = readCaller(() => options?.signal)
                                const invalidSignal = readCaller(() => operationSignalError(signal))
                                if (invalidSignal) return Effect.fail(invalidSignal)
                                if (signal) {
                                    const abort = () => controller.abort()
                                    // Record ownership before invoking a caller-controlled registration method
                                    removeSignal = () => signal.removeEventListener("abort", abort)
                                    readCaller(() => signal.addEventListener("abort", abort, { once: true }))
                                    if (readCaller(() => signal.aborted)) {
                                        abort()
                                        return Effect.interrupt
                                    }
                                }
                                return owner.streamAttachment(attachment, options)
                            }),
                        ),
                        { signal: controller.signal },
                    ))
                const detach = () =>
                    (cleanup ??= (async () => {
                        // Listener failure must not prevent cancellation, body closure or reservation release
                        const removed = await Effect.runPromiseExit(
                            suspendMarked(() => {
                                readCaller(releaseSignal)
                                return Effect.void
                            }),
                        )
                        const aborted = await Effect.runPromiseExit(Effect.sync(() => controller.abort()))
                        const opened = opening && (await opening)
                        const cleaned =
                            opened && Exit.isSuccess(opened)
                                ? await Effect.runPromiseExit((source ?? opened.value).closeEffect)
                                : Exit.void
                        const cause = [removed, aborted, cleaned].reduce(
                            (cause, exit) => (Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause),
                            Cause.empty as Cause.Cause<never>,
                        )
                        return cause.reasons.length ? Exit.failCause(cause) : Exit.void
                    })())
                const bind = () => {
                    if (bound) return
                    bound = true
                    // The caller signal removal is a marked read, so its throw is reported as an application fault
                    source!.bindSignal(controller.signal, () => readCaller(releaseSignal))
                }
                return {
                    async next(): Promise<
                        IteratorResult<
                            Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
                        >
                    > {
                        if (closed) return { done: true, value: undefined }
                        if (pulling) return { done: false, value: err(new AttachmentDownloadError({ reason: "busy" })) }
                        pulling = true
                        try {
                            const opened = await open()
                            let chunk: Exit.Exit<Uint8Array | undefined, AttachmentDownloadFailure | ConfigurationError>
                            if (Exit.isFailure(opened)) chunk = Exit.failCause(opened.cause)
                            else {
                                source = opened.value
                                chunk = await Effect.runPromiseExit(
                                    owner.logging.provide(
                                        Effect.suspend(() => {
                                            bind()
                                            return closed ? Effect.succeed(undefined) : source!.next
                                        }),
                                    ),
                                )
                            }
                            if (Exit.isFailure(chunk) || chunk.value === undefined || closed) {
                                closed = true
                                const cleaned = await detach()
                                if (Exit.isFailure(cleaned))
                                    chunk = Exit.failCause(
                                        Cause.combine(Exit.isFailure(chunk) ? chunk.cause : Cause.empty, cleaned.cause),
                                    )
                            }
                            const result = fromExit(chunk, "attachments.stream")
                            if (result.isErr()) return { done: false, value: err(result.error) }
                            return result.value === undefined || closed
                                ? { done: true, value: undefined }
                                : { done: false, value: ok(result.value) }
                        } finally {
                            pulling = false
                        }
                    },
                    async return(): Promise<
                        IteratorResult<
                            Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
                        >
                    > {
                        closed = true
                        fromExit(await detach(), "attachments.stream")
                        return { done: true, value: undefined }
                    },
                    async throw(
                        error?: unknown,
                    ): Promise<
                        IteratorResult<
                            Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
                        >
                    > {
                        closed = true
                        const cleaned = await detach()
                        if (Exit.isFailure(cleaned))
                            fromExit(
                                Exit.failCause(Cause.combine(Cause.die(error), cleaned.cause)),
                                "attachments.stream",
                            )
                        throw error
                    },
                }
            },
        })
    }
export const defaultInstanceResolve =
    <M extends MessageCore>({ owner, execute }: DefaultContext<M>) =>
    (options?: DefaultInstanceResolveOptions) =>
        execute(owner.instance.resolveInfo(options), "instance.resolve", options)

export const defaultRestRequest =
    <M extends MessageCore>({ owner, execute }: DefaultContext<M>) =>
    <T = unknown>(input: DefaultRestRequest) =>
        execute(owner.request<T>(input), "rest.request", input)

export const defaultCacheEntries =
    <M extends MessageCore>({ owner }: DefaultContext<M>) =>
    <K extends CacheKind>(kind: K, options?: CacheEntriesOptions): readonly CachedResources<M>[K][] =>
        localValue(owner.cacheEntries(kind, options), "cache.entries")

export const defaultCacheClear =
    <M extends MessageCore>({ owner }: DefaultContext<M>) =>
    (kind?: CacheKind) =>
        owner.clearCache(kind)

export const defaultCacheDelete =
    <M extends MessageCore>({ owner }: DefaultContext<M>) =>
    (kind: CacheKind, key: string) =>
        owner.deleteCacheEntry(kind, key)

export const defaultCollect =
    <M extends MessageCore>({ owner }: DefaultContext<M>) =>
    (channelId: string, options?: DefaultCollectorOptions<M>): Collector<M> =>
        openCollector(
            Effect.runSyncExit(
                readInput(() => options?.onMessage).pipe(
                    Effect.flatMap((onMessage) =>
                        collect(
                            owner,
                            channelId,
                            options,
                            true,
                            typeof onMessage === "function" ? collectorHandler(onMessage) : undefined,
                        ),
                    ),
                ),
            ),
            "collect",
            defaultCollector,
            (failure) => failedCollector<CollectorResult<M>>(failure, "collector.result"),
        )

export const defaultCollectReactions =
    <M extends MessageCore>({ owner }: DefaultContext<M>) =>
    (target: MessageReference, options?: DefaultReactionCollectorOptions): ReactionCollector => {
        let callback: DefaultReactionCollectorOptions["onReaction"]
        try {
            callback = options?.onReaction
        } catch (error) {
            throw new SdkDefect("collectReactions", [defectReason(error, "application")])
        }
        const exit = Effect.runSyncExit(
            collectReactions(
                owner,
                target,
                options,
                true,
                typeof callback === "function" ? collectorHandler(callback) : undefined,
            ),
        )
        return openCollector(
            exit,
            "collectReactions",
            (source) => {
                const result = (options?: OperationOptions) =>
                    executeOperation(Deferred.await(source.closed), "reactionCollector.result", options)
                return Object.freeze({
                    close: () => source.stop(),
                    result,
                    [Symbol.asyncDispose]: async () => {
                        source.stop()
                        // The collection outcome stays readable through result, so disposal only awaits cleanup
                        await result()
                    },
                })
            },
            (failure) => failedCollector<ReactionCollectorResult>(failure, "reactionCollector.result"),
        )
    }

export const defaultKeepTyping =
    <M extends MessageCore>({ owner, execute }: DefaultContext<M>) =>
    <A>(channelId: string, task: (signal: AbortSignal) => PromiseLike<A>, options?: DefaultMessageOperationOptions) =>
        execute(
            typeof task === "function"
                ? owner.keepTyping(channelId, defaultTypingTask(task), options)
                : Effect.fail(
                      new MessageOperationError({
                          operation: "typing",
                          reason: "input",
                          outcome: "notDispatched",
                          inputValidation: inputValidationFailure(
                              "task",
                              "type",
                              "The task passed to keepTyping must be a function",
                          ).detail,
                      }),
                  ),
            "keepTyping",
            options,
        )
