import type { Message, MessageDeletion, MessageBulkDeletion } from "./messages.js"
import type { ChannelPinsUpdate } from "./pins.js"
import type { Guild, GuildDeletion, MemberReference } from "./guilds.js"
import type { GuildEmoji, GuildSticker } from "./expressions.js"
import type { MessageReaction, MessageReactionBatch, MessageReactionEmojiRemoval, ReactionTarget } from "./reactions.js"
import type { InviteMetadata } from "./invites.js"
import type { AuditLogEntry } from "./audit-logs.js"

/** One webhook-set change notice with no webhook metadata or credential.
 * Fetch the current set when needed; this does not populate or invalidate an SDK cache
 */
export interface WebhooksUpdate {
    /** Owning guild ID */
    readonly guildId: string
    /** Channel whose webhook set changed */
    readonly channelId: string
}

/** One deleted invite notice, without a snapshot of its former settings.
 * The code grants access to its destination and must not be added to diagnostics or public logs
 */
export interface InviteDeleteEvent {
    /** Provider invite code, retained as the only stable deleted-invite identity */
    readonly code: string
    /** Destination channel when Fluxer supplied one */
    readonly channelId?: string
    /** Owning guild when this was a guild invite */
    readonly guildId?: string
}

/** Frozen audit entry written in one guild, including all context supplied by Fluxer.
 * Reason, options, and changes are intentional domain data, not safe diagnostic content.
 * Gateway string metadata is projected into the same numeric/boolean option fields as audit-log reads
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export function administrativeEventsExample(client: Client) {
 *     return client.events("guildAuditLogEntryCreate", { maxPendingMessages: 10 })
 * }
 * ```
 */
export interface GuildAuditLogEntryCreate extends AuditLogEntry {
    /** Guild that wrote this entry */
    readonly guildId: string
    /** Acting user ID supplied by the gateway */
    readonly userId: string
    /** Affected entity ID or invite code, null when Fluxer recorded no target */
    readonly targetId: string | null
}

/** One live typing notice from Fluxer. It is not durable state and does not populate a cache or trigger a lookup */
export interface TypingStart {
    /** Channel where the user began typing */
    readonly channelId: string
    /** User who began typing */
    readonly userId: string
    /** Provider Unix timestamp in whole seconds */
    readonly timestamp: number
    /** Guild context when Fluxer supplied it. Its absence does not establish that the channel is not in a guild */
    readonly guildId?: string
}

/** Full frozen custom-emoji collection observed through the gateway, without creator accounts or image data
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export function expressionEventsExample(client: Client) {
 *     return client.events("guildEmojisUpdate", { maxPendingMessages: 10 })
 * }
 * ```
 */
export interface GuildEmojisUpdate {
    /** Owning guild ID */
    readonly guildId: string
    /** Provider collection in gateway order */
    readonly items: readonly GuildEmoji[]
}

/** Full frozen custom-sticker collection observed through the gateway, without creator accounts or image data */
export interface GuildStickersUpdate {
    /** Owning guild ID */
    readonly guildId: string
    /** Provider collection in gateway order */
    readonly items: readonly GuildSticker[]
}

/** A bounded guild event subscription
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
    /** A complete current guild snapshot became available and updates its enabled guild-cache observation without hydrating nested members, roles or channels */
    readonly guildCreate: Guild
    /** A complete current guild configuration snapshot, not an old/new pair or a partial patch */
    readonly guildUpdate: Guild
    /** Guild visibility ended or became temporarily unavailable without an inferred deletion cause or membership result; enabled guild-resource and channel observations for this guild invalidate before delivery. Message-cache observations with this guild or unknown guild scope invalidate conservatively because the SDK has no channel-to-guild index */
    readonly guildDelete: GuildDeletion
}

