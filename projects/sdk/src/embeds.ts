/** A rich card to include in a message's embeds array, with optional text, images and named sections.
 * Message operations reject unknown keys and null values locally
 *
 * Length limits use JavaScript `string.length`, so some emoji count as multiple units, before the server changes any text
 *
 * URLs must use HTTP/HTTPS and contain at most 2048 characters, except image and thumbnail URLs may use attachment://filename.
 * An attachment URL must exactly and case-sensitively match one new PNG, JPG, JPEG, WEBP or GIF upload filename in the same send, reply or edit.
 * Its filename may contain letters, marks, numbers, underscores, dots and hyphens only
 *
 * The SDK does not fetch existing attachment metadata, so retained attachment IDs cannot supply an attachment URL.
 * Fluxer moves referenced uploads into embed media, so they are not returned in the message's attachment list
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
 */
export interface EmbedInput {
    /** Heading text, up to 256 `string.length` units. Supply url to make it a link */
    readonly title?: string
    /** Main body text, up to 4096 `string.length` units. Empty text is omitted by Fluxer */
    readonly description?: string
    /** Destination URL for the title */
    readonly url?: string
    /** RGB integer from 0x000000 through 0xffffff */
    readonly color?: number
    /** Time shown with the embed, an ISO 8601 string with a timezone such as `new Date().toISOString()`.
     * Invalid calendar dates are rejected locally
     */
    readonly timestamp?: string
    /** Author label and optional links */
    readonly author?: EmbedAuthorInput
    /** Footer label and optional icon */
    readonly footer?: EmbedFooterInput
    /** Full-size HTTP(S) image or attachment://filename for one same-message uploaded image */
    readonly image?: EmbedMediaInput
    /** Small HTTP(S) image or attachment://filename for one same-message uploaded image */
    readonly thumbnail?: EmbedMediaInput
    /** Up to 25 named sections, in display order. Entries are copied by index when the operation starts */
    readonly fields?: readonly EmbedFieldInput[]
}

/** Label above the embed body, with optional links for its name and icon */
export interface EmbedAuthorInput {
    /** Required author name, 1 through 256 `string.length` units */
    readonly name: string
    /** Destination for the author label */
    readonly url?: string
    /** HTTP(S) icon URL, at most 2048 characters. Attachment URLs are not accepted here */
    readonly iconUrl?: string
}

/** Text beneath the embed body, with an optional icon */
export interface EmbedFooterInput {
    /** Required footer text, 1 through 2048 `string.length` units */
    readonly text: string
    /** HTTP(S) icon URL, at most 2048 characters. Attachment URLs are not accepted here */
    readonly iconUrl?: string
}

/** An image or thumbnail to show in a rich card. Use an HTTP(S) URL or attachment://filename for a new image uploaded with the same message.
 * The SDK neither uploads through this object nor fetches remote or retained attachment bytes
 */
export interface EmbedMediaInput {
    /** Required HTTP(S) image URL or attachment://filename for image and thumbnail fields */
    readonly url: string
    /** Optional description for readers who cannot see the image, 1 through 4096 `string.length` units */
    readonly description?: string
}

/** One heading and body pair within an embed, such as a Status field with value Passed */
export interface EmbedFieldInput {
    /** Required heading, 1 through 256 `string.length` units */
    readonly name: string
    /** Required body, 0 through 1024 `string.length` units. An empty string is accepted */
    readonly value: string
    /** Request side-by-side display when space permits. Defaults to false */
    readonly inline?: boolean
}

/** Author or preview-provider information received with a message. The object is frozen, missing or null server fields become omitted properties */
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

/** Footer information received with a message. The object is frozen, missing or null server fields become omitted properties */
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
    /** Numeric Fluxer media flags, kept as received, including flags unknown to this SDK */
    readonly flags: number
}

/** A heading and body pair received within an embed. This object is frozen */
export interface EmbedField {
    /** Server-provided heading */
    readonly name: string
    /** Server-provided body */
    readonly value: string
    /** Whether inline display was requested */
    readonly inline: boolean
}

/** One received card or link preview, without its optional child previews.
 * This object is frozen, missing or null server fields become omitted properties.
 * Use EmbedInput for sending, this received shape includes server-generated fields and omits unknown server properties
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
    readonly provider?: EmbedAuthor
    /** Video metadata, not a playable SDK resource */
    readonly video?: EmbedMedia
    /** Audio metadata, not a playable SDK resource */
    readonly audio?: EmbedMedia
    /** Preview HTML supplied by Fluxer. The SDK does not render or sanitize it, do not treat it as safe HTML for your own page */
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
 */
export interface Embed extends EmbedChild {
    /** At most one server-generated child, with no further nesting */
    readonly children?: readonly EmbedChild[]
}
