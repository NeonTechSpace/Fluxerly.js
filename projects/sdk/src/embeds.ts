/** A card for a message's `embeds` array, with optional text, images and named sections.
 * Message operations reject unknown keys and null values locally
 *
 * Sends, replies, channel message edits and webhook sends check an empty string like any other value. A webhook
 * message edit differs, because Fluxer treats an empty string there as absent everywhere except in fields, so the SDK
 * sends it as given. There an author with an empty name, a footer with empty text, or an image or thumbnail with an
 * empty url is dropped together with its other values, which the SDK then sends unchecked, and an embed whose values
 * are all empty text fails locally with reason input and path embeds[], since Fluxer refuses it. A color or a fields
 * list, even an empty one, keeps such an embed
 *
 * Text length limits count UTF-16 code units, the units used by JavaScript string length. For validation, the SDK removes
 * U+000C and U+202E and trims surrounding whitespace. It sends the original text unchanged
 *
 * URLs must use HTTP/HTTPS, carry no credentials such as user:pass@, and contain 1 through 2048 characters after the same
 * normalization as text, so surrounding whitespace does not count. As in hosted Fluxer, the host must be an IP address or a
 * domain name with a top-level domain, such as example.com, so a host such as localhost fails locally with reason input.
 * A client for a custom instance skips only the top-level domain rule locally and leaves it to that server, which skips
 * it in development mode. The original value is sent unchanged. Image and thumbnail
 * URLs may use attachment://filename instead, where the prefix and filename are read after that normalization.
 * The filename must exactly and case-sensitively equal the name Fluxer stores for a new upload in the same send, reply or
 * edit. When several uploads share that stored name, Fluxer puts the last of them into the embed. Fluxer stores an upload under a cleaned name: Spaces become underscores, a slash becomes an underscore,
 * runs of dots become one dot, and characters outside letters, marks, numbers, underscores, dots and hyphens are dropped.
 * So an upload named "my photo.png" is referenced as attachment://my_photo.png. A Windows device name such as CON before
 * the first dot gets a leading underscore. The stored extension must map to an image or video MIME type in Fluxer's
 * filename lookup, such as PNG, AVIF, MP4 or WebM
 *
 * An edit that omits attachments, including every webhook message edit, may instead name a file the message already
 * has, as Fluxer resolves it, which moves that file into the embed. Fluxer checks that the name exists and refuses an
 * unknown one with reason rejected. An edit that sends an attachments list can name only the files that list names,
 * which this SDK sends only for new uploads
 *
 * The SDK does not look up existing attachments, so an existing attachment ID kept in an attachments list cannot supply
 * an attachment URL.
 * Fluxer moves referenced uploads into embed media, so they are not returned in the message's attachment list
 *
 * Fluxer also limits the combined text of all embeds in one message to 6,000 UTF-16 code units: Every title, description,
 * footer text, author name, field name and field value counts, measured after normalization. Some bots receive a higher
 * limit, so the SDK does not check this locally. A message over the limit fails remotely with reason rejected and an
 * apiError with code invalidFormBody, so shorten long text, for example with `text.truncate`, or send fewer embeds
 *
 * Fluxer fetches remote media and may normalize text. Permissions and instance-specific limits remain server-owned
 * @example
 * ```ts
 * import type { EmbedInput } from "@neontechspace/fluxerly"
 *
 * export const exampleEmbed = {
 *     title: "Build finished",
 *     description: "Checks passed",
 *     url: "https://example.com/builds/42",
 *     color: 0x3d66b8,
 *     timestamp: "2026-09-08T14:30:00.000Z",
 *     author: { name: "Build service", url: "https://example.com", iconUrl: "https://example.com/author.png" },
 *     footer: { text: "Build #42", iconUrl: "https://example.com/footer.png" },
 *     image: { url: "https://example.com/results.png", description: "Build results" },
 *     thumbnail: { url: "https://example.com/icon.png", description: "Project icon" },
 *     fields: [{ name: "Status", value: "Passed", inline: true }, { name: "Details", value: "" }],
 * } satisfies EmbedInput
 * ```
 * Pass this object in the embeds array of send, reply or edit. The example URLs are placeholders
 *
 * @category Messages
 */
