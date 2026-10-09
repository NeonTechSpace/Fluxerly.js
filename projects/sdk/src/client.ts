import type { MessageCacheOptions, ResourceCacheSettings } from "./cache.js"
import type { GuildChannel } from "./channels.js"
import type { GuildEmoji, GuildSticker } from "./expressions.js"
import type { Guild, GuildMember, GuildRole } from "./guilds.js"
import type { ClientCounters, LoggingOptions } from "./logging.js"
import type { FailureReport } from "./failures.js"
import type { Observer } from "./observer.js"
import type { Message, MessageCore, MessageFields, SelectedMessage } from "./messages.js"
import type { ShardingOptions, ShardState } from "./sharding.js"
import type { DirectMessageChannel, User } from "./users.js"
import type { InstanceOptions } from "./instance.js"
import type { PresenceInput } from "./presence.js"
import type { RestOptions, TransportOptions } from "./rest.js"

/**
 * Configure a bot client before connecting or making requests.
 * Creation checks and copies these settings without authenticating the token or opening a connection.
 * Settings belong to this client and cannot be changed after creation
 *
 * @category Options
 */
export interface ClientOptions<F extends MessageFields | undefined = undefined> {
    /**
     * Choose which optional message fields the application receives.
     * Omit this setting for full Message output.
     * An empty array keeps id, channelId, content, author, type and guildId, where the last two are kept when the response supplies them
     *
     * Excluded fields are absent, not undefined or empty arrays, in this client's REST, event, cache and collector results
     *
     * Selecting a field includes its nested values.
     * For example, messageSnapshots keeps its own media even when top-level media fields are excluded
     *
     * This reduces the objects the SDK builds locally, not network payloads or data stored by Fluxer.
     * The SDK still rejects malformed recognized response fields, even when they are excluded
     *
     * Unknown field names and non-arrays fail with ConfigurationError whose field is messageFields.
     * Including core field names is allowed and does not change the required core
     *
     * TypeScript knows the exact selection when given a literal tuple. For an array whose contents are unknown, optional fields remain optional.
     * The copied selection lasts for this client's lifetime and does not affect separately created webhook clients or other resource types
     *
     * @example
     * ```ts
     * import { createClient } from "@neontechspace/fluxerly"
     * export function selectedMessagesExample(token: string) {
     *     return createClient({ token, messageFields: ["attachments", "messageReference"] })
     * }
     * ```
     */
    readonly messageFields?: F
    /**
     * Select a self-hosted or other Fluxer instance instead of hosted Fluxer.
     * Creation checks the root URL without a request.
     * The first REST, gateway or instance.resolve operation that needs endpoints reads the unauthenticated discovery document.
     * The client keeps those service addresses until shutdown and sends authenticated requests to them.
     * HTTPS and WSS are required unless allowInsecure explicitly allows HTTP and WS
     */
    readonly instance?: InstanceOptions
    /**
     * Tune how many REST requests this client runs and queues, and the default operation deadline.
     * See RestOptions for each limit and its default
     */
    readonly rest?: RestOptions
    /**
     * Replace the HTTP and WebSocket implementations or the User-Agent this client sends.
     * This is an advanced option for proxies, instrumentation and tests. See TransportOptions
     */
    readonly transport?: TransportOptions
    /** Bound the attachment transfer bytes reserved by queued and active upload operations */
    readonly uploads?: {
        /** Maximum reserved attachment transfer bytes across queued and active operations, as a positive safe integer.
         * Defaults to 104,857,600 (100 MiB), separate from the rest.queuedJsonMaxBytes queued JSON budget (4 MiB by default).
         * The SDK reserves accepted byte-array lengths, file sizes or declared stream sizes before waiting for a request slot.
         * A new operation fails with busy if its reservation would exceed this limit.
         * Reservations remain held across rate-limit retries and release after transport cleanup.
         * This excludes caller buffers, metadata and runtime overhead, so it is not a JavaScript heap or process-memory ceiling
         */
        readonly maxBytes?: number
    }
    /**
     * Configure this client's log output without changing another client.
     * By default the client prints Info and higher records to the console: Startup, shard readiness, connection loss
     * with its close code and next step, rate-limit waits of at least one second, shutdown, and application errors in full.
     * Raise or lower the level, adjust single categories, enable Debug records or send records to an application sink.
     * Creation copies and checks these settings without printing anything.
     * Records never contain tokens or other credentials. Logging does not consume or replace returned operation failures
     *
     * @example
     * ```ts
     * import { createClient } from "@neontechspace/fluxerly"
     * export function loggingExample(token: string) {
     *     return createClient({
     *         token,
     *         logging: {
     *             level: "info",
     *             categories: { rest: "debug" },
     *             sink: (record) => console.log(JSON.stringify(record)),
     *         },
     *     })
     * }
     * ```
     */
    readonly logging?: LoggingOptions
    /**
     * Receive every failure that has no returned result: Event handler, command, collector callback and filter,
     * cleanup progress and cache-callback failures, subscriptions stopped by overflow, and failed state observers.
     * The report holds the original error and IDs of the message involved, never message content.
     * A subscription's own onError takes precedence for that subscription.
     * Without a hook the SDK logs each failure at Error with its message, stack and cause chain.
     * A failure only queues its report. Reports are delivered one at a time in order. Up to 256 wait while the hook is busy, and later ones are logged instead, with fields.reportOutcome "queueFull", and counted in diagnostics().counters.reportsDropped.
     * A hook that throws or rejects is logged together with the original failure and is never retried.
     * Shutdown does not wait for a pending hook promise. The report it was handling and any queued ones are logged at Error instead,
     * with fields.reportOutcome "interrupted" for the report being handled and "clientClosed" for queued or later reports
     */
    readonly onError?: (report: FailureReport) => unknown
    /**
     * Receive structured measurements of this client's work to export as metrics or traces to any monitoring system:
     * Each REST request attempt with its route template, status and duration, rate-limit waits, reconnection attempts,
     * resumed sessions, and each handler and command invocation with its duration and outcome.
     * The observer runs synchronously when the measured work finishes and is independent of the logging settings.
     * Observations never contain tokens, payloads or message content.
     * An observer that throws is counted in diagnostics().counters.sinkFailures without changing SDK work.
     * The native API calls the same observer, in addition to its Effect metrics and spans.
     * A value that is not a function fails creation with ConfigurationError
     *
     * @example
     * ```ts
     * import { createClient, type Observation } from "@neontechspace/fluxerly"
     * export function observerExample(token: string, record: (observation: Observation) => void) {
     *     return createClient({
     *         token,
     *         observe: (observation) => {
     *             if (observation.type === "rest" || observation.type === "handler") record(observation)
     *         },
     *     })
     * }
     * ```
     */
    readonly observe?: Observer
    /** Gateway protocol handling and the optional fields sent in each new session's Identify */
    readonly gateway?: GatewayOptions
    /** Bot token used to authenticate requests and gateway connections, commonly read from the process environment.
     * Undefined is accepted so an environment value can be passed directly. Creation requires a non-blank string and
     * otherwise fails with ConfigurationError, whose hint names an unset environment variable as the likely cause.
     * Surrounding whitespace and one pair of matching quotes, which .env files often add, are removed.
     * A value that starts with a Bot or Bearer scheme is rejected, since the SDK adds the Bot scheme itself.
     * Only Fluxer can establish whether the token is valid
     */
    readonly token: string | undefined
    /**
     * Keep bounded, memory-only resource snapshots for local lookups.
     * Omit this setting to retain no snapshots, without disabling REST reads or event delivery.
     * Each category has its own client-wide budget shared across this client's shards, not a budget per shard or community.
     * A lost gateway connection clears affected users, direct messages and messages, even after the session resumes.
     * Community, member, role, emoji, sticker and channel snapshots stay while the shard resumes, because Fluxer replays every
     * missed event on Resume, and are cleared when the shard has to start a new session. Cached threads are the exception:
     * Fluxer does not replay thread list changes, so a resumed shard's threads are cleared.
     * Resume sends no community snapshots, so a process that resumes a session from sharding.sessions refills the enabled
     * community, role and channel caches through REST once every shard is ready, unless sharding.refillCaches is false.
     * When a snapshot lacks enough community context to identify its shard, the SDK clears it conservatively
     */
    readonly cache?: {
        /** Cache public account profiles from explicit reads and complete user events, not partial message authors.
         * A local lookup makes the item less likely to be removed for capacity, but does not extend its age limit.
         * Targeted reads conflict only with later observations of the same account, so unrelated IDs can both populate.
         * Reads without a target ID, lost gateway connections, clear and shutdown can prevent older responses from restoring the whole category
         */
        readonly users?: boolean | ResourceCacheSettings<User>
        /** Cache private conversations from explicit reads and complete channel events, without automatically listing them.
         * A local lookup makes the item less likely to be removed for capacity, but does not extend its age limit.
         * Targeted reads, mutations and channel events conflict only for the same conversation.
         * Full-list reads, opening by user ID, account updates, connection gaps, clear and shutdown can prevent older responses from restoring the whole category
         */
        readonly directMessages?: boolean | ResourceCacheSettings<DirectMessageChannel>
        /** Cache community details from explicit reads and guild create or update events, without preloading members.
         * Community removal or unavailability clears this community's cached resources, including channels
         */
        readonly guilds?: boolean | ResourceCacheSettings<Guild>
        /** Cache individual memberships from explicit reads, REST pages and member add or update events.
         * Member removal clears that membership.
         * Successful or uncertain role assignment clears the target
         */
        readonly members?: boolean | ResourceCacheSettings<GuildMember>
        /** Cache role definitions from explicit list, create or edit results and role events.
         * Successful or uncertain creation or reordering clears this community's cached roles.
         * Edits clear their target, or all this community's roles when changing hoistPosition.
         * Role deletion also clears cached memberships because assignments can change without individual member events.
         * A full list removes missing roles only when no conflicting observation overlaps the read.
         * Partial bulk events replace only the roles they supply.
         * A guild create event replaces this community's cached roles with its complete role list.
         * The cache counts bigint permission fields as decimal strings when measuring bytes
         */
        readonly roles?: boolean | ResourceCacheSettings<GuildRole>
        /** Cache emoji metadata from REST reads and writes, not image bytes or creator accounts.
         * A guild create event replaces this community's cached emojis with its complete list, and other community expression
         * events clear observations.
         * ResourceCacheSettings controls bounds and expiry, while gaps and shutdown release snapshots
         */
        readonly emojis?: boolean | ResourceCacheSettings<GuildEmoji>
        /** Cache sticker metadata, with the same bounds, expiry and invalidation rules as emojis */
        readonly stickers?: boolean | ResourceCacheSettings<GuildSticker>
        /** Cache community channels and threads from explicit reads and channel and thread events, without automatically listing them.
         * A guild create event replaces this community's cached channels and threads with the channels and active threads the bot can view.
         * Once a channel mutation is dispatched, the SDK clears this client's channel cache and prevents pending reads from restoring it,
         * except that an operation confined to one thread clears only that thread.
         * Bulk ordering events clear this community's cached channels because permission updates may still be in progress.
         * Category updates or deletions also clear this community's channels because children can inherit changed permissions.
         * Visibility loss clears the affected channel, and for a text, announcement, forum or media channel also its threads,
         * because Fluxer deletes them without thread deletion events.
         * Thread create and update events store the thread, a thread deletion clears it, and a thread list replaces the cached
         * threads of its community or of its listed parent channels. A change to the bot's own membership of a thread clears
         * that thread, because its membership field is then out of date.
         * A full list removes missing channels, never threads, only when no conflicting observation overlaps the read.
         * These snapshots are not a complete copy of the community's channels or threads
         */
        readonly channels?: boolean | ResourceCacheSettings<GuildChannel>
        /**
         * Cache messages encountered in eligible REST results and gateway events, without automatically requesting history.
         * Omission or false disables this category, while true or an options object enables it.
         * Updates replace snapshots, while deletions and uncertain mutations remove them.
         * A thread deletion removes the thread's messages. Deleting a text, announcement, forum or media channel also deletes its
         * threads without thread events, so it removes the messages of every channel in that community, or without community
         * context, that the channel cache does not hold, and every such message when the channel cache is off.
         * Lost gateway connections clear affected entries even when the session resumes successfully.
         * Overlapping reads and events can cause cache misses.
         * A response that differs from an overlapping event only by lacking its community ID keeps the event snapshot.
         * Shutdown releases this client's references, not messages still held by the application
         */
        readonly messages?: boolean | MessageCacheOptions<NoInfer<SelectedMessage<F>>>
    }
    /** Set the startup deadline and retry limit used by both connect and run, and the recovery timing after readiness */
    readonly connection?: {
        /**
         * Total milliseconds allowed for startup, including instance discovery, retries and every local shard becoming ready.
         * Must be an integer from 1 through 2,147,483,647.
         * When this client owns several shards, the SDK spaces their new-session Identify commands by one second and adds
         * one second to this deadline for each shard after the first, so the spacing alone never causes a timeout.
         * The spacing does not coordinate quotas across processes or an IP address. An identify coordinator replaces it, and
         * the coordinator's waits count against this deadline. Automatic sharding counts the bot's communities under a separate
         * deadline of the same length before the shards start.
         * Expiry stops startup work, while completion still waits for the SDK's owned-resource cleanup
         * @defaultValue 30000
         */
        readonly startupTimeoutMs?: number
        /**
         * Maximum attempts to start each local shard, including its first attempt, as a positive safe integer.
         * The SDK retries only failures it classifies as transient, and the overall deadline can stop retries sooner.
         * This does not limit recovery attempts after a session has become ready
         * @defaultValue 3
         */
        readonly maxStartupAttempts?: number
        /** Retry timing for established-session recovery. See ConnectionRecoveryOptions */
        readonly recovery?: ConnectionRecoveryOptions
    }
    /**
     * Divide community gateway traffic into numbered connections, called shards, and choose which this client owns.
     * Omit this setting for one gateway connection, or omit shardIds to assign every shard in totalShards to this client.
     * Explicit IDs are copied in the supplied order and cannot change during this client's lifetime.
     * Use non-overlapping ID lists when another supervisor distributes shards across processes.
     * Shard zero receives direct-message traffic, so a client handling DMs must own ID zero.
     * A total of one uses the single-connection Identify format, without a shard tuple
     *
     * The value "auto", or totalShards "auto", sizes the plan once, at the first connect, and assigns every shard to this
     * client. The SDK counts the bot's communities by paging GET /users/@me/guilds within startupTimeoutMs and uses one
     * shard per 2,000 communities, from 1 through 16,384 shards. It never uses the shard count from GET /gateway/bot, which
     * Fluxer fixes at 1. Fluxer rejects a new session with close code 4011 (sharding required) when that one shard holds
     * more than 2,500 communities (MAX_GUILDS_PER_SHARD in fluxer_gateway/src/gateway/gateway_sharding.erl). Community IDs do not
     * split evenly across shards, so the lower target keeps every shard below that ceiling and leaves room to grow.
     * Until that count completes, client.shards and diagnostics().shards are empty and community routing treats every community
     * as unowned. A failed count fails startup like a connection failure: A rejected token with AuthenticationError, an
     * exhausted rate limit with RateLimitError, the deadline with ConnectionTimeoutError and other failures with
     * ConnectionError whose phase is discovery, including a community list page that does not move past the previous one.
     *
     * When the bot grows and Fluxer closes a shard with 4011 while the client runs, the SDK counts the communities again and
     * moves every shard to a larger plan in the same process: The plan for the new count, or one shard more when the count
     * still fits the old total. Every shard then starts a new session under the new total, so events sent during the
     * switch are missed and community-scoped caches refill from the new sessions. The SDK logs lifecycle.resharded at Warn
     * and keeps running. A failed count during a move ends the client with the same errors as a failed count at startup.
     * After 3 such moves within an hour, or at 16,384 shards, a further 4011 ends the client with a
     * ConnectionError as an explicit total does. Automatic sizing suits one process that owns every shard. Processes
     * that split shards need an explicit total
     */
    readonly sharding?: ShardingOptions | "auto"
}

