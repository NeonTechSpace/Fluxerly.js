import type { Message, MessageCore, MessageDeletion, MessageBulkDeletion } from "./messages.js"
import type { ChannelPinsUpdate } from "./pins.js"
import type { Guild, GuildDeletion, MemberReference } from "./guilds.js"
import type { GuildEmoji, GuildSticker } from "./expressions.js"
import type { MessageReaction, MessageReactionBatch, MessageReactionEmojiRemoval, ReactionTarget } from "./reactions.js"
import type { InviteMetadata } from "./invites.js"
import type { AuditLogEntry } from "./audit-logs.js"

/** Notice that the webhooks in a channel changed.
 * No webhook details or token are included. Fetch the current set explicitly if needed.
 * This notification does not write or invalidate an SDK cache
 */
export interface WebhooksUpdate {
    /** Server owning the channel, as a decimal ID */
    readonly guildId: string
    /** Channel whose webhook collection changed */
    readonly channelId: string
}

/** Notice that an invite was deleted, without its former settings.
 * Treat the code as access-granting data and keep it out of diagnostics and public logs
 */
export interface InviteDeleteEvent {
    /** Deleted invite's code, the stable identity supplied for this event */
    readonly code: string
    /** Invite destination channel ID, when supplied */
    readonly channelId?: string
    /** Invite destination server ID, when supplied */
    readonly guildId?: string
}

/** Audit entry newly written in a server, using the same field names as audit-log requests.
 * The entry and its nested data are frozen. Access requires Fluxer's VIEW_AUDIT_LOG permission.
 * reason, options and changes can contain application or provider data, so do not treat them as safe diagnostics.
 * Numeric and boolean option values are converted to the same types used by audit-log reads
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export function administrativeEventsExample(client: Client) {
 *     return client.events("guildAuditLogEntryCreate", { maxPendingMessages: 10 })
 * }
 * ```
 */
export interface GuildAuditLogEntryCreate extends AuditLogEntry {
    /** Server that recorded the entry */
    readonly guildId: string
    /** Acting account ID supplied for this entry */
    readonly userId: string
    /** Affected resource ID or invite code, or null when Fluxer recorded no target */
    readonly targetId: string | null
}

/** Notice that an account began typing, not a lasting indication that it is still typing.
 * The SDK does not cache this notice or fetch the user or channel
 */
export interface TypingStart {
    /** Channel ID where typing began */
    readonly channelId: string
    /** Account ID that began typing */
    readonly userId: string
    /** Fluxer's Unix timestamp in whole seconds, not milliseconds */
    readonly timestamp: number
    /** Owning server ID, when supplied. Absence alone does not prove that the channel is private */
    readonly guildId?: string
}

/** Custom emoji collection supplied in one server update, frozen in received order.
 * No creator accounts or image contents are included. This is not an initial enumeration or an automatic cache refill
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export function expressionEventsExample(client: Client) {
 *     return client.events("guildEmojisUpdate", { maxPendingMessages: 10 })
 * }
 * ```
 */
export interface GuildEmojisUpdate {
    /** Server owning this emoji collection, as a decimal ID */
    readonly guildId: string
    /** Emoji snapshots in Fluxer's received order */
    readonly items: readonly GuildEmoji[]
}

/** Custom sticker collection supplied in one server update, frozen in received order.
 * No creator accounts or image contents are included. This is not an initial enumeration or an automatic cache refill
 */
export interface GuildStickersUpdate {
    /** Server owning this sticker collection, as a decimal ID */
    readonly guildId: string
    /** Sticker snapshots in Fluxer's received order */
    readonly items: readonly GuildSticker[]
}

/** A frozen guild-availability observation with event-specific join metadata.
 * It retains the Guild fields without adding lifecycle state to REST results or cached Guild snapshots.
 * Subscribe before connect to observe the startup availability burst. connect does not wait for that burst
 *
 * Join classification requires a Fluxer bot gateway implementing the unavailable-marker distinction.
 * Older or custom instances that omit the marker for startup snapshots cannot be classified reliably.
 * The SDK does not detect that support or infer joins from readiness, elapsed time or cache contents.
 * A supplied marker other than false is invalid for an available snapshot and fails the gateway as a protocol error
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 *
 * export function waitForGuildJoin(client: Client) {
 *     return client.waitFor("guildCreate", { filter: (guild) => guild.isNewJoin, timeoutMs: 30_000 })
 * }
 * ```
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly/effect"
 *
 * export function waitForGuildJoinEffect(client: Client) {
 *     return client.waitFor("guildCreate", { filter: (guild) => guild.isNewJoin, timeoutMs: 30_000 })
 * }
 * ```
 */
