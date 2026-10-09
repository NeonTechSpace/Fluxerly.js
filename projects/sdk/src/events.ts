import type { Message, MessageCore, MessageDeletion, MessageBulkDeletion } from "./messages.js"
import type { ChannelPinsUpdate } from "./pins.js"
import type { Guild, GuildDeletion, GuildMember, MemberReference } from "./guilds.js"
import type { GuildEmoji, GuildSticker } from "./expressions.js"
import type { MessageReaction, MessageReactionBatch, MessageReactionEmojiRemoval, ReactionTarget } from "./reactions.js"
import type { InviteMetadata } from "./invites.js"
import type { AuditLogEntry } from "./audit-logs.js"
import type { GuildThreadChannel, ThreadMember } from "./channels.js"

/** Notice that the webhooks in a channel changed.
 * No webhook details or token are included. Fetch the current set explicitly if needed.
 * This notification does not write or invalidate an SDK cache
 *
 * @category Events and collectors
 */
export interface WebhooksUpdate {
    /** Community that owns the channel, as a decimal ID */
    readonly guildId: string
    /** Channel whose webhook collection changed */
    readonly channelId: string
}

/** Notice that an invite was deleted, without its former settings.
 * Treat the code as access-granting data and keep it out of diagnostics and public logs
 *
 * @category Events and collectors
 */
export interface InviteDeleteEvent {
    /** Deleted invite's code, the stable identity supplied for this event */
    readonly code: string
    /** Invite destination channel ID, when supplied */
    readonly channelId?: string
    /** Invite destination community ID, when supplied */
    readonly guildId?: string
}

/** Audit entry newly written in a community, using the same field names as audit-log requests.
 * The entry and its nested data are frozen. Access requires Fluxer's VIEW_AUDIT_LOG permission.
 * The reason, options and changes fields can contain application or provider data, so do not treat them as safe diagnostics.
 * Numeric and boolean option values are converted to the same types used by audit-log reads
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export function administrativeEventsExample(client: Client) {
 *     return client.subscribe("guildAuditLogEntryCreate", { maxPendingMessages: 10 })
 * }
 * ```
 *
 * @category Events and collectors
 */
export interface GuildAuditLogEntryCreate extends AuditLogEntry {
    /** Community that recorded the entry */
    readonly guildId: string
    /** Acting account ID supplied for this entry */
    readonly userId: string
    /** Affected resource ID or invite code, or null when Fluxer recorded no target */
    readonly targetId: string | null
}

/** Notice that an account began typing, not a lasting indication that it is still typing.
 * The SDK does not cache this notice or fetch the user or channel
 *
 * @category Events and collectors
 */
export interface TypingStart {
    /** Channel ID where typing began */
    readonly channelId: string
    /** Account ID that began typing */
    readonly userId: string
    /** Fluxer's Unix timestamp in whole seconds, not milliseconds */
    readonly timestamp: number
    /** Owning community ID, when supplied. Absence alone does not prove that the channel is private */
    readonly guildId?: string
}

/** Custom emoji collection supplied in one community update, frozen in received order.
 * No creator accounts or image contents are included. This is not an initial enumeration or an automatic cache refill
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export function expressionEventsExample(client: Client) {
 *     return client.subscribe("guildEmojisUpdate", { maxPendingMessages: 10 })
 * }
 * ```
 *
 * @category Events and collectors
 */
export interface GuildEmojisUpdate {
    /** Community that owns this emoji collection, as a decimal ID */
    readonly guildId: string
    /** Emoji snapshots in Fluxer's received order */
    readonly items: readonly GuildEmoji[]
}

/** Custom sticker collection supplied in one community update, frozen in received order.
 * No creator accounts or image contents are included. This is not an initial enumeration or an automatic cache refill
 *
 * @category Events and collectors
 */
