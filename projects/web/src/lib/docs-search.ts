// Docs search: what Pagefind is asked for a query and how its pages are ranked and shown. The search dialog runs it, and
// scripts/checks/search.mjs runs the same code against the built index to measure how often the right page comes first

// The parts of Pagefind's browser API that search uses. The index is written next to the built site by `pagefind --site dist`
export interface PagefindModule {
    createInstance(options: PagefindOptions & { baseUrl?: string; noWorker?: boolean }): PagefindApi
}
export interface PagefindApi {
    init(): Promise<void>
    destroy(): Promise<void>
    // A null query finds every page that the filters let through
    search(query: string | null, options?: { filters?: Record<string, string | { any: string[] }> }): Promise<{ results: PagefindResult[] }>
    debouncedSearch(query: string, options?: object, timeout?: number): Promise<{ results: PagefindResult[] } | null>
}
export interface PagefindResult {
    id: string
    score: number
    // Where the query's words are on the page, the same as its data's locations
    words?: number[]
    data(): Promise<PagefindData>
}
export interface PagefindAnchor {
    element: string
    id: string
    text: string
    location: number
}
export interface PagefindData {
    url: string
    raw_content: string
    locations: number[]
    anchors: PagefindAnchor[]
    // search holds other words for the page's topic, joined with commas, from a guide's search front matter
    meta: { title?: string; group?: string; search?: string }
}
export interface Hit {
    url: string
    title: string
    section?: string
    group?: string
    excerpt: string
}

// How Pagefind weighs its matches. The dialog and the search check open the index with these
export interface PagefindOptions {
    ranking?: { termSimilarity?: number; pageLength?: number; termSaturation?: number; termFrequency?: number }
}
export const pagefindOptions: PagefindOptions = {}

// Words that join a query but say nothing about what to find. They need not match and are never highlighted
const stopWords = new Set(
    "a an and are as at be by can do does for from how i in is it its my of on or the this to was what when where which who why will with you your".split(" "),
)

// What Pagefind is asked for. It requires every word it is given, so a question loses the words that say nothing about
// what to find, unless nothing else is left
const retrievalText = (text: string) =>
    text
        .split(/\s+/)
        .filter((word) => !stopWords.has(word.toLowerCase()))
        .join(" ") || text

// Lowercase letters and digits only, the way Pagefind compares words
const bare = (word: string) => word.replace(/&lt;|&gt;|&amp;/g, " ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

// The words of a title or heading, with camelCase and dotted names split apart, so RateLimitError reads as rate limit error
const wordsOf = (text: string) =>
    text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)

// The longest phrase in a guide's search front matter, in words. A query's phrases up to this long are compared with them
export const aliasWords = 6

// A phrase from a guide's search front matter as the index files it and a query's phrase is compared with it: lowercase
// words joined by single spaces, so first bot, First Bot and first-bot are the same
export const aliasKey = (text: string) => wordsOf(text).join(" ")

interface Query {
    // Every word as typed, split the way titles are split
    words: string[]
    // The words that must match. A query of only stop words keeps them all
    keys: string[]
    // A dotted or camelCase name may match as its words instead, as the code guild.notFound is listed under guild.<reason>
    parts: Map<string, string[]>
    // A query that is one name as code writes it, such as client.closed or onError, as one word: clientclosed
    name?: string
    // That name as typed
    token?: string
}

// A method as code calls it, such as client.messages.send, is named in the reference without the client
const withoutClient = (text: string) => text.replace(/^\s*client\.(?=[\p{L}\p{N}_]+\.)/iu, "")

