/**
 * Client owner: Configuration, caches, REST, instance discovery, shard state and the one client lifetime, split into
 * [shard loop](/projects/sdk/src/internal/client/shard-loop.ts), [intake](/projects/sdk/src/internal/client/intake.ts),
 * [backoff](/projects/sdk/src/internal/client/backoff.ts) and [lifetime](/projects/sdk/src/internal/client/lifetime.ts).
 * Invariant: The client manages its assigned sessions as one lifetime, spaces out Identify sends, coordinates initial state
 * delivery with subscription setup and retains one lifetime outcome. Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type {
    CacheDiagnostic,
    CacheEntriesOptions,
    CachedResources,
    CacheKind,
    ClientDiagnostics,
    ConnectionState,
} from "#sdk/client"
import type { SessionSnapshot, ShardState } from "#sdk/sharding"
import {
    admitReshard,
    automaticShardPlan,
    guildShardId,
    guildsPerShard,
    largerShardPlan,
    type ShardPlan,
} from "./sharding.js"
import { guildList } from "./guild-lifecycle.js"
import type { IdentifyFields } from "./gateway/commands.js"
import { automaticIgnoredEvents, suppressedRegistrations } from "./gateway/event-dispatches.js"
import { maxClientPayloadBytes, Opcode, reservedClientOpcodes } from "./protocol/gateway.js"
import { MessageError, MessageOperationError, type MessageOperationFailure, type SendError } from "#sdk/message-errors"
import { replyInput, snapshotReference } from "./message.js"
import { identifier, record } from "./decode/primitives.js"
import { MessageCache } from "./cache.js"
import { unsupportedKeyHint } from "./suggest.js"
import { GuildCache, type ResourceKind, type Resources } from "./guild-cache.js"
import { ChannelCache } from "./channel-cache.js"
import { CacheChangeHub } from "./cache-changes.js"
import type { DefaultRestRequest, RestRequest, RestRequestFailure, RestResponse } from "#sdk/rest"
import { GatewaySendError, type GatewaySendFailure } from "#sdk/gateway"
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
import { decodeUser, directMessageFetch, userFetch, type UserRequest } from "./users.js"
import {
    ChannelOperationError,
    type ChannelOperation,
    type ChannelOperationOptions,
    type GuildChannel,
} from "#sdk/channels"
import { channelList, type ChannelRequest } from "./channels.js"
import type { WebhookRequest } from "./webhooks.js"
import type { WebhookOperation, WebhookOperationOptions } from "#sdk/webhooks"
import { FailureReporter, messageIds, primaryError, publicReport, throwIfErr, type InternalReport } from "./failures.js"
import {
    AuthenticationError,
    ClientBusyError,
    ClientClosedError,
    ConnectionError,
    ConfigurationError,
    ConnectionTimeoutError,
    RateLimitError,
    type ConnectError,
    type ConnectionFailure,
} from "#sdk/errors"
import { type Configuration, validateConfiguration } from "./configuration.js"
import { InstanceResolver } from "./instance.js"
import type { LinkHelpers } from "#sdk/helpers"
import { CountOwner } from "./counts.js"
import { GatewayRequestBudget } from "./gateway-requests.js"
import { MemberChunkOwner } from "./member-chunks.js"
import { LogicalScheduler, type LogicalTimer, makeLogicalScheduler } from "./logical-scheduler.js"
import { AttemptFailure } from "./gateway.js"
import { sdkVersion } from "./logging.js"
import { EventBus } from "./events.js"
import { nowMs } from "./clock.js"
import { defaultTransport, type Transport } from "./transport/index.js"
import { identifySpacingMs, startupBudgetMs } from "./client/backoff.js"
import { clearCaches } from "./client/intake.js"
import { drainWork } from "./client/drain.js"
import { ScheduledTasks } from "./scheduled-tasks.js"
import {
    closeAll,
    defectsOnly,
    formatDuration,
    logShutdownEnd,
    logShutdownStart,
    superviseShards,
} from "./client/lifetime.js"
import { readCaller, suspendInput, suspendMarked } from "./defects.js"
import { runShardLoop, type ShardLoopHost, type ShardRuntime } from "./client/shard-loop.js"
import type { MessageCollector } from "./collector.js"
import type { ReactionCollector } from "./reaction-collector.js"
import {
    GuildOperationError,
    type GuildOperation,
    type GuildOperationOptions,
    type MemberReference,
    type RoleReference,
} from "#sdk/guilds"
import { guildFetch, roleList, type GuildRequest } from "./guilds.js"
import { guildDeleteOwnMessages, guildLeave, ownDeletionOptions } from "./guild-lifecycle.js"
import { RestOwner } from "./rest.js"
import type { BotApplicationOperation, BotApplicationOperationOptions } from "#sdk/application"
import type { BotApplicationRequest } from "./application.js"
import type { ReactionEmojiInput, ReactionUsersQuery } from "#sdk/reactions"
import type { MessagePinsQuery } from "#sdk/pins"
import type { MessageSearchContext, MessageSearchQuery } from "#sdk/message-search"
import type { ClientLogger } from "./logging.js"
import type {
    Message,
    MessageCore,
    MessageFields,
    SelectedMessage,
    EditMessageInput,
    ForwardMessageInput,
    MessageHistoryQuery,
    MessageInput,
    MessageOperationOptions,
    MessageReference,
    SendOptions,
} from "#sdk/messages"
import type {
    Attachment,
    AttachmentDownloadFailure,
    AttachmentDownloadOptions,
    AttachmentRefreshFailure,
    AttachmentRefreshOptions,
    RefreshedAttachmentUrl,
} from "#sdk/attachments"
import type { AttachmentDownloadSource } from "./rest.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"

const cacheKinds = [
    "messages",
    "guilds",
    "members",
    "roles",
    "channels",
    "users",
    "directMessages",
    "emojis",
    "stickers",
] as const satisfies readonly CacheKind[]
const emptyEntries = Object.freeze([])
/** The documented two-part CacheChange key format of each kind that has one */
const cachePairKeys = {
    messages: "channelId:messageId",
    members: "guildId:userId",
    roles: "guildId:id",
    emojis: "guildId:id",
    stickers: "guildId:id",
} as const
/** The cache kind, or ConfigurationError for misuse */
function validCacheKind(kind: unknown): CacheKind {
    if (!(cacheKinds as readonly unknown[]).includes(kind))
        throw new ConfigurationError("kind", `The cache kind must be one of ${cacheKinds.join(", ")}`)
    return kind as CacheKind
}
const disabledCacheDiagnostic: CacheDiagnostic = Object.freeze({
    configured: false,
    retainedEntries: 0,
    accountedBytes: 0,
    maxEntries: null,
    maxBytes: null,
    hits: 0,
    misses: 0,
    evictions: Object.freeze({ capacity: 0, expiry: 0 }),
})
const freezeCacheDiagnostic = (diagnostic: CacheDiagnostic | undefined): CacheDiagnostic =>
    diagnostic === undefined
        ? disabledCacheDiagnostic
        : Object.freeze({
              configured: diagnostic.configured,
              retainedEntries: diagnostic.retainedEntries,
              accountedBytes: diagnostic.accountedBytes,
              maxEntries: diagnostic.maxEntries,
              maxBytes: diagnostic.maxBytes,
              hits: diagnostic.hits,
              misses: diagnostic.misses,
              evictions: Object.freeze({
                  capacity: diagnostic.evictions.capacity,
                  expiry: diagnostic.evictions.expiry,
              }),
          })

const typingRefreshMs = 8_000
/** Time allowed for each session store save during shutdown */
const sessionSaveTimeoutMs = 5_000
/** Guild list page size used to count guilds for automatic sharding, the largest Fluxer accepts */
const guildCountPageSize = 200
/** Communities whose cache refill may fail before the refill stops */
const refillFailureLimit = 10

type GuildBuild<A> = () => GuildRequest<A> | InputValidationFailure

/** Marks a JSON encoding failure that this module detected itself, so it is not mistaken for a caller throw */
class CommandDataUnencodable {
    constructor(readonly cause: unknown) {}
}

/**
 * Encode gateway command data as JSON. A circular structure, a BigInt or nesting too deep for the stack returns the
 * encoding failure. Any other throw comes from caller code run while encoding, such as a getter, a proxy trap or a
 * toJSON method, and propagates unchanged
 */
function encodeCommandData(data: unknown): { readonly json: string | undefined } | { readonly failure: unknown } {
    // Objects on the path from the root to the value being encoded, the same path JSON.stringify checks for cycles
    const path: unknown[] = []
    try {
        const json = JSON.stringify(data, function (this: unknown, _key, value: unknown) {
            path.length = path.lastIndexOf(this) + 1
            if (typeof value === "bigint")
                throw new CommandDataUnencodable(new TypeError("BigInt values cannot be encoded as JSON"))
            if (typeof value === "object" && value !== null) {
                if (path.includes(value))
                    throw new CommandDataUnencodable(new TypeError("Circular structures cannot be encoded as JSON"))
                path.push(value)
            }
            return value
        })
        return { json }
    } catch (error) {
        if (error instanceof CommandDataUnencodable) return { failure: error.cause }
        if (error instanceof RangeError) return { failure: error }
        throw error
    }
}

/** Translate a failed guild-count read into the startup failure that connect and run report */
function automaticPlanFailure(
    error: GuildOperationError | ClientClosedError,
    startupTimeoutMs: number,
): ConnectionFailure {
    // Closure during startup surfaces as ClientClosedError from connect, as for discovery
    if (error instanceof ClientClosedError) return new ConnectionError("discovery", "closed")
    if (error.status === 401) return new AuthenticationError()
    if (error.reason === "rateLimit") return new RateLimitError("http", error.retryAfterMs)
    if (error.reason === "timeout") return new ConnectionTimeoutError(startupTimeoutMs)
    return new ConnectionError("discovery", error.reason === "response" ? "protocol" : "network", error.status, {
        cause: error,
        details: { detail: "the community count for automatic sharding could not be read" },
        hint: "Check that the bot token can list the bot's communities, or set sharding.totalShards to a number",
    })
}

