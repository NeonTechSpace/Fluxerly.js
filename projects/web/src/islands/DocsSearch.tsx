import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"

// The parts of Pagefind's browser API this dialog uses. The index is written next to the built site by `pagefind --site dist`
interface PagefindApi {
    init(): Promise<void>
    options(options: { baseUrl: string }): Promise<void>
    debouncedSearch(query: string, options?: object, timeout?: number): Promise<{ results: PagefindResult[] } | null>
}
interface PagefindResult {
    score: number
    data(): Promise<PagefindData>
}
interface PagefindAnchor {
    element: string
    id: string
    text: string
    location: number
}
interface PagefindData {
    url: string
    raw_content: string
    locations: number[]
    anchors: PagefindAnchor[]
    meta: { title?: string; group?: string }
}
interface Hit {
    url: string
    title: string
    section?: string
    group?: string
    excerpt: string
}

let pagefind: Promise<PagefindApi> | undefined
function loadPagefind() {
    // A runtime path, so the bundler leaves it alone. It exists only in the built site
    // Each published version has its own index, beside its own pages
    const base = import.meta.env.PUBLIC_DOCS_BASE as string | undefined
    const path = base ? `${base}pagefind/pagefind.js` : "/pagefind/pagefind.js"
    pagefind ??= import(/* @vite-ignore */ path).then(async (api: PagefindApi) => {
        if (base) await api.options({ baseUrl: base })
        await api.init()
        return api
    })
    return pagefind
}

// Words that join a query but say nothing about what to find. They need not match and are never highlighted
const stopWords = new Set(
    "a an and are as at be by can do does for from how i in is it its my of on or the this to was what when where which who why will with you your".split(" "),
)

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

interface Query {
    // Every word as typed, split the way titles are split
    words: string[]
    // The words that must match. A query of only stop words keeps them all
    keys: string[]
}