export interface EmbedInput {
    /** Heading text, up to 256 normalized UTF-16 code units. Supply url to make it a link */
    readonly title?: string
    /** Main body text. An empty string is omitted by Fluxer. A nonempty value must contain 1–4,096 normalized UTF-16 code units */
    readonly description?: string
    /** Destination URL for the title. In a webhook message edit, an empty string counts as absent */
    readonly url?: string
    /** RGB integer from 0x000000 through 0xffffff */
    readonly color?: number
    /** Time shown with the embed, an ISO 8601 string with a timezone such as `new Date().toISOString()`.
     * Invalid calendar dates are rejected locally. In a webhook message edit, an empty string counts as absent
     */
    readonly timestamp?: string
    /** Author label and optional links */
    readonly author?: EmbedAuthorInput
    /** Footer label and optional icon */
    readonly footer?: EmbedFooterInput
    /** Full-size HTTP(S) image or attachment://filename for one same-message uploaded image or video */
    readonly image?: EmbedMediaInput
    /** Small HTTP(S) image or attachment://filename for one same-message uploaded image or video */
    readonly thumbnail?: EmbedMediaInput
    /** Up to 25 named sections, in display order. Entries are copied by index when the operation starts */
    readonly fields?: readonly EmbedFieldInput[]
}

/**
 * Label above the embed body, with optional links for its name and icon
 *
 * @category Messages
 */
export interface EmbedAuthorInput {
    /** Required author name, 1–256 normalized UTF-16 code units. In a webhook message edit, an empty string makes
     * Fluxer drop the whole author, including url and iconUrl
     */
    readonly name: string
    /** Destination for the author label. In a webhook message edit, an empty string counts as absent */
    readonly url?: string
    /** HTTP(S) icon URL without credentials, 1 through 2048 characters after normalization. Attachment URLs are not accepted here. In a webhook message edit, an
     * empty string counts as absent
     */
    readonly iconUrl?: string
}

/**
 * Text beneath the embed body, with an optional icon
 *
 * @category Messages
 */
export interface EmbedFooterInput {
    /** Required footer text, 1–2,048 normalized UTF-16 code units. In a webhook message edit, an empty string makes
     * Fluxer drop the whole footer, including iconUrl
     */
    readonly text: string
    /** HTTP(S) icon URL without credentials, 1 through 2048 characters after normalization. Attachment URLs are not accepted here. In a webhook message edit, an
     * empty string counts as absent
     */
    readonly iconUrl?: string
}

/** Media for an image or thumbnail field in a rich card. Use an HTTP(S) image URL or attachment://filename for a new image or video uploaded with the same message, where the filename is the name Fluxer stores the upload under.
 * The SDK neither uploads through this object nor fetches remote or retained attachment bytes
 *
 * @category Messages
 */
export interface EmbedMediaInput {
    /** Required HTTP(S) image URL or attachment://filename naming an uploaded image or video for image and thumbnail fields.
     * In a webhook message edit, an empty string makes Fluxer drop the whole image or thumbnail, including description
     */
    readonly url: string
    /** Optional description for readers who cannot see the media, 1–4,096 normalized UTF-16 code units. In a webhook
     * message edit, an empty string counts as absent
     */
    readonly description?: string
}

/**
 * One heading and body pair within an embed, such as a Status field with value Passed
 *
 * @category Messages
 */
export interface EmbedFieldInput {
    /** Required heading, 0–256 normalized UTF-16 code units. An empty string sends a field without a heading */
    readonly name: string
    /** Required body, 0–1,024 normalized UTF-16 code units. An empty string sends a field without a body */
    readonly value: string
    /** Request side-by-side display when space permits. Defaults to false */
    readonly inline?: boolean
}

/**
 * Author information received with a message. The object is frozen, missing or null server fields become omitted properties
 *
 * @category Messages
 */
export interface EmbedAuthor {
    /** Server-provided label */
    readonly name: string
    /** Destination for the label */
    readonly url?: string
    /** Original icon URL */
    readonly iconUrl?: string
    /** Icon URL served through Fluxer's media proxy, when supplied */
    readonly proxyIconUrl?: string
}