export interface GuildCreate extends Guild {
    /** True when the outer GUILD_CREATE omits unavailable, false when it supplies literal false.
     * On a supporting bot gateway, true identifies the first create for a guild joined during this session
     * and absent from READY. It remains true if temporary unavailability preceded that first create.
     * Startup and recovery snapshots carry false, including a fresh Identify's membership baseline.
     * A retained join dispatch may replay during Resume, so this is not an exactly-once notification
     */
    readonly isNewJoin: boolean
}

/** Payload types for server availability, configuration and visibility events.
 * A create event can mean an existing server became available, rather than a new server was created
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 *
 * export function guildEventsExample(client: Client) {
 *     return client.events("guildDelete", { maxPendingMessages: 10 })
 * }
 * ```
 */
export interface GuildLifecycleEvents {
    /** Server data became available, including startup hydration, recovery and joins.
     * Use isNewJoin for the provider's join distinction, subject to GuildCreate's gateway-support and replay limits.
     * Updates the enabled server cache before delivery, but does not fetch or retain nested members, roles or channels
     */
    readonly guildCreate: GuildCreate
    /** Current server configuration, not previous-and-current values or a patch to merge */
    readonly guildUpdate: Guild
    /** Server visibility ended or became temporarily unavailable, without establishing deletion or the bot's membership outcome.
     * Before delivery, enabled server-resource and channel caches invalidate this server's observations.
     * Cached messages in this server or with unknown server scope also invalidate, since the SDK has no channel-to-server lookup index
     */
    readonly guildDelete: GuildDeletion
}

/**
 * Account presence reported by Fluxer at one point in time, not a cached or continuously updated status.
 * Changes can be missed during connection gaps. The SDK does not fetch missing presence or account details.
 * Server-scoped updates include guildId, while valid account-scoped observations can omit it.
 * Listening for this event does not request server-member presence subscriptions or guarantee delivery.
 * The hosted provider delivers bot presence through server subscriptions, not friends or group DMs.
 * Common statuses are online, idle, dnd and offline. Other strings are retained if Fluxer adds statuses
 *
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export function presenceEventsExample(client: Client) {
 *     return client.events("presenceUpdate", { maxPendingMessages: 10 })
 * }
 * ```
 */
export interface PresenceUpdate {
    /** Server where the account's presence was observed, when supplied */
    readonly guildId?: string
    /** Account ID whose presence changed, without an account lookup */
    readonly userId: string
    /** Status Fluxer reported at event time, which can already be stale when read */
    readonly status: string
    /** Whether Fluxer reported a mobile client */
    readonly mobile: boolean
    /** Whether Fluxer reported the account as away from keyboard */
    readonly afk: boolean
}

/**
 * Visible online presences grouped into one event after a server becomes available again.
 * Fluxer supplies server context for every entry, omits the recipient's own presence and splits batches at 500 entries.
 * A batch can include visible members outside this client's selected member IDs.
 * The frozen batch does not refill a cache, acknowledge subscriptions or emit individual presenceUpdate events
 */
export interface PresenceUpdateBulk {
    /** Server ID shared by every presence in the batch */
    readonly guildId: string
    /** Frozen presence observations, each carrying this batch's guildId */
    readonly presences: readonly PresenceUpdate[]
}

/**
 * One account's voice connection as observed in a server, without audio or video access.
 * `channelId: null` reports a disconnect. Moving channels can produce a disconnect followed by a join with a new connectionId.
 * Fluxer filters delivery by channel visibility, and connection gaps can miss changes.
 * This frozen observation is not retained as a voice-state cache and does not trigger lookups
 */
