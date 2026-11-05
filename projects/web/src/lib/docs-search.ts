// Docs search: what Pagefind is asked for a query and how its pages are ranked and shown. The search dialog runs it, and
// scripts/checks/search.mjs runs the same code against the built index to measure how often the right page comes first

import { isReaderWord, synonymVariants } from "./search-synonyms.ts"

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
    // Each filter's values and how many pages have each. It reads only the small filter files, not the word index
    filters(): Promise<Record<string, Record<string, number>>>
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
    // search holds other names for the page's topic, joined with commas: A guide's sidebar label and its search front
    // matter
    meta: { title?: string; group?: string; search?: string }
}
export interface Hit {
    url: string
    title: string
    section?: string
    group?: string
    excerpt: string
}

// What a search answers: Its results, and how it read the query
export interface Answer {
    hits: Hit[]
    // The query as search read it after correcting a clear typo, such as collector for colector. The dialog shows it with
    // a way back to the query as typed
    readAs?: string
    // A correction search did not apply, because the word may be meant as typed, such as model for modal. The dialog
    // offers it
    suggestion?: string
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

// The longest phrase in a guide's sidebar label or search front matter, in words. A query's phrases up to this long are
// compared with them
export const aliasWords = 6

// A guide's sidebar label or search phrase as the index files it and a query's phrase is compared with it: Lowercase
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
    // How much naming each key word is worth: More for a word few pages use, such as cooldown, than for bot
    weights: Map<string, number>
    // How many pages hold each key word, as Pagefind counts them, for a query of several key words
    holding: Map<string, number>
    // How many pages share a heading's text and its address, from headings.json
    sharing: (anchor: PagefindAnchor) => { text: number; id: number }
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
    return { words, keys: [...new Set([...(keys.length ? keys : words), ...names.map(bare)])], parts, name, token: name && token, weights: new Map(), holding: new Map(), sharing: () => ({ text: 1, id: 1 }) }
}

// Pagefind matches word prefixes and stems, and with no real match it falls back to as little as one letter. A word
// counts only when it holds the query word, allowing a stemmed ending such as reply in replies
const holds = (word: string, key: string) => {
    const plain = bare(word)
    return plain.includes(key) || (key.length > 3 && plain.includes(key.slice(0, -1)))
}

// How well a title or heading names the query: 2 for the whole phrase in order, 1 for every key word, 0 otherwise
function nameScore(text: string, query: Query) {
    // A heading names a phrase of plain words with stop words between them, as Events and Handlers names event handler.
    // A name as code writes it, such as runB, keeps every word
    const words = wordsOf(text).filter((word) => !!query.name || !stopWords.has(word))
    // Words such as how and the may be left out
    const content = query.words.filter((word) => !stopWords.has(word))
    const phrase = content.length ? content : query.words
    for (let start = 0; start + phrase.length <= words.length; start++) {
        if (phrase.every((word, index) => words[start + index].startsWith(word))) return 2
    }
    const names = (key: string) => words.some((word) => word.startsWith(key)) || bare(text).includes(key)
    return query.keys.every((key) => names(key) || !!query.parts.get(key)?.every(names)) ? 1 : 0
}

// How much of the query a title or heading names, for when none names it all: The weights of the key words it names,
// each times the evidence its naming gives, in full for a title
function coverage(text: string, query: Query, evidence: (key: string) => number = () => 1) {
    const words = wordsOf(text)
    const names = (key: string) => words.some((word) => word.startsWith(key)) || bare(text).includes(key)
    return query.keys.filter((key) => names(key) || !!query.parts.get(key)?.every(names)).reduce((sum, key) => sum + (query.weights.get(key) ?? 1) * evidence(key), 0)
}

// How many pages hold each word, by index copy, so each word is asked for once
const pageCounts = new WeakMap<PagefindApi, Map<string, Promise<number>>>()
const pagesHolding = (api: PagefindApi, word: string) => {
    const counts = pageCounts.get(api) ?? new Map<string, Promise<number>>()
    pageCounts.set(api, counts)
    if (!counts.has(word)) counts.set(word, api.search(word).then((search) => search.results.length))
    return counts.get(word)!
}

