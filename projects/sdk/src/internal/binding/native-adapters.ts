/**
 * Native adapters: The Effect side of operation table entries that need more than the shared Effect, such as
 * byte streams, member chunk streams, collectors and the cached resolved instance.
 * Invariant: Adapters start nothing until the caller runs or consumes them, and scoped resources close with the caller's
 * scope or the stream's consumption. Implements [SDK contracts: Public API model](/docs/SDK-CONTRACTS.md#public-api-model)
 */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { AttachmentDownloadError, type Attachment, type AttachmentDownloadOptions } from "#sdk/attachments"
import type { CacheEntriesOptions, CacheKind } from "#sdk/client"
import type { InstanceResolveOptions } from "#sdk/instance"
import type { MemberChunkOptions, MemberChunkQuery } from "#sdk/member-chunks"
import { ClientClosedError, type ConfigurationError } from "#sdk/errors"
import {
    CollectorError,
    type CollectorFailure,
    type CollectorResult,
    type ReactionCollectorResult,
} from "#sdk/collectors"
import type { MessageCore, MessageOperationOptions, MessageReference } from "#sdk/messages"
import type {
    Collector,
    CollectorOptions,
    ReactionCollector,
    ReactionCollectorOptions,
} from "#sdk/api/effect/collectors"
import { collect, type MessageCollector } from "#sdk/internal/collector"
import { collectReactions, type ReactionCollector as ReactionCollection } from "#sdk/internal/reaction-collector"
import { effectInstance, type ResolvedInstance } from "#sdk/api/effect/instance"
import type { ClientOwner } from "#sdk/internal/client"
import { memberChunkStream } from "#sdk/internal/member-chunks"
import { readInput } from "#sdk/internal/defects"
import type { RestRequest } from "#sdk/rest"

export const nativeInstanceResolve = <M extends MessageCore>(owner: ClientOwner<M>) => {
    // Resolution repeats discovery when needed, but the client keeps returning its first native instance view
    let instance: ResolvedInstance | undefined
    return (options?: InstanceResolveOptions) =>
        owner.instance.resolveInfo(options).pipe(Effect.map((value) => (instance ??= effectInstance(value))))
}

export const nativeRestRequest =
    <M extends MessageCore>(owner: ClientOwner<M>) =>
    <T = unknown>(input: RestRequest) =>
        owner.request<T>(input)

export const nativeCacheEntries =
    <M extends MessageCore>(owner: ClientOwner<M>) =>
    <K extends CacheKind>(kind: K, options?: CacheEntriesOptions) =>
        // Invalid arguments are misuse, so they become a defect rather than a typed failure
        owner.cacheEntries(kind, options).pipe(Effect.orDie)

export const nativeCacheClear =
    <M extends MessageCore>(owner: ClientOwner<M>) =>
    (kind?: CacheKind) =>
        owner.clearCache(kind)

export const nativeCacheDelete =
    <M extends MessageCore>(owner: ClientOwner<M>) =>
    (kind: CacheKind, key: string) =>
        owner.deleteCacheEntry(kind, key)

export const nativeMemberChunks =
    <M extends MessageCore>(owner: ClientOwner<M>) =>
    (guildId: string, query: MemberChunkQuery, options?: MemberChunkOptions) =>
        memberChunkStream(owner.memberChunks.open(guildId, query, options))

export const nativeAttachmentStream =
    <M extends MessageCore>(owner: ClientOwner<M>) =>
    (attachment: Attachment, options: AttachmentDownloadOptions) => {
        let consumed = false
        return Stream.unwrap(
            Effect.suspend(() => {
                if (consumed) return Effect.fail(new AttachmentDownloadError({ reason: "busy" }))
                consumed = true
                return Effect.gen(function* () {
                    const source = yield* Effect.acquireRelease(
                        Effect.interruptible(owner.streamAttachment(attachment, options)),
                        (source) => source.closeEffect,
                    )
                    return Stream.unfold(undefined, () =>
                        source.next.pipe(
                            Effect.map((chunk) => (chunk === undefined ? undefined : ([chunk, undefined] as const))),
                        ),
                    )
                })
            }),
        )
    }

