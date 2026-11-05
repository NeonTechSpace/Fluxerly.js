import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"
import { answer as answerQuery, pagefindOptions, searchable, type Answer, type HeadingCounts, type Hit, type PagefindApi, type PagefindModule, type SearchWords } from "../lib/docs-search"
import { composing, EnterIntent } from "../lib/search-enter"

// Each published version has its own index, beside its own pages
const docsBase = import.meta.env.PUBLIC_DOCS_BASE as string | undefined
const indexPath = `${docsBase || "/"}pagefind/`

// Pagefind logs a failed index chunk download and then answers as if its words were missing. Counting those failures
// tells an empty answer from a broken one, but only on the page, as a request from a web worker can't be seen
let failedChunks = 0
let watching = false
function watchChunks() {
    if (watching) return
    watching = true
    const chunks = `${indexPath}index/`
    const send = window.fetch.bind(window)
    window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        const chunk = new URL(url, window.location.href).pathname.startsWith(chunks)
        try {
            const response = await send(input, init)
            if (chunk && !response.ok) failedChunks += 1
            return response
        } catch (error) {
            if (chunk) failedChunks += 1
            throw error
        }
    }
}

// Pagefind's module, imported once. A runtime path, so the bundler leaves it alone. It exists only in the built site. A
// browser can remember a failed import for good, so each further try asks for a new address
let pagefindModule: Promise<PagefindModule> | undefined
let imports = 0
function importPagefind() {
    if (pagefindModule) return pagefindModule
    const loading: Promise<PagefindModule> = import(/* @vite-ignore */ `${indexPath}pagefind.js${imports ? `?try=${imports}` : ""}`)
    imports += 1
    pagefindModule = loading
    loading.catch(() => {
        if (pagefindModule === loading) pagefindModule = undefined
    })
    return loading
}

// One copy of the index, opened on demand. `onPage` searches without a web worker. Once forgotten, the next use opens a
// new copy, which asks again for every request that failed. Pagefind keeps a failed one and would never ask again
function indexCopy(onPage: boolean) {
    let opened: Promise<PagefindApi> | undefined
    let forgotten = false
    const load = () => {
        if (opened && !forgotten) return opened
        if (onPage) watchChunks()
        const previous = opened
        forgotten = false
        const loading = importPagefind().then(async (pagefind) => {
            await previous?.then((api) => api.destroy()).catch(() => {})
            const api = pagefind.createInstance({ ...pagefindOptions, ...(onPage ? { noWorker: true } : {}), ...(docsBase ? { baseUrl: docsBase } : {}) })
            await api.init()
            return api
        })
        opened = loading
        loading.catch(() => {
            if (opened === loading) opened = undefined
        })
        return loading
    }
    return {
        load,
        forget() {
            forgotten = true
        },
    }
}

// Searching runs in Pagefind's web worker, so typing never waits for it. An empty answer is asked again of a copy on
// the page, where a failed download shows, and only then does the page do that work
const searcher = indexCopy(false)
const checker = indexCopy(true)
const loadPagefind = searcher.load
const reopenPagefind = () => {
    searcher.forget()
    checker.forget()
    return searcher.load()
}

// The words the docs use and the real words close to them, for reading a mistyped word. Downloaded once, the first time
// no title or heading names a whole query, and asked for again after a failure
let words: Promise<SearchWords> | undefined
function loadWords() {
    const loading = (words ??= fetch(`${indexPath}words.json`).then((response) => {
        if (!response.ok) throw new Error(`The search word list answered ${response.status}`)
        return response.json() as Promise<SearchWords>
    }))
    loading.catch(() => {
        if (words === loading) words = undefined
    })
    return loading
}

const copies = {
    searcher: searcher.load,
    checker: checker.load,
    async reachIndex() {
        const entry = await fetch(`${indexPath}pagefind-entry.json`, { cache: "no-store" })
        if (!entry.ok) throw new Error(`The search index answered ${entry.status}`)
    },
    failedChunks: () => failedChunks,
    forgetSearcher: searcher.forget,
    forgetChecker: checker.forget,
    words: loadWords,
    async pageCount() {
        const entry = await fetch(`${indexPath}pagefind-entry.json`)
        if (!entry.ok) throw new Error(`The search index answered ${entry.status}`)
        const { languages } = (await entry.json()) as { languages: Record<string, { page_count: number }> }
        return Object.values(languages).reduce((total, language) => total + language.page_count, 0)
    },
    async headings() {
        const response = await fetch(`${indexPath}headings.json`)
        if (!response.ok) throw new Error(`The shared headings answered ${response.status}`)
        return (await response.json()) as HeadingCounts
    },
}
const answer = (text: string, isStale: () => boolean, asTyped: boolean) => answerQuery(text, isStale, copies, asTyped)

