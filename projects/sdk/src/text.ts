import { err, ok, type Result } from "neverthrow"
import { HelperError, valueOrThrow } from "./helpers.js"

/**
 * Choose the largest piece `text.split` may return. Supply a limit explicitly. This helper does not discover a server's message limit
 *
 * @category Builders and formatting
 */
export interface TextSplitOptions {
    /** Maximum `string.length` of each piece, a positive safe integer with no default. Most emoji count as two or more units, and a piece can be shorter when a visible character would otherwise be cut */
    readonly maxLength: number
}

/**
 * Choose where `text.truncate` cuts and what it appends. Supply the limit explicitly. This helper does not discover a server's message limit
 *
 * @category Builders and formatting
 */
export interface TextTruncateOptions {
    /** Maximum `string.length` of the result including the suffix, a positive safe integer with no default. Most emoji count as two or more units, and the result can be shorter when a visible character would otherwise be cut, down to the suffix alone */
    readonly maxLength: number
    /** Text appended after a cut, a well-formed string of at most maxLength units. Defaults to "…" (U+2026). Pass "" for a hard cut */
    readonly suffix?: string
}

/**
 * Methods of the text helper, which splits and truncates long strings
 *
 * @category Builders and formatting
 */
export type TextHelpers = Readonly<{
    /**
     * Split text into a frozen array of pieces, each with `string.length` at most `options.maxLength` UTF-16 units.
     * Prefer the last newline within a full piece, then the last whitespace, otherwise split a long word.
     * Whitespace stays in the preceding piece, so joining with an empty separator reconstructs the exact input.
     * Empty text gives []
     *
     * No trimming, prefix or suffix insertion, Markdown repair, message-length lookup or remote request occurs.
     * Every piece ends at a grapheme boundary of `Intl.Segmenter`, so a visible character stays whole: The two UTF-16 units of a single Unicode code point,
     * a base character with its combining marks, a flag, a skin-tone emoji, a joined emoji and "\r\n" are never separated.
     * A piece can therefore be shorter than maxLength. Only a single character longer than maxLength is cut, between code points.
     * Throws HelperError for invalid text or options, lone surrogates, or a ceiling too small for a surrogate pair.
     * Input and returned pieces are application-owned, and result size is proportional to the supplied text
     */
    split(content: string, options: TextSplitOptions): readonly string[]
    /**
     * Shorten text to at most `options.maxLength` UTF-16 units, ending in `options.suffix` when anything was cut.
     * Text that already fits is returned unchanged. Otherwise the text is cut so that the kept text and the suffix together fit,
     * at a grapheme boundary of `Intl.Segmenter`, so only whole visible characters are kept:
     * The two UTF-16 units of a single Unicode code point, a base character with its combining marks, a flag, a skin-tone emoji
     * and a joined emoji are never separated, which can leave the result shorter than maxLength.
     * When the first character does not fit in the room before the suffix, or no room is left, the suffix alone is returned.
     * The suffix defaults to "…" (U+2026), and a suffix of "" cuts without marking it.
     *
     * No trimming, word boundary, Markdown repair, message-length lookup or remote request occurs.
     * To cut at a word boundary instead, take the first piece of `text.split` with a limit that leaves room for the suffix, and trim its end.
     * Throws HelperError for text that is not a string or has lone surrogates, so call `content.toWellFormed()` first for untrusted input.
     * Also throws HelperError for options that are not an object with only maxLength and suffix, a maxLength that is not a
     * positive safe integer, or a suffix that is not a well-formed string of at most maxLength units
     */
    truncate(content: string, options: TextTruncateOptions): string
}>

/** Break long text into smaller strings, or shorten it, for later sending or display. No message is sent.
 * The split and truncate methods return their result directly and throw HelperError for invalid text or options
 */
export const text: TextHelpers = Object.freeze({
    split: (content: string, options: TextSplitOptions): readonly string[] => valueOrThrow(splitText(content, options)),
    truncate: (content: string, options: TextTruncateOptions): string => valueOrThrow(truncateText(content, options)),
})

/** Finds the grapheme (user-perceived character) that contains a UTF-16 index, which text.truncate and text.split cut between */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Shorten text with the public truncate rules, returning invalid input as an Err */
function truncateText(content: string, options: TextTruncateOptions): Result<string, HelperError> {
    if (
        typeof options !== "object" ||
        options === null ||
        Array.isArray(options) ||
        Object.keys(options).some((key) => key !== "maxLength" && key !== "suffix") ||
        !Number.isSafeInteger(options.maxLength) ||
        options.maxLength <= 0
    )
        return err(new HelperError("text.truncate", "limit"))
    const suffix = options.suffix === undefined ? "…" : options.suffix
    if (typeof suffix !== "string" || !suffix.isWellFormed() || suffix.length > options.maxLength)
        return err(new HelperError("text.truncate", "limit"))
    if (typeof content !== "string" || !content.isWellFormed()) return err(new HelperError("text.truncate", "text"))
    if (content.length <= options.maxLength) return ok(content)
    let end = options.maxLength - suffix.length
    // Cut at the last grapheme boundary within the room, which is 0 when the first grapheme does not fit
    if (end > 0) end = graphemes.segment(content).containing(end)!.index
    return ok(content.slice(0, end) + suffix)
}

/** Split text with the public split rules, returning invalid input as an Err for SDK callers that map it to their own error */
export function splitText(content: string, options: TextSplitOptions): Result<readonly string[], HelperError> {
    if (
        typeof options !== "object" ||
        options === null ||
        Array.isArray(options) ||
        Object.keys(options).some((key) => key !== "maxLength") ||
        !Number.isSafeInteger(options.maxLength) ||
        options.maxLength <= 0
    )
        return err(new HelperError("text.split", "limit"))
    if (typeof content !== "string" || !content.isWellFormed()) return err(new HelperError("text.split", "text"))
    const chunks: string[] = []
    const segments = graphemes.segment(content)
    // The end of text and the start of a grapheme are boundaries, and an index inside a grapheme is not
    const isBoundary = (index: number): boolean =>
        index >= content.length || segments.containing(index)!.index === index
    // The end of the single grapheme that is being cut between code points, so that its pieces need no further lookup
    let clusterEnd = 0
    for (let start = 0; start < content.length;) {
        let end = Math.min(start + options.maxLength, content.length)
        if (end < content.length) {
            // Cut at the last grapheme boundary after the start. If there is none, cut between code points so the split
            // advances, which fails when not even one code point fits
            let cutInside = end < clusterEnd
            if (!cutInside) {
                const cluster = segments.containing(end)!
                if (cluster.index > start) end = cluster.index
                else {
                    cutInside = true
                    clusterEnd = cluster.index + cluster.segment.length
                }
            }
            if (cutInside && isHighSurrogate(content.charCodeAt(end - 1))) end -= 1
        }
        if (end === start) return err(new HelperError("text.split", "limit"))
        if (end < content.length) {
            let wordEnd = 0
            let lineEnd = 0
            for (let index = end - 1; index >= start; index -= 1) {
                // A line feed always ends a grapheme. Other whitespace does not when a combining mark follows it, nor does a carriage return before a line feed
                if (content[index] === "\n") {
                    lineEnd = index + 1
                    break
                }
                if (wordEnd === 0 && /\s/u.test(content[index]!) && isBoundary(index + 1)) wordEnd = index + 1
            }
            end = lineEnd || wordEnd || end
        }
        chunks.push(content.slice(start, end))
        start = end
    }
    return ok(Object.freeze(chunks))
}

function isHighSurrogate(unit: number): boolean {
    return unit >= 0xd800 && unit <= 0xdbff
}