export interface GuildStickersUpdate {
    /** Community that owns this sticker collection, as a decimal ID */
    readonly guildId: string
    /** Sticker snapshots in Fluxer's received order */
    readonly items: readonly GuildSticker[]
}

/** Frozen community-server health notice, without a cache write or automatic reconnect.
 * A degraded community server is lagging, not disconnected or unavailable
 *
 * @category Events and collectors
 */
export interface GuildHealthUpdate {
    /** Community whose server health changed, as a decimal ID */
    readonly guildId: string
    /** True while the community's server is lagging, false when it recovers. This does not report disconnection or unavailability */
    readonly degraded: boolean
}

/** Frozen community data received with an availability event, plus information about whether this is a new join.
 * The event keeps the Guild fields. REST results and cached Guild values do not gain join state.
 * Subscribe before connecting to receive startup availability events. The `connect` call does not wait for them
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
 *
 * @category Events and collectors
 */
export interface GuildCreate extends Guild {
    /** True when the outer GUILD_CREATE omits unavailable, false when it supplies literal false.
     * On a supporting bot gateway, true identifies the first create for a community joined during this session
     * and absent from READY. It remains true if temporary unavailability preceded that first create.
     * Startup and recovery snapshots carry false, including a fresh Identify's membership baseline.
     * A retained join dispatch may replay during Resume, so this is not an exactly-once notification
     */
    readonly isNewJoin: boolean
}

/** Payload types for community availability, configuration and visibility events.
 * A create event can mean an existing community became available, rather than a new community was created
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 *
 * export function guildEventsExample(client: Client) {
 *     return client.subscribe("guildDelete", { maxPendingMessages: 10 })
 * }
 * ```
 *
 * @category Events and collectors
 */
export interface GuildLifecycleEvents {
    /** Community data became available, including startup hydration, recovery and joins.
     * Use isNewJoin for the provider's join distinction, subject to GuildCreate's gateway-support and replay limits.
     * Before delivery, fills the enabled community, role, emoji, sticker and channel caches from the snapshot, replacing this
     * community's earlier roles, emojis, stickers, channels and threads. The channel cache takes the active threads the
     * bot can view, and a malformed thread is left out with a gateway.threadSkipped Warn record.
     * Members are not retained, because the snapshot lists only a few
     */
    readonly guildCreate: GuildCreate
    /** Current community configuration, not previous-and-current values or a patch to merge */
    readonly guildUpdate: Guild
    /** Community visibility ended or became temporarily unavailable, without establishing deletion or the bot's membership outcome.
     * Before delivery, enabled community-resource and channel caches invalidate this community's observations.
     * Cached messages in this community or with unknown community scope also invalidate, since the SDK has no channel-to-community lookup index
     */
    readonly guildDelete: GuildDeletion
}

/**
 * Account presence reported by Fluxer at one point in time, not a cached or continuously updated status.
 * Changes can be missed during connection gaps. The SDK does not fetch missing presence or account details.
 * Community-scoped updates include guildId, while valid account-scoped observations can omit it.
 * Listening for this event does not request community-member presence subscriptions or guarantee delivery.
 * The hosted provider delivers bot presence through community subscriptions, not friends or group DMs.
 * Common statuses are online, idle, dnd and offline. Other strings are retained if Fluxer adds statuses
 *
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export function presenceEventsExample(client: Client) {
 *     return client.subscribe("presenceUpdate", { maxPendingMessages: 10 })
 * }
 * ```
 *
 * @category Events and collectors
 */
export interface PresenceUpdate {
    /** Community where the account's presence was observed, when supplied */
    readonly guildId?: string
    /** Account ID whose presence changed, without an account lookup */
    readonly userId: string
    /**
     * Status Fluxer reported at event time, which can already be stale when read.
     * A status this SDK version does not recognize is reported as `unknown`, so a switch over the values stays exhaustive
     */
    readonly status: ObservedPresenceStatus
    /** Whether Fluxer reported a mobile client */
    readonly mobile: boolean
    /** Whether Fluxer reported the account as away from keyboard */
    readonly afk: boolean
}