// A query as the note shows it: 32 characters of it, with … where it goes on. They start a few characters before the
// first one that differs from the query as typed, so a corrected word late in a pasted log line stays in view
const noteLength = 32
function brief(text: string, typed = text) {
    if (text.length <= noteLength) return text
    let differs = 0
    while (differs < text.length && text[differs] === typed[differs]) differs++
    const start = differs === text.length ? 0 : Math.min(Math.max(0, differs - 8), text.length - (noteLength - 1))
    const room = noteLength - (start ? 1 : 0)
    const end = start + room >= text.length ? text.length : start + room - 1
    return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`
}

// A note button's spoken name: Its visible label first, then the whole query when the label shows only part of it
const spoken = (label: string, query: string) => (label.includes(query) ? undefined : `${label}, ${query}`)

export default function DocsSearch() {
    const dialog = useRef<HTMLDialogElement>(null)
    const input = useRef<HTMLInputElement>(null)
    const [query, setQuery] = useState("")
    const [hits, setHits] = useState<Hit[]>([])
    // How search read the answered query: A typo it corrected or a correction it only suggests
    const [reading, setReading] = useState<Omit<Answer, "hits">>({})
    // The query the reader asked to search as typed, without correcting it
    const [asTyped, setAsTyped] = useState("")
    // The query the shown results answer. Until the newest query is answered, no result is not yet nothing found
    const [answered, setAnswered] = useState("")
    const [active, setActive] = useState(0)
    const [state, setState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle")
    const listId = useId()
    // Enter pressed before the query's results arrived opens the first of them when they do
    const [enter] = useState(() => new EnterIntent())

    const start = (loading: Promise<PagefindApi>) => {
        setState("loading")
        loading.then(
            () => setState("ready"),
            (error) => {
                console.error("Search could not load:", error)
                setState("unavailable")
            },
        )
    }

    const open = () => {
        if (!dialog.current || dialog.current.open) return
        dialog.current.showModal()
        input.current?.select()
        if (state === "idle") start(loadPagefind())
        else if (state === "unavailable") start(reopenPagefind())
    }

    const retry = () => {
        input.current?.focus()
        start(reopenPagefind())
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

    const go = (hit: Hit | undefined) => {
        if (hit) window.location.assign(hit.url)
    }

    useEffect(() => {
        if (state !== "ready") return
        const text = query.trim()
        // One letter matches the start of almost every page, so a search waits for a second one
        if (!searchable(text)) {
            setHits([])
            setReading({})
            // Cleared results answer no query. The same query typed again then waits for its own answer, so Enter opens its
            // first result once it arrives, and nothing found never shows before it does
            setAnswered("")
            return
        }
        let stale = false
        answer(text, () => stale, text === asTyped).then(
            (next) => {
                if (!next || stale) return
                setHits(next.hits)
                setReading({ readAs: next.readAs, suggestion: next.suggestion })
                setAnswered(text)
                setActive(0)
                go(enter.arrive(text, next.hits))
            },
            (error) => {
                if (stale) return
                enter.clear()
                console.error("Search failed:", error)
                setHits([])
                setReading({})
                setAnswered("")
                setState("unavailable")
            },
        )
        return () => {
            stale = true
        }
    }, [query, state, asTyped])

    // Searches again for a query the reader picks from the note, as typed or as suggested
    const searchFor = (text: string, typed: boolean) => {
        enter.clear()
        setAsTyped(typed ? text : "")
        setQuery(text)
        input.current?.focus()
    }

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (composing(event.nativeEvent)) return
        // A search field's own Escape would only clear the query. Escape leaves search, as the Esc button does
        if (event.key === "Escape") {
            event.preventDefault()
            dialog.current?.close()
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            if (!hits.length) return
            const step = event.key === "ArrowDown" ? 1 : -1
            const next = (active + step + hits.length) % hits.length
            setActive(next)
            document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" })
        } else if (event.key === "Enter") {
            event.preventDefault()
            go(enter.press(query.trim(), answered, hits, active))
        }
    }

    const message =
        state === "unavailable"
            ? "Search could not load. Check the connection and try again"
            : state === "loading"
              ? "Opening the index"
              : searchable(query.trim()) && answered === query.trim() && !hits.length && !reading.suggestion
                ? `Nothing found for “${query.trim()}”`
                : ""
    // The note above the results, where a phone's keyboard does not hide it: A corrected typo with a way back to the
    // query as typed, or a correction search only suggests
    const shown = answered === query.trim() && state === "ready"
    // The query as read stands out from the muted note, so a one-letter correction is not missed. A long query, such as a
    // pasted log line, shows only part of it, so the note stays short and the first result stays in view on a phone. Each
    // button's spoken name also holds the whole query it searches
    const again = `Search “${brief(answered)}”`
    const offered = reading.suggestion && `Search “${brief(reading.suggestion, answered)}”`
    const note = shown && reading.readAs ? (
        <p className="search-note">
            <span>
                Results for “<strong>{brief(reading.readAs, answered)}</strong>”
            </span>
            <button className="search-again" type="button" aria-label={spoken(again, answered)} onClick={() => searchFor(answered, true)}>
                {again}
            </button>
        </p>
    ) : shown && reading.suggestion ? (
        <p className="search-note">
            <span>
                {hits.length ? "" : `Nothing found for “${brief(answered)}”. `}Did you mean “<strong>{brief(reading.suggestion, answered)}</strong>”?
            </span>
            <button className="search-again" type="button" aria-label={spoken(offered!, reading.suggestion)} onClick={() => searchFor(reading.suggestion!, false)}>
                {offered}
            </button>
        </p>
    ) : null

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
                onClose={() => enter.clear()}
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
                        onChange={(event) => {
                            enter.clear()
                            setQuery(event.target.value)
                        }}
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
                {/* Always on the page, so a screen reader announces a note that appears in it */}
                <div className="search-notes" role="status">
                    {note}
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
                    {state === "unavailable" && (
                        <button className="search-retry" type="button" onClick={retry}>
                            Retry
                        </button>
                    )}
                </p>
            </dialog>
        </>
    )
}
