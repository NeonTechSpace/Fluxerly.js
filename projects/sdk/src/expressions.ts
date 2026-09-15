import type { ModerationOptions, DefaultModerationOptions } from "./guilds.js"

/** Address a custom emoji or sticker by its owning guild and resource ID.
 * A fetched emoji or sticker already contains these IDs and can be passed wherever this reference is accepted
 */
export interface ExpressionReference {
    /** Owning guild ID */
    readonly guildId: string
    /** Emoji or sticker ID */
    readonly id: string
}

/** A guild's custom emoji identity, name and animation flag.
 * Pass this snapshot to message reaction helpers or emoji management methods. It contains no image bytes or
 * creator account, and it does not update when the emoji is renamed or deleted
 */
export interface GuildEmoji extends ExpressionReference {
    /** Emoji name */
    readonly name: string
    /** Whether the image is animated */
    readonly animated: boolean
}

/** A guild's custom sticker identity and display metadata, including its description and suggestion tags.
 * This frozen snapshot contains no image bytes or creator account. Use stickers.edit to replace metadata,
 * not to replace the underlying image
 */
export interface GuildSticker extends GuildEmoji {
    /** Provider description, including empty text */
    readonly description: string
    /** Frozen suggestion tags in provider order */
    readonly tags: readonly string[]
}

/** Public name and animation information returned by fetchMetadata without requiring source-guild membership.
 * allowCloning is a provider hint for deciding whether to attempt a clone, not proof of access to either guild.
 * This is not the full guild-owned sticker or emoji management record
 */
export interface ExpressionMetadata extends GuildEmoji {
    /** Provider's current cloning hint, not authorization or a guarantee that a later clone will succeed */
    readonly allowCloning: boolean
}

/** Upload an image as a named custom guild emoji for messages and reactions.
 * Supply encoded image bytes yourself. The SDK does not read a file or fetch an image URL
 * @example
 * ```ts
 * import type { Client, GuildEmoji, GuildSticker, MessageReference } from "@neontechspace/fluxerly"
 * export function expressionExample(client: Client, guildId: string, image: string) {
 *     return client.emojis.create(guildId, { name: "build_passed", image })
 * }
 * export function renameStickerExample(client: Client, sticker: GuildSticker) {
 *     return client.stickers.edit(sticker, { ...sticker, name: "Build passed" })
 * }
 * export function useEmojiExample(client: Client, message: MessageReference, emoji: GuildEmoji) {
 *     return client.messages.addReaction(message, emoji)
 * }
 * ```
 */
export interface EmojiCreate {
    /** 2–32 ASCII letters, digits or underscores */
    readonly name: string
    /** Base64 image data or an image data URI, at most 512 KiB decoded.
     * Fluxer validates the actual format, dimensions, moderation and guild capacity.
     * No file is read implicitly. Callers own encoding and the lifetime of their original bytes
     */
    readonly image: string
}

/** Upload a named custom sticker with optional description and suggestion tags.
 * Supply image bytes as base64 or a data URI, as with EmojiCreate. Fluxer validates image format, dimensions,
 * moderation and guild capacity after local input validation
 */
export interface StickerCreate {
    /** 2–30 Unicode code points */
    readonly name: string
    /** Omitted/null means no description. Otherwise 1–500 Unicode code points */
    readonly description?: string | null
    /** Up to ten tags of 1–30 Unicode code points each. Omitted means empty. Entries are copied by index when the operation starts */
    readonly tags?: readonly string[]
    /** Base64 image data or image data URI, at most 512 KiB decoded */
    readonly image: string
}

/** Rename an emoji without replacing its image */
export interface EmojiEdit {
    /** Replacement name, 2–32 ASCII letters, digits or underscores */
    readonly name: string
}

/** Replace sticker metadata without reading or merging remote state. Images cannot be replaced.
 * A fetched sticker can be spread into this input. Its matching identity and animation fields are ignored
 */
export interface StickerEdit {
    /** Required replacement name, 2–30 Unicode code points */
    readonly name: string
    /** Required replacement description, up to 500 Unicode code points. Empty/null clears it */
    readonly description: string | null
    /** Required replacement list, at most ten tags of 1–30 Unicode code points. [] clears it. Entries are copied by index when the operation starts */
    readonly tags: readonly string[]
}

/** Which emoji or stickers were created and which failed in a batch request.
 * Inspect both lists even when the HTTP request succeeded. Entries in success were created independently of
 * failures, so repeating the whole batch can duplicate successful creations. Provider order does not map failures
 * back to input indexes when names repeat
 */
export interface ExpressionBatch<A> {
    /** Created resources. They remain created even when another entry fails */
    readonly success: readonly A[]
    /** Failed names in provider order. Duplicate names cannot be correlated to an input index.
     * Raw localized provider error text is deliberately excluded from SDK data and diagnostics
     */
    readonly failed: readonly {
        /** Name reported for a failed creation, which may identify more than one input when names repeat */
        readonly name: string
    }[]
}

/** Choose whether deleting a guild emoji or sticker also requests removal of its image asset.
 * The inherited timeout and auditReason follow ModerationOptions.
 * Purging is a separate queued job. Deleting the guild entry does not wait for the image purge to finish
 */
export interface ExpressionDeleteOptions extends ModerationOptions {
    /** False/default removes the guild entry without asking to purge its image.
     * True additionally requests irreversible queued asset/CDN removal and requires Fluxer's expression-purge feature.
     * HTTP success does not mean the purge job has finished. Failure after dispatch can leave either effect applied
     */
    readonly purge?: boolean
}

/** Starts immediately. Cancellation awaits cleanup but cannot undo deletion or queued purging */
export interface DefaultExpressionDeleteOptions extends ExpressionDeleteOptions, DefaultModerationOptions {}
