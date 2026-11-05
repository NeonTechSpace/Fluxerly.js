// Tests what docs search answers for a mistyped word, for a query whose answering page lacks one of its words, and which
// section of the right page a query opens. A small index stands in for Pagefind: It finds the pages that hold every
// word of a query, each word as typed or as the start of a longer word, as Pagefind does
import assert from "node:assert/strict"
import { test } from "node:test"
import { answer, correction, headingKey, type PagefindApi, type PagefindResult, type SearchCopies } from "../src/lib/docs-search.ts"
import { synonymVariants, synonyms } from "../src/lib/search-synonyms.ts"

interface Page {
    url: string
    title: string
    // Each section is a heading and its text. The first one, without a heading, is the page's own opening
    sections: { id?: string; heading?: string; text: string }[]
}

function index(pages: Page[]): PagefindApi {
    const built = pages.map((page) => {
        const words: string[] = []
        const anchors = page.sections.flatMap((section) => {
            const location = words.length
            if (section.heading) words.push(...section.heading.split(" "))
            words.push(...section.text.split(" "))
            return section.id ? [{ element: "h2", id: section.id, text: section.heading ?? "", location }] : []
        })
        return { page, words, anchors }
    })
    const plain = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
    const search = async (query: string | null) => {
        const terms = (query ?? "").split(/\s+/).map(plain).filter(Boolean)
        const results: PagefindResult[] = built.flatMap(({ page, words, anchors }) => {
            const locations = words.flatMap((word, location) => (terms.some((term) => plain(word).startsWith(term)) ? [location] : []))
            if (query !== null && !terms.every((term) => words.some((word) => plain(word).startsWith(term)))) return []
            return [
                {
                    id: page.url,
                    score: locations.length,
                    words: locations,
                    data: async () => ({ url: page.url, raw_content: words.join(" "), locations, anchors, meta: { title: page.title } }),
                },
            ]
        })
        return { results: results.sort((a, b) => b.score - a.score) }
    }
    // No page has an alias here
    return { init: async () => {}, destroy: async () => {}, search, debouncedSearch: search, filters: async () => ({}) }
}

// real stands for the real words the build finds close to a docs word with the spell checker
function copies(pages: Page[], real: string[] = []): SearchCopies {
    const api = index(pages)
    const counts = new Map<string, number>()
    for (const page of pages) {
        const words = new Set(page.sections.flatMap((section) => `${section.heading ?? ""} ${section.text}`.toLowerCase().split(/[^\p{L}\p{N}]+/u)))
        for (const word of words) if (word.length >= 4) counts.set(word, (counts.get(word) ?? 0) + 1)
    }
    return {
        searcher: async () => api,
        checker: async () => api,
        reachIndex: async () => {},
        failedChunks: () => 0,
        forgetSearcher() {},
        forgetChecker() {},
        words: async () => ({ words: [...counts].sort((a, b) => b[1] - a[1]).map(([word]) => word), real }),
        pageCount: async () => pages.length,
        headings: async () => {
            const shared = (keys: (section: Page["sections"][number]) => string | undefined) => {
                const counts: Record<string, number> = {}
                for (const page of pages) for (const key of new Set(page.sections.flatMap((section) => (section.heading ? [keys(section)!] : [])))) counts[key] = (counts[key] ?? 0) + 1
                return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 1))
            }
            return { texts: shared((section) => headingKey(section.heading!)), ids: shared((section) => section.id) }
        },
    }
}

const search = async (pages: Page[], text: string) => (await answer(text, () => false, copies(pages)))?.hits ?? []

const filler = (page: string) => ({ url: `/docs/${page}/`, title: page, sections: [{ text: `A page about ${page} for a bot that sends messages` }] })

test("a mistyped word finds the page that uses the closest word", async () => {
    const collectors: Page = { url: "/docs/collectors/", title: "Collect replies", sections: [{ text: "A collector gathers replies until its time runs out" }] }
    const found = await answer("colector", () => false, copies([collectors, filler("threads"), filler("webhooks")]))
    assert.equal(found?.hits[0]?.url, "/docs/collectors/", `Results: ${found?.hits.map((hit) => hit.url).join(", ")}`)
    // The dialog shows the query as search read it, with a way back to the query as typed
    assert.equal(found?.readAs, "collector")
    // As typed, nothing is corrected
    const typed = await answer("colector", () => false, copies([collectors, filler("threads"), filler("webhooks")]), true)
    assert.equal(typed?.readAs, undefined)
})