function parseQuery(text: string): Query {
    const words = wordsOf(text)
    const keys = words.filter((word) => !stopWords.has(word))
    // A dotted or camelCase name such as guild.create is also the one word Pagefind indexes, guildcreate
    const joined = text.split(/\s+/).map(bare).filter((word) => word.length > 1 && !stopWords.has(word))
    return { words, keys: [...new Set([...(keys.length ? keys : words), ...joined])] }
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
    const phrase = query.words
    for (let start = 0; start + phrase.length <= words.length; start++) {
        if (phrase.every((word, index) => words[start + index].startsWith(word))) return 2
    }
    return query.keys.every((key) => words.some((word) => word.startsWith(key)) || bare(text).includes(key)) ? 1 : 0
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

const cleanTitle =(text: string) => text.replace(/\s*#\s*$/, "").trim()

interface Ranked {
    hit: Hit
    // Whether the page title or a section heading names the query. It ranks above Pagefind's score
    named: number
    score: number
}

// Picks the section whose heading or text best answers the query, and an excerpt that starts at a sentence, prefers
// prose to code and highlights only the key words
async function toHit(result: PagefindResult, query: Query): Promise<Ranked | undefined> {
    const data = await result.data()
    const title = cleanTitle(data.meta.title ?? data.url)
    const words = data.raw_content.split(/[\r\n\s]+/)
    const hits = [...new Set(data.locations)].filter((location) => query.keys.some((key) => holds(words[location] ?? "", key))).sort((a, b) => a - b)
    // Every key word must really appear, so nonsense finds nothing instead of pages with one matching letter
    const found = (key: string) => bare(title).includes(key) || hits.some((location) => holds(words[location], key))
    if (!query.keys.every(found)) return undefined

    const headings = data.anchors
        .filter((anchor) => /^h\d$/i.test(anchor.element) && /\S/.test(anchor.text))
        .sort((a, b) => a.location - b.location)
    // Sections run from one heading to the next. The part before the first heading is the page itself
    const sections = [{ anchor: undefined as PagefindAnchor | undefined, start: 0 }, ...headings.map((anchor) => ({ anchor, start: anchor.location }))].map(
        (section, index, all) => ({ ...section, end: all[index + 1]?.start ?? words.length }),
    )

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
        const named = section.anchor ? nameScore(cleanTitle(section.anchor.text), query) : 0
        const readable = inside.some((location) => prose(...sentenceOf(location, section.start)) > 0.6)
        return { section, inside, named, keys, readable }
    })
    const chosen = ranked
        .filter((entry) => entry.inside.length || entry.named)
        .sort((a, b) => b.named - a.named || b.keys - a.keys || Number(b.readable) - Number(a.readable) || b.inside.length - a.inside.length)[0]
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
    const url = section.anchor ? `${data.url.split("#")[0]}#${section.anchor.id}` : data.url
    return {
        hit: { url, title, section: heading && heading !== title ? heading : undefined, group: data.meta.group, excerpt: lead + text + tail },
        named: Math.max(nameScore(title, query), chosen.named),
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
const searchable = (text: string) => bare(text).length > 1

// Pagefind ranks whole pages. A page whose title or one of whose headings names the query comes first, as the reader
// most likely means that place
async function rank(results: PagefindResult[], query: Query) {
    const ranked = (await Promise.all(results.slice(0, 24).map((result) => toHit(result, query)))).filter((entry): entry is Ranked => !!entry)
    ranked.sort((a, b) => b.named - a.named || b.score - a.score)
    return distinct(ranked.map((entry) => entry.hit))
}

export default function DocsSearch() {
    const dialog = useRef<HTMLDialogElement>(null)
    const input = useRef<HTMLInputElement>(null)
    const [query, setQuery] = useState("")
    const [hits, setHits] = useState<Hit[]>([])
    // The query the shown results answer. Until the newest query is answered, no result is not yet nothing found
    const [answered, setAnswered] = useState("")
    const [active, setActive] = useState(0)
    const [state, setState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle")
    const listId = useId()

    const open = () => {
        if (!dialog.current || dialog.current.open) return
        dialog.current.showModal()
        input.current?.select()
        if (state === "idle") {
            setState("loading")
            loadPagefind().then(
                () => setState("ready"),
                () => setState("unavailable"),
            )
        }
    }

    useEffect(() => {
        const onKey = (event: globalThis.KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
                event.preventDefault()
                open()
            }
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    })

    useEffect(() => {
        if (state !== "ready") return
        const text = query.trim()
        // One letter matches the start of almost every page, so a search waits for a second one
        if (!searchable(text)) {
            setHits([])
            return
        }
        let stale = false
        loadPagefind()
            .then((api) => api.debouncedSearch(text, {}, 120))
            .then(async (search) => {
                if (!search || stale) return
                const next = await rank(search.results, parseQuery(text))
                if (stale) return
                setHits(next)
                setAnswered(text)
                setActive(0)
            })
        return () => {
            stale = true
        }
    }, [query, state])

    const go = (hit: Hit | undefined) => {
        if (hit) window.location.assign(hit.url)
    }

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            if (!hits.length) return
            const step = event.key === "ArrowDown" ? 1 : -1
            const next = (active + step + hits.length) % hits.length
            setActive(next)
            document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" })
        } else if (event.key === "Enter") {
            event.preventDefault()
            go(hits[active])
        }
    }

    const message =
        state === "unavailable"
            ? "Search works in the built site, after pagefind has indexed it"
            : state === "loading"
              ? "Opening the index"
              : searchable(query.trim()) && answered === query.trim() && !hits.length
                ? `Nothing found for “${query.trim()}”`
                : ""

    return (
        <>
            <button className="search-open" type="button" onClick={open} aria-haspopup="dialog">
                <MagnifyingGlassIcon size={19} aria-hidden="true" />
                <span className="search-open-label">Search the docs</span>
                <kbd>Ctrl K</kbd>
            </button>
            <dialog
                ref={dialog}
                className="search-dialog"
                aria-label="Search the docs"
                onClick={(event) => {
                    if (event.target === dialog.current) dialog.current.close()
                }}
            >
                <div className="search-field">
                    <MagnifyingGlassIcon size={21} aria-hidden="true" />
                    <input
                        ref={input}
                        type="search"
                        placeholder="Search guides and reference"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={onKeyDown}
                        role="combobox"
                        aria-expanded={hits.length > 0}
                        aria-controls={listId}
                        aria-activedescendant={hits.length ? `${listId}-${active}` : undefined}
                        aria-autocomplete="list"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <button className="search-close" type="button" onClick={() => dialog.current?.close()}>
                        Esc
                    </button>
                </div>
                <ul className="search-results" id={listId} role="listbox" aria-label="Results">
                    {hits.map((hit, index) => (
                        <li key={hit.url} id={`${listId}-${index}`} role="option" aria-selected={index === active} onMouseMove={() => setActive(index)}>
                            <a href={hit.url} tabIndex={-1}>
                                <span className="search-hit-head">
                                    <span className="search-hit-title">
                                        {hit.title}
                                        {hit.section && <span className="search-hit-section"> › {hit.section}</span>}
                                    </span>
                                    {hit.group && <span className="search-hit-group" data-group={hit.group}>
                                            {hit.group}
                                        </span>}
                                </span>
                                {/* The page text as Pagefind escaped it, with the matched words marked */}
                                <span className="search-hit-excerpt" dangerouslySetInnerHTML={{ __html: hit.excerpt }} />
                            </a>
                        </li>
                    ))}
                </ul>
                <p className="search-status" role="status">
                    {message}
                </p>
            </dialog>
        </>
    )
}
