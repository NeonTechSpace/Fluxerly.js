import type { ModerationOptions, DefaultModerationOptions } from "./guilds.js"

/** Decimal guild and expression IDs. A snapshot can be used wherever this reference is accepted */
export interface ExpressionReference {
    /** Owning guild ID */
    readonly guildId: string
    /** Emoji or sticker ID */
    readonly id: string
}

/** Frozen custom emoji metadata, without image bytes or creator-account retention */
export interface GuildEmoji extends ExpressionReference {
    /** Emoji name */
    readonly name: string
    /** Whether the image is animated */
    readonly animated: boolean
}

/** Frozen custom sticker metadata, without image bytes or creator-account retention */
export interface GuildSticker extends GuildEmoji {
    /** Provider description, including empty text */
    readonly description: string
    /** Frozen suggestion tags in provider order */
    readonly tags: readonly string[]
}

/** Minimal remote metadata available without source-guild membership, not a full editable snapshot */
export interface ExpressionMetadata extends GuildEmoji {
    /** Provider's current cloning hint, not authorization or a guarantee that a later clone will succeed */
    readonly allowCloning: boolean
}

/** Create one custom emoji. The SDK does not fetch image URLs
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
     * No file is read implicitly; callers own encoding and the lifetime of their original bytes
     */
    readonly image: string
}

/** Create one sticker; image upload rules are shared with EmojiCreate */
export interface StickerCreate {
    /** 2–30 Unicode code points */
    readonly name: string
    /** Omitted/null means no description; otherwise 1–500 Unicode code points */
    readonly description?: string | null
    /** Up to ten tags of 1–30 Unicode code points each; omitted means empty */
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
 * A fetched sticker can be spread into this input; its matching identity and animation fields are ignored
 */
export interface StickerEdit {
    /** Required replacement name, 2–30 Unicode code points */
    readonly name: string
    /** Required replacement description, up to 500 Unicode code points. Empty/null clears it */
    readonly description: string | null
    /** Required replacement list, at most ten tags of 1–30 Unicode code points; [] clears it */
    readonly tags: readonly string[]
}

/** One provider batch result, not a transaction or an input-index mapping */
export interface ExpressionBatch<A> {
    /** Created resources. They remain created even when another entry fails */
    readonly success: readonly A[]
    /** Failed names in provider order. Duplicate names cannot be correlated to an input index.
     * Raw localized provider error text is deliberately excluded from SDK data and diagnostics
     */
    readonly failed: readonly { readonly name: string }[]
}

/** Guild expression operations reuse the existing audit header and deadline rules */
export interface ExpressionDeleteOptions extends ModerationOptions {
    /** False/default removes the guild entry without asking to purge its image.
     * True additionally requests irreversible queued asset/CDN removal and requires Fluxer's expression-purge feature.
     * HTTP success does not mean the purge job has finished. Failure after dispatch can leave either effect applied
     */
    readonly purge?: boolean
}

/** Starts immediately; cancellation awaits cleanup but cannot undo deletion or queued purging */
export interface DefaultExpressionDeleteOptions extends ExpressionDeleteOptions, DefaultModerationOptions {}