/**
 * Optional gateway settings: Malformed-dispatch handling and the fields sent in each new session's Identify.
 * Creation validates and copies every value
 *
 * @category Options
 */
export interface GatewayOptions {
    /** What to do when Fluxer sends a known dispatch that fails validation.
     * The default, skip, drops that event, logs gateway.dispatchRejected at Warn with the dispatch type and failing field path,
     * clears cache entries it could have changed and keeps the session running. When the dispatch lacks a usable
     * channel or community ID, the entries it could have changed are found by message ID or cleared more widely.
     * The value terminate ends the shard with a protocol ConnectionError instead, without the new-session retry that
     * other invalid gateway data gets
     */
    readonly onMalformedDispatch?: "skip" | "terminate"
    /**
     * Dispatch types Fluxer should not send to this client's sessions, to save bandwidth and decoding.
     * Omission suppresses nothing. An array lists upper-case dispatch names such as TYPING_START or PRESENCE_UPDATE:
     * Names may use letters, digits and underscores up to 64 characters, are upper-cased and deduplicated, and the list
     * may hold at most 256 names that encode to at most 2,560 bytes, keeping Identify within Fluxer's 4,096-byte limit.
     * Creation rejects READY, RESUMED and the request replies GUILD_MEMBERS_CHUNK, RATE_LIMITED, GUILD_COUNTS_UPDATE and
     * CHANNEL_MEMBER_COUNTS_UPDATE, and any type an enabled cache category needs to stay current, with ConfigurationError.
     * Fluxer still delivers MESSAGE_CREATE for a message that directly mentions the bot, @here or @everyone, but not
     * merely for a role mention, a direct message or a message the bot authored. A suppressed dispatch uses no sequence
     * number. MESSAGE_REACTION_ADD_MANY batches are generated from unsuppressed MESSAGE_REACTION_ADD dispatches, so
     * ignoring ADD prevents batches, while ignoring MANY alone does not. The list is fixed for each session, so changing
     * an explicit list needs a new client. Resume retains the session's filtering.
     * Registering an event whose source dispatch types are all suppressed receives nothing, apart from the message
     * mention exceptions, and each new session logs gateway.ignoredEventRegistered at Warn for such registrations
     *
     * The value "auto" computes the list at each new-session Identify from the events registered at that moment,
     * through on, subscribe, waitFor, collectors and command routers: Every dispatch type that delivers no registered
     * event is suppressed, except those enabled cache categories, presence member selection (GUILD_CREATE) and cache
     * clearing (GUILD_DELETE) need, READY, RESUMED, request replies and types this SDK version does not decode.
     * MESSAGE_REACTION_ADD and MESSAGE_REACTION_REMOVE are always kept, because reaction pages started after Identify
     * read clicks from them, so bots in busy guilds save less than the registrations alone suggest. A raw
     * subscriber disables suppression entirely. The tradeoff: A handler registered after a session started does not
     * receive suppressed types until that shard's next new session, which a Resume does not start, so register handlers
     * before connecting. A messageReactionAddMany registration keeps MESSAGE_REACTION_ADD for Fluxer's batch generator.
     * Cache categories keep their dispatch types whether or not an event is registered, so enabled caches reduce the
     * savings
     */
    readonly ignoredEvents?: readonly string[] | "auto"
    /**
     * Identify session flags. Omission sets none. Creation rejects other keys and non-boolean values
     */
    readonly flags?: {
        /**
         * Ask Fluxer to merge runs of reaction additions in direct messages and group direct messages into one
         * messageReactionAddMany event (MESSAGE_REACTION_ADD_MANY) instead of many messageReactionAdd events.
         * Community reactions always arrive individually. This is Fluxer's DEBOUNCE_MESSAGE_REACTIONS flag, value 2.
         * Defaults to false
         */
        readonly debounceMessageReactions?: boolean
    }
    /**
     * Initial presence: The status each new session's Identify carries, and the first presence intent, as if
     * presence.set were called with it before connecting. A later presence.set replaces it, and later new sessions
     * then Identify with the latest accepted presence. Because Fluxer may prefer the account's saved status to an
     * Identify presence, the SDK also publishes the intent with a presence update after READY or RESUMED, as for
     * presence.set. Creation validates it like presence.set and fails with ConfigurationError for invalid input.
     * Omission sends no Identify presence, so Fluxer uses the account's saved status
     */
    readonly presence?: PresenceInput
}