test("a word list that fails to load is logged, and the search still answers", async (context) => {
    const errors: unknown[][] = []
    context.mock.method(console, "error", (...args: unknown[]) => errors.push(args))
    // Pages are cached by address across searches, so each test uses its own addresses
    const collectors: Page = { url: "/docs/collect-replies/", title: "Collect replies", sections: [{ text: "A collector gathers replies" }] }
    const broken = { ...copies([collectors, filler("threads")]), words: () => Promise.reject(new Error("offline")) }
    assert.deepEqual((await answer("colector", () => false, broken))?.hits, [])
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]?.[0]), /word list/)
})

// A word list without real words, for rules that do not depend on them
const docs = (...words: string[]) => ({ words, real: [] })

test("a missing, swapped or doubled letter is a typo search corrects, and a word being typed stays", () => {
    const words = docs("announcement", "collector", "troubleshooting", "message", "messages", "oauth", "send")
    assert.deepEqual(correction("anouncement", words), { text: "announcement", sure: true, confirm: false })
    // The reading keeps the reader's letter case
    assert.deepEqual(correction("Colector?", words), { text: "Collector", sure: true, confirm: false })
    assert.deepEqual(correction("COLECTOR", words), { text: "COLLECTOR", sure: true, confirm: false })
    assert.deepEqual(correction("handlerFaild", docs("handlerfailed")), { text: "handlerFailed", sure: true, confirm: false })
    assert.deepEqual(correction("oauht", words), { text: "oauth", sure: true, confirm: false })
    // A doubled last letter is no word ending, so sendd is no form of send
    assert.deepEqual(correction("sendd", words), { text: "send", sure: true, confirm: false })
    assert.deepEqual(correction("messagess", words), { text: "messages", sure: true, confirm: false })
    // The start of a word the docs use is a word being typed
    assert.equal(correction("troublesh", words), undefined)
    // A dotted name is read part by part, and a short word stays as typed
    assert.deepEqual(correction("client.colector", words), { text: "client.collector", sure: true, confirm: false })
    assert.equal(correction("mesg", words), undefined)
})

test("of two equally close docs words, the one a slip of the hand makes wins over the more common one", () => {
    // intent is more common and one letter apart, but intens lacks a letter of intents
    assert.deepEqual(correction("intens", docs("intent", "intents")), { text: "intents", sure: true, confirm: false })
})

test("a four-letter word that lacks a letter is read only where a heading confirms it", () => {
    // Many real words lack one letter of a docs word, as cars of cards, so the answer reads it only where a title or
    // heading names the query as read
    assert.deepEqual(correction("send embd", docs("send", "embed")), { text: "send embed", sure: false, confirm: true })
    assert.equal(correction("jest", docs("just", "jests")), undefined)
    // A real four-letter word is only suggested, even where a heading would name the reading
    assert.deepEqual(correction("cars", { words: ["cards"], real: ["cars"] }), { text: "cards", sure: false, confirm: false })
})

test("a real word is never rewritten: Another letter is only suggested, and a word whose stem the docs use stays", () => {
    const words = docs("model", "discard", "stack", "crash", "caching", "aggregate", "root", "them")
    // One letter for another is how a different real word differs, so search only suggests it
    assert.deepEqual(correction("modal", words), { text: "model", sure: false, confirm: false })
    assert.deepEqual(correction("discord", words), { text: "discard", sure: false, confirm: false })
    assert.deepEqual(correction("stuck", words), { text: "stack", sure: false, confirm: false })
    // Pagefind already finds crashing through crash, so it is no typo
    assert.equal(correction("crashing", words), undefined)
    assert.equal(correction("aggregated", words), undefined)
    // An added letter that doubles none is how robot differs from root, and theme from them
    assert.deepEqual(correction("robot", words), { text: "root", sure: false, confirm: false })
    assert.deepEqual(correction("dark theme", words), { text: "dark them", sure: false, confirm: false })
})

test("a real word the spell checker knows is only suggested, even when it looks like a slip", () => {
    const words = { words: ["launch", "present", "lose"], real: ["lunch", "preset", "loose"] }
    assert.deepEqual(correction("lunch", words), { text: "launch", sure: false, confirm: false })
    assert.deepEqual(correction("preset", words), { text: "present", sure: false, confirm: false })
    assert.deepEqual(correction("loose", words), { text: "lose", sure: false, confirm: false })
    // Without the spell checker's word, lunch would read as launch
    assert.deepEqual(correction("lunch", docs("launch")), { text: "launch", sure: true, confirm: false })
})