/**
 * One presence observation from the gateway, without retained presence state or a user snapshot.
 * Connection gaps can miss changes. The SDK neither caches nor fetches presence, so treat this as a notification rather than current state.
 * Guild-scoped updates include `guildId`; valid account-scoped wire observations can omit it.
 * The hosted provider currently delivers bot presence through guild subscriptions, not friends or group DMs.
 * Registering `on("presenceUpdate")` or `events("presenceUpdate")` does not request guild-member subscriptions or establish delivery.
 * The provider currently sends online, idle, dnd and offline statuses, but this remains a string for forward compatibility
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
    /** Guild whose visible member presence changed, when the provider supplied guild scope */
    readonly guildId?: string
    /** User whose presence changed, without an automatic account lookup */
    readonly userId: string
    /** Provider status at the time of this observation, not a freshness guarantee */
    readonly status: string
    /** Whether the provider reports a mobile client */
    readonly mobile: boolean
    /** Whether the provider reports away-from-keyboard status */
    readonly afk: boolean
}

/**
 * Visible online presences delivered together after a guild becomes available again.
 * Fluxer supplies the outer guild context, omits the recipient's own presence, and splits batches at 500 entries. The batch can include visible members outside this client's selected member IDs.
 * This is one frozen recovery observation, not a cache refill, subscription acknowledgement, or synthetic sequence of presenceUpdate events
 */
export interface PresenceUpdateBulk {
    /** Guild context applied to every presence in this provider batch */
    readonly guildId: string
    /** Frozen presence observations with the batch guild context */
    readonly presences: readonly PresenceUpdate[]
}

/**
 * One frozen non-media voice connection observed through a guild gateway session.
 * `channelId: null` is a disconnect observation. A server move can appear as a disconnect followed by a join under a new connection ID.
 * Fluxer filters observations by channel visibility. Connection gaps can miss transitions, and the SDK performs no lookup or retention
 */
export interface VoiceState {
    /** Guild that owns the voice channel */
    readonly guildId: string
    /** Current voice channel, or null when this connection disconnected */
    readonly channelId: string | null
    /** Connected member's user ID */
    readonly userId: string
    /** Provider connection identity, suitable for targeting one connection in a move or disconnect */
    readonly connectionId: string
    /** Gateway session identity when Fluxer supplied one */
    readonly sessionId?: string
    /** Server-controlled mute flag */
    readonly isMuted: boolean
    /** Server-controlled deafen flag */
    readonly isDeafened: boolean
    /** Participant-controlled mute flag */
    readonly isSelfMuted: boolean
    /** Participant-controlled deafen flag */
    readonly isSelfDeafened: boolean
    /** Whether Fluxer reports this connection as mobile */
    readonly isMobile: boolean
    /** Whether Fluxer currently suppresses this connection from speaking */
    readonly isSuppressed: boolean
}

/**
 * Visibility-filtered voice states delivered inside one available `GUILD_CREATE` snapshot.
 * Register before connecting to observe startup snapshots. An empty `voiceStates` array means Fluxer supplied an empty initial collection; no event is emitted when the collection is absent.
 * This is neither a complete guild roster nor a retained cache, and later connection gaps can make it stale immediately
 */
export interface VoiceStateSnapshot {
    /** Guild whose available snapshot supplied the collection */
    readonly guildId: string
    /** Frozen provider-order connection states, possibly empty */
    readonly voiceStates: readonly VoiceState[]
}

