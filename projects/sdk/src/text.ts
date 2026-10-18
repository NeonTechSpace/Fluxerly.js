import { err, ok, type Result } from "neverthrow"
import { HelperError, valueOrThrow } from "./helpers.js"

/**
 * Choose the largest piece `text.split` may return. Supply a limit explicitly. This helper does not discover a server's message limit
 *
 * @category Builders and formatting
 */
export interface TextSplitOptions {
    /** Maximum `string.length` of each piece, a positive safe integer with no default. Most emoji count as two or more units */
    readonly maxLength: number
}

/**
 * Choose where `text.truncate` cuts and what it appends. Supply the limit explicitly. This helper does not discover a server's message limit
 *
 * @category Builders and formatting
 */
export interface TextTruncateOptions {
    /** Maximum `string.length` of the result including the suffix, a positive safe integer with no default. Most emoji count as two or more units */
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
     * The two UTF-16 units of a single Unicode code point stay together.
     * A visible character made of multiple code points, such as a base character with combining marks or a joined emoji, may still be split.
     * Throws HelperError for invalid text or options, lone surrogates, or a ceiling too small for a surrogate pair.
     * Input and returned pieces are application-owned, and result size is proportional to the supplied text
     */
    split(content: string, options: TextSplitOptions): readonly string[]
    /**
     * Shorten text to at most `options.maxLength` UTF-16 units, ending in `options.suffix` when anything was cut.
     * Text that already fits is returned unchanged. Otherwise the text is cut so that the kept text and the suffix together fit,
     * and the two UTF-16 units of a single Unicode code point are never separated, which can leave the result one unit shorter.
     * When no room is left for text before the suffix, the suffix alone is returned.
     * The suffix defaults to "…" (U+2026), and a suffix of "" cuts without marking it.
     *
     * No trimming, word boundary, Markdown repair, message-length lookup or remote request occurs.
     * A visible character made of multiple code points, such as a base character with combining marks or a joined emoji, may still be cut.
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
    // The text is well formed and longer than the limit, so a high surrogate before the cut has its pair after it
    const previous = end > 0 ? content.charCodeAt(end - 1) : 0
    if (previous >= 0xd800 && previous <= 0xdbff) end -= 1
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
    for (let start = 0; start < content.length;) {
        let end = Math.min(start + options.maxLength, content.length)
        const previous = content.charCodeAt(end - 1)
        if (end < content.length && previous >= 0xd800 && previous <= 0xdbff) end -= 1
        if (end === start) return err(new HelperError("text.split", "limit"))
        if (end < content.length) {
            let wordEnd = 0
            let lineEnd = 0
            for (let index = end - 1; index >= start; index -= 1) {
                if (content[index] === "\n") {
                    lineEnd = index + 1
                    break
                }
                if (wordEnd === 0 && /\s/u.test(content[index]!)) wordEnd = index + 1
            }
            end = lineEnd || wordEnd || end
        }
        chunks.push(content.slice(start, end))
        start = end
    }
    return ok(Object.freeze(chunks))
}