/**
 * Retry timing for shards that lost an established session. Startup retries keep their own timing within
 * connection.startupTimeoutMs. Each recovery wait is a random delay from zero up to a ceiling that starts at minDelayMs
 * and doubles per consecutive failure up to maxDelayMs, and never shorter than a wait Fluxer requires.
 * Recovery never gives up on transient failures unless a native recovery schedule ends it. Creation validates every
 * value and fails with ConfigurationError for other keys or out-of-range values
 *
 * @category Options
 */
export interface ConnectionRecoveryOptions {
    /** Ceiling for the first recovery retry in milliseconds, an integer from 100 through 2,147,483,647
     * @defaultValue 1000
     */
    readonly minDelayMs?: number
    /** Largest backoff ceiling in milliseconds, an integer from minDelayMs through 2,147,483,647.
     * Defaults to 30,000, or to minDelayMs when that is larger
     * @defaultValue 30000
     */
    readonly maxDelayMs?: number
    /** Time allowed for one recovery attempt in milliseconds, covering discovery, the handshake and Identify or Resume,
     * an integer from 1,000 through 2,147,483,647. An attempt that runs out fails and is retried
     * @defaultValue 30000
     */
    readonly attemptTimeoutMs?: number
    /** Continuous connected time in milliseconds after which the next connection loss restarts the backoff sequence
     * from minDelayMs, an integer from 1,000 through 2,147,483,647. Socket cleanup never counts as connected time
     * @defaultValue 60000
     */
    readonly healthyResetMs?: number
}

