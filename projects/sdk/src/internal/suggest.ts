/**
 * Typo suggestions shared by command names, event names and option keys.
 * Invariant: Suggestions only name known candidates and never echo rejected values beyond the misspelled name itself
 */
import { ConfigurationError } from "#sdk/errors"
import { readCaller } from "./defects.js"

/** Edit distance with adjacent transpositions counted as one edit (optimal string alignment), so swapping two
 * adjacent characters is one edit. Comparison is case-sensitive. Stops early and returns limit + 1 once every
 * alignment exceeds limit
 */
export function editDistance(left: string, right: string, limit = Number.POSITIVE_INFINITY): number {
    if (Math.abs(left.length - right.length) > limit) return limit + 1
    let before: number[] = []
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
    for (let row = 1; row <= left.length; row += 1) {
        const current = [row]
        let smallest = row
        for (let column = 1; column <= right.length; column += 1) {
            const cost = left[row - 1] === right[column - 1] ? 0 : 1
            let value = Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost)
            if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1])
                value = Math.min(value, before[column - 2]! + 1)
            current.push(value)
            smallest = Math.min(smallest, value)
        }
        if (smallest > limit) return limit + 1
        before = previous
        previous = current
    }
    return previous[right.length]!
}

/** The value of the candidate whose text is closest to wanted, within one edit when wanted has up to four characters and
 * two edits when longer, preferring the earliest candidate among equally close ones. Candidate text is compared as given,
 * so callers fold case first. Returns undefined when no candidate is that close
 */
export function closestMatch<T>(
    wanted: string,
    candidates: Iterable<readonly [text: string, value: T]>,
): T | undefined {
    const limit = wanted.length <= 4 ? 1 : 2
    let best: { readonly value: T; readonly distance: number } | undefined
    for (const [text, value] of candidates) {
        const distance = editDistance(wanted, text, limit)
        if (distance <= limit && (best === undefined || distance < best.distance)) best = { value, distance }
    }
    return best?.value
}

/**
 * The public `commands.suggest` rule: The first candidate closest to name, ignoring case, and undefined for an empty name.
 * Misuse throws ConfigurationError: A name that is not a string, candidates that are not an iterable of strings, or a
 * lone string as the candidates, which is almost always a forgotten array
 */
export function suggestName(name: unknown, candidates: unknown): string | undefined {
    if (typeof name !== "string") throw new ConfigurationError("commands", "The name to suggest for must be a string")
    // Reading the iterator method can run an application getter or proxy trap
    const iterable = readCaller(
        () =>
            typeof candidates === "object" &&
            candidates !== null &&
            typeof (candidates as Iterable<unknown>)[Symbol.iterator] === "function",
    )
    if (!iterable)
        throw new ConfigurationError("commands", "The candidates must be an iterable of strings, such as an array")
    const names: (readonly [string, string])[] = []
    for (const candidate of readCaller(() => [...(candidates as Iterable<unknown>)])) {
        if (typeof candidate !== "string") throw new ConfigurationError("commands", "Every candidate must be a string")
        names.push([candidate.toLowerCase(), candidate])
    }
    // No command has an empty name, so nothing is close to it
    return name === "" ? undefined : closestMatch(name.toLowerCase(), names)
}

/** A hint for an unsupported option key: The closest supported key when one is near, then the full supported list */
export function unsupportedKeyHint(key: string, supported: readonly string[], noun = "options"): string {
    const suggestion = key.length > 64 ? undefined : suggestName(key, supported)
    return `${suggestion === undefined ? "" : `Did you mean ${JSON.stringify(suggestion)}? `}Supported ${noun} are ${supported.join(", ")}`
}