/** Implemented gateway events and their frozen payloads. No subscription history, cache reconstruction or REST-generated notifications */
export interface EventMap extends GuildLifecycleEvents {
    /** Complete public account update, never private account settings */
    readonly userUpdate: import("./users.js").User
    /** Private conversation became visible, not proof it was newly created */
    readonly directMessageCreate: import("./users.js").DirectMessageChannel
    /** Complete private conversation update, not an old/new pair */
    readonly directMessageUpdate: import("./users.js").DirectMessageChannel
    /** Visible online guild presences after availability recovery, delivered as one batch and never flattened */
    readonly presenceUpdateBulk: PresenceUpdateBulk
    /** One visibility-filtered initial connection collection from an available guild snapshot, including an explicit empty collection */
    readonly voiceStateSnapshot: VoiceStateSnapshot
    /** One subsequent visible connection join, state change, move phase or disconnect; no initial reconstruction or cache update */
    readonly voiceStateUpdate: VoiceState
    /** Private conversation closed, left or deleted for this bot, not proof of deletion for others */
    readonly directMessageDelete: { readonly id: string }
    /** Recipient added; invalidates private-channel cache without synthesizing a membership list */
    readonly directMessageRecipientAdd: import("./users.js").DirectMessageRecipientChange
    /** Recipient removed; invalidates private-channel cache without claiming channel deletion */
    readonly directMessageRecipientRemove: import("./users.js").DirectMessageRecipientChange
    /** Webhook set changed for one visible guild channel. No webhook metadata, token, cache write, or automatic refetch follows */
    readonly webhooksUpdate: WebhooksUpdate
    /** Complete frozen invite metadata. Its code and URL grant destination access, so keep this intentional result out of diagnostics and public logs */
    readonly inviteCreate: InviteMetadata
    /** Deleted invite identity and the optional destination context Fluxer still supplied. No local invite retention or deletion inference occurs */
    readonly inviteDelete: InviteDeleteEvent
    /** One frozen audit entry from a guild where the bot holds `VIEW_AUDIT_LOG`. `reason`, `options`, and `changes` are provider domain data, not diagnostic-safe content */
    readonly guildAuditLogEntryCreate: GuildAuditLogEntryCreate
    /** Full emoji collection projection, not an initial enumeration or cache hydration. Connection gaps can miss changes; fetch when current state matters. An enabled expression cache is invalidated before delivery */
    readonly guildEmojisUpdate: GuildEmojisUpdate
    /** Full sticker collection projection, not an initial enumeration or cache hydration. Connection gaps can miss changes; fetch when current state matters. An enabled expression cache is invalidated before delivery */
    readonly guildStickersUpdate: GuildStickersUpdate
    /** Ban recorded for these guild/user IDs, not a full ban or proof member removal has finished. Evicts the member cache entry */
    readonly guildBanAdd: MemberReference
    /** Explicit ban removal notice, not proof of rejoining. Database TTL expiry need not emit this event. Evicts the member cache entry */
    readonly guildBanRemove: MemberReference
    /** Channel became visible, including newly created channels. Not proof of remote creation or an initial enumeration */
    readonly guildChannelCreate: import("./channels.js").GuildChannel
    /** Frozen guild channel update, not an old/new pair. Current permissions may require an explicit fetch */
    readonly guildChannelUpdate: import("./channels.js").GuildChannel
    /** Channel was deleted or became invisible. Evicts cached channel messages without synthesizing message deletion events */
    readonly guildChannelDelete: import("./channels.js").GuildChannel
    /** One visibility-filtered batch without fan-out. Not a complete guild list or proof that permission copying has finished */
    readonly guildChannelUpdateBulk: import("./channels.js").GuildChannelUpdateBulk
    /** Frozen role creation observation, without an initial enumeration */
    readonly guildRoleCreate: import("./guilds.js").GuildRole
    /** Frozen role update, not an old/new pair */
    readonly guildRoleUpdate: import("./guilds.js").GuildRole
    /** One batch without fan-out to guildRoleUpdate; not a complete guild role list */
    readonly guildRoleUpdateBulk: import("./guilds.js").GuildRoleUpdateBulk
    /** Role deletion notice, not a role snapshot or a guarantee of individual member-update events */
    readonly guildRoleDelete: import("./guilds.js").RoleReference
    /** Frozen member joined observation. No initial member enumeration or complete guild view */
    readonly guildMemberAdd: import("./guilds.js").GuildMember
    /** Frozen member update. Delivery can be limited by guild size/session visibility; refetch when current state matters */
    readonly guildMemberUpdate: import("./guilds.js").GuildMember
    /** Membership ended; only IDs are available. No account lookup, cause inference or automatic cache */
    readonly guildMemberRemove: import("./guilds.js").MemberReference
    /** One delivered presence change, without cache retention, custom-status text, an account snapshot or an automatic guild-member subscription */
    readonly presenceUpdate: PresenceUpdate
    /** Channel pin-list change notice. No target message ID or automatic fetch; its timestamp can stay unchanged after unpin */
    readonly channelPinsUpdate: ChannelPinsUpdate
    /** Ephemeral typing notice. Delivery can be filtered by Fluxer and is not a presence snapshot, cache entry or member lookup */
    readonly typingStart: TypingStart
    /** Newly created message with text, deeply frozen embeds and attachment metadata, never file bytes. Malformed known message data fails the connection as a protocol error */
    readonly messageCreate: Message
    /** Current message projection, not an old/new pair or partial patch. Non-text changes may repeat the same projected values */
    readonly messageUpdate: Message
    /** Single deletion with required message/channel IDs and only the optional context supplied by Fluxer */
    readonly messageDelete: MessageDeletion
    /** One batch with channel and message IDs. Subscribe to both deletion types to observe both forms */
    readonly messageDeleteBulk: MessageBulkDeletion
    /** One user's reaction addition. The SDK does not synthesize this from add-many batches or REST success */
    readonly messageReactionAdd: MessageReaction
    /** One server-coalesced batch, without fan-out. Subscribe to both addition types to observe both forms */
    readonly messageReactionAddMany: MessageReactionBatch
    /** One user's reaction removal, which may have been performed by a moderator */
    readonly messageReactionRemove: MessageReaction
    /** Every reaction on this message was cleared; no reactor list is provided */
    readonly messageReactionRemoveAll: ReactionTarget
    /** Every reaction using one emoji was cleared; no reactor list is provided */
    readonly messageReactionRemoveEmoji: MessageReactionEmojiRemoval
}

