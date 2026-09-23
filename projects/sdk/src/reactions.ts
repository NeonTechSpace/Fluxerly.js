import type { MessageReference } from "./messages.js"
import type { GuildEmoji } from "./expressions.js"

/** Choose one page of users who reacted with a particular emoji.
 * Pass to messages.fetchReactionUsers. Use iterateReactionUsers to traverse bounded multiple pages.
 * Fields are captured once. Unknown properties and invalid limits or IDs are rejected before the request
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
 * Several pages do not represent one fixed list of people who reacted
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
 * Pass literal Unicode such as `"👍"`, custom markup such as `"<:party:123>"` or `"<a:party:123>"`,
 * a `{ name, id, animated? }` value, or a `GuildEmoji` returned by `client.emojis`.
 * Values returned by `format.parseCustomEmoji`, `emojis.fetchMetadata` and reaction events can be reused directly
 *
 * Custom names use 1 through 32 ASCII letters, digits, underscores or hyphens. IDs are decimal strings.
 * Markup must occupy the whole string. Shortcodes such as `:wave:` and URL-encoded text are rejected.
 * Custom animation flags are optional and do not change the request identity or collector match
 *
 * Unicode input is limited to 128 UTF-16 code units and rejects spaces, control characters and reserved markup characters.
 * Fluxer checks that the emoji is supported and that the bot may use it. The SDK does not fetch the emoji or decide whether the bot has permission to use it
 */
export type ReactionEmojiInput = string | ReactionEmoji | GuildEmoji

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
 * The `id` field is the message ID.
 * Gateway reconnection can miss events. An event does not show current counts or everyone who reacted.
 * Additional provider data, such as member details and session identifiers, is not retained
 */
export interface ReactionTarget extends MessageReference {
    /** Owning server ID when supplied. Absence alone does not establish private-channel scope */
    readonly guildId?: string
}

/** One reaction addition or removal delivered by Fluxer.
 * The `userId` field identifies the user whose reaction changed. Another account can perform the removal
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
 * The SDK does not ask Fluxer to batch events or fill in changes Fluxer did not send
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