/** Internal fresh-Identify coordination used only by supervisor.child.run */
export interface IdentifyGate {
    permit(shardId: number, send: () => void): Effect.Effect<void, ConnectionError>
}

const identifyGates = new WeakMap<object, IdentifyGate>()

/** Attach a non-public gateway permit to the helper-owned client configuration object */
export function attachIdentifyGate<T extends object>(options: T, gate: IdentifyGate): T {
    identifyGates.set(options, gate)
    return options
}

export class ClientOwner<M extends MessageCore = Message> {
    readonly presence: PresenceOwner
    readonly #gatewayRequests = new GatewayRequestBudget()
    readonly #identify = Semaphore.makeUnsafe(1)
    /** SDK-private owner for fresh correlated gateway-count replies, with no count cache */
    readonly counts: CountOwner
    readonly memberChunks: MemberChunkOwner

    setPresence(input: PresenceInput) {
        // The presence owner marks its reads of the caller input, so its own faults stay SDK faults
        return suspendMarked((): Effect.Effect<void, PresenceFailure> => {
            if (this.#state === "Closing" || this.#state === "Closed") return Effect.fail(new ClientClosedError())
            const failure = this.presence.set(input)
            if (failure === undefined) return Effect.void
            if (failure === false) return Effect.fail(new ClientClosedError())
            return Effect.fail(new PresenceError({ reason: "input", inputValidation: failure.detail }))
        })
    }
    setPresenceMembers(guildId: string, memberIds: readonly string[]) {
        return suspendMarked((): Effect.Effect<void, PresenceFailure> => {
            if (this.#state === "Closing" || this.#state === "Closed") return Effect.fail(new ClientClosedError())
            const failure = this.presence.setMembers(guildId, memberIds)
            if (failure === undefined) return Effect.void
            if (failure === "limit") return Effect.fail(new PresenceError({ reason: "limit" }))
            if (failure === false) return Effect.fail(new ClientClosedError())
            return Effect.fail(new PresenceError({ reason: "input", inputValidation: failure.detail }))
        })
    }
    #messageCollectors = new Set<MessageCollector<M>>()
    trackMessageCollector(collector: MessageCollector<M>) {
        this.#messageCollectors.add(collector)
        return () => this.#messageCollectors.delete(collector)
    }
    #reactionCollectors = new Set<ReactionCollector>()
    trackReactionCollector(collector: ReactionCollector) {
        this.#reactionCollectors.add(collector)
        return () => this.#reactionCollectors.delete(collector)
    }
    readonly logging: ClientLogger
    /** Client-wide failure reports, delivered to onError or logged */
    readonly failures: FailureReporter
    /** Tasks started with client.schedule, which end with this client */
    readonly tasks: ScheduledTasks
    readonly events = new EventBus<M>(
        () => this.logging,
        () => this.failures,
    )
    readonly decodeMessage: Configuration<M>["decodeMessage"]
    readonly rest: RestOwner<M>
    /** One owner-scoped immutable discovery result, independent of credentials and REST admission state */
    readonly instance: InstanceResolver
    readonly cache: MessageCache<M> | undefined
    readonly resources: GuildCache | undefined
    readonly channelCache: ChannelCache | undefined
    readonly userCache: UserCache
    /** Client-wide cache change notifications, shared by every cache this client owns */
    readonly cacheChanges = new CacheChangeHub()
    #configuration: Configuration<M> | undefined
    #state: ConnectionState = "Disconnected"
    /** Known shard plan. An automatic plan stays undefined until the first connect computes it */
    #plan: ShardPlan | undefined
    readonly #shards = new Map<number, ShardRuntime>()
    readonly #shardListeners = new Map<number, Set<(state: ConnectionState) => void>>()
    readonly #shardHost: ShardLoopHost<M>
    #groupReady = false
    /** Shards whose sessions shutdown saves, captured when shutdown begins */
    #saveOnClose: ReadonlySet<number> | undefined
    /** Logical time before which the next fresh Identify may not be sent */
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
    /** Whether connect or run began, so shutdown records describe a client that did something */
    #everStarted = false
    /** Logical times of recent moves to a larger automatic plan, oldest first */
    #reshards: number[] = []
    /** The shard whose 4011 closure started a move to a larger plan, until the new plan is adopted */
    #reshardShard: number | undefined
    /** Shards that resumed a session from the session store, whose guild caches wait for a refill */
    readonly #restoredShards = new Set<number>()

    constructor(
        configuration: Configuration<M>,
        readonly scope: Scope.Scope,
        failures: FailureReporter,
        readonly logical: LogicalScheduler,
        private readonly identifyGate: IdentifyGate | undefined,
        /** Network implementations for REST, discovery and the gateway */
        readonly transport: Transport = defaultTransport,
    ) {
        this.decodeMessage = configuration.decodeMessage
        this.#configuration = configuration
        const route = (guildId: string) => this.shardIdForGuild(guildId)
        this.presence = new PresenceOwner(
            {
                now: () => logical.now(),
                set: (callback, delay) => logical.set(callback, delay, "presence"),
                clear: (timer) => logical.clear(timer as LogicalTimer),
            },
            route,
        )
        // The configured initial presence is the first presence intent: Identify carries it and READY publishes it
        if (configuration.gateway.presence !== undefined) this.presence.set(configuration.gateway.presence)
        this.counts = new CountOwner(this.#gatewayRequests, route)
        this.memberChunks = new MemberChunkOwner(this.#gatewayRequests, logical, route)
        this.logging = configuration.logging
        this.failures = failures
        this.tasks = new ScheduledTasks(logical, failures, configuration.logging)
        const reportCache = (error: unknown) => this.failures.report({ kind: "cache", error })
        this.cache = configuration.cache
            ? new MessageCache(
                  configuration.cache,
                  (error, message) => this.failures.report({ kind: "cache", error, message: messageIds(message) }),
                  () => logical.now(),
                  logical,
                  this.cacheChanges,
              )
            : undefined
        this.resources = Object.keys(configuration.resourceCache).length
            ? new GuildCache(configuration.resourceCache, () => logical.now(), logical, this.cacheChanges, reportCache)
            : undefined
        this.channelCache = configuration.channelCache
            ? new ChannelCache(configuration.channelCache, () => logical.now(), logical, this.cacheChanges, reportCache)
            : undefined
        this.userCache = new UserCache(
            configuration.userCache,
            () => logical.now(),
            logical,
            this.cacheChanges,
            reportCache,
        )
        this.instance = new InstanceResolver(configuration.instance, scope, {
            http: transport.http,
            onDiscovered: (resolved) => {
                this.#instanceLinks = resolved.links
                const migration = resolved.domainMigration
                if (!migration) return
                const webapp = new URL(resolved.endpoints.webapp).host
                this.logging.log({
                    level: migration.enabled ? "info" : "debug",
                    category: "lifecycle",
                    code: "lifecycle.domainMigration",
                    message: migration.enabled
                        ? `The Fluxer instance announced a web domain migration, so links and OAuth URLs use the web app at ${webapp}`
                        : "The Fluxer instance announced a web domain migration that is switched off, so links and OAuth URLs are unchanged",
                    fields: {
                        enabled: migration.enabled,
                        webapp,
                        anonymousRolloutBasisPoints: migration.anonymousRolloutBasisPoints,
                    },
                })
            },
        })
        this.rest = new RestOwner({
            cache: this.cache,
            uploadMaxBytes: configuration.uploadMaxBytes,
            resources: this.resources,
            channels: this.channelCache,
            users: this.userCache,
            resolveInstance: () => this.instance.resolve(),
            decodeMessage: configuration.decodeMessage,
            logical,
            logging: configuration.logging,
            http: transport.http,
            settings: configuration.rest,
        })
        if (configuration.sharding !== "auto") this.#adoptPlan(configuration.sharding, "Disconnected")
        this.#shardHost = {
            logging: this.logging,
            instance: this.instance,
            caches: this,
            events: this.events,
            presence: this.presence,
            counts: this.counts,
            memberChunks: this.memberChunks,
            sockets: transport.sockets,
            state: () => this.#state,
            setShardState: (shard, state) => this.#setShardState(shard, state),
            newSession: (shardId) => this.#clearShardGuilds(shardId),
            identify: (shardId, send) => this.#identifyPermit(shardId, send),
            identifyFields: (shardId) => this.#identifyFields(configuration, shardId),
            sessions: configuration.sessions,
            saveSessionOnClose: (shardId) =>
                configuration.sessions !== undefined && this.#saveOnClose?.has(shardId) === true,
            ...(configuration.reshard ? { reshard: (shardId: number) => this.#acceptReshard(shardId) } : {}),
            ...(configuration.sessions && configuration.refillCaches
                ? { restored: (shardId: number) => void this.#restoredShards.add(shardId) }
                : {}),
            // Fluxer replays every missed dispatch on Resume except THREAD_LIST_SYNC, so cached threads may be stale
            resumed: (shardId) => this.channelCache?.dropThreads(this.#shardGuilds(shardId)),
            readyUser: (body, shardId) => this.#readyUser(body, shardId),
        }
    }

    /**
     * Record the known plan, replace the shard runtimes and size REST concurrency for the local shard count. Called at
     * creation, when an automatic plan is computed and when an automatic plan moves to a larger one
     */
    #adoptPlan(plan: ShardPlan, state: ConnectionState) {
        this.#plan = plan
        this.#shards.clear()
        this.rest.scaleConcurrency(plan.shardIds.length)
        for (const shardId of plan.shardIds)
            this.#shards.set(shardId, {
                shardId,
                state,
                latency: null,
                recovery: null,
                session: { id: undefined, sequence: null },
                submit: undefined,
                gatewayUrl: undefined,
            })
    }

    /**
     * Pace a fresh Identify across this client's shards, then wait for the supervisor's gate when one is configured.
     * An application identify coordinator replaces the SDK's own spacing, and its permits are requested one at a time.
     * A single unsharded, uncoordinated shard sends immediately
     */
    #identifyPermit(shardId: number, send: () => void): Effect.Effect<void, AttemptFailure> {
        const owner = this
        const plan = owner.#plan!
        const coordinator = owner.#configuration?.identifyCoordinator
        const permit = coordinator
            ? Effect.tryPromise({
                  try: (signal) => Promise.resolve(coordinator.permit(shardId, plan.totalShards, signal)),
                  catch: (error) => error,
              }).pipe(
                  Effect.asVoid,
                  Effect.mapError((error) => {
                      owner.logging.log({
                          level: "error",
                          category: "lifecycle",
                          code: "lifecycle.identifyPermitFailed",
                          message: `The identify coordinator (sharding.identify) failed to grant shard ${shardId} permission to start a new session, so the SDK retries the connection as after a network failure`,
                          shardId,
                          error,
                          origin: "application",
                      })
                      return new AttemptFailure(
                          new ConnectionError("gateway", "network", null, {
                              cause: error,
                              details: {
                                  detail: "the identify coordinator did not grant permission to start a new session",
                              },
                              hint: "Check the permit function of the sharding.identify coordinator",
                          }),
                          true,
                      )
                  }),
              )
            : Effect.void
        const grant = () =>
            owner.identifyGate
                ? owner.identifyGate
                      .permit(shardId, send)
                      .pipe(Effect.mapError((error) => new AttemptFailure(error, true)))
                : Effect.sync(send)
        if (!plan.identifyShards) return permit.pipe(Effect.andThen(Effect.suspend(grant)))
        if (coordinator) return owner.#identify.withPermit(permit.pipe(Effect.andThen(Effect.suspend(grant))))
        return owner.#identify.withPermit(
            Effect.gen(function* () {
                const clock = yield* Clock.Clock
                const now = () => nowMs(clock)
                // Pace actual Identify sends, including handshakes that finish out of order
                while (owner.#nextIdentifyAt > now()) yield* Effect.sleep(owner.#nextIdentifyAt - now())
                yield* grant()
                owner.#nextIdentifyAt = now() + identifySpacingMs
            }),
        )
    }

    /**
     * Identify fields for one new session: The current presence intent, the flags and the ignored dispatch names.
     * Automatic filtering reads the event registrations present now, so later registrations take effect at the next
     * new session only
     */
    #identifyFields(configuration: Configuration<M>, shardId: number): IdentifyFields {
        const gateway = configuration.gateway
        const registered = this.events.registeredEvents()
        let ignoredEvents: readonly string[]
        if (gateway.ignoredEvents === "auto") {
            ignoredEvents = automaticIgnoredEvents(registered, gateway.automaticNeeds)
        } else {
            ignoredEvents = gateway.ignoredEvents
            const suppressed = suppressedRegistrations(registered, new Set(ignoredEvents))
            if (suppressed.length)
                this.logging.log({
                    level: "warn",
                    category: "gateway",
                    code: "gateway.ignoredEventRegistered",
                    message: `Handlers for ${suppressed.join(", ")} receive nothing on shard ${shardId}, because gateway.ignoredEvents suppresses every gateway event that delivers them`,
                    shardId,
                    fields: { events: suppressed.join(",") },
                })
        }
        if (ignoredEvents.length && this.logging.enabled("debug", "gateway"))
            this.logging.log({
                level: "debug",
                category: "gateway",
                code: "gateway.identifyFilter",
                message: `Shard ${shardId} asks Fluxer not to send ${ignoredEvents.length} gateway event type${ignoredEvents.length === 1 ? "" : "s"}`,
                shardId,
                fields: { ignoredEvents: ignoredEvents.join(","), automatic: gateway.ignoredEvents === "auto" },
            })
        return {
            presence: this.presence.identifyPresence(),
            ignoredEvents,
            flags: gateway.flags,
        }
    }
    get state(): ConnectionState {
        return this.#state
    }
    /** Default deadline for multi-step REST workflows, from rest.defaultTimeoutMs */
    get defaultTimeoutMs(): number {
        return this.rest.defaultTimeoutMs
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
                    recovery:
                        shard.recovery === null
                            ? null
                            : Object.freeze({
                                  phase: shard.recovery.phase,
                                  attempt: shard.recovery.attempt,
                                  retryDelayMs: shard.recovery.retryDelayMs,
                              }),
                }),
            ),
        )
    }
    diagnostics(): ClientDiagnostics {
        const rest = this.rest.diagnostics()
        const caches = Object.freeze({
            messages: freezeCacheDiagnostic(this.cache?.diagnostics()),
            guilds: freezeCacheDiagnostic(this.resources?.diagnostics("guilds")),
            members: freezeCacheDiagnostic(this.resources?.diagnostics("members")),
            roles: freezeCacheDiagnostic(this.resources?.diagnostics("roles")),
            channels: freezeCacheDiagnostic(this.channelCache?.diagnostics()),
            users: freezeCacheDiagnostic(this.userCache.diagnostics("users")),
            directMessages: freezeCacheDiagnostic(this.userCache.diagnostics("directMessages")),
            emojis: freezeCacheDiagnostic(this.resources?.diagnostics("emojis")),
            stickers: freezeCacheDiagnostic(this.resources?.diagnostics("stickers")),
        })
        return Object.freeze({
            state: this.state,
            gatewayLatencyMs: this.gatewayLatencyMs,
            shards: this.shards,
            rest: Object.freeze({
                activeRequests: rest.activeRequests,
                activeCapacity: rest.activeCapacity,
                queuedRequests: rest.queuedRequests,
                queuedCapacity: rest.queuedCapacity,
                queuedJsonBytes: rest.queuedJsonBytes,
                queuedJsonByteCapacity: rest.queuedJsonByteCapacity,
            }),
            uploads: Object.freeze({ reservedBytes: rest.reservedUploadBytes, byteCapacity: rest.uploadByteCapacity }),
            gatewayRequests: Object.freeze(this.#gatewayRequests.diagnostics()),
            events: Object.freeze(this.events.diagnostics()),
            caches,
            counters: this.logging.counters(),
        })
    }
    cacheEntries<K extends CacheKind>(
        kind: K,
        options?: CacheEntriesOptions,
    ): Effect.Effect<readonly CachedResources<M>[K][], ConfigurationError> {
        return suspendInput(() => {
            if (!cacheKinds.includes(kind))
                return Effect.fail(
                    new ConfigurationError("kind", `The cache kind must be one of ${cacheKinds.join(", ")}`),
                )
            if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options)))
                return Effect.fail(new ConfigurationError("limit", "Cache entry options must contain only limit"))
            const unsupported = options && Object.keys(options).find((key) => key !== "limit")
            if (unsupported !== undefined)
                return Effect.fail(
                    new ConfigurationError(
                        "limit",
                        `Unsupported option ${JSON.stringify(unsupported)} in the cache entry options`,
                        { hint: unsupportedKeyHint(unsupported, ["limit"]) },
                    ),
                )
            // Read limit once, so the validated limit is the one applied
            const limitInput = options?.limit
            const limit = limitInput === undefined ? 100 : limitInput
            if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
                return Effect.fail(
                    new ConfigurationError("limit", "Cache entry limit must be a safe integer from 1 through 1,000"),
                )
            return Effect.sync(() => this.#cacheEntries(kind, limit))
        })
    }
    /** The public cache.clear: Every cache, or one validated kind */
    clearCache(kind?: CacheKind) {
        if (kind === undefined) {
            clearCaches(this)
            return
        }
        const valid = validCacheKind(kind)
        switch (valid) {
            case "messages":
                return this.cache?.clear()
            case "guilds":
            case "members":
            case "roles":
            case "emojis":
            case "stickers":
                return this.resources?.clearKind(valid)
            case "channels":
                return this.channelCache?.clear()
            case "users":
            case "directMessages":
                return this.userCache.invalidate(valid)
        }
    }
    /** The public cache.delete: One entry by its validated CacheChange key */
    deleteCacheEntry(kind: CacheKind, key: string) {
        const valid = validCacheKind(kind)
        const format = cachePairKeys[valid as keyof typeof cachePairKeys] as string | undefined
        const parts = typeof key === "string" ? key.split(":") : []
        if (parts.length !== (format === undefined ? 1 : 2) || !parts.every(identifier))
            throw new ConfigurationError("key", `A ${valid} cache key must be ${format ?? "a decimal ID"}`)
        const [first, second] = parts as [string, string | undefined]
        switch (valid) {
            case "messages":
                return this.cache?.deleteMany(first, [second!])
            case "guilds":
            case "members":
            case "roles":
            case "emojis":
            case "stickers":
                // A community's own key is its ID, which the guild cache stores as both community and resource ID
                return this.resources?.delete(valid, first, second ?? first)
            case "channels":
                return this.channelCache?.delete(first)
            case "users":
            case "directMessages":
                return this.userCache.invalidate(valid, first)
        }
    }
    #cacheEntries<K extends CacheKind>(kind: K, limit: number): readonly CachedResources<M>[K][] {
        switch (kind) {
            case "messages":
                return (this.cache?.entries(limit) ?? emptyEntries) as readonly CachedResources<M>[K][]
            case "guilds":
            case "members":
            case "roles":
            case "emojis":
            case "stickers":
                return (this.resources?.entries(kind, limit) ?? emptyEntries) as readonly CachedResources<M>[K][]
            case "channels":
                return (this.channelCache?.entries(limit) ?? emptyEntries) as readonly CachedResources<M>[K][]
            case "users":
            case "directMessages":
                return this.userCache.entries(kind, limit) as readonly CachedResources<M>[K][]
        }
    }
    shardIdForGuild(guildId: string): number | undefined {
        if (this.#plan === undefined) return undefined
        const id = guildShardId(guildId, this.#plan.totalShards)
        return this.#shards.has(id) ? id : undefined
    }
    /** The public client.shardIdForGuild: shardIdForGuild after checking the caller's ID */
    ownedShardForGuild(guildId: unknown): number | undefined {
        if (!identifier(guildId)) throw new ConfigurationError("guildId", "Guild IDs must be decimal strings")
        return this.shardIdForGuild(guildId)
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
            // A move to a larger plan replaces the listener sets, and a new set for the same ID must stay
            if (!listeners.size && this.#shardListeners.get(id) === listeners) this.#shardListeners.delete(id)
        }
    }
    #shardGuilds(shardId: number) {
        const totalShards = this.#plan?.totalShards ?? 1
        return (guildId: string | null | undefined) =>
            guildId === undefined || (guildId === null ? shardId === 0 : guildShardId(guildId, totalShards) === shardId)
    }
    /**
     * Invalidate a shard's cached observations when its connection is lost. Guild-scoped entries stay while the shard
     * can still resume, because Fluxer's Resume replays every missed dispatch or refuses the session, and
     * #clearShardGuilds releases them once a new session is needed. Messages and users are cleared at once
     */
    #gapShard(shardId: number, resumable: boolean) {
        const affects = this.#shardGuilds(shardId)
        this.cache?.gap(affects)
        if (resumable) {
            this.resources?.pause(affects)
            this.channelCache?.pause(affects)
        } else this.#clearShardGuilds(shardId)
        this.userCache.gap(affects)
        this.counts.detach(shardId)
        this.memberChunks.detach(shardId)
        this.presence.detach(shardId)
    }
    /** Release a shard's guild-scoped entries when its next connection starts a new session, which replays nothing */
    #clearShardGuilds(shardId: number) {
        const affects = this.#shardGuilds(shardId)
        this.resources?.gap(affects)
        this.channelCache?.gap(affects)
    }
    #setShardState(shard: ShardRuntime, state: ConnectionState) {
        if (this.#state === "Closing" || this.#state === "Closed" || shard.state === state) return
        if (state === "Recovering") this.#gapShard(shard.shardId, true)
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
                if (shard.state === "Connected" || shard.state === "Recovering") this.#gapShard(shard.shardId, false)
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
                shard.recovery = null
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

    #selfUserId: string | undefined
    /** The bot account ID once READY or a self read supplied it, without starting a read, for gateway cache intake */
    get botUserId(): string | undefined {
        return this.#selfUserId
    }
    /** The bot's own public account from the latest READY that carried a complete one, for users.getSelf */
    #selfUser: User | undefined
    /** The one users.fetchSelf read in flight, which concurrent mentions share */
    #selfUserRead: Deferred.Deferred<string | undefined> | undefined
    /** Consecutive failed reads, and the logical time before which no new read starts */
    #selfUserFailures = 0
    #selfUserRetryAtMs = 0
    static readonly #selfUserBackoffMs = 5_000
    static readonly #selfUserMaxBackoffMs = 300_000

    /** The bot's username from the latest READY, for the connected record */
    #readyName: string | undefined
    /** Each shard's community count from its latest READY, for the connected record */
    readonly #readyCommunities = new Map<number, number>()
    /** Links for the discovered instance, so the connected record can offer an installation link */
    #instanceLinks: LinkHelpers | undefined

    /**
     * Keep the bot account ID from a READY body's user, so mention prefixes need no REST read, its public account for
     * users.getSelf when the user is complete, so an incomplete one keeps the previous account, and the bot's username and the shard's community count for the connected record. For a bot, READY
     * lists each community as unavailable
     */
    #readyUser(body: unknown, shardId: number) {
        const user = record(body) && record(body.user) ? body.user : undefined
        if (identifier(user?.id) && user.id !== "0") this.#selfUserId = user.id
        const self = decodeUser(user)
        if (self !== undefined && self.id !== "0") this.#selfUser = self
        if (typeof user?.username === "string" && user.username.length > 0) this.#readyName = user.username
        if (record(body) && Array.isArray(body.guilds)) this.#readyCommunities.set(shardId, body.guilds.length)
        else this.#readyCommunities.delete(shardId)
    }

    /**
     * Log once per start that every local shard is connected, naming the bot and its community count when READY
     * supplied them. A bot that owns every shard and is in no community gets a Warn with an installation link instead
     */
    #logConnected(context: Context.Context<never>) {
        const plan = this.#plan
        if (plan === undefined) return
        const counts = plan.shardIds.map((shardId) => this.#readyCommunities.get(shardId))
        const communities = counts.every((count) => count !== undefined)
            ? counts.reduce<number>((total, count) => total + count!, 0)
            : undefined
        const everyShard = plan.shardIds.length === plan.totalShards
        const subject = `Connected to Fluxer${this.#readyName === undefined ? "" : ` as ${this.#readyName}`}`
        const empty = communities === 0 && everyShard
        const message = empty
            ? `${subject}, but the bot is not in any community yet. ${this.#inviteText()}`
            : communities === undefined
              ? subject
              : `${subject} in ${communities} ${communities === 1 ? "community" : "communities"}${everyShard ? "" : " on this client's shards"}`
        this.logging.log(
            {
                level: empty ? "warn" : "info",
                category: "lifecycle",
                code: "lifecycle.connected",
                message,
                fields: { communities: communities ?? null, shards: plan.shardIds.length },
            },
            context,
        )
    }

    /** Where to invite the bot: Its installation link when the bot account ID and instance are known */
    #inviteText(): string {
        const id = this.#selfUserId
        if (id === undefined || this.#instanceLinks === undefined)
            return "Invite it with an installation link that uses the application ID"
        try {
            return `Invite it by opening ${this.#instanceLinks.installation(id)}`
        } catch {
            // allow-silent: An ID the link helper rejects still gets the general instruction
            return "Invite it with an installation link that uses the application ID"
        }
    }

    /** The bot's own public account from the latest READY, kept for the client lifetime. It never fails */
    getSelf(): Effect.Effect<User | undefined> {
        return Effect.sync(() => this.#selfUser)
    }

    /**
     * The bot account ID for command mention prefixes, kept for the client lifetime.
     * READY normally supplies it. Until then it is read through users.fetchSelf, and concurrent callers share one read.
     * A failed read is logged at Warn and produces undefined, and callers get undefined without a new read for a backoff
     * that starts at 5 seconds and doubles per consecutive failure up to 5 minutes, unless READY supplies the ID first
     */
    selfUserId(): Effect.Effect<string | undefined> {
        return Effect.suspend(() => {
            if (this.#selfUserId !== undefined) return Effect.succeed(this.#selfUserId)
            if (this.#selfUserRead !== undefined) return Deferred.await(this.#selfUserRead)
            if (this.logical.now() < this.#selfUserRetryAtMs) return Effect.succeed(undefined)
            const read = Deferred.makeUnsafe<string | undefined>()
            this.#selfUserRead = read
            return this.user("users.fetchSelf", () => userFetch("@me")).pipe(
                Effect.map((user) => {
                    this.#selfUserFailures = 0
                    return (this.#selfUserId = user.id)
                }),
                Effect.catch((error) =>
                    Effect.sync(() => {
                        this.#selfUserFailures += 1
                        const retryInMs = Math.min(
                            ClientOwner.#selfUserMaxBackoffMs,
                            ClientOwner.#selfUserBackoffMs * 2 ** (this.#selfUserFailures - 1),
                        )
                        this.#selfUserRetryAtMs = this.logical.now() + retryInMs
                        this.logging.log({
                            level: "warn",
                            category: "commands",
                            code: "commands.mentionPrefixUnavailable",
                            message: `The bot's user ID could not be read, so commands that start with a mention of the bot are ignored for ${retryInMs / 1_000} s. The next such command after that reads the ID again`,
                            error,
                            fields: { retryInMs, failures: this.#selfUserFailures },
                        })
                        return undefined
                    }),
                ),
                // Waiters get the reader's result. An interrupted or defective read releases them with undefined and
                // lets the next mention read again
                Effect.onExit((exit) =>
                    Effect.sync(() => {
                        this.#selfUserRead = undefined
                        Deferred.doneUnsafe(read, Effect.succeed(Exit.isSuccess(exit) ? exit.value : undefined))
                    }),
                ),
            )
        })
    }

    user<A>(
        operation: UserOperation,
        build: () => UserRequest<A> | InputValidationFailure,
        options?: UserOperationOptions,
    ) {
        return suspendInput(() => {
            if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                return Effect.fail(new ClientClosedError())
            const request = build()
            if (request instanceof InputValidationFailure)
                return Effect.fail(
                    new UserOperationError({
                        operation,
                        reason: "input",
                        outcome: "notDispatched",
                        inputValidation: request.detail,
                    }),
                )
            const owner = this
            const token = this.#configuration.token
            // Read the caller's options here, where a throwing getter is reported as an application fault
            const timeout = options?.timeoutMs ?? owner.rest.defaultTimeoutMs
            const unsupportedOption = record(options)
                ? unsupportedKeyFailure(options, ["timeoutMs", "signal"], "options", "the operation options")
                : undefined
            return Effect.gen(function* () {
                if (options !== undefined && !record(options))
                    return yield* Effect.fail(
                        new UserOperationError({
                            operation,
                            reason: "input",
                            outcome: "notDispatched",
                            inputValidation: inputValidationFailure(
                                "options",
                                "type",
                                "Operation options must be an object",
                            ).detail,
                        }),
                    )
                if (unsupportedOption)
                    return yield* Effect.fail(
                        new UserOperationError({
                            operation,
                            reason: "input",
                            outcome: "notDispatched",
                            inputValidation: unsupportedOption.detail,
                        }),
                    )
                if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
                    return yield* Effect.fail(
                        new UserOperationError({
                            operation,
                            reason: "input",
                            outcome: "notDispatched",
                            inputValidation: inputValidationFailure(
                                "options.timeoutMs",
                                "range",
                                "Operation timeoutMs must be an integer from 1 through 2,147,483,647 milliseconds",
                            ).detail,
                        }),
                    )
                const deadline = owner.logical.now() + timeout
                if (request.verifyType) {
                    const channel = yield* owner.rest.user(
                        token,
                        operation,
                        () => directMessageFetch(request.id!),
                        options,
                    )
                    if (request.verifyType === "group" && channel.type !== "group")
                        return yield* Effect.fail(
                            new UserOperationError({
                                operation,
                                reason: "input",
                                outcome: "notDispatched",
                                inputValidation: inputValidationFailure(
                                    "channelId",
                                    "relationship",
                                    "This operation requires a group DM channel",
                                ).detail,
                            }),
                        )
                }
                const remaining = Math.floor(deadline - owner.logical.now())
                if (remaining <= 0)
                    return yield* Effect.fail(
                        new UserOperationError({ operation, reason: "timeout", outcome: "notDispatched" }),
                    )
                if (request.noCache)
                    return yield* owner.rest.user(token, operation, () => request, { timeoutMs: remaining })
                const guard = owner.userCache.begin(request.resource, {
                    ...(request.id === undefined ? {} : { id: request.id }),
                    mutation: request.method !== "GET",
                    ...(request.replace === undefined ? {} : { replace: request.replace }),
                })
                return yield* owner.rest
                    .user(token, operation, () => request, { timeoutMs: remaining })
                    .pipe(
                        Effect.tap((value) =>
                            Effect.sync(() =>
                                owner.userCache.complete(
                                    guard,
                                    (value === undefined ? [] : Array.isArray(value) ? value : [value]) as readonly (
                                        User | DirectMessageChannel
                                    )[],
                                ),
                            ),
                        ),
                        Effect.onExit((exit) =>
                            Effect.sync(() => {
                                if (exit._tag === "Failure") {
                                    owner.userCache.failed(guard)
                                }
                                if (request.method === "DELETE" && request.id) owner.cache?.deleteChannel(request.id)
                            }),
                        ),
                    )
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
                if (!identifier(id))
                    return Effect.fail(
                        new UserOperationError({
                            operation: `${kind}.get`,
                            reason: "input",
                            outcome: "notDispatched",
                            inputValidation: inputValidationFailure(
                                kind === "users" ? "userId" : "channelId",
                                "format",
                                kind === "users"
                                    ? "User IDs must be decimal strings"
                                    : "Channel IDs must be decimal strings",
                            ).detail,
                        }),
                    )
                return Effect.succeed(this.userCache.get(kind, id))
            },
        )
    }

    /** Send one caller-described request through this client's REST scheduler */
    request<T>(input: RestRequest | DefaultRestRequest): Effect.Effect<RestResponse<T>, RestRequestFailure> {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.request<T>(this.#configuration.token, input)
                : Effect.fail(new ClientClosedError()),
        )
    }

    /**
     * Send one application command on a ready local shard through that socket's paced path.
     * Validation happens before anything is queued. The data is copied through JSON so later caller changes cannot
     * alter the frame, and a frame above Fluxer's 4,096-byte limit is rejected rather than closing the connection
     */
    gatewaySend(shardId: number, op: number, d: unknown, options?: unknown): Effect.Effect<void, GatewaySendFailure> {
        // Only encoding the caller data is marked, so a throw from its getters or toJSON is an application fault
        return suspendMarked((): Effect.Effect<void, GatewaySendFailure> => {
            if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                return Effect.fail(new ClientClosedError())
            const validShard = typeof shardId === "number" && Number.isSafeInteger(shardId) && shardId >= 0
            const validOpcode = typeof op === "number" && Number.isSafeInteger(op) && op >= 0
            const input = (path: string, explanation: string, cause?: unknown) =>
                Effect.fail(
                    new GatewaySendError({
                        reason: "input",
                        shardId: validShard ? shardId : null,
                        opcode: validOpcode ? op : null,
                        inputValidation: inputValidationFailure(path, path === "d" ? "format" : "type", explanation)
                            .detail,
                        cause,
                    }),
                )
            if (!validShard) return input("shardId", "Shard IDs must be non-negative integers")
            if (!validOpcode) return input("op", "Opcodes must be non-negative integers")
            // Only the default API passes options, whose signal the operation executor reads
            const unsupported = record(options)
                ? readCaller(() => unsupportedKeyFailure(options, ["signal"], "options", "the gateway send options"))
                : undefined
            if (unsupported)
                return Effect.fail(
                    new GatewaySendError({ reason: "input", shardId, opcode: op, inputValidation: unsupported.detail }),
                )
            if (reservedClientOpcodes.has(op))
                return Effect.fail(new GatewaySendError({ reason: "reserved", shardId, opcode: op }))
            const result = readCaller(() => encodeCommandData(d))
            if ("failure" in result) return input("d", "Command data must be encodable as JSON", result.failure)
            const encoded = result.json
            if (encoded === undefined) return input("d", "Command data must be a JSON value; use null for no data")
            if (Buffer.byteLength(`{"op":${op},"d":${encoded}}`) > maxClientPayloadBytes)
                return input("d", "The encoded command must be at most 4,096 bytes")
            const shard = this.#shards.get(shardId)
            if (!shard) return Effect.fail(new GatewaySendError({ reason: "notOwned", shardId, opcode: op }))
            if (shard.state !== "Connected" || shard.submit === undefined)
                return Effect.fail(new GatewaySendError({ reason: "notReady", shardId, opcode: op }))
            // Fluxer limits raw member requests together with members.iterateChunks, so one counts there too, from the
            // moment the socket takes it, because a caller interrupted before it resumes cannot withdraw a sent frame
            const sent = op === Opcode.requestGuildMembers ? () => this.memberChunks.countSent() : undefined
            return shard.submit(op, JSON.parse(encoded), sent).pipe(
                Effect.mapError(
                    (reason) =>
                        new GatewaySendError({
                            reason: reason === "busy" ? "busy" : "notReady",
                            shardId,
                            opcode: op,
                        }),
                ),
            )
        })
    }

    webhook<A>(
        operation: WebhookOperation,
        build: () => WebhookRequest<A> | InputValidationFailure,
        options?: WebhookOperationOptions,
    ) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.webhook(this.#configuration.token, operation, build, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    guild<A>(operation: GuildOperation, build: GuildBuild<A>, options?: GuildOperationOptions) {
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

    deleteOwnGuildMessages(guildId: string, options: unknown) {
        return suspendInput(() => {
            const checked = ownDeletionOptions<GuildOperationOptions>(options)
            return checked instanceof InputValidationFailure
                ? this.guild<void>("guilds.deleteOwnMessages", () => checked)
                : this.guild("guilds.deleteOwnMessages", () => guildDeleteOwnMessages(guildId), checked)
        })
    }

    channel<A>(
        operation: ChannelOperation,
        build: () => ChannelRequest<A> | InputValidationFailure,
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
                    return Effect.fail(
                        new ChannelOperationError({
                            operation: "channels.get",
                            reason: "input",
                            outcome: "notDispatched",
                            inputValidation: inputValidationFailure(
                                "channelId",
                                "format",
                                "Channel IDs must be decimal strings",
                            ).detail,
                        }),
                    )
                return Effect.succeed(this.channelCache?.get(id))
            },
        )
    }

    getResource<K extends ResourceKind>(kind: K, target: string | MemberReference | RoleReference) {
        return suspendInput((): Effect.Effect<Resources[K] | undefined, ClientClosedError | GuildOperationError> => {
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
                return Effect.fail(
                    new GuildOperationError({
                        operation: `${kind}.get`,
                        reason: "input",
                        outcome: "notDispatched",
                        inputValidation: inputValidationFailure(
                            kind === "guilds" ? "guildId" : "target",
                            "format",
                            kind === "guilds"
                                ? "Guild IDs must be decimal strings"
                                : "Resource targets require decimal guild and resource IDs",
                        ).detail,
                    }),
                )
            return Effect.sync(() => this.resources?.get(kind, guildId, id))
        })
    }

    reply(target: MessageReference, input: MessageInput | string, options?: SendOptions) {
        return suspendInput(() => {
            const request = replyInput(target, input)
            if (request instanceof MessageError) return Effect.fail(request)
            return this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.reply(this.#configuration.token, request.target, request.input, options)
                : Effect.fail(new ClientClosedError())
        })
    }

    send(channelId: string, input: MessageInput | string, options?: SendOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.send(this.#configuration.token, channelId, input, options)
                : Effect.fail(new ClientClosedError()),
        )
    }
    refreshAttachmentUrls(
        urls: readonly string[],
        options?: AttachmentRefreshOptions,
    ): Effect.Effect<readonly RefreshedAttachmentUrl[], AttachmentRefreshFailure> {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.refreshAttachmentUrls(this.#configuration.token, urls, options)
                : Effect.fail(new ClientClosedError()),
        )
    }
    downloadAttachment(
        attachment: Attachment,
        options?: AttachmentDownloadOptions,
    ): Effect.Effect<Uint8Array, AttachmentDownloadFailure> {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.download(attachment, options)
                : Effect.fail(new ClientClosedError()),
        )
    }
    streamAttachment(
        attachment: Attachment,
        options?: AttachmentDownloadOptions,
    ): Effect.Effect<AttachmentDownloadSource, AttachmentDownloadFailure> {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.openDownload(attachment, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    forward(channelId: string, input: ForwardMessageInput, options?: SendOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.forward(this.#configuration.token, channelId, input, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    sendDirectMessage(userId: string, input: MessageInput | string, options?: SendOptions) {
        return suspendInput((): Effect.Effect<M, SendError> => {
            if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                return Effect.fail(new ClientClosedError())
            if (!identifier(userId))
                return Effect.fail(
                    new MessageError({
                        reason: "input",
                        outcome: "notDispatched",
                        inputValidation: inputValidationFailure("userId", "format", "User IDs must be decimal strings")
                            .detail,
                    }),
                )
            if (typeof input !== "string" && !record(input))
                return Effect.fail(
                    new MessageError({
                        reason: "input",
                        outcome: "notDispatched",
                        inputValidation: inputValidationFailure(
                            "input",
                            "type",
                            "Direct message input must be a string or an object",
                        ).detail,
                    }),
                )
            // The send encoder rejects a messageReference first, reading it only once with the other fields
            return this.rest.send(this.#configuration.token, userId, input, options, userId)
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
                ? this.rest.fetch(this.#configuration.token, target, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    publish(target: MessageReference, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.publish(this.#configuration.token, target, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    fetchCrosspostSource(target: MessageReference, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.fetchCrosspostSource(this.#configuration.token, target, options)
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
        if (!Effect.isEffect(task))
            return Effect.fail(
                new MessageOperationError({
                    operation: "typing",
                    reason: "input",
                    outcome: "notDispatched",
                    inputValidation: inputValidationFailure(
                        "task",
                        "type",
                        "The task passed to keepTyping must be an Effect",
                    ).detail,
                }),
            )
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
                ? this.rest.fetchHistory(this.#configuration.token, channelId, query, options)
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

    edit(target: MessageReference, input: EditMessageInput | string, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.edit(this.#configuration.token, target, input, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    delete(target: MessageReference, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.delete(this.#configuration.token, target, options)
                : Effect.fail(new ClientClosedError()),
        )
    }

    deleteAttachment(target: MessageReference, attachmentId: string, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? this.rest.deleteAttachment(this.#configuration.token, target, attachmentId, options)
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

    deleteOwnMessages(channelId: string, options: unknown) {
        return suspendInput(() => {
            if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                return Effect.fail(new ClientClosedError())
            const checked = ownDeletionOptions<MessageOperationOptions>(options)
            if (checked instanceof InputValidationFailure)
                return Effect.fail(
                    new MessageOperationError({
                        operation: "deleteOwnMessages",
                        reason: "input",
                        outcome: "notDispatched",
                        inputValidation: checked.detail,
                    }),
                )
            return this.rest.deleteOwnMessages(this.#configuration.token, channelId, checked)
        })
    }

    get(target: MessageReference) {
        return suspendInput((): Effect.Effect<M | undefined, ClientClosedError | MessageOperationError> => {
            if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                return Effect.fail(new ClientClosedError())
            const reference = snapshotReference(target)
            if (reference === undefined)
                return Effect.fail(
                    new MessageOperationError({
                        operation: "messages.get",
                        reason: "input",
                        outcome: "notDispatched",
                        inputValidation: inputValidationFailure(
                            "target",
                            "format",
                            "Message targets require decimal id and channelId strings",
                        ).detail,
                    }),
                )
            return Effect.sync(() => this.cache?.get(reference))
        })
    }

    #closeServices() {
        Deferred.doneUnsafe(this.#typingClosed, Effect.void)
        this.events.stop()
        this.rest.stop()
        return closeAll([
            Effect.exit(this.instance.shutdown()),
            Effect.exit(this.events.shutdown()),
            Effect.exit(this.tasks.shutdown()),
            Effect.exit(this.rest.shutdown()),
            Effect.exit(this.failures.shutdown()),
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
            ).pipe(Effect.map((exits) => defectsOnly(exits.flat()))),
        ]).pipe(Effect.onExit(() => this.#awaitTyping()))
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

    #supervise(configuration: Configuration<M>, startup: Deferred.Deferred<void, ConnectError>) {
        const owner = this
        return Effect.gen(function* () {
            // Automatic sizing counts guilds under its own deadline, so the shard group always gets its full budget
            let plan = owner.#plan ?? (yield* owner.#automaticPlan(configuration))
            // The refill waits for the whole group, and a failed startup ends this worker and the refill with it
            yield* Effect.forkChild(
                Effect.exit(Deferred.await(startup)).pipe(
                    Effect.flatMap((ready) => (Exit.isSuccess(ready) ? owner.#refillRestored() : Effect.void)),
                ),
            )
            for (let first = true; ; first = false) {
                // Capture and rethrow defects or interruption while masked, as REST attempts do. Otherwise an interruption that
                // skips this handler discards the plan's typed failure, and one pending at the mask's end discards the whole cause
                const exit = yield* Effect.uninterruptibleMask((restore) =>
                    Effect.exit(restore(owner.#runPlan(configuration, startup, plan, first))).pipe(
                        Effect.flatMap((exit) =>
                            Exit.isFailure(exit) && (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
                                ? Effect.failCause(exit.cause)
                                : Effect.succeed(exit),
                        ),
                    ),
                )
                const shardId = owner.#reshardShard
                if (Exit.isSuccess(exit)) return
                if (shardId === undefined || Cause.hasDies(exit.cause)) return yield* Effect.failCause(exit.cause)
                plan = yield* owner.#reshard(configuration, plan, shardId)
            }
        })
    }

    /**
     * Run every shard of one plan until one fails permanently. Only the first plan offers stored sessions, because a
     * snapshot belongs to the plan it was saved under
     */
    #runPlan(
        configuration: Configuration<M>,
        startup: Deferred.Deferred<void, ConnectError>,
        plan: ShardPlan,
        loadSessions: boolean,
    ) {
        const owner = this
        return Effect.gen(function* () {
            const spaced = plan.identifyShards && configuration.identifyCoordinator === undefined
            const startupTimeoutMs = startupBudgetMs(configuration.startupTimeoutMs, spaced ? plan.shardIds.length : 1)
            if (startupTimeoutMs > configuration.startupTimeoutMs)
                owner.logging.log({
                    level: "info",
                    category: "lifecycle",
                    code: "lifecycle.startupDeadline",
                    message: `Startup of ${plan.shardIds.length} shards may take up to ${formatDuration(startupTimeoutMs)}: The configured ${formatDuration(configuration.startupTimeoutMs)} (connection.startupTimeoutMs) plus ${identifySpacingMs / 1_000} s per additional shard, because the SDK starts shard sessions ${identifySpacingMs / 1_000} s apart`,
                    fields: {
                        startupTimeoutMs,
                        configuredMs: configuration.startupTimeoutMs,
                        shards: plan.shardIds.length,
                    },
                })
            return yield* superviseShards({
                shards: [...owner.#shards.values()],
                startupTimeoutMs,
                attributeShards: plan.identifyShards,
                startup,
                runShard: (shard, deadline) =>
                    runShardLoop({
                        host: owner.#shardHost,
                        configuration,
                        startup,
                        shard,
                        plan,
                        deadline,
                        startupTimeoutMs,
                        established: owner.#groupReady,
                        loadSessions,
                    }),
            })
        })
    }

    /**
     * Decide whether a 4011 (sharding required) closure on this shard moves the automatic plan to a larger one: True when
     * it does, otherwise why not. Closures of sibling shards during the same move join it
     */
    #acceptReshard(shardId: number): true | string {
        if (this.#reshardShard !== undefined) return true
        const refused = admitReshard(this.#reshards, this.logical.now(), this.#plan!.totalShards)
        if (refused !== undefined) return refused
        this.#reshardShard = shardId
        return true
    }

    /**
     * Move every local shard to a larger automatic plan after Fluxer closed shardId with 4011, from an automatic plan or
     * the one-shard plan of omitted settings. The old sessions are already closed. Their guild-scoped observations are
     * released under the old routing, the guilds are counted again and the new plan's shards start new sessions.
     * Guild-scoped state observers see the waiting state, because the shard that served their guild is gone
     */
    #reshard(
        configuration: Configuration<M>,
        previous: ShardPlan,
        shardId: number,
    ): Effect.Effect<ShardPlan, ConnectionFailure> {
        const owner = this
        return Effect.gen(function* () {
            const waiting = owner.#groupReady ? "Recovering" : "Connecting"
            for (const shard of owner.#shards.values()) {
                owner.#gapShard(shard.shardId, false)
                shard.state = waiting
                shard.latency = null
                shard.recovery = null
                shard.submit = undefined
            }
            const listeners = [...owner.#shardListeners.values()]
            owner.#shardListeners.clear()
            owner.#setState(waiting)
            for (const set of listeners) for (const listener of set) listener(waiting)
            const guilds = yield* owner.countGuilds(configuration.startupTimeoutMs)
            const plan = largerShardPlan(guilds, previous.totalShards)
            owner.#reshardShard = undefined
            owner.#adoptPlan(plan, "Connecting")
            owner.presence.reroute()
            // Omitted settings start with this fixed one-shard plan and switch to automatic sharding at the first move
            const switched = previous === configuration.sharding
            owner.logging.log({
                level: "warn",
                category: "lifecycle",
                code: "lifecycle.resharded",
                message: `Fluxer closed shard ${shardId} with close code 4011 (sharding required), so ${switched ? "the client without sharding settings switched to automatic sharding and moved" : "automatic sharding moved"} from ${previous.totalShards} to ${plan.totalShards} shards for ${guilds} communit${guilds === 1 ? "y" : "ies"}. Every shard starts a new session, so events sent during the move are missed${switched ? '. Set sharding to "auto" to start with enough shards next time' : ""}`,
                shardId,
                fields: { guilds, previousTotalShards: previous.totalShards, totalShards: plan.totalShards },
            })
            return plan
        })
    }

    /**
     * Refill the enabled guild, role and channel caches for the guilds of shards that resumed a stored session, since a
     * resumed session receives no guild data. Guilds are fetched one request at a time through the REST scheduler, so
     * the refill holds at most one REST slot and waits out rate limits. It stops after refillFailureLimit failed guilds,
     * when a guild-list page does not move past the previous one and when the client closes
     */
    #refillRestored(): Effect.Effect<void> {
        const owner = this
        const shards = new Set(owner.#restoredShards)
        owner.#restoredShards.clear()
        const guildsEnabled = owner.resources?.diagnostics("guilds").configured === true
        const rolesEnabled = owner.resources?.diagnostics("roles").configured === true
        const channelsEnabled = owner.channelCache !== undefined
        if (shards.size === 0 || (!guildsEnabled && !rolesEnabled && !channelsEnabled)) return Effect.void
        return Effect.gen(function* () {
            const startedAt = owner.logical.now()
            const plan = owner.#plan!
            const guildIds: string[] = []
            let after: string | undefined
            let failed = 0
            let firstError: unknown
            let stopped: string | undefined
            while (true) {
                const page = yield* Effect.result(
                    owner.guild("guilds.fetchPage", () =>
                        guildList({ limit: guildCountPageSize, ...(after === undefined ? {} : { after }) }),
                    ),
                )
                if (page._tag === "Failure") {
                    if (page.failure instanceof ClientClosedError) return
                    firstError = page.failure
                    stopped = "the bot's community list could not be read"
                    break
                }
                // As in guilds.iterate, a page that repeats or goes back past the cursor would page forever
                const cursor = after
                if (cursor !== undefined && page.success.some((guild) => BigInt(guild.id) <= BigInt(cursor))) {
                    stopped = "the bot's community list returned a page that did not move past the previous one"
                    break
                }
                for (const guild of page.success)
                    if (shards.has(guildShardId(guild.id, plan.totalShards))) guildIds.push(guild.id)
                if (page.success.length < guildCountPageSize) break
                after = page.success.at(-1)!.id
            }
            let refilled = 0
            for (const guildId of stopped === undefined ? guildIds : []) {
                const reads: Effect.Effect<unknown, unknown>[] = [
                    ...(guildsEnabled ? [owner.guild("guilds.fetch", () => guildFetch(guildId))] : []),
                    ...(rolesEnabled ? [owner.guild("roles.fetchAll", () => roleList(guildId))] : []),
                    ...(channelsEnabled ? [owner.channel("channels.fetchAll", () => channelList(guildId))] : []),
                ]
                let failure: unknown
                for (const read of reads) {
                    const result = yield* Effect.result(read)
                    if (result._tag === "Success") continue
                    if (result.failure instanceof ClientClosedError) return
                    failure ??= result.failure
                }
                if (failure === undefined) {
                    refilled += 1
                    continue
                }
                failed += 1
                firstError ??= failure
                if (failed >= refillFailureLimit) {
                    stopped = `${failed} communities failed`
                    break
                }
            }
            const durationMs = Math.round(owner.logical.now() - startedAt)
            const shardText = `${shards.size} shard${shards.size === 1 ? "" : "s"}`
            owner.logging.log({
                level: failed > 0 || stopped !== undefined ? "warn" : "info",
                category: "lifecycle",
                code: "lifecycle.cacheRefill",
                message:
                    stopped !== undefined
                        ? `The cache refill after ${shardText} resumed saved sessions stopped after ${refilled} of ${guildIds.length} communities, because ${stopped}. The remaining cache entries fill as events and requests arrive`
                        : failed > 0
                          ? `Refilled the caches of ${refilled} of ${guildIds.length} communities after ${shardText} resumed saved sessions. The others failed, so their cache entries fill as events and requests arrive`
                          : `Refilled the caches of ${refilled} communit${refilled === 1 ? "y" : "ies"} after ${shardText} resumed saved sessions, in ${formatDuration(durationMs)}`,
                durationMs,
                ...(firstError === undefined ? {} : { error: firstError }),
                fields: { guilds: guildIds.length, refilled, failed, shards: shards.size },
            })
        })
    }

    /**
     * Count the bot's guilds by paging the current-user guild list within timeoutMs. Automatic sharding and the
     * supervisor's automatic plan both size their plans from this count. A page that does not move past the previous
     * one fails at once as a discovery ConnectionError, instead of paging until the deadline
     */
    countGuilds(timeoutMs: number): Effect.Effect<number, ConnectionFailure> {
        const owner = this
        return Effect.gen(function* () {
            const clock = yield* Clock.Clock
            const deadline = nowMs(clock) + timeoutMs
            let guilds = 0
            let after: string | undefined
            while (true) {
                const remaining = Math.floor(deadline - nowMs(clock))
                if (remaining <= 0) return yield* Effect.fail(new ConnectionTimeoutError(timeoutMs))
                const page = yield* owner
                    .guild(
                        "guilds.fetchPage",
                        () => guildList({ limit: guildCountPageSize, ...(after === undefined ? {} : { after }) }),
                        { timeoutMs: remaining },
                    )
                    .pipe(Effect.mapError((error) => automaticPlanFailure(error, timeoutMs)))
                // As in guilds.iterate, a page that repeats or goes back past the cursor would page until the deadline
                const cursor = after
                if (cursor !== undefined && page.some((guild) => BigInt(guild.id) <= BigInt(cursor)))
                    return yield* Effect.fail(
                        new ConnectionError("discovery", "protocol", null, {
                            details: {
                                detail: "the community list returned a page that did not move past the previous one, so the community count for automatic sharding could not be read",
                            },
                            hint: 'Set sharding.totalShards to a number instead of "auto"',
                        }),
                    )
                guilds += page.length
                if (page.length < guildCountPageSize) return guilds
                after = page.at(-1)!.id
            }
        })
    }

    /**
     * Size the plan from the bot's guild count, read by paging the current-user guild list under the startup deadline.
     * GET /gateway/bot is never used, because Fluxer returns a fixed compatibility shard count there
     */
    #automaticPlan(configuration: Configuration<M>): Effect.Effect<ShardPlan, ConnectionFailure> {
        const owner = this
        return Effect.gen(function* () {
            const guilds = yield* owner.countGuilds(configuration.startupTimeoutMs)
            if (owner.#plan !== undefined) return owner.#plan
            const plan = automaticShardPlan(guilds)
            owner.#adoptPlan(plan, "Connecting")
            owner.logging.log({
                level: "info",
                category: "lifecycle",
                code: "lifecycle.automaticSharding",
                message: `Automatic sharding chose ${plan.totalShards} shard${plan.totalShards === 1 ? "" : "s"} for ${guilds} communit${guilds === 1 ? "y" : "ies"}, aiming for at most ${guildsPerShard} communities per shard on average`,
                fields: { guilds, totalShards: plan.totalShards, guildsPerShard },
            })
            return plan
        })
    }

    /**
     * Save the resumable session of each shard that was Connected when shutdown began, once, after its socket closed.
     * A shard that was recovering is skipped, because its session may already have expired. Failures are logged in
     * full and never block shutdown
     */
    #saveSessions(): Effect.Effect<void> {
        const store = this.#configuration?.sessions
        const live = this.#saveOnClose
        this.#saveOnClose = undefined
        const plan = this.#plan
        if (!store || !live || !plan) return Effect.void
        const owner = this
        const shards = [...this.#shards.values()].filter(
            (shard) =>
                live.has(shard.shardId) &&
                shard.session.id !== undefined &&
                shard.session.sequence !== null &&
                shard.gatewayUrl !== undefined,
        )
        return Effect.forEach(
            shards,
            (shard) => {
                const snapshot: SessionSnapshot = Object.freeze({
                    sessionId: shard.session.id!,
                    sequence: shard.session.sequence!,
                    resumeUrl: shard.gatewayUrl!,
                    savedAt: Date.now(),
                    totalShards: plan.totalShards,
                })
                return Effect.tryPromise({
                    try: () => Promise.resolve(store.save(shard.shardId, snapshot)),
                    catch: (error) => error,
                }).pipe(
                    Effect.timeoutOrElse({
                        duration: sessionSaveTimeoutMs,
                        orElse: () =>
                            Effect.fail(
                                new Error(
                                    `The session store's save did not finish within ${formatDuration(sessionSaveTimeoutMs)}`,
                                ),
                            ),
                    }),
                    Effect.matchEffect({
                        onSuccess: () =>
                            Effect.sync(() =>
                                owner.logging.log({
                                    level: "debug",
                                    category: "lifecycle",
                                    code: "lifecycle.sessionSaved",
                                    message: `Saved shard ${shard.shardId}'s session, so the next start can resume it`,
                                    shardId: shard.shardId,
                                }),
                            ),
                        onFailure: (error) =>
                            Effect.sync(() =>
                                owner.logging.log({
                                    level: "error",
                                    category: "lifecycle",
                                    code: "lifecycle.sessionSaveFailed",
                                    message: `Shard ${shard.shardId}'s session could not be saved, so the next start begins a new session`,
                                    shardId: shard.shardId,
                                    error,
                                    origin: "application",
                                }),
                            ),
                    }),
                )
            },
            { concurrency: "unbounded", discard: true },
        )
    }

    #start(): Effect.Effect<void, ConnectError> {
        const owner = this
        return Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
                if (owner.#state === "Closing" || owner.#state === "Closed")
                    return yield* Effect.fail(new ClientClosedError())
                if (owner.#state === "Connected") return
                if (owner.#state !== "Disconnected") return yield* Effect.fail(new ClientBusyError())
                const configuration = owner.#configuration!
                owner.#everStarted = true
                const creator = yield* Effect.withFiber((fiber) => Effect.succeed(fiber))
                owner.logging.banners(creator.context)
                const plan = owner.#plan
                const host = new URL(configuration.instance.bootstrap).host
                owner.logging.log(
                    {
                        level: "info",
                        category: "lifecycle",
                        code: "lifecycle.starting",
                        message:
                            plan === undefined
                                ? `Starting Fluxerly ${sdkVersion()} for ${host} with an automatic shard count`
                                : `Starting Fluxerly ${sdkVersion()} for ${host} with ${plan.shardIds.length} shard${plan.shardIds.length === 1 ? "" : "s"}`,
                        fields: {
                            version: sdkVersion(),
                            instance: host,
                            shards: plan?.shardIds.length ?? null,
                            totalShards: plan?.totalShards ?? null,
                        },
                    },
                    creator.context,
                )
                const startup = Deferred.makeUnsafe<void, ConnectError>()
                let becameReady = false
                owner.#workerExit = undefined
                owner.#groupReady = false
                for (const shard of owner.#shards.values()) {
                    shard.state = "Connecting"
                    shard.recovery = null
                }
                owner.#setState("Connecting")
                const trackReady = owner.subscribe((state) => {
                    if (state === "Connected") becameReady = true
                })
                owner.#worker = yield* Effect.forkIn(
                    owner.#supervise(configuration, startup).pipe(
                        Effect.provideService(Clock.Clock, owner.logical.clock),
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
                                    const startedAt = Date.now()
                                    if (!closing)
                                        logShutdownStart(
                                            owner.logging,
                                            fiber.context,
                                            owner.#everStarted,
                                            "the connection ended",
                                        )
                                    owner.#setState("Closing")
                                    // An explicit shutdown lands here once the sockets are closed
                                    if (closing) yield* owner.#saveSessions()
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
                                    if (!closing)
                                        logShutdownEnd(owner.logging, fiber.context, {
                                            everStarted: owner.#everStarted,
                                            startedAt,
                                            services,
                                        })
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
                        // allow-silent: Outcomes are retained above, not left as unobserved fiber failures
                        Effect.catchCause(() => Effect.void),
                    ),
                    owner.scope,
                )
                const worker = owner.#worker
                // A shutdown can interrupt the worker before it runs, and then its exit handler above never runs.
                // Startup still ends, with the same ClientClosedError a closing client gives, instead of waiting forever
                worker.addObserver(() => Deferred.doneUnsafe(startup, Effect.fail(new ClientClosedError())))
                return yield* restore(Deferred.await(startup)).pipe(
                    Effect.tap(() => Effect.sync(() => owner.#logConnected(creator.context))),
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
            // A draining shutdown keeps the state until the drain ends, but the client never connects again
            if (this.#shutdownStarted || this.#state === "Closing" || this.#state === "Closed")
                return Effect.fail(new ClientClosedError())
            return this.#managed ? Effect.fail(new ClientBusyError()) : this.#start()
        })
    }

    waitForClose(): Effect.Effect<void, ConnectionFailure> {
        return Deferred.await(this.#terminal)
    }

    /**
     * Shut down once. A positive drainMs first stops event intake and lets running work finish until that deadline, while
     * the state and REST admission stay as they were
     */
    shutdown(drainMs = 0): Effect.Effect<void> {
        return Effect.withFiber((fiber) =>
            this.events.ownsHandler(fiber.id) ||
            this.failures.owns(fiber.id) ||
            this.tasks.owns(fiber.id) ||
            [...this.#messageCollectors].some((collector) => collector.owns(fiber.id)) ||
            [...this.#reactionCollectors].some((collector) => collector.owns(fiber.id))
                ? // A native handler cannot join its own cleanup: The client scope owns shutdown and interrupts this caller.
                  // A drain would wait for this handler, so the handler ends at once instead of when the drain ends
                  Effect.forkIn(this.#performShutdown(drainMs), this.scope).pipe(
                      Effect.andThen(drainMs > 0 ? Effect.interrupt : Effect.never),
                  )
                : this.#performShutdown(drainMs),
        )
    }

    #performShutdown(drainMs: number): Effect.Effect<void> {
        const owner = this
        return Effect.uninterruptible(
            Effect.suspend(() => {
                if (owner.#shutdownStarted) return Deferred.await(owner.#shutdown)
                if (owner.#state === "Closed") return Effect.void
                owner.#shutdownStarted = true
                const drain =
                    drainMs > 0
                        ? Effect.withFiber((fiber) =>
                              drainWork({
                                  events: owner.events,
                                  tasks: owner.tasks,
                                  requests: () => owner.rest.inFlight(),
                                  logging: owner.logging,
                                  drainMs,
                                  context: fiber.context,
                              }).pipe(Effect.provideService(Clock.Clock, owner.logical.clock)),
                          )
                        : Effect.void
                return drain.pipe(
                    Effect.andThen(owner.#closeAfterDrain()),
                    Effect.onExit((exit) => Deferred.done(owner.#shutdown, exit)),
                )
            }),
        )
    }

    /** The shutdown steps after any drain. A connection that ended during the drain has already closed the client */
    #closeAfterDrain(): Effect.Effect<void> {
        const owner = this
        return Effect.suspend(() => {
            if (owner.#state === "Closed") return Effect.void
            // Only sessions that are live now are worth resuming later
            owner.#saveOnClose = new Set(
                [...owner.#shards.values()]
                    .filter((shard) => shard.state === "Connected")
                    .map((shard) => shard.shardId),
            )
            owner.#setState("Closing")
            owner.events.stop()
            owner.rest.stop()
            owner.tasks.stop()
            return Effect.gen(function* () {
                const fiber = yield* Effect.withFiber((fiber) => Effect.succeed(fiber))
                const startedAt = Date.now()
                logShutdownStart(owner.logging, fiber.context, owner.#everStarted, undefined)
                if (owner.#worker) yield* Fiber.interrupt(owner.#worker)
                // Every shard's socket is closed now, so a saved session cannot receive further dispatches
                yield* owner.#saveSessions()
                const services = yield* Effect.exit(owner.#closeServices())
                const exit = owner.#workerExit
                owner.#finish()
                logShutdownEnd(owner.logging, fiber.context, {
                    everStarted: owner.#everStarted,
                    startedAt,
                    services,
                })
                if (Exit.isFailure(services)) {
                    Deferred.doneUnsafe(owner.#terminal, services)
                    return yield* Effect.failCause(services.cause)
                }
                if (exit && Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
                    Deferred.doneUnsafe(owner.#terminal, exit)
                    return yield* Effect.failCause(
                        Cause.fromReasons<never>(exit.cause.reasons.filter((reason) => reason._tag !== "Fail")),
                    )
                }
                Deferred.doneUnsafe(owner.#terminal, Effect.void)
            })
        })
    }

    run(): Effect.Effect<void, ConnectError> {
        const owner = this
        return Effect.uninterruptibleMask((restore) =>
            Effect.suspend(() => {
                if (owner.#shutdownStarted || owner.#state === "Closed" || owner.#state === "Closing")
                    return Effect.fail(new ClientClosedError())
                if (owner.#managed || owner.#state !== "Disconnected") return Effect.fail(new ClientBusyError())
                owner.#managed = true
                return restore(owner.#start().pipe(Effect.andThen(owner.waitForClose()))).pipe(
                    Effect.ensuring(owner.shutdown()),
                )
            }),
        )
    }
}

export function makeClient<F extends MessageFields | undefined = undefined>(
    options: unknown,
    scope: Scope.Scope,
    native = false,
): Effect.Effect<ClientOwner<SelectedMessage<F>>, ConfigurationError> {
    return Effect.gen(function* () {
        const identifyGate = typeof options === "object" && options !== null ? identifyGates.get(options) : undefined
        if (typeof options === "object" && options !== null) identifyGates.delete(options)
        const configuration = yield* validateConfiguration<F>(options, native)
        return yield* configuration.logging.provide(
            Effect.gen(function* () {
                const context = yield* Effect.context<never>()
                if (native) configuration.logging.context = context
                const callback = configuration.onError as ((report: unknown) => unknown) | undefined
                const hook = callback
                    ? (report: InternalReport): Effect.Effect<unknown, unknown> =>
                          native
                              ? Effect.suspend(() => {
                                    const result = callback(report)
                                    // The report worker supplies the captured creation context, including the hook's services
                                    return Effect.isEffect(result)
                                        ? (result as Effect.Effect<unknown, unknown>)
                                        : Effect.die(
                                              new TypeError(
                                                  "An onError hook in the native Effect API must return an Effect",
                                              ),
                                          )
                                })
                              : Effect.tryPromise({
                                    try: () => Promise.resolve(callback(publicReport(report))).then(throwIfErr),
                                    catch: (error) => error,
                                })
                    : undefined
                const failures = new FailureReporter(configuration.logging, hook, () => context)
                const logical = yield* makeLogicalScheduler(scope, (owner, cause) =>
                    configuration.logging.log({
                        level: "error",
                        category: owner.includes("cache") ? "cache" : "sdk",
                        code: "sdk.timerFailed",
                        message: `The ${owner} timer callback failed`,
                        error: primaryError(cause),
                        cause,
                    }),
                )
                return new ClientOwner(
                    configuration,
                    scope,
                    failures,
                    logical,
                    identifyGate,
                    configuration.transport.transport,
                )
            }),
        )
    })
}