/**
 * An account status observed in a presence event. Fluxer reports invisible accounts to others as offline, and a status
 * this SDK version does not recognize is `unknown`
 *
 * @category Events and collectors
 */
export type ObservedPresenceStatus = "online" | "idle" | "dnd" | "offline" | "invisible" | "unknown"

/**
 * Visible online presences grouped into one event after a community becomes available again.
 * Fluxer supplies community context for every entry, omits the recipient's own presence and splits batches at 500 entries.
 * A batch can include visible members outside this client's selected member IDs.
 * The frozen batch does not refill a cache, acknowledge subscriptions or emit individual presenceUpdate events
 *
 * @category Events and collectors
 */
export interface PresenceUpdateBulk {
    /** Community ID shared by every presence in the batch */
    readonly guildId: string
    /** Frozen presence observations, each carrying this batch's guildId */
    readonly presences: readonly PresenceUpdate[]
}

/**
 * One account's voice connection as observed in a community, without audio or video access.
 * A null `channelId` reports a disconnect. Moving channels can produce a disconnect followed by a join with a new connectionId.
 * Fluxer filters delivery by channel visibility, and connection gaps can miss changes.
 * This frozen observation is not retained as a voice-state cache and does not trigger lookups
 *
 * @category Events and collectors
 */
export interface VoiceState {
    /** Community that owns this voice connection */
    readonly guildId: string
    /** Observed voice channel ID, or null for a disconnect */
    readonly channelId: string | null
    /** Connected account's user ID */
    readonly userId: string
    /** Fluxer's connection ID, usable to target one connection in a move or disconnect request */
    readonly connectionId: string
    /** Gateway session ID, when supplied by Fluxer */
    readonly sessionId?: string
    /** Whether the community has muted this connection */
    readonly isMuted: boolean
    /** Whether the community has deafened this connection */
    readonly isDeafened: boolean
    /** Whether the participant has muted themselves */
    readonly isSelfMuted: boolean
    /** Whether the participant has deafened themselves */
    readonly isSelfDeafened: boolean
    /** Whether Fluxer identifies this connection as mobile */
    readonly isMobile: boolean
    /** Whether Fluxer reports this connection as prevented from speaking */
    readonly isSuppressed: boolean
    /** Whether the participant is publishing camera video. An omitted flag reads as false */
    readonly isSelfVideoOn: boolean
    /**
     * Whether the connection advertises a screen-share track. The participant's client reports it, and in a community
     * Fluxer sets it to false while the participant lacks the Stream permission. An omitted flag reads as false
     */
    readonly isSelfStreaming: boolean
    /**
     * Keys of the screen shares this connection is watching, empty when it watches none or Fluxer omits them.
     * A key reads `{guildId}:{channelId}:{connectionId}` for a community voice channel and `dm:{channelId}:{connectionId}`
     * for a private call, where the last part is the publisher's connectionId
     */
    readonly viewerStreamKeys: readonly string[]
    /**
     * The participant's community member data as Fluxer attached it to this voice state, omitted when Fluxer sends none.
     * Fluxer refreshes it when the voice state changes, so it can lag behind later nickname or role edits.
     * It is a frozen observation and neither reads nor writes any member cache
     */
    readonly member?: GuildMember
}

/**
 * Visible voice connections supplied when a community becomes available.
 * Register before connecting to receive startup snapshots.
 * An empty voiceStates array means Fluxer explicitly supplied no initial connections. No event is emitted when the collection is absent.
 * The frozen collection is not a complete member roster or a voice-state cache, and can become stale immediately
 *
 * @category Events and collectors
 */
export interface VoiceStateSnapshot {
    /** Community whose availability data supplied these connections */
    readonly guildId: string
    /** Frozen voice connections in received order, including an explicitly supplied empty array */
    readonly voiceStates: readonly VoiceState[]
}