/**
 * The client's current gateway connection state, not a history of events.
 * Disconnected permits startup. Connecting includes startup retries until every shard owned by this client is ready at the same time.
 * Connected means every local shard is ready.
 * Recovering means an established shard lost readiness and lasts until all shards owned by this client are ready again.
 * Other ready shards can continue work during Recovering.
 * Closing means permanent cleanup is underway, and Closed requires a new client to connect again
 *
 * @category Client and lifecycle
 */
export type ConnectionState = "Disconnected" | "Connecting" | "Connected" | "Recovering" | "Closing" | "Closed"

/**
 * The resource category to inspect or clear in the client's local cache, not a remote resource identifier
 *
 * @category Caching
 */
export type CacheKind =
    "messages" | "guilds" | "members" | "roles" | "channels" | "users" | "directMessages" | "emojis" | "stickers"

/** Maps each cache category to the snapshot returned by its local lookup and enumeration methods.
 * Message snapshots use this client's selected message fields
 *
 * @category Caching
 */
export interface CachedResources<M extends MessageCore = Message> {
    /** Messages encountered by eligible REST calls or gateway events */
    readonly messages: M
    /** Community identity and settings, without a preloaded member or role list */
    readonly guilds: Guild
    /** Individual community memberships */
    readonly members: GuildMember
    /** Community role definitions */
    readonly roles: GuildRole
    /** Community channels, distinct from private conversations */
    readonly channels: GuildChannel
    /** Public account profiles, not partial message authors */
    readonly users: User
    /** Direct-message and group direct-message conversations */
    readonly directMessages: DirectMessageChannel
    /** Community emoji metadata, not image bytes */
    readonly emojis: GuildEmoji
    /** Community sticker metadata, not image bytes */
    readonly stickers: GuildSticker
}

