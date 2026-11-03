import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"
import { answer as answerQuery, pagefindOptions, searchable, type Hit, type PagefindApi, type PagefindModule } from "../lib/docs-search"
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
}
const answer = (text: string, isStale: () => boolean) => answerQuery(text, isStale, copies)

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
            // Cleared results answer no query. The same query typed again then waits for its own answer, so Enter opens its
            // first result once it arrives, and nothing found never shows before it does
            setAnswered("")
            return
        }
        let stale = false
        answer(text, () => stale).then(
            (next) => {
                if (!next || stale) return
                setHits(next)
                setAnswered(text)
                setActive(0)
                go(enter.arrive(text, next))
            },
            (error) => {
                if (stale) return
                enter.clear()
                console.error("Search failed:", error)
                setHits([])
                setAnswered("")
                setState("unavailable")
            },
        )
        return () => {
            stale = true
        }
    }, [query, state])

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