/**
 * A participant's entrance sound started playing in a voice channel or private call they were already connected to.
 * Fluxer sends one event to every other connected participant, never to the participant whose sound plays.
 * The SDK does not download the sound, fetch the channel or account, or cache this notice
 *
 * @category Events and collectors
 */
export interface EntranceSoundPlay {
    /** Account ID of the participant whose sound plays */
    readonly userId: string
    /** Voice channel or private call channel ID */
    readonly channelId: string
    /** Community that owns the voice channel, or null for a private call */
    readonly guildId: string | null
    /** Entrance sound ID */
    readonly soundId: string
    /** Fluxer's content hash of the sound file, usable to reuse an already downloaded copy */
    readonly hash: string
    /** Address to download the sound from, as received and without an SDK download or validation of its host */
    readonly url: string
    /** Sound length in whole milliseconds, a nonnegative safe integer */
    readonly durationMs: number
    /** Media type Fluxer reported for the sound file, such as audio/ogg */
    readonly contentType: string
}

/**
 * One participant's connection in a private call, as observed when the call was created or updated.
 * The fields match VoiceState without a community and member, since calls take place in private channels and Fluxer
 * attaches no community member there.
 * Fluxer's region_id and server_id entry fields are internal routing data and are not projected
 *
 * @category Events and collectors
 */
export interface CallVoiceState extends Omit<VoiceState, "guildId" | "member"> {}

/**
 * Current state of an active private-channel call: Its ringing set, participants and voice region.
 * This is a frozen observation, not a patch to merge and not a cached call record. Changes can be missed during connection gaps
 *
 * @category Events and collectors
 */
export interface CallUpdate {
    /** Private channel ID the call takes place in */
    readonly channelId: string
    /** ID of the call message that opened the call */
    readonly messageId: string
    /** Voice region serving the call, or null until Fluxer chooses one */
    readonly region: string | null
    /** Account IDs currently being rung, in received order */
    readonly ringingUserIds: readonly string[]
    /** Connected participants, frozen in Fluxer's order by participant ID */
    readonly voiceStates: readonly CallVoiceState[]
}

/**
 * A private-channel call began or became visible, including initial call state delivered shortly after READY
 * and state recovered after a lost call connection.
 * Recovered state can repeat a call that was already observed, so this is not proof that a new call started
 *
 * @category Events and collectors
 */
export interface CallCreate extends CallUpdate {
    /** Every recipient of the channel, whether or not they joined the call. Present only on initial or recovered call state */
    readonly recipientIds?: readonly string[]
    /** Unix time in milliseconds when the call was opened. Present only on initial or recovered call state */
    readonly createdAtMs?: number
}

/**
 * A private-channel call ended or became temporarily unavailable
 *
 * @category Events and collectors
 */
export interface CallDelete {
    /** Private channel ID the call took place in */
    readonly channelId: string
    /** True when the call became unavailable rather than ending.
     * An unavailable call can return with a later callCreate that includes its recipients and creation time, although Fluxer does not guarantee recovery
     */
    readonly unavailable: boolean
}

/**
 * A thread that was created or that the bot was added to, with whether it was just created.
 * Fluxer also sends this event to the bot when it joins or is added to an existing thread, then with isNewlyCreated
 * false. The bot's own membership is in membership when the bot is a member
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 *
 * export function greetNewThreads(client: Client) {
 *     return client.on("threadCreate", (thread) =>
 *         thread.isNewlyCreated ? client.messages.send(thread.id, `Welcome to ${thread.name}`) : undefined,
 *     )
 * }
 * ```
 *
 * @category Events and collectors
 */
export type ThreadCreateEvent = GuildThreadChannel & {
    /** True when the thread was just created, false when the bot joined or was added to an existing thread */
    readonly isNewlyCreated: boolean
}

