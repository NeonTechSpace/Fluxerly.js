// Words readers type for things the docs name differently, and the words the docs use for them. Docs search also looks
// for a query with these words swapped in, so event listener finds the events and handlers section. The pages keep their
// own wording, and nothing here is written into them
//
// The rules for an entry: General developer vocabulary a reader would really type, mapped to words the docs really use
// for the same thing, never to a page. Keys are lowercase. The search check fails when a docs word here is missing from
// the built index's word list, which holds words of four letters or more, so a docs word must be at least that long. A
// word ending in s also matches its form without the s, so listeners finds handler

export const synonyms: Readonly<Record<string, readonly string[]>> = {
    // What the docs call a handler
    listener: ["handler"],
    // A failure, which the docs call an error, and which the default API returns as a Result instead of throwing
    exception: ["error", "result"],
    // A private conversation with one user, which the docs call a direct message
    dm: ["direct message"],
    "private message": ["direct message"],
    // Deleting many messages at once, as the docs' deleteMany does
    "bulk delete": ["delete many"],
    // Answering a message
    respond: ["reply"],
    // A stand-in for Fluxer in tests, which the docs call fake
    mock: ["fake"],
    mocking: ["fake"],
    stub: ["fake"],
    // Logging libraries a bot may already use, which the docs cover as an existing logger
    pino: ["logger"],
    winston: ["logger"],
    bunyan: ["logger"],
    // What keeps a gateway connection alive
    keepalive: ["heartbeat"],
    "keep alive": ["heartbeat"],
    // Running work at set times. A cron job is the whole phrase for it
    cron: ["schedule"],
    "cron job": ["schedule"],
    // Settings from the environment
    "env var": ["environment variable"],
    // Holding back requests that come too fast
    throttle: ["rate limit"],
    throttling: ["rate limit"],
}

// The longest entry, in words
const longest = Math.max(...Object.keys(synonyms).map((term) => term.split(" ").length))

// The docs words for a reader's word or phrase, or nothing. Only the map's own entries count, not names every object has
// such as constructor
const entry = (term: string) => (Object.hasOwn(synonyms, term) ? synonyms[term] : undefined)
const docsWords = (term: string) => entry(term) ?? (term.endsWith("s") ? entry(term.slice(0, -1)) : undefined)

// Whether a word is a reader's word with docs words, which typo correction leaves as typed
export const isReaderWord = (word: string) => !!docsWords(word)

// The query with the docs' words swapped in for a reader's words, one version for each choice of docs word, at most
// four. A query without such a word has none
export function synonymVariants(text: string): string[] {
    const tokens = text.split(/\s+/).filter(Boolean)
    const plain = tokens.map((token) => token.toLowerCase().replace(/[?!.,;:]+$/, ""))
    let variants: string[][] = [[]]
    let swapped = false
    for (let index = 0; index < tokens.length; ) {
        // The longest phrase that starts here and has docs words
        let size = Math.min(longest, tokens.length - index)
        while (size > 0 && !docsWords(plain.slice(index, index + size).join(" "))) size--
        const words = size ? docsWords(plain.slice(index, index + size).join(" "))! : [tokens[index]!]
        if (size) swapped = true
        variants = variants.flatMap((variant) => words.map((word) => [...variant, word])).slice(0, 4)
        index += size || 1
    }
    return swapped ? variants.map((variant) => variant.join(" ")) : []
}
