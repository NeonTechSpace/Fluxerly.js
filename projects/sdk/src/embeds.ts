/** Rich embed input, not a received preview. Unknown keys and null values are rejected locally.
 * String length limits count UTF-16 code units before server normalization.
 * URLs must use HTTP/HTTPS and contain at most 2048 characters; uploads and attachment URLs are not supported
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
 * Pass this object in the embeds array of send, reply or edit; the example URLs are placeholders
 */
export interface EmbedInput {
    /** Linked title, up to 256 characters */
    readonly title?: string
    /** Body text, up to 4096 characters. Empty text is omitted by Fluxer */
    readonly description?: string
    /** Destination URL for the title */
    readonly url?: string
    /** RGB integer from 0x000000 through 0xffffff */
    readonly color?: number
    /** ISO 8601 timestamp string with a timezone, not a Date or epoch number */
    readonly timestamp?: string
    /** Author label and optional links */
    readonly author?: EmbedAuthorInput
    /** Footer label and optional icon */
    readonly footer?: EmbedFooterInput
    /** Full-size remote image */
    readonly image?: EmbedMediaInput
    /** Small remote image */
    readonly thumbnail?: EmbedMediaInput
    /** Up to 25 named sections, in display order */
    readonly fields?: readonly EmbedFieldInput[]
}

/** Author supplied with a rich embed */
export interface EmbedAuthorInput {
    /** Required label, 1 through 256 characters */
    readonly name: string
    /** Destination for the author label */
    readonly url?: string
    /** Remote author icon */
    readonly iconUrl?: string
}

/** Footer supplied with a rich embed */
export interface EmbedFooterInput {
    /** Required label, 1 through 2048 characters */
    readonly text: string
    /** Remote footer icon */
    readonly iconUrl?: string
}

/** Remote image input; the SDK does not upload or fetch these bytes */
export interface EmbedMediaInput {
    /** Required HTTP/HTTPS image URL */
    readonly url: string
    /** Optional alternative text, 1 through 4096 characters */
    readonly description?: string
}

/** One named section, not an arbitrary embed property */
export interface EmbedFieldInput {
    /** Required heading, 1 through 256 characters */
    readonly name: string
    /** Required body, 0 through 1024 characters */
    readonly value: string
    /** Request side-by-side display when space permits. Defaults to false */
    readonly inline?: boolean
}

/** Frozen received author or provider. Optional null wire properties are omitted */
export interface EmbedAuthor {
    /** Server-provided label */
    readonly name: string
    /** Destination for the label */
    readonly url?: string
    /** Original icon URL */
    readonly iconUrl?: string
    /** Server-provided proxied icon URL */
    readonly proxyIconUrl?: string
}

/** Frozen received footer. Optional null wire properties are omitted */
export interface EmbedFooter {
    /** Server-provided label */
    readonly text: string
    /** Original icon URL */
    readonly iconUrl?: string
    /** Server-provided proxied icon URL */
    readonly proxyIconUrl?: string
}

/** Frozen received media metadata, not downloaded bytes. Optional null wire properties are omitted */
export interface EmbedMedia {
    /** Original media location */
    readonly url: string
    /** Server-provided proxied location */
    readonly proxyUrl?: string
    /** MIME type when known */
    readonly contentType?: string
    /** Server-provided content hash, with no SDK verification */
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
    /** Fluxer media bitfield, preserved without interpreting unknown bits */
    readonly flags: number
}

/** Frozen received named section */
export interface EmbedField {
    /** Server-provided heading */
    readonly name: string
    /** Server-provided body */
    readonly value: string
    /** Whether inline display was requested */
    readonly inline: boolean
}

/** Frozen received embed without nested children. Optional null wire properties are omitted.
 * This is a projection, not a send input or raw wire object; unknown wire properties are not exposed
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
    /** Specialized preview HTML supplied by Fluxer. The SDK neither renders nor sanitizes it */
    readonly html?: string
    /** Preferred HTML preview width in pixels */
    readonly htmlWidth?: number
    /** Preferred HTML preview height in pixels */
    readonly htmlHeight?: number
    /** Whether Fluxer marks the embed as NSFW */
    readonly nsfw?: boolean
}

/** Frozen received rich embed or generated preview; media processing may change later snapshots */
export interface Embed extends EmbedChild {
    /** At most one server-generated child, with no further nesting */
    readonly children?: readonly EmbedChild[]
}