export interface VoiceState {
    /** Server owning this voice connection */
    readonly guildId: string
    /** Observed voice channel ID, or null for a disconnect */
    readonly channelId: string | null
    /** Connected account's user ID */
    readonly userId: string
    /** Fluxer's connection ID, usable to target one connection in a move or disconnect request */
    readonly connectionId: string
    /** Gateway session ID, when supplied by Fluxer */
    readonly sessionId?: string
    /** Whether the server has muted this connection */
    readonly isMuted: boolean
    /** Whether the server has deafened this connection */
    readonly isDeafened: boolean
    /** Whether the participant has muted themselves */
    readonly isSelfMuted: boolean
    /** Whether the participant has deafened themselves */
    readonly isSelfDeafened: boolean
    /** Whether Fluxer identifies this connection as mobile */
    readonly isMobile: boolean
    /** Whether Fluxer reports this connection as prevented from speaking */
    readonly isSuppressed: boolean
}

/**
 * Visible voice connections supplied when a server becomes available.
 * Register before connecting if you need startup snapshots.
 * An empty voiceStates array means Fluxer explicitly supplied no initial connections. No event is emitted when the collection is absent.
 * The frozen collection is not a complete member roster or a voice-state cache, and can become stale immediately
 */
export interface VoiceStateSnapshot {
    /** Server whose availability data supplied these connections */
    readonly guildId: string
    /** Frozen voice connections in received order, including an explicitly supplied empty array */
    readonly voiceStates: readonly VoiceState[]
}

/** Event names and payload types accepted by on, events and waitFor.
 * Register listeners before triggering an action when you need to observe its event.
 * Payloads are frozen observations received from Fluxer, not live objects or previously cached history.
 * Requests do not generate synthetic events. Changes can be missed during disconnection and recovery.
 * Bulk events remain one event instead of also delivering their individual entries.
 * Message events use this client's messageFields selection. Known malformed received data still fails the connection even if excluded.
 * Server and account cache handling, where documented below, occurs before event delivery
 */
