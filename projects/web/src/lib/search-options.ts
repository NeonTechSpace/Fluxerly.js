import { isTestingReferenceUrl } from "../../scripts/reference-entries.js"

// The engine returns more entries than the dialog shows, so ordering can promote a dedicated page
// that full-text relevance placed further down
const candidates = 240
const shown = 60

// Shared by the search dialog and the search precision check, so the check measures real behavior.
// One edit of typo tolerance finds names such as createClient from a single missing letter
export const searchOptions = { tolerance: 1, limit: candidates }

interface Result {
    type: string
    content: unknown
    url: string
    breadcrumbs?: unknown[]
}

const plain = (content: unknown) =>
    String(content)
        .replace(/<[^>]*>/g, "")
        .trim()

// Letters and digits only, so createClient, "create client" and "Where do I…?" compare by their words
const compact = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")

const stopWords = new Set(["a", "an", "and", "the", "to", "of", "in", "on", "for", "with", "by", "or", "is", "it", "do", "i", "how"])

// Lowercase words without a plural "s", so a title with "commands" answers "command"
const words = (text: string) =>
    text
        .split(/[^\p{L}\p{N}]+/u)
        .map((word) => word.toLowerCase())
        .filter((word) => word && !stopWords.has(word))
        .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word))

// Identifier parts, so RateLimitError answers "rate limit"
const identifierWords = (text: string) => words(text.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2"))

const containsAll = (wanted: string[], available: string[]) => wanted.length > 0 && wanted.every((word) => available.includes(word))

const pagePath = (url: string) => /^\/docs\/[^/]+\/?([^#?]*)/.exec(url)?.[1]?.replace(/\/$/, "")

// Landing, index, glossary, FAQ, example and code list pages route readers onward, so the dedicated page answers first
const hubPaths = new Set(["", "api", "api/tasks", "changelog", "where-do-i", "faq", "glossary", "examples", "error-and-log-codes"])
const isHubUrl = (url: string) => hubPaths.has(pagePath(url) ?? "\0")

// Effect guides are the optional path after the default API guides
const isEffectGuideUrl = (url: string) => (pagePath(url) ?? "").startsWith("effect-")

// Effect entry points repeat most default API symbols under the same names,
// and name command types Native<Name> where the default API uses Default<Name>
const effectEntryPoints: Record<string, string> = { Effect: "js-ts", "Effect-testing": "testing" }
function defaultTwins(url: string): string[] {
    const match = /^(.*\/api\/(?:modules\/|[a-z]+\/))(Effect(?:-testing)?)([.#/]|$)(.*)$/.exec(url)
    if (!match) return []
    const prefix = `${match[1]}${effectEntryPoints[match[2]!]}${match[3]}`
    const name = match[4]!
    const native = /^native(?=\w)/i.exec(name)?.[0]
    return [`${prefix}${name}`, ...(native ? [`${prefix}${native === "Native" ? "Default" : "default"}${name.slice(native.length)}`] : [])]
}

const isReferenceUrl = (url: string) => (pagePath(url) ?? "").startsWith("api/")

const fragment =(url: string) => decodeURIComponent(url.split("#")[1] ?? "").toLowerCase()

// Match strength, strongest first
const Match = { Title: 0, TitleWords: 1, Heading: 2, TitleParts: 3, HeadingWords: 4, Text: 5 } as const
type Match = (typeof Match)[keyof typeof Match]

/**
 * Order page groups for the search dialog.
 * A group whose page title or sidebar label equals the query comes first, so an exact symbol or page name opens that page.
 * `Owner.member` queries treat the owner's page with that member as exact.
 * Other groups follow by match strength: every query word in the title or label, a heading equal to the query,
 * every query word in an identifier title such as RateLimitError, every query word in a heading, then text only.
 * Among identifier titles, the one with the fewest characters beyond the query comes first, so RateLimitError answers
 * "rate limit" before RateLimitObservation.
 * For a query of several words, a guide heading containing every word counts as a heading equal to the query,
 * and guides come before reference pages of equal strength.
 * Landing, index, glossary, FAQ and example pages rise only by an exact title and follow dedicated pages of equal strength.
 * Effect guides follow other guides of equal strength unless the query names Effect.
 * Testing entry point groups follow the other matches unless their title is exact.
 * Groups of equal rank keep the search engine's order
 */
export function rankResults<T extends Result>(query: string, results: T[]): T[] {
    const wanted = compact(query)
    if (!wanted) return results
    const queryWords = words(query)
    // Several words describe a task, which a guide section answers before a symbol that shares one of the words
    const taskQuery = queryWords.length > 1
    const effectQuery = queryWords.includes("effect")
    const qualified = /^[\w$]+(?:\.[\w$]+)+$/.test(query.trim()) ? query.trim().split(".").slice(-2) : undefined
    const groups: T[][] = []
    for (const result of results) {
        if (result.type === "page" || groups.length === 0) groups.push([result])
        else groups.at(-1)!.push(result)
    }
    const labelOf = (page: T) => (page.type === "page" && page.breadcrumbs?.length ? plain(page.breadcrumbs.at(-1)) : undefined)
    const strength = (group: T[], hub: boolean): Match => {
        const page = group[0]!
        if (page.type !== "page") return Match.Text
        const title = plain(page.content)
        const titles = [title, labelOf(page)].filter((text) => text !== undefined)
        if (titles.some((text) => compact(text) === wanted)) return Match.Title
        if (qualified && compact(title) === compact(qualified[0]!) && group.some((entry) => fragment(entry.url) === qualified[1]!.toLowerCase()))
            return Match.Title
        const headings = group.filter((entry) => entry.type === "heading").map((entry) => plain(entry.content))
        if (!hub) {
            if (titles.some((text) => containsAll(queryWords, words(text)))) return Match.TitleWords
            if (headings.some((heading) => compact(heading) === wanted)) return Match.Heading
            // A guide section naming every query word answers a task phrasing as well as an exact member heading
            if (taskQuery && !isReferenceUrl(page.url) && headings.some((heading) => containsAll(queryWords, words(heading)))) return Match.Heading
            if (containsAll(queryWords, identifierWords(title))) return Match.TitleParts
        }
        if (headings.some((heading) => containsAll(queryWords, words(heading)))) return Match.HeadingWords
        return Match.Text
    }
    const ranked = groups.map((group, index) => {
        const url = group[0]!.url
        const hub = isHubUrl(url)
        const match = strength(group, hub)
        const testing = match !== Match.Title && isTestingReferenceUrl(url)
        const label = labelOf(group[0]!)
        // The page row shows its sidebar label, so the label's searchable copy is not repeated
        const entries = label === undefined ? group : group.filter((entry, position) => position === 0 || entry.type !== "text" || entry.url !== url || plain(entry.content) !== label)
        const extra = match === Match.TitleParts ? compact(plain(group[0]!.content)).length - wanted.length : 0
        return { entries, key: [testing ? 1 : 0, match, extra, hub ? 1 : 0, taskQuery && isReferenceUrl(url) ? 1 : 0, !effectQuery && isEffectGuideUrl(url) ? 1 : 0, index] }
    })
    ranked.sort((a, b) => {
        for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i]! - b.key[i]!
        return 0
    })
    // The default API form of a symbol takes the place of its Effect twin when that ranked first
    const positions = new Map(ranked.map((item, position) => [item.entries[0]!.url, position]))
    for (const [position, item] of ranked.entries()) {
        const twin = defaultTwins(item.entries[0]!.url).map((url) => positions.get(url)).find((found) => found !== undefined)
        if (twin === undefined || twin < position) continue
        ranked[position] = ranked[twin]!
        ranked[twin] = item
        positions.set(ranked[position]!.entries[0]!.url, position)
        positions.set(item.entries[0]!.url, twin)
    }
    return ranked.flatMap(({ entries }) => entries).slice(0, shown)
}