test("a clear typo is read before pages that miss one of the query's words are tried", async () => {
    const messages: Page = {
        url: "/docs/send-embeds/",
        title: "Messages",
        sections: [{ text: "Post text and embeds" }, { id: "send-an-embed", heading: "Send an embed", text: "An embed shows a title and fields" }],
    }
    // Its heading names all of send embd but embd, so without reading the typo first it would come first
    const direct: Page = { url: "/docs/direct/", title: "Direct messages", sections: [{ text: "Reach one user" }, { id: "send-a-direct-message", heading: "Send a direct message", text: "Open a channel with one user" }] }
    const found = await answer("send embd", () => false, copies([direct, messages, filler("threads")]))
    assert.equal(found?.readAs, "send embed")
    assert.equal(found?.hits[0]?.url, "/docs/send-embeds/#send-an-embed", `Results: ${found?.hits.map((hit) => hit.url).join(", ")}`)
})

test("a four-letter reading no title or heading names is only suggested, and a real word is never read", async () => {
    const embeds: Page = { url: "/docs/embed-fields/", title: "Fields", sections: [{ text: "You can send an embed with fields" }] }
    const found = await answer("send embd", () => false, copies([embeds, filler("threads")]))
    assert.equal(found?.readAs, undefined)
    assert.equal(found?.suggestion, "send embed")
    const cards: Page = { url: "/docs/cards/", title: "Send cards", sections: [{ text: "Cards hold a title" }] }
    const real = await answer("send cars", () => false, copies([cards, filler("threads")], ["cars"]))
    assert.equal(real?.readAs, undefined)
    assert.equal(real?.suggestion, "send cards")
})

test("the note shows a corrected method as the reader wrote it, client. included", async () => {
    const reference: Page = {
        url: "/docs/api/js-ts/client-messages/",
        title: "Messages",
        sections: [{ text: "Entries" }, { id: "send", heading: "messages.send", text: "messages.send posts a message" }],
    }
    const found = await answer("client.mesages.send", () => false, copies([reference, filler("threads")]))
    assert.equal(found?.readAs, "client.messages.send")
    assert.equal(found?.hits[0]?.url, "/docs/api/js-ts/client-messages/#send", `Results: ${found?.hits.map((hit) => hit.url).join(", ")}`)
    // A suggestion keeps it too
    const choice: Page = { url: "/docs/api/js-ts/client-fetch/", title: "Fetch", sections: [{ text: "Entries" }, { id: "fetch", heading: "messages.fetch", text: "messages.fetch reads a message" }] }
    assert.equal((await answer("client.messages.fetcj", () => false, copies([choice, filler("threads")])))?.suggestion, "client.messages.fetch")
})

test("the note shows a pasted log line with its code corrected in place", async () => {
    const codes: Page = { url: "/docs/codes-list/", title: "Codes", sections: [{ text: "Entries" }, { id: "handler-failed", heading: "events.handlerFailed", text: "events.handlerFailed is logged when a handler fails" }] }
    const found = await answer("[events.handlerFaild] boom", () => false, copies([codes, filler("threads")]))
    assert.equal(found?.readAs, "[events.handlerFailed] boom")
})

test("an escaped character at the end of a marked word stays whole, so the excerpt shows > rather than &gt", async () => {
    // Pagefind's text escapes < and >, as in this type from the reference
    const reference: Page = { url: "/docs/api/js-ts/splash/", title: "Splash", sections: [{ text: 'Pass Pick&lt;Guild, "embedSplash"&gt;;, to read the splash' }] }
    const hits = await search([reference, filler("threads")], "embedsplash")
    assert.match(hits[0]?.excerpt ?? "", /&gt;<\/mark>;,/)
    assert.doesNotMatch(hits[0]?.excerpt ?? "", /&amp;gt/)
})

test("a heading that half the pages holding a word share, such as Variables, names no topic for that word", async () => {
    // Differently titled reference pages each file their exported values under Variables
    const reference = (name: string): Page => ({
        url: `/docs/api/js-ts/${name}-values/`,
        title: `${name} values`,
        sections: [{ text: "Entries" }, { id: "kind-variable", heading: "Variables", text: "A variable read from the environment" }],
    })
    const configuration: Page = { url: "/docs/configure/", title: "Configure a bot", sections: [{ text: "Settings" }, { id: "token", heading: "Token", text: "Read the token from an environment variable, the environment variable FLUXER_BOT_TOKEN" }] }
    // Pages without the word give it a weight
    const others = ["threads", "webhooks", "logging", "guilds"].map(filler)
    const hits = await search([reference("sharding"), reference("oauth"), reference("builders"), configuration, ...others], "environment variable")
    assert.equal(hits[0]?.url, "/docs/configure/#token", `Results: ${hits.map((hit) => hit.url).join(", ")}`)
})