export interface EventMap<M extends MessageCore = Message> extends GuildLifecycleEvents {
    /** Current public account data, without private account settings.
     * Updates the enabled account cache and clears the enabled private-conversation cache
     */
    readonly userUpdate: import("./users.js").User
    /** A private conversation became visible to this bot, which does not prove it was just created.
     * Updates its enabled private-conversation cache observation
     */
    readonly directMessageCreate: import("./users.js").DirectMessageChannel
    /** Current private conversation data, without previous values to compare. Updates its enabled private-conversation cache observation */
    readonly directMessageUpdate: import("./users.js").DirectMessageChannel
    /** Visible online presences delivered together after server recovery, without individual presenceUpdate events */
    readonly presenceUpdateBulk: PresenceUpdateBulk
    /** Visible initial voice connections when a server becomes available, including an explicitly supplied empty collection */
    readonly voiceStateSnapshot: VoiceStateSnapshot
    /** A visible voice connection joined, changed or disconnected. A move can produce multiple phases, and no voice-state cache is updated */
    readonly voiceStateUpdate: VoiceState
    /** A private conversation closed, was left, or was deleted for this bot. Other accounts may still have access.
     * Clears the enabled private-conversation cache and evicts this channel's cached messages
     */
    readonly directMessageDelete: {
        /** Private conversation channel ID as a decimal string */
        readonly id: string
    }
    /** A private conversation gained a recipient. Clears the enabled private-conversation cache without reconstructing a recipient list */
    readonly directMessageRecipientAdd: import("./users.js").DirectMessageRecipientChange
    /** A private conversation lost a recipient. Clears the enabled private-conversation cache without establishing conversation deletion */
    readonly directMessageRecipientRemove: import("./users.js").DirectMessageRecipientChange
    /** A visible server channel's webhook collection changed, without webhook details, tokens, cache writes or automatic requests */
    readonly webhooksUpdate: WebhooksUpdate
    /** Invite metadata supplied when an invite was created. Its code and URL grant access, so keep them out of diagnostics and public logs */
    readonly inviteCreate: InviteMetadata
    /** A deleted invite's code and any destination IDs Fluxer still supplied, without reconstructing its old settings */
    readonly inviteDelete: InviteDeleteEvent
    /** A newly recorded server audit entry, requiring VIEW_AUDIT_LOG. Its reason, options and changes are not safe diagnostic text */
    readonly guildAuditLogEntryCreate: GuildAuditLogEntryCreate
    /** Updated server emoji collection, not an initial list or cache refill.
     * Invalidates the enabled expression cache before delivery. Fetch explicitly when current state matters after a connection gap
     */
    readonly guildEmojisUpdate: GuildEmojisUpdate
    /** Updated server sticker collection, not an initial list or cache refill.
     * Invalidates the enabled expression cache before delivery. Fetch explicitly when current state matters after a connection gap
     */
    readonly guildStickersUpdate: GuildStickersUpdate
    /** A ban was recorded for these server and account IDs, without full ban details or proof that member removal finished.
     * Evicts the enabled member cache entry
     */
    readonly guildBanAdd: MemberReference
    /** An explicit ban removal, not proof of rejoining. A ban expiring automatically may not emit this event.
     * Evicts the enabled member cache entry
     */
    readonly guildBanRemove: MemberReference
    /** A server channel became visible, possibly after creation, without establishing its creation time or enumerating initial channels.
     * Updates its enabled channel-cache observation
     */
    readonly guildChannelCreate: import("./channels.js").GuildChannel
    /** Current server channel data, without previous values. Fetch explicitly if a decision requires fresh permissions.
     * Updates its enabled channel-cache observation, except a category update invalidates all channels cached for the server
     */
    readonly guildChannelUpdate: import("./channels.js").GuildChannel
    /** A server channel was deleted or became invisible. Evicts its cached messages, without generating message deletion events.
     * Evicts its enabled channel-cache entry. A category deletion invalidates all channels cached for that server
     */
    readonly guildChannelDelete: import("./channels.js").GuildChannel
    /** Visible server-channel updates grouped into one batch, without individual guildChannelUpdate events.
     * This is not the complete channel list or proof that permission copying has finished.
     * Invalidates the enabled channel cache for this server
     */
    readonly guildChannelUpdateBulk: import("./channels.js").GuildChannelUpdateBulk
    /** A server role creation observation, not an initial enumeration of roles. Updates the enabled role-cache observation */
    readonly guildRoleCreate: import("./guilds.js").GuildRole
    /** Current role data, without previous values. Updates the enabled role-cache observation */
    readonly guildRoleUpdate: import("./guilds.js").GuildRole
    /** Role updates grouped into one batch, without individual guildRoleUpdate events or a complete role list.
     * Updates the enabled role-cache observations for supplied roles
     */
    readonly guildRoleUpdateBulk: import("./guilds.js").GuildRoleUpdateBulk
    /** Deleted role's IDs, without its former settings or a guarantee that affected members each produce an update.
     * Invalidates enabled role and member caches for the server
     */
    readonly guildRoleDelete: import("./guilds.js").RoleReference
    /** A member join observation, not an initial roster or complete server membership view. Updates the enabled member-cache observation */
    readonly guildMemberAdd: import("./guilds.js").GuildMember
    /** Current member data. Fluxer can limit delivery by server size and session visibility, so fetch when current state matters.
     * Updates the enabled member-cache observation
     */
    readonly guildMemberUpdate: import("./guilds.js").GuildMember
    /** Membership ended, with only server and account IDs supplied. No account lookup or removal-cause inference follows.
     * Evicts the enabled member-cache entry
     */
    readonly guildMemberRemove: import("./guilds.js").MemberReference
    /** A delivered presence observation, without custom-status text, account data, retained state or automatic member subscriptions */
    readonly presenceUpdate: PresenceUpdate
    /** A channel's pins changed, with guild context only when supplied and without fetching the list.
     * Does not identify the message. The timestamp may stay unchanged after unpin
     */
    readonly channelPinsUpdate: ChannelPinsUpdate
    /** A short-lived typing notice, subject to Fluxer's delivery filtering. It is not an account presence snapshot or cache entry */
    readonly typingStart: TypingStart
    /** Newly created message using this client's selected fields, with frozen nested metadata rather than downloaded file contents.
     * Updates the enabled message-cache observation
     */
    readonly messageCreate: M
    /** Message data supplied for an update, not previous-and-current values or a patch to merge.
     * Optional metadata may be absent. A non-text change can deliver the same selected values again.
     * Replaces the enabled message-cache observation rather than merging absent metadata from an older snapshot
     */
    readonly messageUpdate: M
    /** One deleted message's channel and message IDs, plus supplied guild ID, text and author ID when available.
     * Evicts its enabled message-cache entry without reconstructing missing context
     */
    readonly messageDelete: MessageDeletion
    /** Deleted message IDs grouped by channel, with guild context only when supplied.
     * Listen to this and messageDelete to observe both deletion forms.
     * Evicts the listed enabled message-cache entries
     */
    readonly messageDeleteBulk: MessageBulkDeletion
    /** One user's reaction addition, not synthesized from reaction batches or successful addReaction requests */
    readonly messageReactionAdd: MessageReaction
    /** Reaction additions grouped by Fluxer. Listen to this and messageReactionAdd to observe both addition forms */
    readonly messageReactionAddMany: MessageReactionBatch
    /** One user's reaction was removed, possibly by a moderator rather than that user */
    readonly messageReactionRemove: MessageReaction
    /** All reactions on the target message were cleared, without a list of affected users */
    readonly messageReactionRemoveAll: ReactionTarget
    /** All reactions using one emoji were cleared from the target message, without a list of affected users */
    readonly messageReactionRemoveEmoji: MessageReactionEmojiRemoval
}