/**
 * Limit the snapshots returned by one local cache enumeration, without fetching missing resources
 *
 * @category Caching
 */
export interface CacheEntriesOptions {
    /** Maximum snapshots to return, from 1 through 1,000, default 100 */
    readonly limit?: number
}

/** Current snapshot count and accounted bytes for one local cache category.
 * These values measure SDK retention, not how many resources exist remotely or how much process memory is used
 *
 * @category Caching
 */
export interface CacheDiagnostic {
    /** Whether this category was configured when the client was created. A Closing/Closed client accepts no further snapshots */
    readonly configured: boolean
    /** Snapshots still held by the SDK after expired entries are removed */
    readonly retainedEntries: number
    /** Accounted UTF-8 JSON bytes of retained snapshots, excluding JavaScript overhead and caller-held copies */
    readonly accountedBytes: number
    /** Configured client-wide entry bound, or null when this category was disabled */
    readonly maxEntries: number | null
    /** Configured client-wide accounted-byte bound, or null when this category was disabled */
    readonly maxBytes: number | null
}

/** Inspect this client's current connection state, occupied request slots and cache usage.
 * These local values do not describe other processes or guarantee that a later request can start or the gateway will stay ready.
 * Diagnostics include no token, remote route, resource ID or cached payload
 *
 * @category Logging and diagnostics
 */
