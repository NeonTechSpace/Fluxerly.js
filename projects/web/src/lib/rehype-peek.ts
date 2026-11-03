// Marks what docs prose names, so a reader can tell an API name, a code, a log level or a glossary term at a glance and
// hover or focus it for a peek. Each mark is a link to where the thing is explained, so a tap on a touch screen
// follows it. It works on the rendered HTML tree of a guide or a reference comment, after code blocks are highlighted,
// and never enters example code, headings or links.
//
// Every occurrence it recognises is marked, and one fixed rule per kind decides how loud the mark is. A name or a code
// is marked in full at its first mention in each h2 section and quietly after that, a glossary term in full at its
// first use on the page and quietly after that, and a level or a status code looks the same every time. In a reference
// comment, the comment is the section, and glossary terms are quiet, as each comment is read on its own.
// Recognition follows rules over the reference model, the code catalogue and the glossary, never lists of pages or terms
import type { ApiMember, ApiNode, PeekTerms } from "./peek-index.ts"
import type { Type } from "./reference"

interface Text {
    type: "text"
    value: string
}

interface Element {
    type: "element"
    tagName: string
    properties: Record<string, unknown>
    children: Node[]
}

type Node = Text | Element | { type: string; children?: Node[]; value?: string }

export type MarkKind = "api" | "code" | "level" | "term"

interface Candidate {
    kind: MarkKind
    key: string
    href: string
    /** For a level, its name, which colors the tag */
    level?: string
    /** A peek key that is not the link itself, such as a status code's */
    peek?: string
    /** The text node and the span inside it, or the inline code element the mark wraps */
    text?: Text
    start?: number
    end?: number
    code?: Element
    parent: Element
    quiet?: boolean
}

export interface RehypePeekOptions {
    terms: PeekTerms
    /** The page's guide slug when the file path does not say, such as "logging" */
    page?: string
    /** Called with every mark in reading order, for counting */
    onMark?: (mark: { kind: MarkKind; key: string; text: string; quiet: boolean }) => void
    /** A digest of the terms' sources. Unused here, it makes Astro render cached Markdown again when they change */
    digest?: string
    /** A reference comment rather than a guide: the comment is the section, and glossary terms are quiet */
    comment?: boolean
}

const isElement = (node: Node): node is Element => node.type === "element"
const isText = (node: Node): node is Text => node.type === "text"

const skipped = new Set(["pre", "a", "button", "summary", "script", "style", "svg", "kbd", "samp", "th", "h1", "h2", "h3", "h4", "h5", "h6"])
const blocks = new Set(["p", "li", "td", "dd", "dt", "blockquote", "figcaption", "caption"])
const sectionBreaks = new Set(["h1", "h2"])

// Where two recognitions overlap, the more specific kind wins
const priority: Record<MarkKind, number> = { code: 0, level: 0, api: 1, term: 2 }

const classes: Record<MarkKind, string[]> = {
    api: ["peek", "peek-api"],
    code: ["peek", "peek-code"],
    level: ["peek", "peek-level"],
    term: ["peek", "peek-term"],
}

/** The page a file renders, by its guide slug, such as effect-first-bot. Guides sit in content/guides in the working tree
 * and in content/<version>/guides in a published version's snapshot */
function pageOf(path: string | undefined): string | undefined {
    return /[\\/]guides[\\/]([\w-]+)\.md$/.exec(path ?? "")?.[1]
}

/** The entry points a page looks names up in. A guide whose slug holds every word of an entry point's key, such as
 * effect-application-testing for effect-testing, looks there first, the most specific first */
export function preferredEntries(entries: string[], page?: string): string[] {
    const words = new Set(page?.split("-") ?? [])
    const matching = entries.filter((key) => key.split("-").every((word) => words.has(word))).sort((a, b) => b.split("-").length - a.split("-").length)
    return [...matching, ...entries.filter((key) => !matching.includes(key))]
}

// Following a dotted path

function nodeOfType(terms: PeekTerms, type: Type | undefined, member: string): ApiNode | undefined {
    if (!type || typeof type === "string") return undefined
    if ("r" in type) {
        const node = type.h ? terms.byUrl.get(type.h) : undefined
        if (node?.members.has(member)) return node
        // A Promise, Result or Readonly wraps the type that has the member
        return type.a?.map((argument) => nodeOfType(terms, argument, member)).find(Boolean)
    }
    if (type.k === "union" || type.k === "and") return type.t.map((inner) => nodeOfType(terms, inner, member)).find(Boolean)
    return undefined
}

function walk(terms: PeekTerms, start: ApiNode | ApiMember, rest: string[]): string | undefined {
    let at: ApiNode | ApiMember = start
    for (const name of rest) {
        const node: ApiNode | undefined = "members" in at ? at : nodeOfType(terms, at.next, name)
        const member = node?.members.get(name)
        if (!member) return undefined
        at = member
    }
    return at.key
}

