import type { ModerationOptions, DefaultModerationOptions } from "./guilds.js"

/** Address a custom emoji or sticker by its owning community and resource ID.
 * A fetched emoji or sticker already contains these IDs and can be passed wherever this reference is accepted
 *
 * @category Emoji and stickers
 */
export interface ExpressionReference {
    /** Owning guild ID */
    readonly guildId: string
    /** Emoji or sticker ID */
    readonly id: string
}

/** A community's custom emoji identity, name and animation flag.
 * Pass this snapshot to message reaction helpers or emoji management methods. It contains no image bytes or
 * creator account, and it does not update when the emoji is renamed or deleted
 *
 * @category Emoji and stickers
 */
export interface GuildEmoji extends ExpressionReference {
    /** Emoji name */
    readonly name: string
    /** Whether the image is animated */
    readonly animated: boolean
}

/** A community's custom sticker identity and display metadata, including its description and suggestion tags.
 * This frozen snapshot contains no image bytes or creator account. Use stickers.edit to replace metadata,
 * not to replace the underlying image
 *
 * @category Emoji and stickers
 */
export interface GuildSticker extends GuildEmoji {
    /** Provider description, including empty text */
    readonly description: string
    /** Frozen suggestion tags in provider order */
    readonly tags: readonly string[]
}

/** Public name and animation information returned by fetchMetadata without requiring source-community membership.
 * The allowCloning flag is a provider hint for deciding whether to attempt a clone, not proof of access to either community.
 * This is not the full community-owned sticker or emoji management record
 *
 * @category Emoji and stickers
 */
export interface ExpressionMetadata extends GuildEmoji {
    /** Provider's current cloning hint, not authorization or a guarantee that a later clone will succeed */
    readonly allowCloning: boolean
}

/** Upload an image as a named custom community emoji for messages and reactions.
 * Supply encoded image bytes, because the SDK does not read a file or fetch an image URL
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
 *
 * @category Emoji and stickers
 */
export interface EmojiCreate {
    /** 2–32 ASCII letters, digits or underscores */
    readonly name: string
    /** Base64 image data or an image data URI, at most 512 KiB decoded.
     * Fluxer validates the actual format, dimensions, moderation and community capacity.
     * No file is read implicitly. Callers own encoding and the lifetime of their original bytes
     */
    readonly image: string
}

/** Upload a named custom sticker with optional description and suggestion tags.
 * Supply image bytes as base64 or a data URI, as with EmojiCreate. Fluxer validates image format, dimensions,
 * moderation and community capacity after local input validation
 *
 * @category Emoji and stickers
 */
export interface StickerCreate {
    /** Sticker name, 2–30 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace trimming.
     * The original string is sent unchanged
     */
    readonly name: string
    /** Omitted/null means no description. Otherwise the value must contain 1–500 normalized UTF-16 code units.
     * Validation removes U+000C and U+202E and trims surrounding whitespace. The original string is sent unchanged
     */
    readonly description?: string | null
    /** Up to ten tags of 1–30 normalized UTF-16 code units each. Omitted means empty. Validation removes U+000C and
     * U+202E and trims surrounding whitespace without changing the strings sent. Entries are copied by index when the operation starts
     */
    readonly tags?: readonly string[]
    /** Base64 image data or image data URI, at most 512 KiB decoded */
    readonly image: string
}

/**
 * Rename an emoji without replacing its image
 *
 * @category Emoji and stickers
 */
export interface EmojiEdit {
    /** Replacement name, 2–32 ASCII letters, digits or underscores */
    readonly name: string
}

/** Replace sticker metadata without reading or merging remote state. Images cannot be replaced.
 * A fetched sticker can be spread into this input. Its matching identity and animation fields are ignored
 *
 * @category Emoji and stickers
 */
export interface StickerEdit {
    /** Required replacement name, 2–30 normalized UTF-16 code units. Validation removes U+000C and U+202E and
     * trims surrounding whitespace without changing the string sent
     */
    readonly name: string
    /** Required replacement description, 1–500 normalized UTF-16 code units. Empty/null clears it. Validation removes
     * U+000C and U+202E and trims surrounding whitespace without changing a nonempty string sent
     */
    readonly description: string | null
    /** Required replacement list, at most ten tags of 1–30 normalized UTF-16 code units. [] clears it. Validation
     * removes U+000C and U+202E and trims surrounding whitespace without changing the strings sent. Entries are copied by index when the operation starts
     */
    readonly tags: readonly string[]
}

/** Results of creating emoji or stickers in one batch request.
 * Inspect both lists even when the HTTP request succeeded. Entries in success were created independently of
 * failures, so repeating the whole batch can duplicate successful creations. Provider order does not map failures
 * back to input positions when names repeat
 *
 * @category Emoji and stickers
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

/** Choose whether deleting a community emoji or sticker also requests removal of its image asset.
 * The inherited timeout and auditReason follow ModerationOptions.
 * Removing the image is a separate queued job. Deleting the community entry does not wait for it to finish
 *
 * @category Options
 */
export interface ExpressionDeleteOptions extends ModerationOptions {
    /** False/default removes the community entry without asking to purge its image.
     * True additionally requests irreversible queued asset/CDN removal and requires Fluxer's expression-purge feature.
     * HTTP success does not mean the purge job has finished. Failure after dispatch can leave either effect applied
     */
    readonly purge?: boolean
}

/**
 * Starts immediately. Cancellation awaits cleanup but cannot undo deletion or queued purging
 *
 * @category Options
 */
export interface DefaultExpressionDeleteOptions extends ExpressionDeleteOptions, DefaultModerationOptions {}

/** Public presentation of the community that owns a custom emoji or sticker, returned by fetchSource.
 * Fluxer returns it for a public source community, or for a private one the bot is a member of. It is a frozen snapshot with
 * no member, channel or permission data, and reading it grants no access to the community or the expression
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export async function sourceBadgeExample(client: Client, emojiId: string) {
 *     const source = await client.emojis.fetchSource(emojiId)
 *     return source.map((guild) => `${guild.name}${guild.features.includes("VERIFIED") ? " (verified)" : ""}`)
 * }
 * ```
 *
 * @category Emoji and stickers
 */
export interface ExpressionSourceGuild {
    /** Source guild ID as a decimal string */
    readonly id: string
    /** Source community name at the time of the read */
    readonly name: string
    /** Icon hash of the source community, or null when it has no icon. Build an image URL with the asset helpers */
    readonly icon: string | null
    /** Badge features in provider order. Fluxer currently limits them to VERIFIED, PARTNERED and DISCOVERABLE.
     * A badge string added by Fluxer later is retained unchanged rather than failing the read, so compare against known names
     */
    readonly features: readonly string[]
}