export interface ClientDiagnostics {
    /** Current aggregate client lifecycle state, not an event history or a readiness promise */
    readonly state: ConnectionState
    /** Slowest current shard heartbeat round-trip time in milliseconds, or null under ClientState.gatewayLatencyMs availability rules */
    readonly gatewayLatencyMs: number | null
    /** Current locally owned shard state only, in configured local order.
     * Empty for an automatically sized client until its first connect has chosen the plan
     */
    readonly shards: readonly ShardState[]
    /** HTTP requests running or waiting for a slot in this client.
     * Active values combine the rest.concurrency REST or upload slots, four per local shard by default, with the separate rest.mediaConcurrency media-download slots, four by default.
     * Queued JSON bytes exclude attachment transfers and do not measure heap or process memory
     */
    readonly rest: {
        /** Requests currently using either the REST/upload pool or the media-download pool */
        readonly activeRequests: number
        /** Combined active-request capacity of those two pools */
        readonly activeCapacity: number
        /** Requests waiting for a local request slot */
        readonly queuedRequests: number
        /** Maximum queued requests shared by both pools */
        readonly queuedCapacity: number
        /** Accounted JSON-body bytes of queued requests, excluding attachment transfer bytes */
        readonly queuedJsonBytes: number
        /** Maximum accounted JSON-body bytes allowed in the shared queue */
        readonly queuedJsonByteCapacity: number
    }
    /** Attachment transfer reservations across queued and active uploads, not caller buffers or remote temporary storage */
    readonly uploads: {
        /** Attachment transfer bytes currently reserved by queued and active work */
        readonly reservedBytes: number
        /** Configured maximum transfer-byte reservation for this client */
        readonly byteCapacity: number
    }
    /** Local request slots shared by fresh counts and member streams, not provider worker occupancy or a cross-process quota */
    readonly gatewayRequests: {
        /** Logical count requests and member streams currently holding shared local slots */
        readonly activeRequests: number
        /** Maximum logical requests allowed concurrently by this client */
        readonly activeCapacity: number
    }
    /** Current event sources, collectors and running callbacks owned by this client, not process memory or a shared quota.
     * Counts exclude other clients and application tasks outside SDK event handlers
     */
    readonly events: {
        /** Open event sources, including subscriptions, event streams and single-event waits */
        readonly subscriptions: number
        /** Registered message collectors, including collectors waiting for matching messages */
        readonly messageCollectors: number
        /** Registered reaction collectors, including collectors waiting for matching reactions */
        readonly reactionCollectors: number
        /** Subscription callbacks currently executing, excluding idle subscriptions and collector filters */
        readonly activeHandlers: number
    }
    /** Accounting for each local cache category.
     * Closure releases retained snapshots but leaves configured capacity values available for inspection
     */
    readonly caches: Readonly<Record<CacheKind, CacheDiagnostic>>
    /** Running totals of failures, drops, retries, waits and reconnects since creation, including work the logs summarized or suppressed */
    readonly counters: ClientCounters
}

