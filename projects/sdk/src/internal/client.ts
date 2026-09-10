import { Cause, Clock, Deferred, Effect, Exit, Fiber, Queue, Random, Redacted, Scope, Semaphore, Stream } from "effect"
import type { ConnectionState } from "#sdk/client"
import type { ShardState } from "#sdk/sharding"
import { guildShardId, type ShardPlan } from "./sharding.js"
import type { CachePolicyErrorReport } from "#sdk/cache"
import { MessageError, MessageOperationError, type MessageOperationFailure, type SendError } from "#sdk/message-errors"
import { identifier, record, reference } from "./message.js"
import { MessageCache } from "./cache.js"
import { GuildCache, type ResourceKind, type Resources } from "./guild-cache.js"
import { ChannelCache } from "./channel-cache.js"
import { UserCache, type UserResources } from "./user-cache.js"
import { PresenceOwner } from "./presence.js"
import { PresenceError, type PresenceInput, type PresenceFailure } from "#sdk/presence"
import {
    UserOperationError,
    type UserOperation,
    type UserOperationOptions,
    type User,
    type DirectMessageChannel,
} from "#sdk/users"
import { directMessageFetch, type UserRequest } from "./users.js"
import {
    ChannelOperationError,
    type ChannelOperation,
    type ChannelOperationOptions,
    type GuildChannel,
} from "#sdk/channels"
import type { ChannelRequest } from "./channels.js"
import type { WebhookRequest } from "./webhooks.js"
import type { WebhookOperation, WebhookOperationOptions } from "#sdk/webhooks"
import { makeCacheReports, type CacheReports } from "./cache-reports.js"
import {
    ClientBusyError,
    ClientClosedError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
    ShardConnectionError,
    type ConfigurationError,
    type ConnectError,
    type ConnectionFailure,
} from "#sdk/errors"
import { type Configuration, validateConfiguration } from "./configuration.js"
import { discoverGateway } from "./discovery.js"
import { mapFailureCause, withDeadline } from "./effect-failures.js"
import { CountOwner } from "./counts.js"
import { GatewayRequestBudget } from "./gateway-requests.js"
import { MemberChunkOwner } from "./member-chunks.js"
import { AttemptFailure, runGateway, type Session } from "./gateway.js"
import { EventBus } from "./events.js"
import type { MessageCollector } from "./collector.js"
import type { ReactionCollector } from "./reaction-collector.js"
import {
    GuildOperationError,
    type GuildOperation,
    type GuildOperationOptions,
    type MemberReference,
    type RoleReference,
} from "#sdk/guilds"
import type { GuildRequest } from "./guilds.js"
import { guildLeave } from "./guild-lifecycle.js"
import { RestOwner } from "./rest.js"
import type { BotApplicationOperation, BotApplicationOperationOptions } from "#sdk/application"
import type { BotApplicationRequest } from "./application.js"
import type { ReactionEmojiInput, ReactionUsersQuery } from "#sdk/reactions"
import type { MessagePinsQuery } from "#sdk/pins"
import type { MessageSearchContext, MessageSearchQuery } from "#sdk/message-search"
import type { ClientLogging } from "./logging.js"
import type {
    Message,
    EditMessageInput,
    ForwardMessageInput,
    MessageHistoryQuery,
    MessageInput,
    MessageOperationOptions,
    MessageReference,
    SendOptions,
} from "#sdk/messages"

const typingRefreshMs = 8_000

interface ShardRuntime {
    readonly shardId: number
    state: ConnectionState
    latency: number | null
    session: Session
}

export class ClientOwner {
    readonly presence: PresenceOwner
    readonly #gatewayRequests = new GatewayRequestBudget()
    readonly #identify = Semaphore.makeUnsafe(1)
    /** SDK-private owner for fresh correlated gateway-count replies, with no count cache */
    readonly counts: CountOwner
    readonly memberChunks: MemberChunkOwner