// How many pages the index holds, as the answer learned it from its copies
const pageTotals = new WeakMap<PagefindApi, number>()
const pageCountOf = (copies: SearchCopies) =>
    copies.pageCount().catch((error: unknown) => {
        console.error("Search could not read how many pages it holds, so it weighs every word the same:", error)
        return 0
    })

// How many pages share each heading, as the answer learned it from its copies
const headingTotals = new WeakMap<PagefindApi, HeadingCounts | undefined>()
const headingsOf = (copies: SearchCopies) =>
    copies.headings().catch((error: unknown) => {
        console.error("Search could not read how many pages share each heading, so every heading counts in full:", error)
        return undefined
    })

// Weighs a query of several key words by how rare each word is, as Pagefind counts the pages that hold it
async function weigh(api: PagefindApi, query: Query) {
    const total = pageTotals.get(api)
    // A query that already has weights, such as the rest of a query with one word left out, keeps them
    if (query.keys.length < 2 || !total || query.weights.size) return query
    const counts = await Promise.all(query.keys.map((key) => pagesHolding(api, key)))
    return {
        ...query,
        weights: new Map(query.keys.map((key, index) => [key, Math.log((total + 1) / (counts[index]! + 1))])),
        holding: new Map(query.keys.map((key, index) => [key, counts[index]!])),
    }
}