/** Observe a client's current gateway state in either API without starting a connection */
export interface ClientState {
    /** Current connection state, controlled by the SDK rather than the consumer */
    readonly state: ConnectionState
    /**
     * The slowest current heartbeat round-trip time in milliseconds across this client's gateway shards.
     * Null unless the client is Connected and every local shard has a current heartbeat acknowledgement.
     * Connection loss, recovery and shutdown clear the affected shard's measurement until its new connection receives an acknowledgement.
     * Zero is a valid measurement, not a marker for unavailable data
     */
    readonly gatewayLatencyMs: number | null
    /**
     * Frozen connection state and heartbeat measurements for this client's shards, in configured local ID order.
     * An unsharded client contains only shard ID zero, and an automatically sized client contains none until its
     * first connect has chosen the plan.
     * Inspect this to identify a recovering shard even while other shards remain ready.
     * It excludes shards owned by other processes and does not establish whole-bot state or cross-process ordering
     */
    readonly shards: readonly ShardState[]
    /**
     * Return the ID of this client's shard that receives a community's gateway events, or undefined when another
     * process owns that shard. Fluxer calls a community a guild, so the argument is a guild ID.
     * An automatically sized client returns undefined until its first connect has chosen the plan, and the answer can
     * change when automatic sharding moves to a larger plan. snowflakes.shardFor computes the same routing for any plan.
     * Throws ConfigurationError when the ID is not a decimal string
     */
    shardIdForGuild(guildId: string): number | undefined
}

