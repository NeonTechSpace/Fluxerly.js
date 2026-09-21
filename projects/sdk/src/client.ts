import type { MessageCacheOptions, ResourceCacheSettings } from "./cache.js"
import type { GuildChannel } from "./channels.js"
import type { GuildEmoji, GuildSticker } from "./expressions.js"
import type { Guild, GuildMember, GuildRole } from "./guilds.js"
import type { DefaultLoggingOptions } from "./logging.js"
import type { Message, MessageCore, MessageFields, SelectedMessage } from "./messages.js"
import type { ShardingOptions, ShardState } from "./sharding.js"
import type { DirectMessageChannel, User } from "./users.js"
import type { InstanceOptions } from "./instance.js"

/**
 * Configure a bot client before connecting or making requests.
 * Creation checks and copies these settings without authenticating the token or opening a connection.
 * Settings belong to this client and cannot be changed after creation
 */
export interface ClientOptions<F extends MessageFields | undefined = undefined> {
    /**
     * Choose which optional message fields your application receives.
     * Omit this setting for full Message output.
     * An empty array keeps id, channelId, content, author and guildId when the response supplies it
     *
     * Excluded fields are absent, not undefined or empty arrays, in this client's REST, event, cache and collector results
     *
     * Selecting a field includes its nested values.
     * For example, messageSnapshots keeps its own media even when top-level media fields are excluded
     *
     * This reduces locally constructed objects, not network payloads or server-side data.
     * The SDK still rejects malformed recognized response fields, even when you exclude them
     *
     * Unknown field names and non-arrays fail with ConfigurationError whose field is messageFields.
     * Including core field names is allowed and does not change the required core
     *
     * TypeScript infers exact selections from literal tuples, but makes optional fields optional for arrays whose contents are unknown.
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
     * The client retains those endpoints until shutdown and trusts them for credentialed service requests.
     * HTTPS and WSS are required unless you explicitly allow HTTP and WS with allowInsecure
     */
    readonly instance?: InstanceOptions
    /** Bound the attachment transfer bytes reserved by queued and active upload operations */
    readonly uploads?: {
        /** Maximum reserved attachment transfer bytes across queued and active operations, as a positive safe integer.
         * Defaults to 104,857,600 (100 MiB), separate from the 4 MiB queued JSON budget.
         * The SDK reserves accepted byte-array lengths, file sizes or declared stream sizes before waiting for a request slot.
         * A new operation fails with busy if its reservation would exceed this limit.
         * Reservations remain held across rate-limit retries and release after transport cleanup.
         * This excludes caller buffers, metadata and runtime overhead, so it is not a JavaScript heap or process-memory ceiling
         */
        readonly maxBytes?: number
    }
    /**
     * Configure this client's log output without changing another client.
     * Creation copies and checks these settings without invoking a logger.
     * Connection diagnostics and low-cardinality operation measurements are off by default, while handler, cache-policy and observer error reports remain enabled.
     * SDK messages omit credentials, private payloads and raw upstream errors.
     * Logging does not consume or replace returned operation failures, and adds no telemetry service, background work or stored history
     *
     * @example
     * ```ts
     * import { createClient, fromStructuredLogger } from "@neontechspace/fluxerly"
     * export function loggingExample(token: string) {
     *     return createClient({
     *         token,
     *         logging: {
     *             development: true,
     *             measurements: true,
     *             logger: fromStructuredLogger(record => console.log(JSON.stringify(record))),
     *         },
     *     })
     * }
     * ```
     */
    readonly logging?: DefaultLoggingOptions
    /** Bot token used to authenticate requests and gateway connections.
     * Creation requires a non-blank string, but only Fluxer can establish whether the token is valid
     */
    readonly token: string
    /**
     * Keep bounded, memory-only resource snapshots for local lookups.
     * Omit this setting to retain no snapshots, without disabling REST reads or event delivery.
     * Each category has its own client-wide budget shared across this client's shards, not a budget per shard or guild.
     * A lost gateway connection clears affected observations even after resume.
     * When a snapshot lacks enough guild context to identify its shard, the SDK clears it conservatively
     */
    readonly cache?: {
        /** Cache public account profiles from explicit reads and complete user events, not partial message authors.
         * Local lookups improve eviction priority without renewing age.
         * Targeted reads conflict only with later observations of the same account, so unrelated IDs can both populate.
         * Reads without a target ID, lost gateway connections, clear and shutdown retain collection-wide fences
         */
        readonly users?: boolean | ResourceCacheSettings
        /** Cache private conversations from explicit reads and complete channel events, without automatically listing them.
         * Local lookups improve eviction priority without renewing age.
         * Targeted reads, mutations and channel events conflict only for the same conversation.
         * Full-list reads, opening by user ID, account updates, connection gaps, clear and shutdown retain collection-wide fences
         */
        readonly directMessages?: boolean | ResourceCacheSettings
        /** Cache guild details from explicit reads and guild create or update events, without preloading members or roles.
         * Guild removal or unavailability clears this guild's cached resources, including channels
         */
        readonly guilds?: boolean | ResourceCacheSettings
        /** Cache individual memberships from explicit reads, REST pages and member add or update events.
         * Member removal clears that membership.
         * Successful or uncertain role assignment clears the target
         */
        readonly members?: boolean | ResourceCacheSettings
        /** Cache role definitions from explicit list, create or edit results and role events.
         * Successful or uncertain creation or reordering clears this guild's cached roles.
         * Edits clear their target, or all this guild's roles when changing hoistPosition.
         * Role deletion also clears cached memberships because assignments can change without individual member events.
         * A full list removes missing roles only when no conflicting observation overlaps the read.
         * Partial bulk events replace only the roles they supply.
         * Byte accounting represents bigint permission fields as decimal strings
         */
        readonly roles?: boolean | ResourceCacheSettings
        /** Cache emoji metadata from REST reads and writes, not image bytes or creator accounts.
         * Guild expression events clear observations.
         * ResourceCacheSettings controls bounds and expiry, while gaps and shutdown release snapshots
         */
        readonly emojis?: boolean | ResourceCacheSettings
        /** Cache sticker metadata, with the same bounds, expiry and invalidation rules as emojis */
        readonly stickers?: boolean | ResourceCacheSettings
        /** Cache guild channels from explicit reads and channel create or update events, without automatically listing them.
         * Once a channel mutation is dispatched, the SDK clears this client's channel cache and prevents pending reads from restoring it.
         * Bulk ordering events clear this guild's cached channels because permission updates may still be in progress.
         * Category updates or deletions also clear this guild's channels because children can inherit changed permissions.
         * Visibility loss clears the affected channel.
         * A full list removes missing channels only when no conflicting observation overlaps the read.
         * These snapshots are not a complete copy of the guild's channels
         */
        readonly channels?: boolean | ResourceCacheSettings
        /**
         * Cache messages encountered in eligible REST results and gateway events, without automatically requesting history.
         * Omission or false disables this category, while true or an options object enables it.
         * Updates replace snapshots, while deletions and uncertain mutations remove them.
         * Lost gateway connections clear affected entries even when the session resumes successfully.
         * Conflicting in-flight observations can cause misses.
         * Shutdown releases this client's references, not messages still held by your application
         */
        readonly messages?: boolean | MessageCacheOptions<NoInfer<SelectedMessage<F>>>
    }
    /** Set the startup deadline and retry limit used by both connect and run */
    readonly connection?: {
        /**
         * Total milliseconds allowed for startup, including instance discovery, retries and every local shard becoming ready.
         * Must be an integer from 1 through 2,147,483,647.
         * The SDK spaces new-session Identify commands by one second when this client owns multiple shards.
         * That wait counts against this deadline, but does not coordinate quotas across processes or an IP address.
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
    }
    /**
     * Divide guild gateway traffic into numbered connections, called shards, and choose which this client owns.
     * Omit this setting for one gateway connection, or omit shardIds to assign every shard in totalShards to this client.
     * Explicit IDs are copied in your supplied order and cannot change during this client's lifetime.
     * Use non-overlapping ID lists when another supervisor distributes shards across processes.
     * Shard zero receives direct-message traffic, so a client handling DMs must own ID zero.
     * The SDK checks the plan but does not choose its size, coordinate processes or change a running shard assignment.
     * A total of one uses the single-connection Identify format, without a shard tuple
     */
    readonly sharding?: ShardingOptions
}

/**
 * The client's current gateway lifecycle state, not a history of events.
 * Disconnected permits startup, and Connecting includes startup retries until every local shard is ready at the same time.
 * Connected means every local shard is ready.
 * Recovering means an established shard has lost readiness and lasts until all local shards are ready again.
 * Other ready shards can continue work during Recovering.
 * Closing means permanent cleanup is underway, and Closed requires a new client to connect again
 */
export type ConnectionState = "Disconnected" | "Connecting" | "Connected" | "Recovering" | "Closing" | "Closed"

/** The resource category to inspect or clear in the client's local cache, not a remote resource identifier */
export type CacheKind =
    "messages" | "guilds" | "members" | "roles" | "channels" | "users" | "directMessages" | "emojis" | "stickers"

/** Maps each cache category to the snapshot returned by its local lookup and enumeration methods.
 * Message snapshots use this client's selected message fields
 */
export interface CachedResources<M extends MessageCore = Message> {
    /** Messages encountered by eligible REST calls or gateway events */
    readonly messages: M
    /** Guild identity and settings, without a preloaded member or role list */
    readonly guilds: Guild
    /** Individual guild memberships */
    readonly members: GuildMember
    /** Guild role definitions */
    readonly roles: GuildRole
    /** Guild channels, distinct from private conversations */
    readonly channels: GuildChannel
    /** Public account profiles, not partial message authors */
    readonly users: User
    /** Direct-message and group direct-message conversations */
    readonly directMessages: DirectMessageChannel
    /** Guild emoji metadata, not image bytes */
    readonly emojis: GuildEmoji
    /** Guild sticker metadata, not image bytes */
    readonly stickers: GuildSticker
}

/** Limit the snapshots returned by one local cache enumeration, without fetching missing resources */
export interface CacheEntriesOptions {
    /** Maximum snapshots to return, from 1 through 1,000, default 100 */
    readonly limit?: number
}

/** Current snapshot count and accounted bytes for one local cache category.
 * These values measure SDK retention, not how many resources exist remotely or how much process memory is used
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

/** Inspect this client's current connection state, request occupancy and cache accounting.
 * These local values do not describe other processes or guarantee that a later request can start or the gateway will stay ready.
 * Diagnostics include no token, remote route, resource ID or cached payload
 */
export interface ClientDiagnostics {
    /** Current aggregate client lifecycle state, not an event history or a readiness promise */
    readonly state: ConnectionState
    /** Slowest current shard heartbeat round-trip time in milliseconds, or null under ClientState.gatewayLatencyMs availability rules */
    readonly gatewayLatencyMs: number | null
    /** Current locally owned shard state only, in configured local order */
    readonly shards: readonly ShardState[]
    /** Active and queued HTTP work shared by this client's operations.
     * Active values combine four REST or upload slots with four separate media-download slots.
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
    /** Current event-work registrations owned by this client, not process memory or an enforced aggregate quota.
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
     * An unsharded client contains only shard ID zero.
     * Inspect this to identify a recovering shard even while other shards remain ready.
     * It excludes shards owned by other processes and does not establish whole-bot state or cross-process ordering
     */
    readonly shards: readonly ShardState[]
}

/** Add cancellation to a default-API operation with an AbortController's signal.
 * Aborting affects this operation's owned work, not unrelated calls
 */
export interface OperationOptions {
    /**
     * Pass an AbortController's signal to cancel this operation and await its required cleanup.
     * An already-aborted signal cancels before the operation takes ownership.
     * For connect it controls startup only, so aborting after READY does not close the established connection.
     * For an accepted run it controls the full client lifetime, but waitForClose cancels only that observer.
     * Cancellation cannot undo a dispatched server mutation, and a later abort cannot undo completed work.
     * A malformed signal returns ConfigurationError with field signal before work starts, or on a lazy iterator's first next.
     * Throwing signal accessors or listener methods are unexpected defects rather than typed input failures.
     * Shutdown does not accept a signal
     */
    readonly signal?: OperationSignal
}

/** The AbortSignal members used by default-API operations.
 * A standard AbortController provides this shape without requiring DOM types in your TypeScript project
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
