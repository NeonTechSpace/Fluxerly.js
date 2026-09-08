import type { MessageReference } from "./messages.js"

/** One explicit reaction-user page request; no automatic traversal */
export interface ReactionUsersQuery {
    /** Maximum users in this page, integer 1–100, default 25 */
    readonly limit?: number
    /** Exclusive decimal user-ID cursor, not a reaction timestamp */
    readonly after?: string
}

/** Frozen user projection, not a complete profile, guild member or cached live object */
export interface ReactionUser {
    /** Decimal user ID */
    readonly id: string
    /** Account username returned by Fluxer */
    readonly username: string
    /** Whether Fluxer marks this user as a bot; an omitted wire flag means false */
    readonly isBot: boolean
}

/** Frozen page observed from Fluxer; separate requests are not an atomic snapshot */
export interface ReactionUsersPage {
    /** Frozen users in ascending user-ID order, at most the requested limit */
    readonly items: readonly ReactionUser[]
    /** Whether Fluxer reported a further page at response time */
    readonly hasMore: boolean
    /** Last returned user ID when hasMore is true, otherwise null */
    readonly nextAfter: string | null
}

/** Literal Unicode emoji, or a custom emoji's name and decimal ID.
 * Pass Unicode without URL encoding, shortcodes or <:name:id> markup.
 * Custom names are 1–32 ASCII letters, digits or underscores; IDs are decimal strings.
 * Unicode input is bounded to 128 UTF-16 code units; Fluxer validates supported single emoji and permissions
 */
export type ReactionEmojiInput = string | { readonly name: string; readonly id: string }

/** Frozen gateway emoji identity. Missing animated means unknown, not false */
export interface ReactionEmoji {
    /** Unicode emoji or custom emoji name supplied by Fluxer */
    readonly name: string
    /** Decimal custom emoji ID, absent for Unicode */
    readonly id?: string
    /** Animation flag when supplied by Fluxer; omitted for Unicode */
    readonly animated?: boolean
}

/** Frozen reaction target; id is the message ID.
 * Observations are not a complete reactor list or count and may be missed across recovery.
 * Unknown fields, member details and session identifiers are not retained
 */
export interface ReactionTarget extends MessageReference {
    /** Decimal guild ID when supplied, omitted for private channels */
    readonly guildId?: string
}

/** One user's addition or removal, not the identity of a moderator removing another user's reaction */
export interface MessageReaction extends ReactionTarget {
    /** Decimal ID of the user whose reaction changed */
    readonly userId: string
    /** Frozen emoji identity */
    readonly emoji: ReactionEmoji
}

/** All users' reactions for one emoji were removed, without listing those users */
export interface MessageReactionEmojiRemoval extends ReactionTarget {
    /** Frozen identity of the cleared emoji */
    readonly emoji: ReactionEmoji
}

/** One server-coalesced addition batch in wire order, without synthetic single-add events.
 * Counts as one subscription payload; its full source JSON counts toward the byte budget.
 * The SDK does not enable reaction debouncing or reconstruct changes the server omitted
 */
export interface MessageReactionBatch extends ReactionTarget {
    /** Frozen additions for this message; each nested emoji and entry is frozen */
    readonly reactions: readonly { readonly userId: string; readonly emoji: ReactionEmoji }[]
}