    setPresence(input: PresenceInput) {
        return Effect.suspend((): Effect.Effect<void, PresenceFailure> => {
            if (this.#state === "Closing" || this.#state === "Closed") return Effect.fail(new ClientClosedError())
            return this.presence.set(input) ? Effect.void : Effect.fail(new PresenceError())
        })
    }
    setPresenceMembers(guildId: string, memberIds: readonly string[]) {
        return Effect.suspend((): Effect.Effect<void, PresenceFailure> => {
            if (this.#state === "Closing" || this.#state === "Closed") return Effect.fail(new ClientClosedError())
            const failure = this.presence.setMembers(guildId, memberIds)
            return failure === undefined ? Effect.void : Effect.fail(new PresenceError(failure))
        })
    }
    #messageCollectors = new Set<MessageCollector>()
    trackMessageCollector(collector: MessageCollector) {
        this.#messageCollectors.add(collector)
        return () => this.#messageCollectors.delete(collector)
    }
    #reactionCollectors = new Set<ReactionCollector>()
    trackReactionCollector(collector: ReactionCollector) {
        this.#reactionCollectors.add(collector)
        return () => this.#reactionCollectors.delete(collector)
    }
    readonly logging: ClientLogging
    readonly events = new EventBus()
    readonly rest: RestOwner
    readonly cache: MessageCache | undefined
    readonly resources: GuildCache | undefined
    readonly channelCache: ChannelCache | undefined
    readonly userCache: UserCache
    #configuration: Configuration | undefined
    #state: ConnectionState = "Disconnected"
    readonly #plan: ShardPlan
    readonly #shards = new Map<number, ShardRuntime>()
    readonly #shardListeners = new Map<number, Set<(state: ConnectionState) => void>>()
    #groupReady = false
    #nextIdentifyAt = 0
    #worker: Fiber.Fiber<void> | undefined
    #workerExit: Exit.Exit<void, ConnectionFailure> | undefined
    #terminal = Deferred.makeUnsafe<void, ConnectionFailure>()
    #shutdown = Deferred.makeUnsafe<void>()
    #typingClosed = Deferred.makeUnsafe<void>()
    #typing = new Map<symbol, Fiber.Fiber<never, MessageOperationFailure>>()
    #listeners = new Set<(state: ConnectionState) => void>()
    #managed = false
    #shutdownStarted = false

    constructor(
        configuration: Configuration,
        readonly scope: Scope.Scope,
        private readonly reports: CacheReports | undefined,
        now: () => number,
    ) {
        this.#configuration = configuration
        this.#plan = configuration.sharding
        for (const shardId of this.#plan.shardIds)
            this.#shards.set(shardId, {
                shardId,
                state: "Disconnected",
                latency: null,
                session: { id: undefined, sequence: null },
            })
        const route = (guildId: string) => this.shardIdForGuild(guildId)
        this.presence = new PresenceOwner(undefined, route)
        this.counts = new CountOwner(this.#gatewayRequests, route)
        this.memberChunks = new MemberChunkOwner(this.#gatewayRequests, route)
        this.logging = configuration.logging
        this.cache = configuration.cache
            ? new MessageCache(configuration.cache, (report) => reports!.offer(report), now)
            : undefined
        this.resources = Object.keys(configuration.resourceCache).length
            ? new GuildCache(configuration.resourceCache, now)
            : undefined
        this.channelCache = configuration.channelCache ? new ChannelCache(configuration.channelCache, now) : undefined
        this.userCache = new UserCache(configuration.userCache, now)
        this.rest = new RestOwner(
            this.cache,
            configuration.uploadMaxBytes,
            this.resources,
            this.channelCache,
            this.userCache,
        )
    }
    get state(): ConnectionState {
        return this.#state
    }
    get gatewayLatencyMs(): number | null {
        if (this.#state !== "Connected") return null
        let maximum = 0
        for (const shard of this.#shards.values()) {
            if (shard.latency === null) return null
            maximum = Math.max(maximum, shard.latency)
        }
        return maximum
    }
    get shards(): readonly ShardState[] {
        return Object.freeze(
            [...this.#shards.values()].map((shard) =>
                Object.freeze({
                    shardId: shard.shardId,
                    state: shard.state,
                    gatewayLatencyMs: shard.latency,
                }),
            ),
        )
    }
    shardIdForGuild(guildId: string): number | undefined {
        const id = guildShardId(guildId, this.#plan.totalShards)
        return this.#shards.has(id) ? id : undefined
    }
    gatewayState(guildId?: string): ConnectionState {
        if (guildId === undefined) return this.#state
        if (this.#state === "Closing" || this.#state === "Closed") return this.#state
        const id = this.shardIdForGuild(guildId)
        return id === undefined ? "Disconnected" : this.#shards.get(id)!.state
    }
    subscribeGateway(guildId: string | undefined, listener: (state: ConnectionState) => void) {
        if (guildId === undefined) return this.subscribe(listener)
        const id = this.shardIdForGuild(guildId)
        if (id === undefined) {
            listener(this.gatewayState(guildId))
            return () => {}
        }
        let listeners = this.#shardListeners.get(id)
        if (!listeners) this.#shardListeners.set(id, (listeners = new Set()))
        if (this.#state !== "Closed") listeners.add(listener)
        listener(this.gatewayState(guildId))
        return () => {
            listeners.delete(listener)
            if (!listeners.size) this.#shardListeners.delete(id)
        }
    }
    #gapShard(shardId: number) {
        const affects = (guildId: string | null | undefined) =>
            guildId === undefined ||
            (guildId === null ? shardId === 0 : guildShardId(guildId, this.#plan.totalShards) === shardId)
        this.cache?.gap(affects)
        this.resources?.gap(affects)
        this.channelCache?.gap(affects)
        this.userCache.gap(affects)
        this.counts.detach(shardId)
        this.memberChunks.detach(shardId)
        this.presence.detach(shardId)
    }
    #setShardState(shard: ShardRuntime, state: ConnectionState) {
        if (this.#state === "Closing" || this.#state === "Closed" || shard.state === state) return
        if (state === "Recovering") this.#gapShard(shard.shardId)
        shard.state = state
        if (state !== "Connected") shard.latency = null
        for (const listener of this.#shardListeners.get(shard.shardId) ?? []) listener(state)
        if ([...this.#shards.values()].every((value) => value.state === "Connected")) {
            this.#groupReady = true
            this.#setState("Connected")
        } else this.#setState(this.#groupReady ? "Recovering" : "Connecting")
    }

    #setState(state: ConnectionState) {
        if (this.#state === state) return
        if (state === "Disconnected") {
            // A reusable startup can have delivered events from a ready sibling before the group failed
            for (const shard of this.#shards.values())
                if (shard.state === "Connected" || shard.state === "Recovering") this.#gapShard(shard.shardId)
        }
        if (state === "Closing" || state === "Closed") this.cache?.close()
        if (state === "Closing" || state === "Closed") this.counts.close()
        if (state === "Closing" || state === "Closed") this.memberChunks.close()
        if (state === "Closing" || state === "Closed") this.resources?.close()
        if (state === "Closing" || state === "Closed") this.userCache.close()
        if (state === "Closing" || state === "Closed") this.presence.close()
        if (state === "Closing" || state === "Closed") this.channelCache?.close()
        this.#state = state
        if (state === "Disconnected" || state === "Closing" || state === "Closed") {
            for (const shard of this.#shards.values()) {
                shard.state = state
                shard.latency = null
                if (state !== "Closing") shard.session = { id: undefined, sequence: null }
                for (const listener of this.#shardListeners.get(shard.shardId) ?? []) listener(state)
            }
        }
        for (const listener of this.#listeners) listener(state)
        if (state === "Closed") {
            this.#listeners.clear()
            this.#shardListeners.clear()
        }
    }

    subscribe(listener: (state: ConnectionState) => void) {
        if (this.#state !== "Closed") this.#listeners.add(listener)
        listener(this.#state)
        return () => {
            this.#listeners.delete(listener)
        }
    }

    observeState() {
        const owner = this
        return Stream.unwrap(
            Effect.gen(function* () {
                const queue = yield* Queue.sliding<ConnectionState, Cause.Done>(1)
                let initial: ConnectionState | undefined
                const unsubscribe = owner.subscribe((state) => {
                    if (initial === undefined) initial = state
                    else Queue.offerUnsafe(queue, state)
                    if (state === "Closed") Queue.endUnsafe(queue)
                })
                yield* Effect.addFinalizer(() => Effect.sync(unsubscribe).pipe(Effect.andThen(Queue.shutdown(queue))))
                return Stream.concat(Stream.succeed(initial!), Stream.fromQueue(queue))
            }),
        )
    }

    #finish() {
        Deferred.doneUnsafe(this.#typingClosed, Effect.void)
        this.events.stop()
        this.rest.stop()
        if (this.#configuration) Redacted.wipeUnsafe(this.#configuration.token)
        this.#configuration = undefined
        this.#setState("Closed")
    }

    user<A>(operation: UserOperation, build: () => UserRequest<A> | undefined, options?: UserOperationOptions) {
        return Effect.suspend(() => {
            if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                return Effect.fail(new ClientClosedError())
            const request = build()
            if (!request) return Effect.fail(new UserOperationError(operation, "input", "notDispatched"))
            const owner = this
            const token = this.#configuration.token
            return Effect.gen(function* () {
                const timeout = options?.timeoutMs ?? 30_000
                if (
                    (options !== undefined &&
                        (!record(options) ||
                            Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal"))) ||
                    !Number.isSafeInteger(timeout) ||
                    timeout <= 0 ||
                    timeout > 2_147_483_647
                )
                    return yield* Effect.fail(new UserOperationError(operation, "input", "notDispatched"))
                const deadline = performance.now() + timeout
                if (request.verifyType) {
                    const channel = yield* owner.rest.user(
                        token,
                        operation,
                        () => directMessageFetch(request.id!),
                        options,
                    )
                    if (request.verifyType === "group" && channel.type !== "group")
                        return yield* Effect.fail(new UserOperationError(operation, "input", "notDispatched"))
                }
                const remaining = Math.floor(deadline - performance.now())
                if (remaining <= 0)
                    return yield* Effect.fail(new UserOperationError(operation, "timeout", "notDispatched"))
                if (request.noCache)
                    return yield* owner.rest.user(token, operation, () => request, { timeoutMs: remaining })
                const generation = owner.userCache.begin(request.resource, request.method !== "GET")
                const value = yield* owner.rest
                    .user(token, operation, () => request, { timeoutMs: remaining })
                    .pipe(
                        Effect.onExit((exit) =>
                            Effect.sync(() => {
                                if (exit._tag === "Failure") {
                                    if (request.method !== "GET") owner.userCache.invalidate(request.resource)
                                    else owner.userCache.failed(request.resource, generation)
                                }
                                if (request.method === "DELETE" && request.id) owner.cache?.deleteChannel(request.id)
                            }),
                        ),
                    )
                if (value !== undefined)
                    owner.userCache.complete(
                        request.resource,
                        generation,
                        (Array.isArray(value) ? value : [value]) as readonly (User | DirectMessageChannel)[],
                        request.replace,
                    )
                return value
            })
        })
    }

    application<A>(
        operation: BotApplicationOperation,
        build: () => BotApplicationRequest<A>,
        options?: BotApplicationOperationOptions,
    ) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.application(this.#configuration.token, operation, build, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    getUserResource<K extends "users" | "directMessages">(kind: K, id: string) {
        return Effect.suspend(
            (): Effect.Effect<UserResources[K] | undefined, ClientClosedError | UserOperationError> => {
                if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                    return Effect.fail(new ClientClosedError())
                if (!identifier(id)) return Effect.fail(new UserOperationError(`${kind}.get`, "input", "notDispatched"))
                return Effect.succeed(this.userCache.get(kind, id))
            },
        )
    }

    webhook<A>(
        operation: WebhookOperation,
        build: () => WebhookRequest<A> | undefined,
        options?: WebhookOperationOptions,
    ) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.webhook(this.#configuration.token, operation, build, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    guild<A>(operation: GuildOperation, build: () => GuildRequest<A> | undefined, options?: GuildOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.guild(this.#configuration.token, operation, build, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    leaveGuild(guildId: string, options?: GuildOperationOptions) {
        return this.guild("guilds.leave", () => guildLeave(guildId), options).pipe(
            Effect.tap(() => Effect.sync(() => this.presence.forgetMembers(guildId))),
        )
    }

    channel<A>(
        operation: ChannelOperation,
        build: () => ChannelRequest<A> | undefined,
        options?: ChannelOperationOptions,
    ) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.channel(this.#configuration.token, operation, build, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    getChannel(id: string) {
        return Effect.suspend(
            (): Effect.Effect<GuildChannel | undefined, ClientClosedError | ChannelOperationError> => {
                if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                    return Effect.fail(new ClientClosedError())
                if (!identifier(id))
                    return Effect.fail(new ChannelOperationError("channels.get", "input", "notDispatched"))
                return Effect.succeed(this.channelCache?.get(id))
            },
        )
    }

    getResource<K extends ResourceKind>(kind: K, target: string | MemberReference | RoleReference) {
        return Effect.suspend((): Effect.Effect<Resources[K] | undefined, ClientClosedError | GuildOperationError> => {
            if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                return Effect.fail(new ClientClosedError())
            const guildId = kind === "guilds" ? target : record(target) ? target.guildId : undefined
            const id =
                kind === "guilds"
                    ? guildId
                    : record(target)
                      ? kind === "members"
                          ? target.userId
                          : target.id
                      : undefined
            if (!identifier(guildId) || !identifier(id))
                return Effect.fail(new GuildOperationError(`${kind}.get`, "input", "notDispatched"))
            return Effect.succeed(this.resources?.get(kind, guildId, id))
        })
    }

    send(channelId: string, input: MessageInput, options?: SendOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(this.rest.send(this.#configuration.token, channelId, input, options)),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    forward(channelId: string, input: ForwardMessageInput, options?: SendOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(this.rest.forward(this.#configuration.token, channelId, input, options)),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    sendDirectMessage(userId: string, input: MessageInput, options?: SendOptions) {
        return Effect.suspend((): Effect.Effect<Message, SendError> => {
            if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                return Effect.fail(new ClientClosedError())
            if (!identifier(userId) || !record(input) || input.messageReference !== undefined)
                return Effect.fail(new MessageError("input", "notSent"))
            return (this.reports?.start() ?? Effect.void).pipe(
                Effect.andThen(this.rest.send(this.#configuration.token, userId, input, options, userId)),
            )
        })
    }

    fetchReactionUsers(
        target: MessageReference,
        emoji: ReactionEmojiInput,
        query?: ReactionUsersQuery,
        options?: MessageOperationOptions,
    ) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.fetchReactionUsers(this.#configuration.token, target, emoji, query, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    reaction(
        operation: "addReaction" | "removeReaction" | "removeUserReaction" | "clearReaction" | "clearReactions",
        target: MessageReference,
        emoji: ReactionEmojiInput | undefined,
        options?: MessageOperationOptions,
        userId?: string,
    ) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.reaction(this.#configuration.token, operation, target, emoji, options, userId)
                : Effect.fail(new ClientClosedError()),
        )
    }

    fetch(target: MessageReference, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(this.rest.fetch(this.#configuration.token, target, options)),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    typing(channelId: string, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.typing(this.#configuration.token, channelId, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    keepTyping<A, E, R>(
        channelId: string,
        task: Effect.Effect<A, E, R>,
        options?: MessageOperationOptions,
    ): Effect.Effect<A, E | MessageOperationFailure, R> {
        const owner = this
        return Effect.uninterruptibleMask((restore) =>
            restore(owner.typing(channelId, options)).pipe(
                Effect.flatMap(() =>
                    Effect.gen(function* () {
                        const id = Symbol("typing")
                        const started = Deferred.makeUnsafe<void>()
                        const refresh = yield* Effect.forkChild(
                            Deferred.await(started).pipe(
                                Effect.andThen(owner.#refreshTyping(channelId, options)),
                                Effect.ensuring(Effect.sync(() => owner.#typing.delete(id))),
                            ),
                        )
                        owner.#typing.set(id, refresh)
                        Deferred.doneUnsafe(started, Effect.void)
                        return yield* restore(task).pipe(Effect.onExit(() => owner.#stopTyping(refresh)))
                    }),
                ),
            ),
        )
    }

    #refreshTyping(
        channelId: string,
        options?: MessageOperationOptions,
    ): Effect.Effect<never, MessageOperationFailure> {
        const owner = this
        return Effect.forever(
            Effect.raceFirst(
                Effect.sleep(typingRefreshMs),
                Deferred.await(owner.#typingClosed).pipe(Effect.andThen(Effect.fail(new ClientClosedError()))),
            ).pipe(Effect.andThen(owner.typing(channelId, options))),
        )
    }

    #stopTyping(fiber: Fiber.Fiber<never, MessageOperationFailure>): Effect.Effect<void, MessageOperationFailure> {
        return Effect.uninterruptible(
            Fiber.interrupt(fiber).pipe(
                Effect.andThen(Fiber.await(fiber)),
                Effect.flatMap((exit) =>
                    Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                        ? Effect.failCause(exit.cause)
                        : Effect.void,
                ),
            ),
        )
    }

    pin(operation: "pin" | "unpin", target: MessageReference, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.pin(this.#configuration.token, operation, target, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    fetchPins(channel: string, query?: MessagePinsQuery, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.fetchPins(this.#configuration.token, channel, query, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    fetchHistory(channelId: string, query?: MessageHistoryQuery, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(this.rest.fetchHistory(this.#configuration.token, channelId, query, options)),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    searchMessages(context: MessageSearchContext, query?: MessageSearchQuery, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.search(this.#configuration.token, context, query, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    edit(target: MessageReference, input: EditMessageInput, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(this.rest.edit(this.#configuration.token, target, input, options)),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    delete(target: MessageReference, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(this.rest.delete(this.#configuration.token, target, options)),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    deleteAttachment(target: MessageReference, attachmentId: string, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(
                          this.rest.deleteAttachment(this.#configuration.token, target, attachmentId, options),
                      ),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    deleteMany(channelId: string, ids: readonly string[], options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.deleteMany(this.#configuration.token, channelId, ids, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    get(target: MessageReference) {
        return Effect.suspend((): Effect.Effect<Message | undefined, ClientClosedError | MessageOperationError> => {
            if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                return Effect.fail(new ClientClosedError())
            if (!reference(target)) return Effect.fail(new MessageOperationError("get", "input", "notDispatched"))
            return Effect.succeed(this.cache?.get(target))
        })
    }

    #closeServices() {
        Deferred.doneUnsafe(this.#typingClosed, Effect.void)
        this.events.stop()
        this.rest.stop()
        return Effect.all(
            [
                Effect.exit(this.events.shutdown()),
                Effect.exit(this.rest.shutdown()),
                Effect.exit(this.reports?.shutdown() ?? Effect.void),
                Effect.all(
                    [
                        Effect.forEach(
                            [...this.#messageCollectors],
                            (collector) => Effect.exit(Deferred.await(collector.closed).pipe(Effect.asVoid)),
                            { concurrency: "unbounded" },
                        ),
                        Effect.forEach(
                            [...this.#reactionCollectors],
                            (collector) => Effect.exit(Deferred.await(collector.closed).pipe(Effect.asVoid)),
                            { concurrency: "unbounded" },
                        ),
                    ],
                    { concurrency: "unbounded" },
                ).pipe(
                    Effect.map((exits) => {
                        const reasons = exits
                            .flat()
                            .flatMap((exit) =>
                                Exit.isFailure(exit)
                                    ? exit.cause.reasons.filter((reason) => reason._tag === "Die")
                                    : [],
                            )
                        return reasons.length ? Exit.failCause(Cause.fromReasons<never>(reasons)) : Exit.void
                    }),
                ),
            ],
            {
                concurrency: "unbounded",
            },
        ).pipe(
            Effect.flatMap((exits) => {
                const reasons = exits.flatMap((exit) => (Exit.isFailure(exit) ? exit.cause.reasons : []))
                return reasons.length ? Effect.failCause(Cause.fromReasons<never>(reasons)) : Effect.void
            }),
            Effect.onExit(() => this.#awaitTyping()),
        )
    }

    #awaitTyping(): Effect.Effect<void> {
        return Effect.forEach([...this.#typing.values()], (fiber) => Fiber.await(fiber), {
            concurrency: "unbounded",
        }).pipe(
            Effect.flatMap((exits) => {
                const reasons = exits.flatMap((exit) =>
                    Exit.isFailure(exit) ? exit.cause.reasons.filter((reason) => reason._tag === "Die") : [],
                )
                return reasons.length ? Effect.failCause(Cause.fromReasons<never>(reasons)) : Effect.void
            }),
        )
    }

    #supervise(configuration: Configuration, startup: Deferred.Deferred<void, ConnectError>) {
        const owner = this
        return Effect.suspend(() => {
            const exits: Exit.Exit<unknown, ConnectionFailure>[] = []
            const sessions = Effect.gen(function* () {
                const clock = yield* Clock.Clock
                const deadline = Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000 + configuration.startupTimeoutMs
                return yield* Effect.forEach(
                    [...owner.#shards.values()],
                    (shard) =>
                        owner.#loop(configuration, startup, shard, deadline).pipe(
                            mapFailureCause((failure) =>
                                configuration.sharding.identifyShards && !(failure instanceof ShardConnectionError)
                                    ? new ShardConnectionError(shard.shardId, failure)
                                    : failure,
                            ),
                            Effect.onExit((exit) =>
                                Effect.sync(() => {
                                    exits.push(exit)
                                }),
                            ),
                        ),
                    { concurrency: "unbounded", discard: true },
                )
            })
            const startupGuard = Deferred.await(startup).pipe(
                Effect.ignore,
                withDeadline(
                    configuration.startupTimeoutMs,
                    () => new ConnectionTimeoutError(configuration.startupTimeoutMs),
                ),
                Effect.andThen(Effect.never),
            )
            return Effect.raceFirst(sessions, startupGuard).pipe(
                // A losing session may defect during socket cleanup. Keep those causes across the race boundary
                Effect.onExit((outcome) => {
                    const missing = exits.flatMap((exit) =>
                        Exit.isFailure(exit)
                            ? exit.cause.reasons.filter(
                                  (reason) =>
                                      reason._tag !== "Interrupt" &&
                                      (!Exit.isFailure(outcome) || !outcome.cause.reasons.includes(reason)),
                              )
                            : [],
                    )
                    return missing.length ? Effect.failCause(Cause.fromReasons(missing)) : Effect.void
                }),
            )
        })
    }

    #loop(
        configuration: Configuration,
        startup: Deferred.Deferred<void, ConnectError>,
        shard: ShardRuntime,
        deadline: number,
    ) {
        const owner = this
        return Effect.gen(function* () {
            const fiber = yield* Effect.withFiber((fiber) => Effect.succeed(fiber))
            const emit = (diagnostic: Parameters<ClientLogging["emit"]>[1]) =>
                owner.logging.emit(fiber, {
                    ...diagnostic,
                    ...(configuration.sharding.identifyShards ? { shardId: shard.shardId } : {}),
                })
            emit({ event: "connecting", phase: "startup" })
            const clock = yield* Clock.Clock
            const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000
            let established = false
            let attempts = 0
            let recoveryStep = 0
            let connectedAt: number | undefined
            let disconnectedAt: number | undefined
            let url: string | undefined
            while (true) {
                attempts += 1
                const phase = established ? "recovery" : "startup"
                const mode = shard.session.id !== undefined && shard.session.sequence !== null ? "resume" : "identify"
                emit({ event: "attempt", phase, attempt: attempts, mode })
                const budget = established ? 30_000 : Math.max(0, deadline - now())
                const attempt = Effect.gen(function* () {
                    const attemptDeadline = now() + budget
                    if (!url) {
                        url = yield* discoverGateway(configuration.token).pipe(
                            mapFailureCause(
                                (error) =>
                                    new AttemptFailure(
                                        error,
                                        error instanceof RateLimitError ||
                                            (error instanceof ConnectionError &&
                                                error.reason === "network" &&
                                                (error.status === null || error.status >= 500)),
                                    ),
                            ),
                            withDeadline(budget, () => new AttemptFailure(new ConnectionTimeoutError(budget), true)),
                        )
                    }
                    return yield* runGateway(
                        url,
                        configuration.token,
                        shard.session,
                        Math.max(0, attemptDeadline - now()),
                        (readyMode) => {
                            established = true
                            connectedAt = now()
                            disconnectedAt = undefined
                            owner.#setShardState(shard, "Connected")
                            emit({ event: "connected", phase, attempt: attempts, mode: readyMode })
                            if (owner.#state === "Connected") Deferred.doneUnsafe(startup, Effect.void)
                        },
                        (latency) => {
                            shard.latency = latency
                        },
                        () => {
                            disconnectedAt ??= now()
                            owner.#setShardState(shard, "Recovering")
                        },
                        (event, message, bytes) => {
                            owner.resources?.event(event, message)
                            owner.channelCache?.event(event, message)
                            if (event === "userUpdate" && "discriminator" in message) {
                                const generation = owner.userCache.begin("users", false)
                                owner.userCache.complete("users", generation, [message])
                                owner.userCache.invalidate("directMessages")
                            }
                            if (
                                (event === "directMessageCreate" || event === "directMessageUpdate") &&
                                "recipients" in message
                            ) {
                                const generation = owner.userCache.begin("directMessages", false)
                                owner.userCache.complete("directMessages", generation, [message])
                            }
                            if (
                                event === "directMessageRecipientAdd" ||
                                event === "directMessageRecipientRemove" ||
                                event === "directMessageDelete"
                            )
                                owner.userCache.invalidate("directMessages")
                            if (event === "directMessageDelete" && "id" in message)
                                owner.cache?.deleteChannel(message.id)
                            if (event === "guildChannelDelete" && "id" in message)
                                owner.cache?.deleteChannel(message.id)
                            if ("author" in message) owner.cache?.observe(message)
                            else if ("ids" in message) {
                                for (const id of message.ids) owner.cache?.delete({ id, channelId: message.channelId })
                            } else if (event === "messageDelete" && "id" in message && "channelId" in message)
                                owner.cache?.delete(message)
                            owner.events.offer(event, message, bytes, shard.shardId)
                        },
                        owner.resources || owner.channelCache || owner.cache
                            ? (event, value) => {
                                  owner.resources?.guildEvent(event, value)
                                  if (event !== "GUILD_EMOJIS_UPDATE" && event !== "GUILD_STICKERS_UPDATE")
                                      owner.channelCache?.guildEvent(event, value)
                                  if (event === "GUILD_DELETE")
                                      owner.cache?.gap(
                                          (guildId) => guildId === undefined || (record(value) && value.id === guildId),
                                      )
                              }
                            : undefined,
                        {
                            attach: (send, members, mode) => owner.presence.attach(send, members, mode, shard.shardId),
                            detach: () => owner.presence.detach(shard.shardId),
                            guildCreate: (guildId) => owner.presence.guildCreate(guildId),
                        },
                        {
                            attach: (guilds, channels) => owner.counts.attach(guilds, channels, shard.shardId),
                            detach: () => owner.counts.detach(shard.shardId),
                            receiveGuildCounts: (value) => owner.counts.receiveGuildCounts(value),
                            receiveChannelMemberCounts: (value) => owner.counts.receiveChannelMemberCounts(value),
                        },
                        {
                            attach: (send) => owner.memberChunks.attach(send, shard.shardId),
                            detach: () => owner.memberChunks.detach(shard.shardId),
                            receive: (value, bytes) => owner.memberChunks.receive(value, bytes),
                            rateLimited: (value) => owner.memberChunks.rateLimited(value),
                        },
                        configuration.sharding.identifyShards
                            ? [shard.shardId, configuration.sharding.totalShards]
                            : undefined,
                        configuration.sharding.identifyShards
                            ? (send) =>
                                  owner.#identify.withPermit(
                                      Effect.gen(function* () {
                                          // Pace actual Identify sends, including handshakes that finish out of order
                                          while (owner.#nextIdentifyAt > now())
                                              yield* Effect.sleep(owner.#nextIdentifyAt - now())
                                          send()
                                          owner.#nextIdentifyAt = now() + 1_000
                                      }),
                                  )
                            : undefined,
                    )
                })
                const result = yield* Effect.uninterruptibleMask((restore) =>
                    Effect.exit(restore(attempt)).pipe(
                        Effect.flatMap((result) => {
                            // Translate even when caller interruption is pending, without exposing AttemptFailure
                            if (
                                Exit.isFailure(result) &&
                                (Cause.hasDies(result.cause) || Cause.hasInterrupts(result.cause))
                            ) {
                                if (!Cause.hasInterruptsOnly(result.cause))
                                    emit({
                                        event: "connectionEnded",
                                        phase: established ? "recovery" : "startup",
                                        failure: Cause.hasDies(result.cause) ? "defect" : "interrupted",
                                    })
                                return Effect.failCause(Cause.map(result.cause, (failure) => failure.failure))
                            }
                            return Effect.succeed(result)
                        }),
                    ),
                )
                if (Exit.isSuccess(result))
                    return yield* Effect.die(new Error("Gateway lifetime ended without an outcome"))
                const reason = result.cause.reasons.find((reason) => reason._tag === "Fail")
                if (reason?._tag !== "Fail") return yield* Effect.die(new Error("Gateway failure had no reason"))
                const failure = reason.error
                if (established && connectedAt !== undefined) emit({ event: "connectionLost", phase: "recovery" })
                if (failure.resetSession) {
                    shard.session = { id: undefined, sequence: null }
                    emit({ event: "sessionReset", phase, mode: "identify" })
                }
                const reported =
                    !established && failure.failure instanceof ConnectionTimeoutError
                        ? new ConnectionTimeoutError(configuration.startupTimeoutMs)
                        : failure.failure
                const classification =
                    failure.failure instanceof ConnectionError ? failure.failure.reason : failure.failure._tag
                if (!failure.retry || (!established && attempts >= configuration.maxStartupAttempts)) {
                    emit({
                        event: "connectionEnded",
                        phase: established ? "recovery" : "startup",
                        failure: classification,
                    })
                    return yield* Effect.fail(reported)
                }
                if (established) {
                    owner.#setShardState(shard, "Recovering")
                    if (connectedAt !== undefined && (disconnectedAt ?? now()) - connectedAt >= 60_000) recoveryStep = 0
                    connectedAt = undefined
                }
                const ceiling = established
                    ? Math.min(30_000, 1000 * 2 ** Math.min(recoveryStep++, 5))
                    : Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5))
                const jitter = (yield* Random.next) * ceiling
                const requiredWait = failure.failure instanceof RateLimitError ? (failure.failure.retryAfterMs ?? 0) : 0
                const delay = Math.max(jitter, requiredWait)
                if (!established && delay >= deadline - now()) {
                    emit({
                        event: "connectionEnded",
                        phase,
                        failure: requiredWait > 0 ? "RateLimitError" : "ConnectionTimeoutError",
                    })
                    return yield* Effect.fail(
                        requiredWait > 0 ? failure.failure : new ConnectionTimeoutError(configuration.startupTimeoutMs),
                    )
                }
                emit({
                    event: "retry",
                    phase: established ? "recovery" : "startup",
                    attempt: attempts,
                    delayMs: delay,
                    failure: classification,
                })
                yield* Effect.sleep(delay)
            }
        })
    }

    #start(): Effect.Effect<void, ConnectError> {
        const owner = this
        return Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
                if (owner.#state === "Closing" || owner.#state === "Closed")
                    return yield* Effect.fail(new ClientClosedError())
                if (owner.#state === "Connected") return
                if (owner.#state !== "Disconnected") return yield* Effect.fail(new ClientBusyError())
                yield* owner.reports?.start() ?? Effect.void
                const configuration = owner.#configuration!
                const startup = Deferred.makeUnsafe<void, ConnectError>()
                let becameReady = false
                owner.#workerExit = undefined
                owner.#groupReady = false
                for (const shard of owner.#shards.values()) shard.state = "Connecting"
                owner.#setState("Connecting")
                const trackReady = owner.subscribe((state) => {
                    if (state === "Connected") becameReady = true
                })
                owner.#worker = yield* Effect.forkIn(
                    owner.#supervise(configuration, startup).pipe(
                        Effect.onExit((exit) =>
                            Effect.gen(function* () {
                                trackReady()
                                owner.#workerExit = exit
                                const closing = owner.#state === "Closing" || owner.#state === "Closed"
                                const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                                const defect = Exit.isFailure(exit) && Cause.hasDies(exit.cause)
                                if (closing && !defect)
                                    Deferred.doneUnsafe(startup, Effect.fail(new ClientClosedError()))
                                else Deferred.doneUnsafe(startup, exit)
                                if (becameReady || defect) {
                                    const fiber = yield* Effect.withFiber((fiber) => Effect.succeed(fiber))
                                    if (!closing) owner.logging.emit(fiber, { event: "closing" })
                                    owner.#setState("Closing")
                                    const services = yield* Effect.exit(owner.#closeServices())
                                    const outcome = Exit.isFailure(services)
                                        ? Exit.failCause(
                                              Cause.combine(
                                                  Exit.isFailure(exit) ? exit.cause : Cause.empty,
                                                  services.cause,
                                              ),
                                          )
                                        : exit
                                    owner.#workerExit = outcome
                                    owner.#finish()
                                    if (!closing) owner.logging.emit(fiber, { event: "closed" })
                                    Deferred.doneUnsafe(
                                        owner.#terminal,
                                        interrupted && !Exit.isFailure(services) ? Effect.void : outcome,
                                    )
                                } else if (!closing) {
                                    owner.#setState("Disconnected")
                                }
                            }),
                        ),
                        // Outcomes are retained above, not left as unobserved fiber failures
                        Effect.catchCause(() => Effect.void),
                    ),
                    owner.scope,
                )
                const worker = owner.#worker
                return yield* restore(Deferred.await(startup)).pipe(
                    Effect.onInterrupt(() =>
                        Effect.gen(function* () {
                            yield* Fiber.interrupt(worker)
                            const exit = owner.#workerExit
                            if (exit && Exit.isFailure(exit) && Cause.hasDies(exit.cause))
                                return yield* Effect.failCause(exit.cause)
                        }),
                    ),
                )
            }),
        )
    }

    connect(): Effect.Effect<void, ConnectError> {
        return Effect.suspend(() => {
            if (this.#state === "Closing" || this.#state === "Closed") return Effect.fail(new ClientClosedError())
            return this.#managed ? Effect.fail(new ClientBusyError()) : this.#start()
        })
    }

    waitForClose(): Effect.Effect<void, ConnectionFailure> {
        return Deferred.await(this.#terminal)
    }

    shutdown(): Effect.Effect<void> {
        return Effect.withFiber((fiber) =>
            this.events.ownsHandler(fiber.id) ||
            this.reports?.owns(fiber.id) ||
            [...this.#messageCollectors].some((collector) => collector.owns(fiber.id)) ||
            [...this.#reactionCollectors].some((collector) => collector.owns(fiber.id))
                ? // A native handler cannot join its own cleanup: The client scope owns shutdown and interrupts this caller
                  Effect.forkIn(this.#performShutdown(), this.scope).pipe(Effect.andThen(Effect.never))
                : this.#performShutdown(),
        )
    }

    #performShutdown(): Effect.Effect<void> {
        const owner = this
        return Effect.uninterruptible(
            Effect.suspend(() => {
                if (owner.#shutdownStarted) return Deferred.await(owner.#shutdown)
                if (owner.#state === "Closed") return Effect.void
                owner.#shutdownStarted = true
                owner.#setState("Closing")
                owner.events.stop()
                owner.rest.stop()
                return Effect.gen(function* () {
                    const fiber = yield* Effect.withFiber((fiber) => Effect.succeed(fiber))
                    owner.logging.emit(fiber, { event: "closing" })
                    if (owner.#worker) yield* Fiber.interrupt(owner.#worker)
                    const services = yield* Effect.exit(owner.#closeServices())
                    const exit = owner.#workerExit
                    owner.#finish()
                    owner.logging.emit(fiber, { event: "closed" })
                    if (Exit.isFailure(services)) {
                        Deferred.doneUnsafe(owner.#terminal, services)
                        return yield* Effect.failCause(services.cause)
                    }
                    if (exit && Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
                        Deferred.doneUnsafe(owner.#terminal, exit)
                        return yield* Effect.die(exit.cause)
                    }
                    Deferred.doneUnsafe(owner.#terminal, Effect.void)
                }).pipe(Effect.onExit((exit) => Deferred.done(owner.#shutdown, exit)))
            }),
        )
    }

    run(): Effect.Effect<void, ConnectError> {
        const owner = this
        return Effect.uninterruptibleMask((restore) =>
            Effect.suspend(() => {
                if (owner.#state === "Closed" || owner.#state === "Closing") return Effect.fail(new ClientClosedError())
                if (owner.#managed || owner.#state !== "Disconnected") return Effect.fail(new ClientBusyError())
                owner.#managed = true
                return restore(owner.#start().pipe(Effect.andThen(owner.waitForClose()))).pipe(
                    Effect.ensuring(owner.shutdown()),
                )
            }),
        )
    }
}

export function makeClient(
    options: unknown,
    scope: Scope.Scope,
    native = false,
): Effect.Effect<ClientOwner, ConfigurationError> {
    return Effect.gen(function* () {
        const configuration = yield* validateConfiguration(options, native)
        return yield* configuration.logging.provide(
            Effect.gen(function* () {
                const callback = configuration.cache?.onError
                const reporter = callback
                    ? (report: CachePolicyErrorReport): Effect.Effect<unknown, unknown> =>
                          native
                              ? Effect.suspend(() => {
                                    const result = callback(report)
                                    // The report worker supplies the captured creation context, including the native reporter's services
                                    return Effect.isEffect(result)
                                        ? (result as Effect.Effect<unknown, unknown>)
                                        : Effect.die(new Error("Cache reporter must return an Effect"))
                                })
                              : Effect.callback((resume) => {
                                    void Promise.resolve()
                                        .then(() => callback(report))
                                        .then(
                                            () => resume(Effect.void),
                                            () => resume(Effect.die(new Error("Cache reporter failed"))),
                                        )
                                })
                    : undefined
                const reports = configuration.cache ? yield* makeCacheReports(reporter, scope) : undefined
                const clock = yield* Clock.Clock
                return new ClientOwner(
                    configuration,
                    scope,
                    reports,
                    () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000,
                )
            }),
        )
    })
}
