import type { OperationOptions } from "./client.js"
import type { CollectorFailure } from "./collectors.js"
import type { EmbedBuilder } from "./builders.js"
import type { EmbedInput } from "./embeds.js"
import type { ConfigurationError } from "./errors.js"
import type { MessageOperationFailure, SendError } from "./message-errors.js"
import type { Message, MessageCore } from "./messages.js"
import type { MessageReaction } from "./reactions.js"

/** One page shown by reaction pages, such as `"Page 1"` or `{ embeds: [embed] }`.
 * A string is the page's text. An object supplies text, embeds or both, and must not be empty.
 * Showing a page replaces the message's text and embeds, so text from one page never stays on an embed-only page.
 * Files, stickers and mentions are not supported on pages, and mention notifications stay off.
 * Fluxer validates each page when it is sent or shown, so an invalid later page fails only when someone turns to it
 *
 * @category Messages
 */
export type PageInput =
    | string
    | {
          /** Page text, without trimming. Omit for an embed-only page */
          readonly content?: string
          /** Page embeds in display order, as plain objects or EmbedBuilder instances. Omit for a text-only page */
          readonly embeds?: readonly (EmbedInput | EmbedBuilder)[]
      }

/** Who may turn pages: A list of account IDs, or a synchronous check that returns true to accept a click.
 * The check receives the reaction addition, or the removal in the default toggle mode, after the arrow is matched.
 * Return true for anyone, as in `users: () => true`. Reactions by the bot itself are never clicks.
 * A throw or a non-boolean return ends the pages with CollectorError reason filter, and is reported to the
 * client-level onError with kind filter, or logged at Error
 *
 * @category Messages
 */
export type PageTurners = readonly string[] | ((reaction: MessageReaction) => boolean)

/** Choose who may turn reaction pages and how long they listen.
 * The bot adds ◀ and ▶ reactions, and each click on one shows the previous or next page, wrapping around at the ends.
 * By default adding or removing an arrow both count as one click, so the bot needs only Add Reactions and Read Message
 * History. Registration needs a connected gateway, like messages.collectReactions
 *
 * @category Messages
 */
export interface PaginateOptions {
    /** Who may turn pages. A command context defaults to the command's author. messages.paginate requires it */
    readonly users?: PageTurners
    /** Stop after this many milliseconds without an accepted click. Integer 1 through 2,147,483,647, default 60,000 */
    readonly idleMs?: number
    /** Stop after this many milliseconds from registration, regardless of clicks. Integer 1 through 2,147,483,647, default 300,000 */
    readonly timeoutMs?: number
    /** Count only added arrows, and remove the clicker's arrow after each turn so the next click is another addition.
     * The bot then needs Manage Messages. Default false, where adding and removing an arrow both turn the page
     */
    readonly removeClicks?: boolean
}

/** Reaction page settings for the Promise and Result API.
 * Aborting the signal stops listening, removes the bot's arrows and returns CancelledError, leaving the current page shown.
 * The Effect entry point uses interruption instead
 *
 * @category Messages
 */
export interface DefaultPaginateOptions extends PaginateOptions, OperationOptions {}

/** Reaction page settings for messages.paginate, where no message identifies an asker, so users is required
 *
 * @category Messages
 */
export interface ChannelPaginateOptions extends PaginateOptions {
    /** Who may turn pages, such as `[userId]`, or `() => true` for anyone */
    readonly users: PageTurners
}

/** Settings for messages.paginate in the Promise and Result API, with the signal described on DefaultPaginateOptions
 *
 * @category Messages
 */
export interface DefaultChannelPaginateOptions extends ChannelPaginateOptions, OperationOptions {}

/** How reaction pages ended after listening normally.
 * Failures, cancellation and interruption are returned in the failure channel instead
 *
 * @category Messages
 */
export interface PaginateResult<M extends MessageCore = Message> {
    /** Latest snapshot of the page message, as sent or as returned by the last page change */
    readonly message: M
    /** Position of the page shown at the end, with 0 identifying the first page */
    readonly page: number
    /** The reason idle means idleMs passed without a click, timeout means timeoutMs passed and singlePage means only one
     * page was sent, without arrows or listening
     */
    readonly reason: "idle" | "timeout" | "singlePage"
}

/** Expected reaction page failures: Invalid pages or options, a failed send, a failed page change, arrow or click
 * removal, an unavailable or lost gateway, an overflowing listener or a failing users check.
 * After the first page is sent, the message stays at its current page and the bot still removes its own arrows.
 * When that removal also fails, the earlier failure is returned. After an otherwise normal end, the removal failure is returned
 *
 * @category Errors
 */
export type PaginateFailure = ConfigurationError | SendError | MessageOperationFailure | CollectorFailure