/**
 * Identity of a deleted thread, without its former settings or messages.
 * Deleting a parent channel deletes its threads without this event
 *
 * @category Events and collectors
 */
export interface ThreadDeletion {
    /** Decimal ID of the deleted thread */
    readonly id: string
    /** Community that held the thread */
    readonly guildId: string
    /** Channel that held the thread */
    readonly parentId: string
    /** Type of the deleted thread */
    readonly type: GuildThreadChannel["type"]
}

/**
 * The bot's complete set of active threads in a community, or in some of its channels, as Fluxer replaced it.
 * Fluxer sends it when the bot gains access to channels with active threads, and when a community reloads its thread
 * state. It is never replayed on Resume
 *
 * @category Events and collectors
 */
export interface ThreadListSync {
    /** Community whose threads were replaced */
    readonly guildId: string
    /** Channels whose threads were replaced. Absent when the list replaces every thread in the community */
    readonly parentIds?: readonly string[]
    /** Every active thread the bot can view in the replaced scope, each with the bot's membership when it is a member */
    readonly threads: readonly GuildThreadChannel[]
}

/**
 * Accounts that joined or left one thread, including the bot itself
 *
 * @category Events and collectors
 */
export interface ThreadMembersUpdate {
    /** Decimal ID of the thread */
    readonly threadId: string
    /** Community that holds the thread */
    readonly guildId: string
    /** Approximate number of thread members after the change, capped at 50 */
    readonly memberCount: number
    /** Members who joined, each with their community membership when Fluxer has one for the account. Empty when none joined */
    readonly added: readonly ThreadMember[]
    /** Decimal IDs of the accounts that left. Empty when none left */
    readonly removedUserIds: readonly string[]
}

/**
 * Delivery details for one event, passed to on handlers and event middleware.
 * The object is frozen and describes how this client received the event, not Fluxer state
 *
 * @category Events and collectors
 */
export interface EventContext {
    /** Local shard whose gateway connection received the event. A client without a sharding plan uses shard 0 */
    readonly shardId: number
    /** UTF-8 byte length of the whole received gateway frame that carried the event, the same size counted against maxPendingBytes.
     * Events decoded from one frame, such as guildCreate and its voiceStateSnapshot, report the same value
     */
    readonly receivedBytes: number
}

/**
 * One on handler invocation of a specific event type, as seen by event middleware
 *
 * @category Events and collectors
 */
export interface EventInvocationOf<K extends EventName, M extends MessageCore = Message> {
    /** Event name the subscription was registered for */
    readonly event: K
    /** Frozen event payload the handler receives */
    readonly payload: EventMap<M>[K]
    /** Shard and received size of the frame that carried the event */
    readonly context: EventContext
    /** Identifier of the subscription whose handler this invocation runs, such as messageCreate#3 */
    readonly subscriptionId: string
}

/**
 * One on handler invocation passed to event middleware.
 * Compare the event field with an event name to narrow the payload type
 *
 * @category Events and collectors
 */
export type EventInvocation<M extends MessageCore = Message> = {
    readonly [K in EventName]: EventInvocationOf<K, M>
}[EventName]

/** Event names and payload types accepted by on, events and waitFor.
 * Register listeners before triggering an action to observe its event.
 * Payloads are frozen copies of data received from Fluxer. They cannot be changed and do not update as Fluxer changes.
 * A new listener does not receive earlier events from the cache.
 * Requests do not generate synthetic events. Changes can be missed during disconnection and recovery.
 * Bulk events remain one event instead of also delivering their individual entries.
 * Message events use this client's messageFields selection. Known malformed received data still fails the connection even if excluded.
 * Community and account cache handling, where documented below, occurs before event delivery
 *
 * @category Events and collectors
 */