// A word that reads as code rather than prose
const codeLike = (word: string) => /[{}()[\]=;|`]|&lt;|&gt;|^\W+$|[a-z][A-Z]|\w\.\w/.test(word)

const sentenceEnd = (word = "") => /[.!?:]$/.test(word)

const excerptWords = 24

const display = (word: string) => word.replace(/&(?!lt;|gt;|amp;)/g, "&amp;").replace(/"/g, "&quot;")

// The mark covers the word, not the punctuation after it. An escaped character such as &gt; stays whole, so its
// semicolon is no punctuation
const highlight = (word: string) => {
    const [, core, after] = /^(.*?(?:&(?:lt|gt|amp);)?)([.,:;!?)]*)$/s.exec(word) ?? [word, word, ""]
    return core ? `<mark>${display(core)}</mark>${display(after)}` : display(word)
}

const cleanTitle = (text: string) => text.replace(/\s*#\s*$/, "").trim()

// A heading as headings.json files it: Its words in lowercase, without the # a reference heading ends with
export const headingKey = (text: string) => aliasKey(cleanTitle(text))

// How many pages share each heading, as scripts/docs/search-words.mjs writes them to headings.json beside the index: The
// heading texts, as headingKey writes them, and the heading addresses that two pages or more share, with how many share
// each. Any other heading is on one page
export interface HeadingCounts {
    texts: Record<string, number>
    ids: Record<string, number>
}

// How many pages share a heading's text and its address. An address that only spells the heading's own words, as a
// guide's variables for Variables, says no more than the heading, so it counts as the heading's text does
function sharerOf(counts: HeadingCounts | undefined) {
    const count = (shared: Record<string, number> | undefined, key: string) => (shared && Object.hasOwn(shared, key) ? shared[key]! : 1)
    return (anchor: PagefindAnchor) => {
        const text = count(counts?.texts, headingKey(anchor.text))
        return { text, id: bare(anchor.id) === bare(cleanTitle(anchor.text)) ? text : count(counts?.ids, anchor.id) }
    }
}

// The evidence a heading gives by naming a query word, the way BM25 weighs a word by the documents that hold it: In
// full when no other page that holds the word shares the heading, less the more of those pages share it, and none once
// half of them do, as for a heading such as Variables that many reference pages file their exported values under
function evidence(sharing: number, holding: number | undefined) {
    if (sharing < 2 || !holding || holding < 2) return 1
    return Math.max(0, Math.log((holding + 1) / (2 * sharing)) / Math.log((holding + 1) / 2))
}

// A reference entry's heading shows only its own name, such as send, while its address holds the full one, messages-send
const fullName = (anchor: PagefindAnchor) => anchor.id.replaceAll("-", " ")

// How much of the query a heading names: By its text, as many pages share it, or by its address, which names a
// reference entry in full, as messages-send for send, and which fewer pages share
function headingCoverage(anchor: PagefindAnchor, query: Query) {
    const { text, id } = query.sharing(anchor)
    return Math.max(coverage(cleanTitle(anchor.text), query, (key) => evidence(text, query.holding.get(key))), coverage(fullName(anchor), query, (key) => evidence(id, query.holding.get(key))))
}


interface Ranked {
    hit: Hit
    // Whether the page title or a section heading names the query: 3 for an entry's exact full name, 2.5 for an entry that
    // only its address or code names, 2 for the phrase, 1 for every key word. It ranks above Pagefind's score
    named: number
    // How well the page title alone names the query
    titled: number
    // How much of the query the page title or the chosen heading names, its rare words counting for more
    covered: number
    // 1 when the page holds every key word of the query, 0 when it lacks one
    whole: number
    // 1 for a guide that answers a question in words, such as how do I reply to a message, which asks for a guide more
    // than for a reference entry
    guide: number
    score: number
}

// The order of results: How well a title or heading names the query, then a guide for a question, how well the page
// title names it, how much of the query the title or chosen heading names, a page that holds every word before one that
// lacks one, and Pagefind's score
const order = (a: Ranked, b: Ranked) => b.named - a.named || b.guide - a.guide || b.titled - a.titled || b.covered - a.covered || b.whole - a.whole || b.score - a.score

// A page's address, words, headings and metadata, which stay the same from query to query. Pagefind builds its own
// excerpts each time a result's data is read, which the dialog does not show, so each page is read once and the 32 most
// recently used are kept
interface PageText {
    url: string
    words: string[]
    anchors: PagefindAnchor[]
    meta: PagefindData["meta"]
}
const pageTexts = new Map<string, Promise<PageText>>()
function pageText(result: PagefindResult) {
    const kept = pageTexts.get(result.id)
    pageTexts.delete(result.id)
    const text = kept ?? result.data().then((data) => ({ url: data.url, words: data.raw_content.split(/[\r\n\s]+/), anchors: data.anchors, meta: data.meta }))
    pageTexts.set(result.id, text)
    text.catch(() => pageTexts.delete(result.id))
    while (pageTexts.size > 32) pageTexts.delete(pageTexts.keys().next().value!)
    return text
}

// Picks the section whose heading or text best answers the query, and an excerpt that starts at a sentence, prefers
// prose to code and highlights only the key words
async function toHit(result: PagefindResult, query: Query): Promise<Omit<Ranked, "guide"> | undefined> {
    const data = await pageText(result)
    const locations = result.words ?? (await result.data()).locations
    const title = cleanTitle(data.meta.title ?? data.url)
    // Other words for the page's topic, such as getting started for the quick start, which name the page as its title does
    const terms = (data.meta.search ?? "").split(",").map((term) => term.trim()).filter(Boolean)
    const termed = Math.max(0, ...terms.map((term) => nameScore(term, query)))
    const { words } = data
    const hits = [...new Set(locations)].filter((location) => query.keys.some((key) => holds(words[location] ?? "", key))).sort((a, b) => a - b)
    const headings = data.anchors
        .filter((anchor) => /^h\d$/i.test(anchor.element) && /\S/.test(anchor.text))
        .sort((a, b) => a.location - b.location)
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
        const held = query.keys.filter((key) => inside.some((location) => holds(words[location], key)))
        // The exact full name, such as messages.send, ranks above a longer one that starts with it, such as messages.sendMany.
        // A member of the page's own class, such as connect on the Client page, has the page's title before its name, as in
        // client.connect
        const fullAnchor = section.anchor && (bare(section.anchor.id) === query.words.join("") || (!!query.name && bare(title) + bare(section.anchor.id) === query.name))
        const exact = fullAnchor ? 3 : section.entry ? 2.5 : 0
        const named = section.anchor ? Math.max(exact, nameScore(cleanTitle(section.anchor.text), query), nameScore(fullName(section.anchor), query)) : 0
        const covered = section.anchor ? headingCoverage(section.anchor, query) : 0
        const readable = inside.some((location) => prose(...sentenceOf(location, section.start)) > 0.6)
        // The query's words in the section's text, and once more for each its heading names, each by its weight
        const weight = held.reduce((sum, key) => sum + (query.weights.get(key) ?? 1), 0) + covered
        return { section, inside, named, covered, weight, readable }
    })
    const headingLength = (entry: (typeof ranked)[number]) => wordsOf(entry.section.anchor?.text ?? "").length
    const chosen = ranked
        // A page named only by its search words opens at its top
        .filter((entry) => entry.inside.length || entry.named || (!entry.section.anchor && termed))
        // Without a heading that names the whole query, the section that holds most of it, rare words counting for more, and
        // a word its heading names counting twice. Of headings that name the query equally well, the one with the fewest
        // other words names it best
        .sort((a, b) => b.named - a.named || b.weight - a.weight || (a.named ? headingLength(a) - headingLength(b) : 0) || Number(b.readable) - Number(a.readable) || b.inside.length - a.inside.length)[0]
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
    const titleCovered = coverage(title, query)
    const untitled = { ...query, keys: query.keys.filter((key) => coverage(title, { ...query, keys: [key] }) === 0) }
    return {
        hit: { url, title, section: heading && heading !== title ? heading : undefined, group: data.meta.group, excerpt: lead + text + tail },
        named: Math.max(titled, chosen.named),
        titled,
        // The title and the heading shown with it name the query together, as Configure a Bot and Options at a Glance
        // name config options. A word only the heading names counts by the evidence the heading gives
        covered: titleCovered + (section.anchor ? headingCoverage(section.anchor, untitled) : 0),
        whole: 1,
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
async function ranked(api: PagefindApi, results: PagefindResult[], unweighed: Query, limit = 24, concept = false): Promise<Ranked[]> {
    if (!results.length) return []
    const query = { ...(await weigh(api, unweighed)), sharing: sharerOf(headingTotals.get(api)) }
    const question = concept || (query.words.length > 2 && query.words.some((word) => stopWords.has(word)))
    const entries = (await Promise.all(results.slice(0, limit).map((result) => toHit(result, query))))
        .filter((entry) => !!entry)
        .map((entry): Ranked => ({ ...entry, guide: Number(question && !/\/docs\/(?:[^/]+\/)?api\//.test(entry.hit.url)) }))
    // At the same level, a page whose title names the query, such as the threads guide for threa, comes first
    entries.sort(order)
    return javascriptFirst(entries)
}

// When the JavaScript & TypeScript and the Effect reference both hold an entry, the Effect copy comes after every other
// result that names the query as well as it does, so a repeated entry does not take a place from another answer, and
// never before its JavaScript & TypeScript twin. Each sort of results ends with it, as sorting by Pagefind's score would
// put a shorter Effect page first
function javascriptFirst(entries: Ranked[]) {
    const level = (entry: Ranked) => `${entry.named} ${entry.covered} ${entry.guide} ${entry.titled}`
    const effectEntry = /(\/docs\/(?:[^/]+\/)?api\/)effect\//
    const urls = new Set(entries.map((entry) => entry.hit.url))
    const twinned = (entry: Ranked) => effectEntry.test(entry.hit.url) && urls.has(entry.hit.url.replace(effectEntry, "$1js-ts/"))
    const sorted: Ranked[] = []
    for (let start = 0; start < entries.length; ) {
        let end = start
        while (end < entries.length && level(entries[end]!) === level(entries[start]!)) end++
        const run = entries.slice(start, end)
        sorted.push(...run.filter((entry) => !twinned(entry)), ...run.filter(twinned))
        start = end
    }
    return sorted
}

const rank = async (api: PagefindApi, results: PagefindResult[], query: Query) => distinct((await ranked(api, results, query)).map((entry) => entry.hit))

// Pages that hold every word of the query but one, kept only where a title or heading names every word they hold. A
// word the answering page lacks, such as unit in unit test, then still finds the page named for the rest. It costs one
// more search for each of the query's two to five key words, each reading its first twelve pages, and a newer query
// stops it
async function mostWords(api: PagefindApi, text: string, isStale: () => boolean): Promise<Ranked[]> {
    const tokens = text.split(/\s+/).filter(Boolean)
    const content = tokens.flatMap((token, index) => (bare(token) && !stopWords.has(bare(token)) ? [index] : []))
    if (content.length < 2 || content.length > 5) return []
    // Each rest is weighed as the whole query is, so its pages rank on the same scale as the query's own
    const { weights, holding } = await weigh(api, parseQuery(text))
    const searches = content.map(async (skip) => {
        const rest = tokens.filter((_, index) => index !== skip).join(" ")
        const { results } = await api.search(retrievalText(rest))
        return isStale() ? [] : ranked(api, await candidates(api, rest, results), { ...parseQuery(rest), weights, holding }, 12)
    })
    const found = new Map<string, Ranked>()
    for (const entry of (await Promise.all(searches)).flat()) {
        if (entry.named < 1) continue
        // It names every word it holds, not the whole query
        const partial = { ...entry, named: 0, titled: 0, whole: 0 }
        const seen = found.get(partial.hit.url)
        if (!seen || order(partial, seen) < 0) found.set(partial.hit.url, partial)
    }
    return [...found.values()].sort(order)
}

// One entry for each place, the best of those found for it, in the order of results
function mergeEntries(entries: Ranked[]) {
    const best = new Map<string, Ranked>()
    for (const entry of entries) {
        const seen = best.get(entry.hit.url)
        if (!seen || order(entry, seen) < 0) best.set(entry.hit.url, entry)
    }
    return javascriptFirst([...best.values()].sort(order))
}

// The pages for the query with the docs' words in place of a reader's, such as event handler for event listener. Each
// version reads as many pages as the query's own search. A reader's word names a concept, so among pages that name the
// query equally well, a guide that explains it comes before a reference entry, as for a question
async function withSynonyms(api: PagefindApi, text: string, isStale: () => boolean) {
    const variants = synonymVariants(text)
    const searches = variants.map(async (variant) => {
        const { results } = await api.search(retrievalText(variant))
        return isStale() ? [] : ranked(api, await candidates(api, variant, results), parseQuery(variant), 24, true)
    })
    return (await Promise.all(searches)).flat()
}

// The query's own pages and the pages for its synonyms, best first
async function ownEntries(api: PagefindApi, text: string, results: PagefindResult[], isStale: () => boolean) {
    const [found, swapped] = await Promise.all([candidates(api, text, results).then((pages) => ranked(api, pages, parseQuery(text))), withSynonyms(api, text, isStale)])
    return mergeEntries([...found, ...swapped])
}

const namesQuery = (entries: Ranked[]) => entries.some((entry) => entry.named >= 1)

// The results for a query read as corrected: Its own pages, joined by the pages that name all of it but one word when
// no title or heading names it all, and whether one does
async function correctedAnswer(api: PagefindApi, text: string, isStale: () => boolean) {
    const own = await ownEntries(api, text, (await api.search(retrievalText(text))).results, isStale)
    if (namesQuery(own) || isStale()) return { hits: distinct(own.map((entry) => entry.hit)), named: true }
    return { hits: distinct(mergeEntries([...own, ...(await mostWords(api, text, isStale))]).map((entry) => entry.hit)), named: false }
}

// How search reads a query's misspelled words, from the word list, which is downloaded the first time it is needed
async function correctionFor(text: string, copies: SearchCopies) {
    const words = await copies.words().catch((error: unknown) => {
        console.error("Search could not load its word list, so it cannot correct typos:", error)
        return { words: [], real: [] }
    })
    return correction(text, words)
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

// The index files a guide's sidebar label and each phrase of its search front matter as an alias filter, such as first
// bot for the quick start. A query that holds one whole asks for that guide, so the guide always gets a place among the
// 24 that ranking reads, even when pages that use the query's words more often fill them. Pagefind returns every page
// that holds all the query's words, so a guide missing from those results lacks some of them and opens at its top when
// its search phrases name the query
async function withAliases(api: PagefindApi, text: string, results: PagefindResult[]) {
    // A search for the filter alone reads the whole word index, so it runs only for a phrase that is an alias
    const aliases = (await api.filters()).alias ?? {}
    const phrases = phrasesOf(text).filter((phrase) => Object.hasOwn(aliases, phrase))
    if (!phrases.length) return results
    const { results: named } = await api.search(null, { filters: { alias: { any: phrases } } })
    if (!named.length) return results
    const ids = new Set(named.map((result) => result.id))
    const reserved = named.map((result): PagefindResult => {
        const own = results.find((other) => other.id === result.id)
        // A page only the filter found has no score for the query, so it ranks below the query's own pages when they name
        // the query equally well
        return own ?? { id: result.id, score: 0, words: result.words, data: () => result.data() }
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
            words: result.words && other.words ? [...result.words, ...other.words] : undefined,
            data: async () => {
                const own = await result.data()
                return { ...own, locations: [...own.locations, ...(other.words ?? (await other.data()).locations)] }
            },
        }
    }
    const kept = results.slice(0, 24 - missing(results.slice(0, 24)).slice(0, 12).length).map(joined)
    const added = missing(kept)
        .slice(0, 24 - kept.length)
        .map((result) => ({ id: result.id, score: result.score / 1000, words: result.words, data: () => result.data() }))
    return [...kept, ...added]
}

// A pasted log line or error names its record code in brackets, such as [events.handlerFailed], and the code finds its entry
const recordCode = (text: string) => /\[(\p{L}[\p{L}\p{N}]*(?:\.[\p{L}\p{N}<>]+)+)\]/u.exec(text)?.[1]

// The words a typo is read against, as scripts/docs/search-words.mjs writes them: The words the docs use, most common
// first, and the real words one missing, swapped or doubled letter from one of them, which search never reads as a typo
export interface SearchWords {
    words: readonly string[]
    real: readonly string[]
}

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
    // The words the docs use and the real words close to them, from words.json beside the index. Asked for only when no
    // title or heading names the whole query
    words(): Promise<SearchWords>
    // How many pages the index holds, from pagefind-entry.json, for weighing rare words
    pageCount(): Promise<number>
    // How many pages share each heading, from headings.json beside the index, for weighing a heading that names the query
    headings(): Promise<HeadingCounts>
}

// The results for a query, or nothing when a newer query took over. It throws when the index can't be reached. Pagefind
// hides a failed index request and from then on answers as if the word were missing, so an empty answer counts only once
// the connection works and the copy on the page agrees without losing a chunk. Only empty answers cost the page that work.
// When no title or heading names the query, a clear typo is corrected before pages that miss a word are tried, and asTyped
// turns correcting off, for the reader who asks for the query as typed
export async function answer(typed: string, isStale: () => boolean, copies: SearchCopies, asTyped = false): Promise<Answer | undefined> {
    const api = await copies.searcher()
    // The page count and the shared headings are read alongside the first search, not before it
    const counting = pageTotals.has(api) ? undefined : pageCountOf(copies)
    const sharing = headingTotals.has(api) ? undefined : headingsOf(copies)
    const text = recordCode(typed) ?? withoutClient(typed)
    const search = await api.debouncedSearch(retrievalText(text), {}, 120)
    if (counting) pageTotals.set(api, await counting)
    if (sharing) headingTotals.set(api, await sharing)
    if (!search || isStale()) return undefined
    const own = await ownEntries(api, text, search.results, isStale)
    if (isStale()) return undefined
    if (namesQuery(own)) return { hits: distinct(own.map((entry) => entry.hit)) }
    if (!own.length) {
        await copies.reachIndex()
        if (isStale()) return undefined
        const check = await copies.checker()
        if (!pageTotals.has(check)) pageTotals.set(check, await pageCountOf(copies))
        if (!headingTotals.has(check)) headingTotals.set(check, await headingsOf(copies))
        const failed = copies.failedChunks()
        const results = await candidates(check, text, (await check.search(retrievalText(text))).results)
        if (copies.failedChunks() > failed) {
            // That copy keeps the failed chunk, so the next check opens a new one
            copies.forgetChecker()
            throw new Error("The search index could not be downloaded")
        }
        const checked = await rank(check, results, parseQuery(text))
        // The worker missed words the page found, so it lost a chunk earlier. The next search opens a new copy there
        if (checked.length) {
            copies.forgetSearcher()
            return { hits: checked }
        }
    }
    // No title or heading names the whole query, or nothing holds every word, perhaps because of a typo
    const read = asTyped ? undefined : await correctionFor(text, copies)
    if (isStale()) return undefined
    // A four-letter reading holds where a title or heading names it and the query has another word to go by
    const confirmable = read?.confirm && parseQuery(text).keys.length > 1
    if (read?.sure || confirmable) {
        const found = await correctedAnswer(api, read!.text, isStale)
        if (isStale()) return undefined
        if (found.hits.length && (read!.sure || found.named)) return { hits: found.hits, readAs: asWritten(typed, text, read!.text) }
    }
    const suggestion = read && !read.sure ? asWritten(typed, text, read.text) : undefined
    // When no page holds every word, a long word's first letters, such as containe for containerize or permis for
    // permision, may still find pages that hold all of the query, and those come before pages that miss a word
    const loose = looseText(text)
    let held: Hit[] = []
    if (!own.length && loose !== text) {
        const looseSearch = await api.search(retrievalText(loose))
        if (isStale()) return undefined
        held = await rank(api, await candidates(api, loose, looseSearch.results), parseQuery(loose))
    }
    // Pages whose title or heading names all of the query but one word join its own, ranked by how much of it they name
    const most = await mostWords(api, text, isStale)
    if (isStale()) return undefined
    return { hits: distinct([...held, ...mergeEntries([...own, ...most]).map((entry) => entry.hit)]), suggestion }
}

// A query read as corrected, as the reader wrote it, so client.mesages.send reads as client.messages.send rather than
// as the messages.send search looks for, and a pasted log line keeps the text around its code
function asWritten(typed: string, text: string, read: string) {
    const written = typed.trim()
    const searched = text.trim()
    return written.includes(searched) ? written.replace(searched, () => read) : read
}

// A corrected word in the reader's letter case, so handlerFaild reads as handlerFailed: A word typed in capitals stays
// in capitals, and otherwise the letters it shares with the typed word at its start and its end keep their typed case,
// and the word list's lowercase fills the rest
function inCase(typed: string, read: string) {
    if (typed.length > 1 && typed === typed.toUpperCase()) return read.toUpperCase()
    let start = 0
    while (start < typed.length && start < read.length && typed[start]!.toLowerCase() === read[start]) start++
    let end = 0
    while (end < typed.length - start && end < read.length - start && typed.at(-1 - end)!.toLowerCase() === read.at(-1 - end)) end++
    return typed.slice(0, start) + read.slice(start, read.length - end) + typed.slice(typed.length - end)
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

// How many edits apart two words are, counting a swap of neighbouring letters as one edit. Past limit it stops counting and
// answers limit + 1
function distance(a: string, b: string, limit: number) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1
    let earlier: number[] = []
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
    for (let i = 1; i <= a.length; i++) {
        const row = [i]
        for (let j = 1; j <= b.length; j++) {
            let edits = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) edits = Math.min(edits, earlier[j - 2]! + 1)
            row.push(edits)
        }
        if (Math.min(...row) > limit) return limit + 1
        earlier = previous
        previous = row
    }
    return previous[b.length]!
}

// Whether a typed word one edit from a docs word differs from it the way a hand mistypes: A missing letter, two swapped
// letters or a doubled letter, as in colector, oauht and sendd. One letter for another, or an added letter that doubles
// none, is how different real words differ, as modal and model, or robot and root
function slip(typed: string, docs: string) {
    if (typed.length < docs.length) return true
    if (typed.length > docs.length) {
        let at = 0
        while (typed[at] === docs[at]) at++
        return typed[at] === typed[at - 1] || typed[at] === typed[at + 1]
    }
    const at = Array.from({ length: typed.length }, (_, index) => index).filter((index) => typed[index] !== docs[index])
    return at.length === 2 && at[1] === at[0]! + 1 && typed[at[0]!] === docs[at[1]!] && typed[at[1]!] === docs[at[0]!]
}

// The words a word with an ending such as -s, -ed, -ing or -er may come from. Such a word is not a typo when the docs use
// one of them, as crashing is not when the docs say crash, and aggregated is not when they say aggregate. A doubled last
// letter, as in sendd or messagess, is no ending
const stemsOf = (word: string) =>
    [
        [/(?<!s)s$/, ""],
        [/es$/, ""],
        [/ed$/, ""],
        [/(?<=e)d$/, ""],
        [/ing$/, ""],
        [/ing$/, "e"],
        [/er$/, ""],
        [/(?<=e)r$/, ""],
    ].flatMap(([ending, put]) => (ending as RegExp).test(word) ? [word.replace(ending as RegExp, put as string)] : [])

// How search reads a query's misspelled words. sure means every change is one missing, swapped or doubled letter in a
// word of five letters or more that is no real word. confirm means a four-letter word that is no real word lacks a
// letter, as embd for embed, which too many words do for the reading to be sure, so it holds only where a title or
// heading names the query as read
export interface Reading {
    text: string
    sure: boolean
    confirm: boolean
}

// The query with each word the docs never use read as the closest word they do, or nothing when no word needs it. A
// candidate starts with the same letter and is one edit away, two for words over seven letters. Of equally close words
// a slip of the hand wins, then the most common. A four-letter word is read only as a longer word it lacks one letter
// of. A dotted name is read part by part. Stop words, reader words the synonym map knows, names with digits, the start
// of a docs word such as troublesh and a word whose stem the docs use stay as typed. A reading that is not a slip, or
// that would replace a real word, such as model for modal or launch for lunch, is a suggestion the reader may take
export function correction(text: string, { words, real }: SearchWords): Reading | undefined {
    const known = new Set(words)
    const realWords = new Set(real)
    const starts = (part: string) => known.has(part) || words.some((other) => other.startsWith(part))
    let sure = true
    let confirm = false
    let suggestOnly = false
    let changed = false
    // One word as search reads it. A four-letter word is read only outside a dotted name
    const readWord = (token: string, short: boolean) => {
        const word = token.toLowerCase()
        if (word.length < 4 || !/^\p{L}+$/u.test(word) || stopWords.has(word) || isReaderWord(word) || starts(word)) return token
        if (word.length === 4) {
            const longer = short ? words.find((other) => other.length === 5 && other[0] === word[0] && Array.from({ length: other.length }, (_, at) => other.slice(0, at) + other.slice(at + 1)).includes(word)) : undefined
            if (!longer) return token
            changed = true
            sure = false
            if (realWords.has(word)) suggestOnly = true
            else confirm = true
            return inCase(token, longer)
        }
        if (stemsOf(word).some((stem) => known.has(stem))) return token
        const limit = word.length > 7 ? 2 : 1
        let closest: string | undefined
        let edits = limit + 1
        let slipped = false
        for (const other of words) {
            // A typo rarely changes the first letter
            if (other[0] !== word[0]) continue
            const apart = distance(word, other, Math.min(limit, edits))
            if (apart > limit || apart > edits) continue
            const isSlip = apart === 1 && slip(word, other)
            if (apart < edits || (isSlip && !slipped)) {
                closest = other
                edits = apart
                slipped = isSlip
                if (slipped) break
            }
        }
        if (!closest) return token
        changed = true
        if (!slipped || realWords.has(word)) {
            sure = false
            suggestOnly = true
        }
        return inCase(token, closest)
    }
    const read = text.split(/\s+/).map((token) => {
        const plain = token.replace(/[?!,;:]+$/, "").replace(/\.$/, "")
        // A dotted name such as mesages.send is read part by part
        if (/^\p{L}+(?:\.\p{L}+)+$/u.test(plain)) return plain.split(".").map((part) => readWord(part, false)).join(".")
        return readWord(plain, true)
    })
    return changed ? { text: read.join(" "), sure, confirm: confirm && !suggestOnly } : undefined
}