function parseQuery(text: string): Query {
    const words = wordsOf(text)
    const keys = words.filter((word) => !stopWords.has(word))
    // A dotted or camelCase name such as guild.create is also the one word Pagefind indexes, guildcreate
    const names = text.split(/\s+/).filter((word) => bare(word).length > 1 && !stopWords.has(bare(word)))
    const parts = new Map(names.map((name) => [bare(name), wordsOf(name).filter((word) => !stopWords.has(word))] as const).filter(([, split]) => split.length > 1))
    const token = text.trim()
    const name = /^[\p{L}\p{N}_.]+$/u.test(token) && /[\p{L}\p{N}]\.[\p{L}\p{N}]|[a-z][A-Z]|_/u.test(token) ? bare(token) : undefined
    return { words, keys: [...new Set([...(keys.length ? keys : words), ...names.map(bare)])], parts, name, token: name && token }
}

// Pagefind matches word prefixes and stems, and with no real match it falls back to as little as one letter. A word
// counts only when it holds the query word, allowing a stemmed ending such as reply in replies
const holds = (word: string, key: string) => {
    const plain = bare(word)
    return plain.includes(key) || (key.length > 3 && plain.includes(key.slice(0, -1)))
}

// How well a title or heading names the query: 2 for the whole phrase in order, 1 for every key word, 0 otherwise
function nameScore(text: string, query: Query) {
    const words = wordsOf(text)
    // Words such as how and the may be left out
    const content = query.words.filter((word) => !stopWords.has(word))
    const phrase = content.length ? content : query.words
    for (let start = 0; start + phrase.length <= words.length; start++) {
        if (phrase.every((word, index) => words[start + index].startsWith(word))) return 2
    }
    const names = (key: string) => words.some((word) => word.startsWith(key)) || bare(text).includes(key)
    return query.keys.every((key) => names(key) || !!query.parts.get(key)?.every(names)) ? 1 : 0
}