export interface EventMap<M extends MessageCore = Message> extends GuildLifecycleEvents {
    /** Community-server lag or recovery, without a disconnection, availability change, cache invalidation or automatic reconnect */
    readonly guildHealthUpdate: GuildHealthUpdate
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
    /** Visible online presences delivered together after community recovery, without individual presenceUpdate events */
    readonly presenceUpdateBulk: PresenceUpdateBulk
    /** Visible initial voice connections when a community becomes available, including an explicitly supplied empty collection */
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
    /** A visible community channel's webhook collection changed, without webhook details, tokens, cache writes or automatic requests */
    readonly webhooksUpdate: WebhooksUpdate
    /** Invite metadata supplied when an invite was created. Its code and URL grant access, so keep them out of diagnostics and public logs */
    readonly inviteCreate: InviteMetadata
    /** A deleted invite's code and any destination IDs Fluxer still supplied, without reconstructing its old settings */
    readonly inviteDelete: InviteDeleteEvent
    /** A newly recorded community audit entry, requiring VIEW_AUDIT_LOG. Its reason, options and changes are not safe diagnostic text */
    readonly guildAuditLogEntryCreate: GuildAuditLogEntryCreate
    /** Updated community emoji collection, not an initial list or cache refill.
     * Invalidates the enabled expression cache before delivery. Fetch explicitly when current state matters after a connection gap
     */
    readonly guildEmojisUpdate: GuildEmojisUpdate
    /** Updated community sticker collection, not an initial list or cache refill.
     * Invalidates the enabled expression cache before delivery. Fetch explicitly when current state matters after a connection gap
     */
    readonly guildStickersUpdate: GuildStickersUpdate
    /** A ban was recorded for these community and account IDs, without full ban details or proof that member removal finished.
     * Evicts the enabled member cache entry
     */
    readonly guildBanAdd: MemberReference
    /** An explicit ban removal, not proof of rejoining. A ban expiring automatically may not emit this event.
     * Evicts the enabled member cache entry
     */
    readonly guildBanRemove: MemberReference
    /** A community channel became visible, possibly after creation, without establishing its creation time or enumerating initial channels.
     * Updates its enabled channel-cache observation
     */
    readonly guildChannelCreate: import("./channels.js").GuildChannel
    /** Current community channel data, without previous values. Fetch explicitly if a decision requires fresh permissions.
     * Updates its enabled channel-cache observation, except a category update invalidates all channels cached for the community
     */
    readonly guildChannelUpdate: import("./channels.js").GuildChannel
    /** A community channel was deleted or became invisible. Evicts its cached messages, without generating message deletion events.
     * Evicts its enabled channel-cache entry. A category deletion invalidates all channels cached for that community.
     * Deleting a text, announcement, forum or media channel also deletes its threads, and Fluxer sends no threadDelete
     * for them. The channel cache then evicts the threads whose parentId is this channel, and the message cache evicts
     * the messages of every channel in this community that the channel cache does not hold outside those threads,
     * including messages without community context. Without the channel cache that is every message of the community
     */
    readonly guildChannelDelete: import("./channels.js").GuildChannel
    /** Visible community-channel updates grouped into one batch, without individual guildChannelUpdate events.
     * This is not the complete channel list or proof that permission copying has finished.
     * Invalidates the enabled channel cache for this community
     */
    readonly guildChannelUpdateBulk: import("./channels.js").GuildChannelUpdateBulk
    /** A thread was created, or the bot joined or was added to an existing thread, as isNewlyCreated tells.
     * Stores the thread, without isNewlyCreated, in the enabled channel cache
     */
    readonly threadCreate: ThreadCreateEvent
    /** Current thread data after a change such as a rename, archive or lock, without previous values.
     * Fluxer leaves the bot's membership out of this event. Replaces the thread's enabled channel-cache observation
     */
    readonly threadUpdate: GuildThreadChannel
    /** A thread was deleted. Evicts it from the enabled channel cache and evicts its cached messages, without
     * generating message deletion events. Deleting a parent channel deletes its threads without this event
     */
    readonly threadDelete: ThreadDeletion
    /** The bot's active threads in a community, or in some of its channels, were replaced. Before delivery, the enabled
     * channel cache evicts its threads in that scope and stores the listed ones. Fluxer never replays this event on Resume,
     * so a resumed shard's cached threads are evicted instead
     */
    readonly threadListSync: ThreadListSync
    /** Accounts joined or left a thread. When the bot is one of them, or before the bot's account ID is known, the
     * enabled channel cache evicts the thread, because its membership changed. Otherwise the cached memberCount is not
     * updated
     */
    readonly threadMembersUpdate: ThreadMembersUpdate
    /** A community role creation observation, not an initial enumeration of roles. Updates the enabled role-cache observation */
    readonly guildRoleCreate: import("./guilds.js").GuildRole
    /** Current role data, without previous values. Updates the enabled role-cache observation */
    readonly guildRoleUpdate: import("./guilds.js").GuildRole
    /** Role updates grouped into one batch, without individual guildRoleUpdate events or a complete role list.
     * Updates the enabled role-cache observations for supplied roles
     */
    readonly guildRoleUpdateBulk: import("./guilds.js").GuildRoleUpdateBulk
    /** Deleted role's IDs, without its former settings or a guarantee that affected members each produce an update.
     * Invalidates enabled role and member caches for the community
     */
    readonly guildRoleDelete: import("./guilds.js").RoleReference
    /** A member join observation, not an initial roster or complete community membership view. Updates the enabled member-cache observation */
    readonly guildMemberAdd: import("./guilds.js").GuildMember
    /** Current member data. Fluxer can limit delivery by community size and session visibility, so fetch when current state matters.
     * Updates the enabled member-cache observation. Before handlers run, invalidates the member's enabled account-cache entry
     * and affected private-conversation snapshots
     */
    readonly guildMemberUpdate: import("./guilds.js").GuildMember
    /** Membership ended, with only community and account IDs supplied. No account lookup or removal-cause inference follows.
     * Evicts the enabled member-cache entry
     */
    readonly guildMemberRemove: import("./guilds.js").MemberReference
    /** A delivered presence observation, without custom-status text, account data, retained state or automatic member subscriptions */
    readonly presenceUpdate: PresenceUpdate
    /** A channel's pins changed, with community context only when supplied and without fetching the list.
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
    /** One deleted message's channel and message IDs, plus supplied community ID, text and author ID when available.
     * Evicts its enabled message-cache entry without reconstructing missing context
     */
    readonly messageDelete: MessageDeletion
    /** Deleted message IDs grouped by channel, with community context only when supplied.
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
    /** Another participant's entrance sound started playing where this account has a voice connection, without a download or cache write */
    readonly entranceSoundPlay: EntranceSoundPlay
    /** A private-channel call began or became visible, including initial and recovered call state, without a call cache */
    readonly callCreate: CallCreate
    /** An active private-channel call's ringing set, participants or region changed. This is the full current state, not a patch */
    readonly callUpdate: CallUpdate
    /** A private-channel call ended, or became unavailable when unavailable is true */
    readonly callDelete: CallDelete
    /** Every received gateway dispatch in its wire form, including types this SDK version does not decode.
     * The body is not part of the SDK's compatibility contract. See RawDispatch
     */
    readonly raw: RawDispatch
}