const lookup = <T>(table: Map<string, T> | undefined, entries: string[]) => entries.map((key) => table?.get(key)).find((value) => value !== undefined)

export interface ApiContext {
    /** Entry points in lookup order */
    entries: string[]
    /** Plain prose rather than code */
    loose: boolean
    /** The sentence calls it an option, as in "the cache option" */
    calledOption?: boolean
    /** The code gives it a value, as in sharding: "auto" */
    valued?: boolean
}

const humped = (name: string) => /[a-z][A-Z]/.test(name)

/** The peek key of an API path such as runBot, client.on or gateway.ignoredEvents, if the reference has one */
export function resolveApi(terms: PeekTerms, path: string, context: ApiContext): string | undefined {
    const [root, ...rest] = path.split(".")
    if (!root) return undefined
    const declaration = lookup(terms.declarations.get(root), context.entries)
    const starts: (ApiNode | ApiMember | undefined)[] = []
    if (!context.loose) {
        // A lone lowercase word such as format, cache or signal is often something else: a log category, a
        // handler's own signal or another options object. It names a namespace or an option only when the code
        // goes on to a member or a value, the sentence calls it an option, or the name is distinctive like onError
        const lone = !rest.length && /^[a-z]/.test(root)
        const optionLike = !lone || context.valued || context.calledOption || humped(root)
        const declared = declaration && (!lone || declaration.kind === "function" || declaration.kind === "class") ? declaration : undefined
        const option = optionLike ? lookup(terms.options.get(root), context.entries) : undefined
        starts.push(...(context.calledOption ? [option, declared] : [declared, option]))
        if (rest.length) {
            // A variable named after a type is one of them, as client is a Client
            const named = /^[a-z]/.test(root) ? lookup(terms.declarations.get(root[0]!.toUpperCase() + root.slice(1)), context.entries) : undefined
            if (named?.kind === "interface" || named?.kind === "class") starts.push(named)
            // Guides write members.fetch for a part of what the entry point creates, the Client
            for (const key of context.entries) for (const created of terms.instances.get(key) ?? []) starts.push(created.members.get(root))
        }
    } else if (rest.length || humped(root)) {
        // Plain prose names only declarations whose name could not be an ordinary word, or a declaration's member
        starts.push(declaration)
    }
    for (const start of starts) {
        if (!start) continue
        const key = walk(terms, start, rest)
        if (key && terms.known.has(key)) return key
    }
    return undefined
}

// What inline code names: a log or error code, else an API path with an optional call or value after it. The word
// after the code can decide, as in "the gateway.send method" against a gateway.send record
function recogniseCode(terms: PeekTerms, value: string, entries: string[], nextWord: string): { kind: MarkKind; key: string } | undefined {
    const text = value.trim()
    const calledApi = /^(?:methods?|functions?|options?|property|properties|hooks?)$/.test(nextWord)
    // A readable log line shows its record code in brackets, as in [lifecycle.connectionLost]
    const code = terms.codes.get(/^\[([\w.]+)\]$/.exec(text)?.[1] ?? text)
    const known = code && terms.known.has(code) ? code : undefined
    const api = () => {
        const match = /^(?:new\s+|await\s+)?([A-Za-z_$][\w$]*(?:(?:\(\))?\.[A-Za-z_$][\w$]*)*)(\(.*\))?(\s*:\s*.+)?$/s.exec(text)
        if (!match) return undefined
        const key = resolveApi(terms, match[1]!.replaceAll("()", ""), { entries, loose: false, calledOption: /^options?$/.test(nextWord), valued: !!match[3] })
        return key ? { kind: "api" as const, key } : undefined
    }
    if (known && !calledApi) return { kind: "code", key: known }
    return api() ?? (known ? { kind: "code", key: known } : undefined)
}

interface Found {
    kind: MarkKind
    key: string
    start: number
    end: number
    level?: string
}

