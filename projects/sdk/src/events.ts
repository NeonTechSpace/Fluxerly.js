import type { Message, MessageDeletion, MessageBulkDeletion } from "./messages.js"
import type { ChannelPinsUpdate } from "./pins.js"
import type { MemberReference } from "./guilds.js"
import type { MessageReaction, MessageReactionBatch, MessageReactionEmojiRemoval, ReactionTarget } from "./reactions.js"

/** Implemented gateway events and their frozen payloads. No subscription history, cache reconstruction or REST-generated notifications */
export interface EventMap {
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
    /** Channel pin-list change notice. No target message ID or automatic fetch; its timestamp can stay unchanged after unpin */
    readonly channelPinsUpdate: ChannelPinsUpdate
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

/** Names accepted by on/events in both API styles */
export type EventName = keyof EventMap

/** Pending queue budgets for one live event subscription, message collector or reaction collector, not process memory limits */
export interface EventBufferOptions {
    /** Maximum queued event payloads, excluding active handlers. A bulk deletion or reaction batch counts once. Positive safe integer, default 256 */
    readonly maxPendingMessages?: number
    /** Maximum queued source-JSON bytes, including the full bulk payload. Positive safe integer, default 4,194,304 */
    readonly maxPendingBytes?: number
}

/** Callback scheduling shared by default and native consumption */
export interface HandlerOptions extends EventBufferOptions {
    /** Active invocations per registration. Defaults to 1, with receive-order starts but no concurrent completion order */
    readonly concurrency?: number
}

/** Safe diagnostic metadata. Intentionally excludes message bodies, credentials and original handler errors */
export interface HandlerErrorReport {
    /** Event whose subscription reported this failure */
    readonly event: EventName
    /** Handler failures continue delivery. Overflow permanently stops this subscription */
    readonly kind: "handler" | "overflow"
}