/** One gateway dispatch as Fluxer sent it, before the SDK decodes or validates its body.
 * Delivered for every dispatch the session accepts, including READY, RESUMED and types this SDK version does not handle.
 * The body is Fluxer's unvalidated wire data and is not part of the SDK's compatibility contract, so its shape can change without an SDK release.
 * Raw subscribers do not change cache updates or decoded event delivery
 *
 * Each delivery is logged at Trace with code events.raw.
 * A raw dispatch is offered before the SDK updates caches for it and before its decoded event.
 * The body object is shared by every raw subscriber, so treat it as read-only.
 * A raw subscriber turns off automatic event suppression, while explicitly ignored types never arrive
 *
 * @category Events and collectors
 */
export interface RawDispatch {
    /** Local shard that received the dispatch */
    readonly shardId: number
    /** Upper-case dispatch type, such as MESSAGE_CREATE */
    readonly t: string
    /** Session sequence number of the dispatch */
    readonly s: number
    /** Unvalidated dispatch body */
    readonly d: unknown
}

/**
 * Event-name strings accepted by on, events and waitFor in both entry points
 *
 * @category Events and collectors
 */
export type EventName = keyof EventMap

/** Limit the waiting queue for one event subscription or collector.
 * Each registration owns its own queue. Filling it stops that registration, or drops events for a handler whose overflow policy drops them, and never affects unrelated subscriptions.
 * These limits measure pending payloads and received JSON bytes, not total application memory use
 *
 * @category Events and collectors
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
 *
 * @category Events and collectors
 */