// A word that reads as code rather than prose
const codeLike = (word: string) => /[{}()[\]=;|`]|&lt;|&gt;|^\W+$|[a-z][A-Z]|\w\.\w/.test(word)

const sentenceEnd = (word = "") => /[.!?:]$/.test(word)

const excerptWords = 24

const display = (word: string) => word.replace(/&(?!lt;|gt;|amp;)/g, "&amp;").replace(/"/g, "&quot;")

// The mark covers the word, not the punctuation after it
const highlight = (word: string) => {
    const [, core, after] = /^(.*?)([.,:;!?)]*)$/s.exec(word) ?? [word, word, ""]
    return core ? `<mark>${display(core)}</mark>${display(after)}` : display(word)
}

const cleanTitle = (text: string) => text.replace(/\s*#\s*$/, "").trim()

interface Ranked {
    hit: Hit
    // Whether the page title or a section heading names the query: 3 for an entry's exact full name, 2.5 for an entry that
    // only its address or code names, 2 for the phrase, 1 for every key word. It ranks above Pagefind's score
    named: number
    // How well the page title alone names the query
    titled: number
    score: number
}

// Picks the section whose heading or text best answers the query, and an excerpt that starts at a sentence, prefers
// prose to code and highlights only the key words
async function toHit(result: PagefindResult, query: Query): Promise<Ranked | undefined> {
    const data = await result.data()
    const title = cleanTitle(data.meta.title ?? data.url)
    // Other words for the page's topic, such as getting started for the quick start, which name the page as its title does
    const terms = (data.meta.search ?? "").split(",").map((term) => term.trim()).filter(Boolean)
    const termed = Math.max(0, ...terms.map((term) => nameScore(term, query)))
    const words = data.raw_content.split(/[\r\n\s]+/)
    const hits = [...new Set(data.locations)].filter((location) => query.keys.some((key) => holds(words[location] ?? "", key))).sort((a, b) => a - b)
    const headings = data.anchors
        .filter((anchor) => /^h\d$/i.test(anchor.element) && /\S/.test(anchor.text))
        .sort((a, b) => a.location - b.location)
    // A reference entry's heading shows only its own name, such as send, while its address holds the full one, messages-send
    const fullName = (anchor: PagefindAnchor) => anchor.id.replaceAll("-", " ")
    // Every key word must really appear, so nonsense finds nothing instead of pages with one matching letter
    const found = (key: string) => bare(title).includes(key) || terms.some((term) => bare(term).includes(key)) || hits.some((location) => holds(words[location], key)) || headings.some((anchor) => bare(anchor.id) === key)
    if (!query.keys.every((key) => found(key) || !!query.parts.get(key)?.every(found))) return undefined
    // Sections run from one heading to the next. The part before the first heading is the page itself
    const sections = [{ anchor: undefined as PagefindAnchor | undefined, start: 0 }, ...headings.map((anchor) => ({ anchor, start: anchor.location }))].map(
        (section, index, all) => ({ ...section, end: all[index + 1]?.start ?? words.length, entry: false }),
    )
    // An entry without a heading, such as an error code or an option, has an address that ends with its name, such as
    // error-client-closed for client.closed, or it lists a code family, such as guild.<reason>, that stands for every code
    // filling its placeholder, such as guild.notFound. It runs to the next address
    const family = (code = "") =>
        code.includes("&lt;") &&
        new RegExp(`^${code.split(/&lt;[^&]*&gt;/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\p{L}\\p{N}]+")}$`, "u").test(query.token ?? "")
    const namesEntry = (id: string, location: number) => id.split("-").some((_, index, parts) => parts.slice(index).join("") === query.name) || family(words[location])
    const marks = data.anchors.map((anchor) => anchor.location).sort((a, b) => a - b)
    if (query.name) {
        for (const anchor of data.anchors.filter((anchor) => !/^h\d$/i.test(anchor.element) && namesEntry(anchor.id, anchor.location))) {
            sections.push({ anchor: { ...anchor, text: anchor.text || words[anchor.location] || "" }, start: anchor.location, end: marks.find((location) => location > anchor.location) ?? words.length, entry: true })
        }
    }

    const sentenceOf = (location: number, start: number) => {
        let from = location
        // A sentence also starts where prose follows code, as in } The helper returns
        while (from > start && !sentenceEnd(words[from - 1]) && !(codeLike(words[from - 1]) && /^[A-Z][a-z]/.test(words[from]))) from--
        let to = location
        while (to < words.length - 1 && !sentenceEnd(words[to])) to++
        return [from, to + 1] as const
    }
    const prose = (from: number, to: number) => {
        const span = words.slice(from, to)
        return span.length ? 1 - span.filter(codeLike).length / span.length : 0
    }

    const ranked = sections.map((section) => {
        const inside = hits.filter((location) => location >= section.start && location < section.end)
        const keys = query.keys.filter((key) => inside.some((location) => holds(words[location], key))).length
        // The exact full name, such as messages.send, ranks above a longer one that starts with it, such as messages.sendMany.
        // A member of the page's own class, such as connect on the Client page, has the page's title before its name, as in
        // client.connect
        const fullAnchor = section.anchor && (bare(section.anchor.id) === query.words.join("") || (!!query.name && bare(title) + bare(section.anchor.id) === query.name))
        const exact = fullAnchor ? 3 : section.entry ? 2.5 : 0
        const named = section.anchor ? Math.max(exact, nameScore(cleanTitle(section.anchor.text), query), nameScore(fullName(section.anchor), query)) : 0
        const readable = inside.some((location) => prose(...sentenceOf(location, section.start)) > 0.6)
        return { section, inside, named, keys, readable }
    })
    const headingLength = (entry: (typeof ranked)[number]) => wordsOf(entry.section.anchor?.text ?? "").length
    const chosen = ranked
        // A page named only by its search words opens at its top
        .filter((entry) => entry.inside.length || entry.named || (!entry.section.anchor && termed))
        // Of headings that name the query equally well, the one with the fewest other words names it best
        .sort((a, b) => b.named - a.named || b.keys - a.keys || (a.named ? headingLength(a) - headingLength(b) : 0) || Number(b.readable) - Number(a.readable) || b.inside.length - a.inside.length)[0]
    if (!chosen) return undefined
    const { section } = chosen

    // The heading's own words open the section, and the title opens the page. The excerpt starts after them
    const label = section.anchor ? section.anchor.text : title
    const labelWords = label.split(/\s+/).filter(Boolean)
    const opens = words.slice(section.start, section.start + labelWords.length).map(bare).join(" ") === labelWords.map(bare).join(" ")
    const body = opens ? Math.min(section.start + labelWords.length, section.end) : section.start

    // The sentence to show: prose first, then the most key words. Without a match in the text, the section's first words
    const pick = chosen.inside
        .filter((location) => location >= body)
        .map((location) => {
            const [from, to] = sentenceOf(location, body)
            const keys = query.keys.filter((key) => words.slice(from, to).some((word) => holds(word, key))).length
            return { location, from, keys, prose: prose(from, to) }
        })
        .sort((a, b) => Number(b.prose > 0.6) - Number(a.prose > 0.6) || b.keys - a.keys || b.prose - a.prose || a.location - b.location)[0]
    let start = pick ? pick.from : body
    let lead = ""
    // A long sentence is cut a few words before its match, so the highlight stays in view
    if (pick && pick.location - start > excerptWords - 8) {
        start = pick.location - 6
        lead = "… "
    }
    let stop = Math.min(section.end, start + excerptWords)
    // End at a sentence when one ends in the second half of the excerpt
    for (let index = stop - 1; index > start + excerptWords / 2; index--) {
        if (sentenceEnd(words[index])) {
            stop = index + 1
            break
        }
    }
    const marked = new Set(hits)
    const text = words
        .slice(start, stop)
        .map((word, index) => (marked.has(start + index) ? highlight(word) : display(word)))
        .join(" ")
    const tail = stop < section.end && !sentenceEnd(words[stop - 1]) ? " …" : ""

    const heading = section.anchor ? cleanTitle(section.anchor.text) : undefined
    // A page named exactly as the query, such as EmbedBuilder, ranks with an exact heading
    const titled = query.name && bare(title) === query.name ? 3 : Math.max(nameScore(title, query), termed)
    const url = section.anchor ? `${data.url.split("#")[0]}#${section.anchor.id}` : data.url
    return {
        hit: { url, title, section: heading && heading !== title ? heading : undefined, group: data.meta.group, excerpt: lead + text + tail },
        named: Math.max(titled, chosen.named),
        titled,
        score: result.score,
    }
}

// The API reference has a page of the same name for each entry point. Its address names the entry point
const entryNames: Record<string, string> = { "js-ts": "JavaScript & TypeScript", effect: "Effect", testing: "Testing", "effect-testing": "Effect testing" }

// One result per place, at most eight. Shown pages of the same name are told apart by their entry point
function distinct(hits: Hit[]) {
    const seen = new Set<string>()
    const unique = hits
        .filter((hit) => {
            const key = hit.url.replace(/index\.html/, "").replace(/\/?(#|$)/, "/$1")
            if (seen.has(key)) return false
            seen.add(key)
            return true
        })
        .slice(0, 8)
    return unique.map((hit) => {
        if (unique.filter((other) => other.title === hit.title).length < 2) return hit
        // A published version's address has its name after /docs/
        const entry = /\/docs\/(?:[^/]+\/)?api\/([^/]+)\//.exec(hit.url)?.[1]
        return entry && entryNames[entry] ? { ...hit, title: `${hit.title} (${entryNames[entry]})` } : hit
    })
}

// A query needs two letters or digits. One matches the start of almost every page
export const searchable = (text: string) => bare(text).length > 1

// Pagefind ranks whole pages. A page whose title or one of whose headings names the query comes first, as the reader
// most likely means that place
async function rank(results: PagefindResult[], query: Query) {
    const ranked = (await Promise.all(results.slice(0, 24).map((result) => toHit(result, query)))).filter((entry): entry is Ranked => !!entry)
    // A question in words, such as how do I reply to a message, asks for a guide more than for a reference entry
    const question = query.words.length > 2 && query.words.some((word) => stopWords.has(word))
    const guide = (entry: Ranked) => Number(question && !/\/docs\/(?:[^/]+\/)?api\//.test(entry.hit.url))
    // At the same level, a page whose title names the query, such as the threads guide for threa, comes first
    ranked.sort((a, b) => b.named - a.named || guide(b) - guide(a) || b.titled - a.titled || b.score - a.score)
    // When the JavaScript & TypeScript and the Effect reference hold the same entry and name the query equally, the
    // JavaScript & TypeScript entry takes the earlier of the two places. Every other page keeps its place
    const level = (entry: Ranked) => `${entry.named} ${guide(entry)} ${entry.titled}`
    const effectEntry = /(\/docs\/(?:[^/]+\/)?api\/)effect\//
    ranked.forEach((entry, place) => {
        if (!effectEntry.test(entry.hit.url)) return
        const twin = entry.hit.url.replace(effectEntry, "$1js-ts/")
        const later = ranked.findIndex((other, index) => index > place && other.hit.url === twin && level(other) === level(entry))
        if (later !== -1) [ranked[place], ranked[later]] = [ranked[later], entry]
    })
    return distinct(ranked.map((entry) => entry.hit))
}

// The phrases of up to aliasWords words in a query, as aliasKey writes them
function phrasesOf(text: string) {
    const words = wordsOf(text)
    const phrases = new Set<string>()
    for (let start = 0; start < words.length; start++) {
        for (let end = start + 1; end <= Math.min(words.length, start + aliasWords); end++) phrases.add(words.slice(start, end).join(" "))
    }
    return [...phrases]
}

// The index files each phrase of a guide's search front matter as an alias filter, such as first bot for the quick start.
// A query that holds one whole asks for that guide, so the guide always gets a place among the 24 that ranking reads, even
// when pages that use the query's words more often fill them. Pagefind returns every page that holds all the query's
// words, so a guide missing from those results lacks some of them and opens at its top when its search phrases name the
// query
async function withAliases(api: PagefindApi, text: string, results: PagefindResult[]) {
    const phrases = phrasesOf(text)
    if (!phrases.length) return results
    const { results: named } = await api.search(null, { filters: { alias: { any: phrases } } })
    if (!named.length) return results
    const ids = new Set(named.map((result) => result.id))
    const reserved = named.map((result): PagefindResult => {
        const own = results.find((other) => other.id === result.id)
        // A page only the filter found has no score for the query, so it ranks below the query's own pages when they name
        // the query equally well
        return own ?? { id: result.id, score: 0, data: () => result.data() }
    })
    return [...reserved, ...results.filter((result) => !ids.has(result.id))]
}

// The pages ranking reads: the query's own, the guides whose search phrases it holds and the pages of a dotted name's words
const candidates = async (api: PagefindApi, text: string, results: PagefindResult[]) => withSplitName(api, text, await withAliases(api, text, results))

// Pagefind reads a dotted name such as threads.join as one word, which a reference entry holds only in its address, so the
// name's words are searched as well and their pages join the ones that hold the whole name
async function withSplitName(api: PagefindApi, text: string, results: PagefindResult[]) {
    if (!/[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(text)) return results
    const splitText = retrievalText(text.replaceAll(".", " "))
    const { results: split } = await api.search(splitText)
    // A code such as message.rejected is listed on the codes page under its family, message.<reason>, but pages that use
    // its words more often can push the codes page out of both searches' best pages, so the codes page is asked alone
    const code = /^[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)+$/u.test(text.trim()) ? (await api.search(splitText, { filters: { page: "codes" } })).results.slice(0, 1) : []
    // Ranking reads the first 24, so the split search's best pages always get a place, also one the whole name's search
    // found but ranked too low to keep. Its scores come from another search, so they rank below the whole name's pages
    // when headings name the query equally well
    const missing = (kept: PagefindResult[]) => {
        const seen = new Set(kept.map((result) => result.id))
        return [...code, ...split].filter((result) => !seen.has(result.id) && !!seen.add(result.id))
    }
    // A page both searches found keeps where the split words are too, such as timeout for oauth.timeout, which the whole
    // name's search does not locate
    const splitPages = new Map(split.map((result) => [result.id, result] as const))
    const joined = (result: PagefindResult): PagefindResult => {
        const other = splitPages.get(result.id)
        if (!other) return result
        return {
            ...result,
            data: async () => {
                const own = await result.data()
                return { ...own, locations: [...own.locations, ...(other.words ?? (await other.data()).locations)] }
            },
        }
    }
    const kept = results.slice(0, 24 - missing(results.slice(0, 24)).slice(0, 12).length).map(joined)
    const added = missing(kept)
        .slice(0, 24 - kept.length)
        .map((result) => ({ id: result.id, score: result.score / 1000, data: () => result.data() }))
    return [...kept, ...added]
}

// A pasted log line or error names its record code in brackets, such as [events.handlerFailed], and the code finds its entry
const recordCode = (text: string) => /\[(\p{L}[\p{L}\p{N}]*(?:\.[\p{L}\p{N}<>]+)+)\]/u.exec(text)?.[1]

// Where the answer's searches run. The dialog searches in Pagefind's web worker and checks an empty answer with a copy on
// the page, where a failed download shows
export interface SearchCopies {
    searcher(): Promise<PagefindApi>
    checker(): Promise<PagefindApi>
    // Throws when the index can't be reached
    reachIndex(): Promise<void>
    // How many index chunk downloads failed on the page so far
    failedChunks(): number
    forgetSearcher(): void
    forgetChecker(): void
}

// The results for a query, or nothing when a newer query took over. It throws when the index can't be reached. Pagefind
// hides a failed index request and from then on answers as if the word were missing, so an empty answer counts only once
// the connection works and the copy on the page agrees without losing a chunk. Only empty answers cost the page that work
export async function answer(text: string, isStale: () => boolean, copies: SearchCopies) {
    const api = await copies.searcher()
    text = recordCode(text) ?? withoutClient(text)
    const search = await api.debouncedSearch(retrievalText(text), {}, 120)
    if (!search || isStale()) return undefined
    const hits = await rank(await candidates(api, text, search.results), parseQuery(text))
    if (hits.length || isStale()) return hits
    await copies.reachIndex()
    if (isStale()) return undefined
    const check = await copies.checker()
    const failed = copies.failedChunks()
    const results = await candidates(check, text, (await check.search(retrievalText(text))).results)
    if (copies.failedChunks() > failed) {
        // That copy keeps the failed chunk, so the next check opens a new one
        copies.forgetChecker()
        throw new Error("The search index could not be downloaded")
    }
    const checked = await rank(results, parseQuery(text))
    // The worker missed words the page found, so it lost a chunk earlier. The next search opens a new copy there
    if (checked.length) {
        copies.forgetSearcher()
        return checked
    }
    // Nothing holds every word, perhaps because of a typo. A long word's first letters, such as permis for permision, may
    // still name what the reader means, and the worker looks for those
    const loose = looseText(text)
    if (loose === text || isStale()) return checked
    const looseSearch = await api.search(retrievalText(loose))
    if (isStale()) return undefined
    return rank(await candidates(api, loose, looseSearch.results), parseQuery(loose))
}

// The first three fifths of every word of five or more letters, and at least four letters
const looseText = (text: string) =>
    text
        .split(/\s+/)
        .map((word) => {
            const plain = bare(word)
            return plain.length < 5 || stopWords.has(plain) ? word : plain.slice(0, Math.max(4, Math.ceil(plain.length * 0.6)))
        })
        .join(" ")
