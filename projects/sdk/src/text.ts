import { err, ok, type Result } from "neverthrow"
import { HelperError } from "./helpers.js"

/** Choose the largest piece `text.split` may return. Supply your own limit, this does not discover a server's message limit */
export interface TextSplitOptions {
    /** Maximum `string.length` of each piece, a positive safe integer with no default. Most emoji count as two or more units */
    readonly maxLength: number
}

/** Break long text into smaller strings before deciding how to send or display them. No message is sent */
export const text: Readonly<{
    /**
     * Return a Result containing a frozen array of strings, each with `string.length` at most `options.maxLength`
     *
     * Prefer the last newline within a full piece, then the last whitespace, otherwise split a long word.
     * Whitespace stays in the preceding piece, so joining with an empty separator reconstructs the exact input
     *
     * Empty text gives []. No trimming, prefix/suffix insertion, Markdown repair or remote request occurs
     *
     * The two UTF-16 units of a single Unicode code point stay together. A visible character made of multiple code points, such as a joined emoji, may still be split
     *
     * Invalid text/options, lone surrogates, or a ceiling too small for a surrogate pair fail with HelperError.
     * Input and returned pieces are application-owned. Result size is proportional to the supplied text
     */
    split(content: string, options: TextSplitOptions): Result<readonly string[], HelperError>
}> = Object.freeze({
    split(content: string, options: TextSplitOptions): Result<readonly string[], HelperError> {
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
    },
})