/**
 * Preview-provider information received with a message, such as the site a link preview came from.
 * Fluxer supplies only a name and a link, so unlike an author, a provider has no icon.
 * The object is frozen, missing or null server fields become omitted properties
 *
 * @category Messages
 */
export interface EmbedProvider {
    /** Server-provided label */
    readonly name: string
    /** Destination for the label */
    readonly url?: string
}

/**
 * Footer information received with a message. The object is frozen, missing or null server fields become omitted properties
 *
 * @category Messages
 */
export interface EmbedFooter {
    /** Server-provided label */
    readonly text: string
    /** Original icon URL */
    readonly iconUrl?: string
    /** Icon URL served through Fluxer's media proxy, when supplied */
    readonly proxyIconUrl?: string
}

/** Information about an embed image, video or audio file, not downloaded bytes.
 * The object is frozen, missing or null server fields become omitted properties. Reading these fields does not download or play media
 *
 * @category Messages
 */
export interface EmbedMedia {
    /** Original media location */
    readonly url: string
    /** Media URL served through Fluxer's media proxy, when supplied */
    readonly proxyUrl?: string
    /** Media type such as image/png, when known */
    readonly contentType?: string
    /** Server's identifier for the media contents. The SDK does not verify it against downloaded bytes */
    readonly contentHash?: string
    /** Width in pixels */
    readonly width?: number
    /** Height in pixels */
    readonly height?: number
    /** Alternative text when provided */
    readonly description?: string
    /** Base64 placeholder supplied by Fluxer, not decoded by the SDK */
    readonly placeholder?: string
    /** Duration in seconds */
    readonly duration?: number
    /** Platform media bits: Explicit media is `1 << 4` and animated media is `1 << 5`. Unknown bits are kept as received.
     * Fluxer leaves flags out of media stored without them, which reads as 0
     */
    readonly flags: number
}

/**
 * A heading and body pair received within an embed. This object is frozen
 *
 * @category Messages
 */
export interface EmbedField {
    /** Server-provided heading */
    readonly name: string
    /** Server-provided body */
    readonly value: string
    /** Whether inline display was requested */
    readonly inline: boolean
}

/** One received card or link preview, without its optional child previews.
 * This frozen object cannot be changed. Missing or null server fields are omitted.
 * Use `EmbedInput` to send a card. A received card can include server-generated fields, but unknown fields are omitted
 *
 * @category Messages
 */
export interface EmbedChild {
    /** Server-provided type, including types unknown to this SDK */
    readonly type: string
    /** Linked title */
    readonly title?: string
    /** Body text */
    readonly description?: string
    /** Destination URL */
    readonly url?: string
    /** Server-provided color integer */
    readonly color?: number
    /** Server-provided ISO timestamp string */
    readonly timestamp?: string
    /** Author metadata */
    readonly author?: EmbedAuthor
    /** Footer metadata */
    readonly footer?: EmbedFooter
    /** Full-size image metadata */
    readonly image?: EmbedMedia
    /** Thumbnail metadata */
    readonly thumbnail?: EmbedMedia
    /** Frozen named sections in received order */
    readonly fields?: readonly EmbedField[]
    /** Preview provider metadata */
    readonly provider?: EmbedProvider
    /** Video metadata, not a playable SDK resource */
    readonly video?: EmbedMedia
    /** Audio metadata, not a playable SDK resource */
    readonly audio?: EmbedMedia
    /** Preview HTML supplied by Fluxer. The SDK does not render or sanitize it. Treat it as untrusted when displaying it on a page */
    readonly html?: string
    /** Preferred HTML preview width in pixels */
    readonly htmlWidth?: number
    /** Preferred HTML preview height in pixels */
    readonly htmlHeight?: number
    /** Whether Fluxer marks the embed as NSFW */
    readonly nsfw?: boolean
}

/** A rich card or generated link preview received with a message, including any child preview.
 * This object is frozen, but later message observations may contain different media-processing results
 *
 * @category Messages
 */
export interface Embed extends EmbedChild {
    /** At most one server-generated child, with no further nesting */
    readonly children?: readonly EmbedChild[]
}