/** Event-name strings accepted by on, events and waitFor in both entry points */
export type EventName = keyof EventMap

/** Bound the waiting queue for one event subscription or collector.
 * Each registration owns its own queue. Filling it stops that registration, not unrelated subscriptions.
 * These budgets measure pending payloads and received JSON bytes, not the total memory used by your application
 */
export interface EventBufferOptions {
    /** Maximum waiting payloads, excluding active handlers. A bulk event counts once, positive safe integer, default 256 */
    readonly maxPendingMessages?: number
    /** Maximum UTF-8 bytes of waiting received JSON, including full bulk payloads. Positive safe integer, default 4,194,304 */
    readonly maxPendingBytes?: number
}

/** Settings for waitFor to receive one future event that passes an optional filter.
 * Waiting does not connect the gateway, read cached history or reconstruct missed events.
 * The queue budgets apply to events received before the wait can take them.
 * Completion, timeout, cancellation and shutdown release the wait's subscription
 */
export interface EventWaitOptions<K extends EventName, M extends MessageCore = Message> extends EventBufferOptions {
    /** Return true to complete with this event, false to keep waiting. Omit to accept the first event.
     * Runs synchronously and can run while the gateway receives events. Keep it short, since deadlines cannot preempt blocking JavaScript.
     * A throw or non-boolean return fails with EventWaitError reason filter, without exposing your original error.
     * Do not return a Promise. Mistaken asynchronous work is neither awaited nor cancelled, and its rejection is discarded
     */
    readonly filter?: (event: EventMap<M>[K]) => boolean
    /** Total milliseconds to wait from registration, an integer from 1 through 2,147,483,647, default 30,000.
     * Expiry fails with EventWaitError reason timeout, rather than returning an empty event
     */
    readonly timeoutMs?: number
}

/** Queue limits and parallelism for one on callback registration.
 * Callbacks are not retried. Callback failures are reported safely and do not stop later event delivery.
 * Overflow stops the subscription, and closure waits for active callback cleanup
 */
export interface HandlerOptions extends EventBufferOptions {
    /** Maximum active callbacks, a positive safe integer, default 1.
     * Starts follow receive order. Values above 1 allow callbacks to finish out of order
     */
    readonly concurrency?: number
}

/** Safe notification that an event callback failed or its waiting queue overflowed.
 * No message bodies, credentials or original callback errors are exposed.
 * When no error hook is configured or it fails, fallback diagnostics identify the event and failure kind.
 * To inspect your original failure, catch it inside a default API callback or use Effect.tapCause inside a native handler.
 * The SDK error hook does not provide access to the raw exception
 */
export interface HandlerErrorReport {
    /** Event name belonging to the affected registration */
    readonly event: EventName
    /** handler means a callback failed and delivery continues, overflow means this subscription stopped permanently */
    readonly kind: "handler" | "overflow"
}