const httpChain = /\bHTTP\s+(\d{3}(?:\s*,\s*\d{3})*(?:,?\s+(?:or|and)\s+\d{3})?)\b/g
const httpBare = /(?<![\w.,$-])(\d{3}(?:\s*,\s*\d{3})*(?:,?\s+(?:or|and)\s+\d{3})?)(?=\s+(?:rejections?|responses?|status)\b)/g
const closeNamed = /\b(?:[Cc]lose|[Cc]ode)\s+(\d{4}(?:,?\s+(?:or|and)\s+\d{4})?)\b/g
const closeBare = /(?<![\w.,$-])(\d{4})(?![\w-]|,\d)/g
const apiWords = /(?<![\w.$/#@'-])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|[A-Za-z_$]*[a-z][A-Z][\w$]*)(?![\w$-])/g

// Every number in a matched chain such as 401 or 403, with its place in the text
function numbers(match: RegExpExecArray, group: number): { value: number; start: number; end: number }[] {
    const offset = match.index + match[0].indexOf(match[group]!)
    return [...match[group]!.matchAll(/\d+/g)].map((number) => ({ value: Number(number[0]), start: offset + number.index, end: offset + number.index + number[0].length }))
}

interface Scan {
    terms: PeekTerms
    entries: string[]
    levelWords: RegExp
    /** Glossary terms are not looked for on the page that defines them */
    glossary: boolean
    /** Whether the text starts a sentence: it opens its block, or the text before it ends one */
    opensBlock: boolean
    blockText: string
}

function scanText(value: string, scan: Scan): Found[] {
    const { terms } = scan
    const found: Found[] = []
    const add = (kind: MarkKind, key: string | undefined, start: number, end: number, level?: string) => key && found.push({ kind, key, start, end, ...(level ? { level } : {}) })
    for (const pattern of [httpChain, httpBare]) for (const match of value.matchAll(pattern)) for (const number of numbers(match, 1)) add("code", terms.http.get(number.value), number.start, number.end)
    for (const match of value.matchAll(closeNamed)) for (const number of numbers(match, 1)) add("code", terms.close.get(number.value), number.start, number.end)
    // A bare four-digit close code counts only where the paragraph speaks of closing
    if (/\bclos(?:e|es|ed|ing|ure)\b/i.test(scan.blockText))
        for (const match of value.matchAll(closeBare)) add("code", terms.close.get(Number(match[1])), match.index, match.index + match[0].length)
    const opensSentence = (at: number) => {
        const before = value.slice(0, at)
        return (before.trim() === "" && scan.opensBlock) || /[.!?]\s+$/.test(before)
    }
    for (const match of value.matchAll(scan.levelWords)) {
        // A level word that opens a sentence is a level only when records follow, as in "Debug records"
        if (opensSentence(match.index) && !/^\s+records?\b/.test(value.slice(match.index + match[0].length))) continue
        if (/\bnew\s+$/.test(value.slice(0, match.index))) continue
        add("level", terms.levels.get(match[1]!), match.index, match.index + match[0].length, match[1]!.toLowerCase())
    }
    for (const match of value.matchAll(apiWords)) add("api", resolveApi(terms, match[1]!, { entries: scan.entries, loose: true }), match.index, match.index + match[1]!.length)
    if (scan.glossary)
        for (const term of terms.glossary)
            for (const match of value.matchAll(term.pattern)) {
                // A sentence that opens with a name such as Effect, or with a singular word such as "Identify each
                // copy", often opens with an ordinary word or a verb. "Events sent during the move" is the term
                const opening = opensSentence(match.index) && (term.name || match[0].toLowerCase() === term.term.toLowerCase())
                if (!opening) add("term", term.key, match.index, match.index + match[0].length)
            }
    // Overlaps keep the earlier, then the longer, then the more specific mark
    found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || priority[a.kind] - priority[b.kind])
    const kept: Found[] = []
    for (const candidate of found) if (!kept.length || candidate.start >= kept.at(-1)!.end) kept.push(candidate)
    return kept
}

// Links in the prose already point somewhere. A link to the reference, the codes or the glossary is the full first
// mention of what it points to
function linkKey(href: unknown): string | undefined {
    if (typeof href !== "string") return undefined
    return /^(?:https:\/\/fluxerly\.neontechspace\.com)?(\/docs\/(?:api|codes|glossary)\/[^?]*)$/.exec(href)?.[1]
}

const textOf = (node: Node): string => (isText(node) ? node.value : "children" in node && node.children ? node.children.map(textOf).join("") : "")

// A key that is a URL is the mark's link. Any other key, such as a status code's, travels as data-peek and links to
// the page that explains it
function target(terms: PeekTerms, key: string): { href: string; peek?: string } {
    return key.startsWith("/") ? { href: key } : { href: terms.hrefs.get(key)!, peek: key }
}

// Levels and status codes are short, so they look the same every time
const alwaysFull = (kind: MarkKind, key: string) => kind === "level" || !key.startsWith("/")

// An entry's column label, such as "What to do", is a label and not prose
const isLabel = (element: Element) => {
    const className = element.properties.className
    return Array.isArray(className) && className.includes("entry-label")
}

interface File {
    path?: string
    history?: string[]
    /** A reference comment names the symbol it documents in its render's frontmatter, so it never marks itself, and the
     * entry point its page belongs to, so its names lead to that entry point */
    data?: { astro?: { frontmatter?: { peekSelf?: unknown; peekEntry?: unknown } } }
}

export default function rehypePeek(options: RehypePeekOptions) {
    const { terms } = options
    const levelWords = new RegExp(`(?<![\\w.$-])(${[...terms.levels.keys()].join("|")})(?![\\w-])`, "g")
    return (tree: Node, file?: File) => {
        const page = options.page ?? pageOf(file?.path ?? file?.history?.[0])
        const self = file?.data?.astro?.frontmatter?.peekSelf
        const entry = file?.data?.astro?.frontmatter?.peekEntry
        const entries = preferredEntries(terms.entries, page ?? (typeof entry === "string" ? entry : undefined))
        // The glossary defines its terms, so it does not mark them
        const glossary = !terms.glossary.some((term) => term.key.startsWith(`/docs/${page}/`))
        const marks: Candidate[] = []
        const seenOnPage = new Set<string>()
        const seenInSection = new Set<string>()
        const blockTexts = new Map<Element, string>()

        // Whether a mention is the first of its kind: in the section for names and codes, on the page for terms
        const first = (kind: MarkKind, key: string) => {
            const seen = kind === "term" ? seenOnPage : seenInSection
            if (seen.has(key)) return false
            seen.add(key)
            return true
        }
        const decide = (mark: Candidate) => {
            if (mark.key === self) return
            const full = alwaysFull(mark.kind, mark.key) || (first(mark.kind, mark.key) && !(options.comment && mark.kind === "term"))
            marks.push({ ...mark, quiet: !full })
        }

        const visit = (node: Node, block: Element) => {
            if (!("children" in node) || !node.children) return
            const children = node.children
            for (let index = 0; index < children.length; index++) {
                const child = children[index]!
                if (isElement(child)) {
                    if (sectionBreaks.has(child.tagName)) seenInSection.clear()
                    if (child.tagName === "a") {
                        const key = linkKey(child.properties.href)
                        if (key && terms.known.has(key)) first(key.startsWith("/docs/glossary/") ? "term" : "api", key)
                        continue
                    }
                    if (child.tagName === "code") {
                        const next = children[index + 1]
                        const nextWord = (next && isText(next) && /^\s+(\w+)/.exec(next.value)?.[1]) || ""
                        const found = recogniseCode(terms, textOf(child), entries, nextWord)
                        if (found) decide({ ...found, ...target(terms, found.key), code: child, parent: node as Element })
                        continue
                    }
                    if (skipped.has(child.tagName) || isLabel(child)) continue
                    visit(child, blocks.has(child.tagName) ? child : block)
                } else if (isText(child)) {
                    const blockText = blockTexts.get(block) ?? blockTexts.set(block, textOf(block)).get(block)!
                    const opensBlock = index === 0 && blockText.trimStart().startsWith(child.value.trimStart())
                    for (const found of scanText(child.value, { terms, entries, levelWords, glossary, opensBlock, blockText }))
                        decide({ ...found, ...target(terms, found.key), text: child, parent: node as Element })
                }
            }
        }
        visit(tree, tree as Element)

        for (const mark of marks)
            options.onMark?.({ kind: mark.kind, key: mark.key, text: mark.code ? textOf(mark.code) : mark.text!.value.slice(mark.start, mark.end), quiet: !!mark.quiet })

        // Wrap the marks. A text node with several is rebuilt once, from its pieces
        const byText = new Map<Text, Candidate[]>()
        for (const mark of marks) {
            if (mark.code) mark.parent.children.splice(mark.parent.children.indexOf(mark.code), 1, anchor(mark, [mark.code]))
            else if (mark.text) byText.set(mark.text, [...(byText.get(mark.text) ?? []), mark])
        }
        for (const [text, inText] of byText) {
            const pieces: Node[] = []
            let at = 0
            for (const mark of inText) {
                if (mark.start! > at) pieces.push({ type: "text", value: text.value.slice(at, mark.start) })
                const inner: Text = { type: "text", value: text.value.slice(mark.start, mark.end) }
                // A status or close code in the prose becomes code, so it wears the same chip as a code in backticks
                pieces.push(anchor(mark, [mark.kind === "code" ? { type: "element", tagName: "code", properties: {}, children: [inner] } : inner]))
                at = mark.end!
            }
            if (at < text.value.length) pieces.push({ type: "text", value: text.value.slice(at) })
            const parent = inText[0]!.parent
            parent.children.splice(parent.children.indexOf(text), 1, ...pieces)
        }
    }
}

function anchor(mark: Candidate, children: Node[]): Element {
    const properties: Record<string, unknown> = { className: mark.quiet ? [...classes[mark.kind], "peek-quiet"] : classes[mark.kind], href: mark.href }
    // A repeat still peeks under the pointer and still follows its link, but it is not a stop for the Tab key: the
    // keyboard reaches each thing once per section at its full mark, instead of thousands of times on a long page
    if (mark.quiet) properties.tabIndex = -1
    if (mark.peek) properties.dataPeek = mark.peek
    if (mark.level) properties.dataLevel = mark.level
    return { type: "element", tagName: "a", properties, children }
}