/** Names accepted by on, events and waitFor in both API styles */
export type EventName = keyof EventMap

/** Pending queue budgets for one live event subscription, message collector or reaction collector, not process memory limits */
export interface EventBufferOptions {
    /** Maximum queued event payloads, excluding active handlers. A bulk deletion or reaction batch counts once. Positive safe integer, default 256 */
    readonly maxPendingMessages?: number
    /** Maximum queued source-JSON bytes, including the full bulk payload. Positive safe integer, default 4,194,304 */
    readonly maxPendingBytes?: number
}

/** Settings for one future event observation. Waiting creates no event history, cache read or gateway connection. Queue budgets apply only to values queued before this wait can take them */
export interface EventWaitOptions<K extends EventName> extends EventBufferOptions {
    /** Synchronously accept a projected event, potentially during gateway intake. Keep it short because cancellation and the deadline cannot preempt it. Throws, non-boolean results and thenables fail this wait without exposing the original value */
    readonly filter?: (event: EventMap[K]) => boolean
    /** Total listening lifetime in milliseconds from registration. Integer 1 through 2,147,483,647, default 30,000 */
    readonly timeoutMs?: number
}

/** Callback scheduling shared by default and native consumption */
export interface HandlerOptions extends EventBufferOptions {
    /** Active invocations per registration. Defaults to 1, with receive-order starts but no concurrent completion order */
    readonly concurrency?: number
}

/** Safe diagnostic metadata. Intentionally excludes message bodies, credentials and original handler errors.
 * Inspect the original error inside a default callback's try/catch or a native handler's Effect.tapCause
 * before SDK isolation. SDK hooks do not provide a raw-exception logging bypass
 */
export interface HandlerErrorReport {
    /** Event whose subscription reported this failure */
    readonly event: EventName
    /** Handler failures continue delivery. Overflow permanently stops this subscription */
    readonly kind: "handler" | "overflow"
}