export interface EventWaitOptions<K extends EventName, M extends MessageCore = Message> extends EventBufferOptions {
    /** Return true to complete with this event, false to keep waiting. Omit to accept the first event.
     * Runs synchronously and can run while the gateway receives events. Keep it short, since deadlines cannot preempt blocking JavaScript.
     * A throw or non-boolean return fails with EventWaitError reason filter. A thrown value is the error's cause.
     * Do not return a Promise. Mistaken asynchronous work is neither awaited nor cancelled, and its rejection is discarded
     */
    readonly filter?: (event: EventMap<M>[K]) => boolean
    /** Total milliseconds to wait from registration, an integer from 1 through 2,147,483,647, default 30,000.
     * Expiry fails with EventWaitError reason timeout, rather than returning an empty event
     */
    readonly timeoutMs?: number
}

/** Queue limits, parallelism, ordering and overflow behavior for one on callback registration.
 * Callbacks are not retried. A callback or middleware failure, including a synchronous throw, is reported and releases
 * the invocation's slot and partition key without stopping later event delivery.
 * Closure waits for active callback cleanup. The type parameter T is the event payload that a partition function receives
 *
 * @category Events and collectors
 */
export interface HandlerOptions<T = unknown> extends EventBufferOptions {
    /** Maximum active callbacks, a positive safe integer.
     * The default is 1, or 8 when partition is set.
     * Starts follow receive order. Values above 1 allow callbacks to finish out of order, except within one partition
     */
    readonly concurrency?: number
    /**
     * Keep related events in order while unrelated events run side by side, up to concurrency.
     * Events with the same key run one at a time in receive order, each starting after the previous one with that key finished.
     * An event whose key is busy waits in the queue while later events with other keys start.
     * The value guild keys each event by its community, which the API calls a guild, and a direct message by its channel.
     * The value channel keys each event by its channel, or by its community when it has no channel.
     * A function receives the event and returns its key as a string.
     * Events without a key, including those for which the function returns undefined, share one key.
     * A function that throws or returns another value is reported as a failure of that event's handler, which then does not run
     *
     * @example
     * ```ts
     * import type { Client, Message } from "@neontechspace/fluxerly"
     * export function orderedPerChannel(client: Client, handle: (message: Message) => Promise<void>) {
     *     // Up to 8 channels at a time, and the messages of one channel in order
     *     return client.on("messageCreate", (message) => handle(message), { partition: "channel" })
     * }
     * ```
     */
    readonly partition?: "guild" | "channel" | ((event: T) => string | undefined)
    /** What happens when an event arrives while the waiting queue is full.
     * The default, dropOldest, discards the oldest waiting events to make room, and dropNewest discards the arriving event.
     * Both drop policies keep the subscription running, log a Warn record and count the drop in diagnostics().counters.eventsDropped.
     * The policy stop ends the subscription and reports an overflow failure, so waitForClose returns EventOverflowError
     */
    readonly overflow?: "stop" | "dropOldest" | "dropNewest"
}
