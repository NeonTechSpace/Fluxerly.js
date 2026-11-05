// Writes the words of a built search index to <site>/pagefind/words.json, most common first, so docs search can read a
// mistyped word as the closest word the docs use. Pagefind has no typo tolerance, so without it colector finds nothing.
// Beside them go the real words close to a docs word, so search never reads a correctly spelled word as a typo. It also
// writes <site>/pagefind/headings.json, how many pages share each heading, so search weighs a heading that sorts many
// pages, such as Variables, below one that names a single page's topic.
// Run it after Pagefind has indexed the site: node scripts/docs/search-words.mjs dist
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
// The spell checker the repository's lint uses, a devDependency of the workspace root
import { checkText } from "cspell"
import { headingKey } from "../../src/lib/docs-search.ts"

// Words shorter than this are left out. A typo in a three-letter word has too many close neighbours to correct
const shortestWord = 4

// The words of a text as search compares them: Lowercase letters and digits, so createTestBot is createtestbot
const wordsOf = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= shortestWord && /^\p{L}/u.test(word))

export async function writeSearchWords(site) {
    const index = join(site, "pagefind")
    // Pagefind reads its own files with fetch. Here they come from disk
    const send = globalThis.fetch
    globalThis.fetch = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (!url.startsWith("file:")) throw new Error(`Reading the search index fetches only its files, not ${url}`)
        return new Response(await readFile(fileURLToPath(url)))
    }
    try {
        const pagefind = await import(pathToFileURL(join(index, "pagefind.js")).href)
        const api = pagefind.createInstance({ baseUrl: "/" })
        await api.init()
        // A null query finds every page
        const { results } = await api.search(null)
        const pages = new Map()
        const texts = new Map()
        const ids = new Map()
        // Each heading's pages and their titles
        const count = (counts, keys, url, title) => {
            for (const key of new Set(keys)) {
                const seen = counts.get(key) ?? { pages: new Set(), titles: new Set() }
                seen.pages.add(url)
                seen.titles.add(title)
                counts.set(key, seen)
            }
        }
        for (const result of results) {
            const data = await result.data()
            for (const word of new Set(wordsOf(`${data.meta.title ?? ""} ${data.meta.search ?? ""} ${data.raw_content}`))) pages.set(word, (pages.get(word) ?? 0) + 1)
            const headings = data.anchors.filter((anchor) => /^h\d$/i.test(anchor.element) && /\S/.test(anchor.text))
            const title = data.meta.title ?? data.url
            count(texts, headings.map((anchor) => headingKey(anchor.text)), data.url, title)
            count(ids, headings.map((anchor) => anchor.id), data.url, title)
        }
        await api.destroy()
        // Only the headings two pages or more share. Any other heading is on one page. Pages with the same title, such as
        // one reference page for each entry point, are copies of one page, so a heading only they share is that page's own
        const shared = (counts) =>
            Object.fromEntries(
                [...counts]
                    .map(([key, seen]) => [key, seen.titles.size > 1 ? seen.pages.size : 1])
                    .filter(([, pageCount]) => pageCount > 1)
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
            )
        const sharing = { texts: shared(texts), ids: shared(ids) }
        await writeFile(join(index, "headings.json"), JSON.stringify(sharing))
        // Most common first, so of two equally close words the one more pages use wins
        const words = [...pages].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([word]) => word)
        const real = shippable(await realWordsNear(words))
        await writeFile(join(index, "words.json"), JSON.stringify({ words, real }))
        return { words: words.length, real: real.length, shared: Object.keys(sharing.texts).length + Object.keys(sharing.ids).length }
    } finally {
        globalThis.fetch = send
    }
}

// The spell checker's American and British English dictionaries and software terms, so categorise is as real as
// categorize, without its lists of joined code words, which accept connectio as connect and io. Nearly every word
// checked here is misspelled, so no limit cuts the report short
const spelling = {
    version: "0.2",
    language: "en",
    dictionaries: ["en-gb", "!coding-compound-terms", "!cpp-compound-words"],
    maxNumberOfProblems: 10_000_000,
    maxDuplicateProblems: 10_000_000,
}

// Words longer than this are joined code names, such as selectcontentembedattachmentorstickerbeforebuild, which the
// spell checker skips as random text rather than checks, and no English word near them is that long
const longestWord = 24

// Profanity the real-word list leaves out, with its endings such as -s, -ing, -ed, -er and -y, so the public words.json
// holds none. The spell checker counts such words as real, near docs words such as count and shift. Search treats a
// word left out as it treats any word the spell checker lacks
const unlisted = ["bitch", "cock", "cunt", "dick", "fag", "fuck", "piss", "shit", "slut", "twat", "wank", "whore"]
const profane = new RegExp(`^(?:${unlisted.join("|")})(?:s|es|ed|er|ers|ing|ings|y|ty|ter|ters|ting|ted)?$`)
export const shippable = (real) => real.filter((word) => !profane.test(word))

// Whether each word checked so far is a real word, so the public build checks a word once across its versions
const checked = new Map()

// The real words a typo could look like: Each word one missing letter, two swapped letters or one doubled letter away
// from a docs word, as lunch is from launch, preset from present and loose from lose, that the spell checker knows.
// Search reads such a slip as the docs word, so for these it only suggests the docs word. The first letter stays, as
// search keeps it, and the start of a docs word is left out, as search reads it as a word being typed
async function realWordsNear(words) {
    const starts = new Set(words.flatMap((word) => Array.from(word, (_, at) => word.slice(0, at + 1))))
    const near = new Set()
    const add = (word) => {
        if (word.length >= shortestWord && !starts.has(word)) near.add(word)
    }
    for (const word of words) {
        if (!/^[a-z]+$/.test(word) || word.length > longestWord) continue
        for (let at = 1; at < word.length; at++) add(word.slice(0, at) + word.slice(at + 1))
        for (let at = 1; at + 1 < word.length; at++) add(word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2))
        for (let at = 0; at < word.length; at++) add(word.slice(0, at + 1) + word.slice(at))
    }
    const unchecked = [...near].filter((word) => !checked.has(word))
    if (unchecked.length) {
        const folder = await mkdtemp(join(tmpdir(), "search-words-"))
        try {
            const list = join(folder, "near.txt")
            const config = join(folder, "cspell.json")
            await writeFile(list, unchecked.join("\n"))
            await writeFile(config, JSON.stringify(spelling))
            const { items } = await checkText(list, { config })
            const misspelled = new Set(items.filter((item) => item.isError).map((item) => item.text))
            for (const word of unchecked) checked.set(word, !misspelled.has(word))
        } finally {
            await rm(folder, { recursive: true, force: true })
        }
    }
    return [...near].filter((word) => checked.get(word)).sort()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const site = resolve(process.argv[2] ?? "dist")
    const counts = await writeSearchWords(site)
    console.log(`Wrote ${counts.words} search words and ${counts.real} real words close to them to ${join(site, "pagefind", "words.json")}, and ${counts.shared} shared heading texts and addresses to headings.json`)
}
