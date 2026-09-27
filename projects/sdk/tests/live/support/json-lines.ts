/** A parsed JSON-lines record printed by a live harness or its test fixture */
export type JsonLine = Readonly<Record<string, unknown>>

/**
 * Parses every output line that holds one JSON object, in output order. Harnesses print their reports and failures
 * this way, so tests assert on stable fields such as `check`, `stage` and `passed` instead of key order or prose
 */
export function jsonLines(output: string): JsonLine[] {
    return output.split(/\r?\n/).flatMap((line) => {
        const text = line.trim()
        if (!text.startsWith("{")) return []
        try {
            const value: unknown = JSON.parse(text)
            return value !== null && typeof value === "object" && !Array.isArray(value) ? [value as JsonLine] : []
        } catch {
            return []
        }
    })
}