function nativeCollector<M extends MessageCore>(source: MessageCollector<M>): Collector<M> {
    return Object.freeze({
        close: () => Effect.sync(() => source.stop()),
        result: () => Deferred.await(source.closed),
    })
}

// Keep completed handles outside the registration closure so they do not retain options or the caller's scope
function nativeReactionCollector(source: ReactionCollection): ReactionCollector {
    return Object.freeze({
        close: () => Effect.sync(() => source.stop()),
        result: () => Deferred.await(source.closed),
    })
}

/** Release a scoped collector registration as soon as the collector closes, without waiting for scope closure */
const releaseWhenClosed = <A, E>(
    source: { readonly closed: Deferred.Deferred<A, E>; stop(): void },
    callerScope: Scope.Scope,
) =>
    Effect.forkIn(
        Deferred.await(source.closed).pipe(
            Effect.asVoid,
            Effect.interruptible,
            Effect.onExit(() =>
                Effect.sync(() => source.stop()).pipe(Effect.andThen(Effect.exit(Deferred.await(source.closed)))),
            ),
            // allow-silent: The collector retains its closure outcome for result
            Effect.catchCause(() => Effect.void),
        ),
        callerScope,
        { uninterruptible: true },
    )

/**
 * Keep a runtime registration failure, such as a gateway that is not ready or a client that began shutting down, as a
 * closed handle whose result fails with it. Shutdown can race a still-running handler that registers, so a closing
 * client is not misuse. Invalid options are misuse, so they and any other failure become defects rather than handles
 */
const openNative = <S, H, R>(
    open: Effect.Effect<S, ConfigurationError | CollectorFailure, R>,
    handle: (source: S) => Effect.Effect<H, never, Scope.Scope>,
    failed: (failure: CollectorFailure) => H,
): Effect.Effect<H, never, R | Scope.Scope> =>
    open.pipe(
        Effect.matchEffect({
            onFailure: (error) =>
                error instanceof CollectorError || error instanceof ClientClosedError
                    ? Effect.succeed(failed(error))
                    : Effect.die(error),
            onSuccess: handle,
        }),
    )

const failedNative = <A>(failure: CollectorFailure) =>
    Object.freeze({
        close: () => Effect.void,
        result: () => Effect.fail(failure) as Effect.Effect<A, CollectorFailure>,
    })

export const nativeCollect =
    <M extends MessageCore>(owner: ClientOwner<M>) =>
    <E = never, R = never>(channelId: string, options?: CollectorOptions<E, R, M>) =>
        Effect.uninterruptible(
            // Reading the handler when the Effect runs keeps a throwing getter an application fault in the Cause
            readInput(() => options?.onMessage).pipe(
                Effect.flatMap((onMessage) =>
                    openNative(
                        collect(owner, channelId, options, false, onMessage),
                        (source) =>
                            Effect.gen(function* () {
                                const callerScope = yield* Effect.scope
                                // A scoped waiter releases its registration when done, rather than retaining every completed collector until scope closure
                                yield* releaseWhenClosed(source, callerScope)
                                return nativeCollector(source)
                            }),
                        (failure): Collector<M> => failedNative<CollectorResult<M>>(failure),
                    ),
                ),
            ),
        )

export const nativeCollectReactions =
    <M extends MessageCore>(owner: ClientOwner<M>) =>
    <E = never, R = never>(target: MessageReference, options?: ReactionCollectorOptions<E, R>) =>
        Effect.uninterruptible(
            // Reading the handler when the Effect runs keeps a throwing getter an application fault in the Cause
            readInput(() => options?.onReaction).pipe(
                Effect.flatMap((onReaction) =>
                    openNative(
                        collectReactions(owner, target, options, false, onReaction),
                        (source) =>
                            Effect.gen(function* () {
                                const callerScope = yield* Effect.scope
                                yield* releaseWhenClosed(source, callerScope)
                                return nativeReactionCollector(source)
                            }),
                        (failure): ReactionCollector => failedNative<ReactionCollectorResult>(failure),
                    ),
                ),
            ),
        )

export const nativeKeepTyping =
    <M extends MessageCore>(owner: ClientOwner<M>) =>
    <A, E, R>(channelId: string, task: Effect.Effect<A, E, R>, options?: MessageOperationOptions) =>
        owner.keepTyping(channelId, task, options)
