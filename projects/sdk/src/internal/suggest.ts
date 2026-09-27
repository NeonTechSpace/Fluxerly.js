/**
 * Typo suggestions shared by command names, event names and option keys.
 * Invariant: Suggestions only name known candidates and never echo rejected values beyond the misspelled name itself
 */

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

/** The first candidate closest to value, ignoring case, within one edit for names up to four characters and two edits
 * for longer names. Returns undefined when no candidate is that close
 */
function closestName(value: string, candidates: Iterable<string>): string | undefined {
    const wanted = value.toLowerCase()
    const limit = wanted.length <= 4 ? 1 : 2
    let best: { readonly name: string; readonly distance: number } | undefined
    for (const candidate of candidates) {
        const distance = editDistance(wanted, candidate.toLowerCase(), limit)
        if (distance <= limit && (best === undefined || distance < best.distance)) best = { name: candidate, distance }
    }
    return best?.name
}

/** A hint for an unsupported option key: The closest supported key when one is near, then the full supported list */
export function unsupportedKeyHint(key: string, supported: readonly string[], noun = "options"): string {
    const suggestion = key.length > 64 ? undefined : closestName(key, supported)
    return `${suggestion === undefined ? "" : `Did you mean ${JSON.stringify(suggestion)}? `}Supported ${noun} are ${supported.join(", ")}`
}