test("a page whose heading names all but one word of the query comes before a page that only uses every word", async () => {
    const faq: Page = {
        url: "/docs/faq/",
        title: "Frequently asked questions",
        sections: [
            { text: "Short answers" },
            { id: "why-does-the-bot-not-see-messages", heading: "Why does the bot not see messages?", text: "The bot needs permission to view the channel" },
        ],
    }
    const testing: Page = {
        url: "/docs/testing/",
        title: "Test a bot",
        sections: [{ text: "A test checks that the bot does not respond to messages it should ignore, and that it does respond to commands" }],
    }
    const hits = await search([testing, faq, filler("threads")], "bot does not respond to messages")
    assert.equal(hits[0]?.url, "/docs/faq/#why-does-the-bot-not-see-messages", `Results: ${hits.map((hit) => hit.url).join(", ")}`)
    // The page that holds every word still follows
    assert.ok(hits.some((hit) => hit.url === "/docs/testing/"))
})

test("the section whose heading names the query's rarest word opens instead of the page's opening", async () => {
    const commands: Page = {
        url: "/docs/commands/",
        title: "Add commands to a bot",
        sections: [
            { text: "Register commands, add guards and cooldowns, and generate help" },
            { id: "register-commands", heading: "Register commands", text: "Each command has a name and a handler" },
            { id: "cooldowns", heading: "Limit commands with a cooldown", text: "A cooldown limits how often each user can run a command, and another cooldown can cover a channel" },
        ],
    }
    const hits = await search([commands, filler("threads"), filler("webhooks"), filler("logging")], "how to add a cooldown to a command")
    assert.equal(hits[0]?.url, "/docs/commands/#cooldowns", `Results: ${hits.map((hit) => hit.url).join(", ")}`)
})

test("a reader's word is also searched as the word the docs use for it", () => {
    assert.deepEqual(synonymVariants("event listeners"), ["event handler"])
    assert.deepEqual(synonymVariants("send a Private message?"), ["send a direct message"])
    // One version for each docs word
    assert.deepEqual(synonymVariants("handle exceptions"), ["handle error", "handle result"])
    assert.deepEqual(synonymVariants("event handler"), [])
    // A word every object has, such as constructor, is not in the map
    assert.deepEqual(synonymVariants("constructor"), [])
})

test("every reader word in the synonym map is lowercase, so a query can match it", () => {
    assert.deepEqual(Object.keys(synonyms).filter((word) => word !== word.toLowerCase()), [])
})

test("a query in a reader's words finds the section the docs name with their own", async () => {
    const events: Page = {
        url: "/docs/core-concepts/",
        title: "Core concepts",
        sections: [{ text: "The ideas behind a bot" }, { id: "events-and-handlers", heading: "Events and handlers", text: "A handler runs for each event" }],
    }
    const signals: Page = { url: "/docs/signals/", title: "Signals", sections: [{ text: "An abort signal takes an event listener" }] }
    const hits = await search([signals, events, filler("threads")], "event listener")
    assert.equal(hits[0]?.url, "/docs/core-concepts/#events-and-handlers", `Results: ${hits.map((hit) => hit.url).join(", ")}`)
})

test("a query holding a name every object has, such as constructor, is no alias, so it does not read the whole index", async () => {
    const pages = [filler("errors"), filler("threads")]
    const plain = copies(pages)
    const api = await plain.searcher()
    let filterSearches = 0
    const counting: PagefindApi = {
        ...api,
        filters: async () => ({ alias: { "first bot": 1 } }),
        search: async (query, options) => {
            if (query === null && options?.filters) filterSearches += 1
            return api.search(query, options)
        },
    }
    const withAlias = { ...plain, searcher: async () => counting, checker: async () => counting }
    await answer("constructor", () => false, withAlias)
    assert.equal(filterSearches, 0)
    // A real alias still runs it
    await answer("first bot", () => false, withAlias)
    assert.ok(filterSearches > 0)
})

test("a JavaScript & TypeScript entry comes before its Effect twin, also in a corrected answer", async () => {
    const twin = (entry: string, text: string): Page => ({
        url: `/docs/api/${entry}/collecting/`,
        title: "Collecting",
        sections: [{ text: "Entries" }, { id: "collector", heading: "Collector", text }],
    })
    // The Effect page holds the word more often, so Pagefind scores it higher
    const pages = [twin("effect", "A collector collector collector in a scope"), twin("js-ts", "A collector that gathers replies"), filler("threads")]
    const found = await answer("colector", () => false, copies(pages))
    assert.equal(found?.readAs, "collector")
    assert.equal(found?.hits[0]?.url, "/docs/api/js-ts/collecting/#collector", `Results: ${found?.hits.map((hit) => hit.url).join(", ")}`)
})