/**
 * Choose how shutdown treats work that is still running, in both entry points
 *
 * @category Client and lifecycle
 */
export interface ShutdownOptions {
    /**
     * Milliseconds to let running work finish before shutdown cancels it, an integer from 0 through 2,147,483,647.
     * The default 0 cancels running handlers at once. The runBot function drains for 5,000 ms by default when asked to stop.
     *
     * During the drain the client accepts no new events. New subscriptions and event waits start closed, as after shutdown.
     * Running handlers and commands continue, events already waiting in on handler queues still run, and REST requests
     * continue, including new ones that handlers send. The connection state stays as it was until the drain ends.
     * The drain ends as soon as no handler is running or waiting and no REST request is in progress, logging
     * lifecycle.drained, or when the time runs out. Then shutdown continues as usual and cancels what is left, logging how
     * many handlers, events and requests it cut off as a lifecycle.drainTimedOut Warn record.
     * Collectors and subscribe subscriptions receive no events during the drain and end with the shutdown.
     * A shutdown call while another is in progress shares that shutdown and its drain.
     *
     * A default API handler that awaits a draining shutdown of its own client keeps the drain waiting until the time runs
     * out, so start the shutdown without awaiting it there. A native handler or collector callback that calls shutdown
     * ends at once, and the drain continues for the other work.
     * An invalid value throws ConfigurationError in the default API and dies with it in the Effect API, before shutdown starts
     */
    readonly drainMs?: number
}

/** Add cancellation to a default-API operation with an AbortController's signal.
 * Aborting affects this operation's owned work, not unrelated calls
 *
 * @category Options
 */
export interface OperationOptions {
    /**
     * Pass an AbortController's signal to cancel this operation and await its required cleanup.
     * An already-aborted signal cancels before the operation takes ownership.
     * For connect it controls startup only, so aborting after READY does not close the established connection.
     * For an accepted run it controls the full client lifetime, but waitForClose cancels only that observer.
     * Cancellation cannot undo a dispatched server mutation, and a later abort cannot undo completed work.
     * A malformed signal returns ConfigurationError with field signal before work starts, or on a lazy iterator's first next.
     * Throwing signal accessors or listener methods are application faults rather than typed input failures, rejected as
     * SdkDefect with code application.defect and the thrown value as its cause.
     * Shutdown does not accept a signal
     */
    readonly signal?: OperationSignal
}

/** The AbortSignal members used by default-API operations.
 * A standard AbortController provides this shape without requiring DOM types in the TypeScript project
 *
 * @category Options
 */
export interface OperationSignal {
    /** Whether cancellation has already been requested */
    readonly aborted: boolean
    /** Register the callback that requests operation cancellation when the signal aborts */
    addEventListener(
        type: "abort",
        listener: () => void,
        options?: {
            /** Remove this listener automatically after its first abort event */
            once?: boolean
        },
    ): void
    /** Remove the operation's callback when its observation ends */
    removeEventListener(type: "abort", listener: () => void): void
}
