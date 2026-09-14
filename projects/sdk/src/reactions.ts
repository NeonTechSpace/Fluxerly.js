import type { MessageReference } from "./messages.js"
import type { GuildEmoji } from "./expressions.js"

/** Choose one page of users who reacted with a particular emoji.
 * Pass to messages.fetchReactionUsers. Use iterateReactionUsers to traverse bounded multiple pages.
 * Unknown properties and invalid limits or IDs are rejected before the request
 */
export interface ReactionUsersQuery {
    /** Maximum users requested in this page, an integer from 1 through 100, default 25 */
    readonly limit?: number
    /** Return user IDs greater than this decimal ID, excluding the cursor user. Omit to start at the first page */
    readonly after?: string
}

/** Account identity returned in a reaction-user page.
 * This frozen snapshot has no account methods, server membership details or automatically refreshed data
 */
export interface ReactionUser {
    /** Account ID as a decimal string, not a JavaScript number */
    readonly id: string
    /** Username at the time Fluxer returned this page */
    readonly username: string
    /** True if Fluxer marked the account as a bot, otherwise false */
    readonly isBot: boolean
}

/** One frozen page of users who reacted with the requested emoji.
 * Users are ordered by ascending ID. Concurrent reaction changes can affect later pages.
 * A sequence of pages is not one consistent snapshot of the reactor list
 */
export interface ReactionUsersPage {
    /** Users ordered by ascending decimal ID, with no more than the requested limit */
    readonly items: readonly ReactionUser[]
    /** True when Fluxer reported more users after this page */
    readonly hasMore: boolean
    /** Cursor to pass as after for the next request. The last returned user ID when hasMore is true, otherwise null */
    readonly nextAfter: string | null
}

/** Emoji accepted by reaction operations and reaction collector selection.
 * Pass literal Unicode such as "👍", not a shortcode, URL-encoded text or <:name:id> markup.
 * For custom emoji, pass { name, id } or a GuildEmoji returned by client.emojis.
 * Custom names use 1 through 32 ASCII letters, digits or underscores. IDs are decimal strings.
 * Unicode input is limited to 128 UTF-16 code units and rejects spaces, control characters and reserved markup characters.
 * Fluxer checks that the emoji is supported and that the bot may use it. The SDK does not look it up or infer permissions
 */
export type ReactionEmojiInput =
    | string
    | {
          /** Custom emoji name, using 1 through 32 ASCII letters, digits or underscores */
          readonly name: string
          /** Custom emoji ID as a decimal string */
          readonly id: string
      }
    | GuildEmoji

/** Emoji identity supplied in a reaction event.
 * This frozen value records the name and any custom ID or animation flag supplied by Fluxer
 */
export interface ReactionEmoji {
    /** Literal Unicode emoji text, or the custom emoji name at event time */
    readonly name: string
    /** Custom emoji ID as a decimal string. Absent for Unicode emoji */
    readonly id?: string
    /** Whether a custom emoji is animated, when supplied. Absence means unknown and Unicode emoji omit this field */
    readonly animated?: boolean
}

/** Message address carried by a reaction event, with optional server context.
 * id is the message ID, not the reaction or user ID.
 * Events can be missed during gateway recovery and do not establish current counts or the complete reactor list.
 * Additional provider data, such as member details and session identifiers, is not retained
 */
export interface ReactionTarget extends MessageReference {
    /** Owning server ID when supplied. Absence alone does not establish private-channel scope */
    readonly guildId?: string
}

/** One reaction addition or removal delivered by Fluxer.
 * userId identifies the user whose reaction changed, not necessarily the person who removed it
 */
export interface MessageReaction extends ReactionTarget {
    /** Account ID of the user whose reaction was added or removed */
    readonly userId: string
    /** Emoji whose reaction changed */
    readonly emoji: ReactionEmoji
}

/** Notice that every reaction using one emoji was cleared from a message.
 * The affected users are not listed
 */
export interface MessageReactionEmojiRemoval extends ReactionTarget {
    /** Emoji whose reactions were cleared */
    readonly emoji: ReactionEmoji
}

/** Reaction additions grouped by Fluxer into one messageReactionAddMany event.
 * Entries retain received order. This does not also emit messageReactionAdd for each entry.
 * Subscribe to both addition events if you need both forms. Reaction collectors already accept both.
 * A batch counts as one queued event, and its full received JSON counts toward the pending-byte budget.
 * The SDK neither requests batching nor reconstructs changes Fluxer omitted
 */
export interface MessageReactionBatch extends ReactionTarget {
    /** Frozen additions on the target message, in received order */
    readonly reactions: readonly {
        /** Account ID whose reaction was added */
        readonly userId: string
        /** Emoji used for this addition */
        readonly emoji: ReactionEmoji
    }[]
}
