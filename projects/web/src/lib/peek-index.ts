// The docs' hover peeks: what a name, code or term in the prose means, in a few lines. One build step turns the
// reference model, the code catalogue, the glossary and the curated meanings into two things. The index is the JSON
// the browser loads once, on the first peek. The terms are the tables src/lib/rehype-peek.ts recognises prose with.
// Nothing here reads files, so the build, the endpoint and the tests can each pass the sources they have
import type { Codes, Declaration, Entry, Member, Signature, Type } from "./reference"
import { declarationHtml, typeHtml } from "./reference-format.ts"
import { closeCodes, httpStatuses, logLevels, type Meaning, type MeaningSource } from "./peek-meanings.ts"

/** One peek. The keys are short and the defaults left out, because the browser loads every entry at once */
export interface PeekEntry {
    /** The title's form: a code, a glossary term or a log level. Without it the title is a signature */
    f?: "code" | "term" | "level"
    /** Title as HTML: a signature with its type names as links, or the code or term itself */
    t: string
    /** What kind of thing it is, such as Function or Option of ClientOptions */
    k: string
    /** The meaning as inline HTML: a summary's first sentence, a code's meaning or a definition */
    d?: string
    /** A second line: the reason of an error code, or the records a log level shows */
    x?: string
    /** What to do */
    a?: string
    /** Levels a log record appears at */
    lv?: string[]
    /** The key of an entry whose meaning and action this one shares, such as an error code's family */
    p?: string
    /** Where the peek's link goes, when that is not the key itself */
    u?: string
    /** The link's label, when the link is a guide. Otherwise the browser names the reference, the codes or the glossary */
    l?: string
}

export interface PeekIndex {
    entries: Record<string, PeekEntry>
}

/** A member: its peek key, and the type a dotted path continues through, which is a method's return type */
export interface ApiMember {
    key: string
    next?: Type
}

/** A declaration the recogniser can name, with the members a dotted path can continue to */
export interface ApiNode {
    key: string
    kind: Declaration["kind"]
    members: Map<string, ApiMember>
}

export interface GlossaryTerm {
    key: string
    term: string
    pattern: RegExp
    /** A capitalized name such as Effect, which as the first word of a sentence may be an ordinary word */
    name: boolean
    /** Where the reference address of the symbol a comment documents matches this, the word has another meaning there,
     * as a token of a command's text */
    notForSymbol?: RegExp
}

export interface PeekTerms {
    /** Declarations by name, then by entry point key */
    declarations: Map<string, Map<string, ApiNode>>
    /** Declarations by URL, to follow a member's type */
    byUrl: Map<string, ApiNode>
    /** Entry point keys in the model's order */
    entries: string[]
    /** The options an entry point's functions take, by name, when one member owns the name. Per entry point */
    options: Map<string, Map<string, ApiMember>>
    /** The objects an entry point's functions create, such as the Client, for paths such as members.fetch */
    instances: Map<string, ApiNode[]>
    /** Log record and error codes to their peek keys. A code that is both stays a log record */
    codes: Map<string, string>
    http: Map<number, string>
    close: Map<number, string>
    /** Log level words, such as Warn */
    levels: Map<string, string>
    glossary: GlossaryTerm[]
    /** Keys the index has a peek for. The recogniser marks nothing else */
    known: Set<string>
    /** Links of the keys that are not a URL themselves, such as http-401 */
    hrefs: Map<string, string>
}

export interface PeekSources {
    model: { entries: Entry[] }
    codes: Codes
    /** content/guides/glossary.md */
    glossary: string
    /** Short guide titles by slug, for the links of meanings that a guide explains */
    guideTitles?: Record<string, string>
    /** Reference URLs the guides link to, so a peek also opens on a link to a member */
    links?: string[]
}

// Text

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&")

/** The first sentence of a Markdown paragraph, without its final period, as the reference's task rows derive it */
export function firstSentence(markdown = ""): string {
    const paragraph = (markdown.split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim()
    const end = paragraph.search(/\.(?=\s+[A-Z])/)
    return (end < 0 ? paragraph : paragraph.slice(0, end)).replace(/\.$/, "")
}

/** Inline Markdown as calm HTML: code spans stay code, links keep only their text, emphasis goes */
export function inlineHtml(markdown: string): string {
    return markdown
        .split(/(`[^`]+`)/)
        .map((part) =>
            part.length > 1 && part.startsWith("`") && part.endsWith("`")
                ? `<code>${escape(part.slice(1, -1))}</code>`
                : escape(part.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)(.+?)\1/g, "$2")),
        )
        .join("")
}

/** Heading anchors as the docs make them: lowercase, punctuation dropped, spaces as hyphens */
export const slug = (heading: string) =>
    heading
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .trim()
        .replace(/\s/g, "-")

/** The ID of a code's row on the codes page, as src/pages/docs/codes.astro writes it */
export const codeAnchor = (prefix: "error" | "log", code: string) => `${prefix}-${code.replace(/[^A-Za-z0-9]+/g, "-").replace(/-$/, "").toLowerCase()}`

// Signatures fit the peek: about 60 characters wide and three lines tall

const peekWidth = 60
const peekLines = 3

function clip(html: string): string {
    const lines = html.split("\n")
    return lines.length <= peekLines ? html : lines.slice(0, peekLines).join("\n") + " …"
}

const keyword = (value: string) => `<span class="ty-k">${escape(value)}</span>`
const declared = (value: string) => `<span class="ty-n">${escape(value)}</span>`
const parameter = (value: string) => `<span class="ty-p">${escape(value)}</span>`

const fits = (html: string) => !html.includes("\n") && plain(html).length <= peekWidth

// Shorter forms of a type for a line that is too long. The first keeps a generic's first argument and a union's first
// three members, the second keeps only names, and an ellipsis stands for the rest. Object bodies become { … }
function compact(type: Type, level: 1 | 2, depth = 0): Type {
    if (typeof type === "string") return type
    const more: Type = { k: "raw", s: "…" }
    if ("r" in type) {
        if (!type.a?.length) return type
        return { ...type, a: level === 2 ? [more] : [compact(type.a[0]!, level, depth + 1), ...(type.a.length > 1 ? [more] : [])] }
    }
    switch (type.k) {
        case "union": {
            const kept = level === 2 ? 1 : 3
            return { k: "union", t: [...type.t.slice(0, kept).map((member) => compact(member, level, depth + 1)), ...(type.t.length > kept ? [more] : [])] }
        }
        case "obj":
            return { k: "obj" }
        case "arr":
        case "optional":
        case "rest":
            return { ...type, t: compact(type.t, level, depth + 1) }
        default:
            return depth ? more : type
    }
}

// A type after a prefix such as "const name: ", in the first form that fits on the line, else the first short form.
// A union that breaks keeps its first member on the prefix line and indents the others
function typeAfter(prefix: string, type: Type): string {
    const width = Math.max(28, peekWidth - plain(prefix).length)
    const forms = [typeHtml(type, width), typeHtml(compact(type, 1), width), typeHtml(compact(type, 2), width)]
    const html = forms.find((form) => fits(prefix + form)) ?? forms.find((form) => !form.includes("\n")) ?? forms[1]!
    const operator = /^(?:\| |&amp; )/.exec(html)?.[0]
    return operator ? html.slice(operator.length).replaceAll("\n", "\n    ") : html
}

// Type parameters by name only, as their constraints are on the reference page
const typeParameters = (parameters?: { n: string }[]) =>
    parameters?.length ? `&lt;${parameters.map((parameter) => `<span class="ty-t">${escape(parameter.n)}</span>`).join(", ")}&gt;` : ""

// A call signature with full parameter types when it fits on one line, otherwise with parameter names only
function callHtml(name: string, signature: Signature): string {
    const full = `${declared(name)}(${signature.p.map((p) => `${p.r ? "..." : ""}${parameter(p.n)}${p.o && !p.dv ? "?" : ""}: ${typeHtml(p.t, peekWidth)}`).join(", ")}): `
    const fullHtml = full + typeAfter(full, signature.r)
    if (fits(fullHtml)) return fullHtml
    const names = `${declared(name)}(${signature.p.map((p) => `${p.r ? "..." : ""}${parameter(p.n)}${p.o ? "?" : ""}`).join(", ")}): `
    return clip(names + typeAfter(names, signature.r))
}

function declarationTitle(item: Declaration): string {
    switch (item.kind) {
        case "function":
            return item.signatures?.[0] ? callHtml(item.name, item.signatures[0]) : declared(item.name)
        case "variable": {
            const prefix = `${keyword(item.const ? "const " : "let ")}${declared(item.name)}: `
            return clip(prefix + typeAfter(prefix, item.type ?? "unknown"))
        }
        case "type": {
            const prefix = `${keyword("type ")}${declared(item.name)}${typeParameters(item.tp)} = `
            return clip(prefix + typeAfter(prefix, item.type ?? "unknown"))
        }
        default: {
            const tp = item.tp?.map((parameter) => ({ n: parameter.n }))
            const forms = ([1, 2] as const).map((level) =>
                declarationHtml(item.kind as "class" | "interface", item.name, {
                    tp,
                    extends: item.extends?.map((type) => compact(type, level)),
                    implements: item.implements?.map((type) => compact(type, level)),
                }),
            )
            return clip(forms.find((form) => !form.includes("\n")) ?? forms[1]!)
        }
    }
}

function memberTitle(member: Member): string | undefined {
    if (member.signatures?.[0]) return callHtml(member.name, member.signatures[0])
    if (member.kind === "constructor") return undefined
    const prefix = `${declared(member.name)}${member.optional ? "?" : ""}: `
    return clip(prefix + typeAfter(prefix, member.type ?? "unknown"))
}

const kindNames: Record<Declaration["kind"], string> = { function: "Function", variable: "Variable", class: "Class", interface: "Interface", type: "Type alias" }

// The reference's own words. A function's first signature carries its comment
const summaryOf = (doc?: { summary?: string }, signature?: Signature) => inlineHtml(firstSentence(signature?.doc?.summary ?? doc?.summary)) || undefined

interface Build {
    entries: Record<string, PeekEntry>
    terms: PeekTerms
    /** The main entry point, whose names need no entry point after their kind */
    firstEntry: Entry
    /** Declarations by URL, to follow a type alias */
    items: Map<string, Declaration>
    members: Map<string, ApiMember>
    memberKeys: Set<string>
}

function addApi(build: Build, entry: Entry, item: Declaration) {
    const { entries, terms } = build
    const where = entry === build.firstEntry ? "" : ` · ${entry.title}`
    const kind = item.kind === "variable" && item.const ? "Constant" : kindNames[item.kind]
    entries[item.url] ??= { t: declarationTitle(item), k: kind + where, d: summaryOf(item.doc, item.signatures?.[0]) }
    const node: ApiNode = terms.byUrl.get(item.url) ?? { key: item.url, kind: item.kind, members: new Map() }
    terms.byUrl.set(item.url, node)
    build.items.set(item.url, item)
    const page = item.url.replace(/#.*$/, "")
    for (const member of item.members ?? []) {
        const title = member.anchor && memberTitle(member)
        if (!title) continue
        const url = `${page}#${member.anchor}`
        const role = member.signatures?.length ? "Method" : /Options$/.test(item.name) ? "Option" : "Property"
        entries[url] ??= { t: title, k: `${role} of ${item.name}${where}`, d: summaryOf(member.doc, member.signatures?.[0]) }
        const known = { key: url, next: member.signatures?.[0]?.r ?? member.type }
        node.members.set(member.name, known)
        build.members.set(url, known)
        build.memberKeys.add(url)
    }
    if (!terms.declarations.has(item.name)) terms.declarations.set(item.name, new Map())
    terms.declarations.get(item.name)!.set(entry.key, node)
}

// Inherited members point at the member they come from, so a path through BotOptions reaches ClientOptions' sharding
function addInherited(build: Build, item: Declaration) {
    const node = build.terms.byUrl.get(item.url)
    for (const group of item.inherited ?? [])
        for (const member of group.m) {
            const home = build.members.get(member.h)
            if (node && home && !node.members.has(member.n)) node.members.set(member.n, home)
        }
}

// The declarations a type is made of, through type aliases, unions, intersections and type arguments, as BotOptions
// in the Effect entry point is an intersection of an Omit of options with more options
function nodesOf(build: Build, type: Type | undefined, seen = new Set<string>()): ApiNode[] {
    if (!type || typeof type !== "object") return []
    if ("r" in type) {
        const item = type.h ? build.items.get(type.h) : undefined
        if (item && seen.has(item.url)) return []
        if (item) seen.add(item.url)
        const node = item && build.terms.byUrl.get(item.url)
        const own = node?.members.size ? [node] : item?.kind === "type" ? nodesOf(build, item.type, seen) : []
        return [...own, ...(type.a ?? []).flatMap((argument) => nodesOf(build, argument, seen))]
    }
    return type.k === "union" || type.k === "and" ? type.t.flatMap((inner) => nodesOf(build, inner, seen)) : []
}

// What a function gives back: the first type argument of a wrapper such as ResultAsync or Effect, never its errors
function createdOf(build: Build, type: Type | undefined): ApiNode[] {
    if (!type || typeof type !== "object") return []
    if ("r" in type) {
        const node = type.h ? build.terms.byUrl.get(type.h) : undefined
        if (node?.members.size) return node.kind === "interface" ? [node] : []
        return createdOf(build, type.a?.[0])
    }
    return type.k === "union" ? type.t.flatMap((inner) => createdOf(build, inner)) : []
}

// The options objects a parameter takes, named like BotOptions, with what such a type is made of. A parameter such as a
// channel is not an options object, so a guildId in a sentence is not that channel's property
function optionsOf(build: Build, type: Type | undefined): ApiNode[] {
    const named = (key: string) => /Options$/.test(build.items.get(key)?.name ?? "")
    const top = type && typeof type === "object" && "r" in type && type.h
    const nodes = nodesOf(build, type)
    return top && named(top) ? nodes : nodes.filter((node) => named(node.key))
}

// An option is a member of the options an entry point's functions take, such as runBot's BotOptions with the
// ClientOptions it inherits. A name counts only when one member owns it across all of them, so token, which both the
// client and a webhook client take, names neither. The objects the functions create, such as the Client, are where
// paths like members.fetch start
function addFunctions(build: Build, entry: Entry, items: Declaration[]) {
    const { terms } = build
    const owners = new Map<string, Map<string, ApiMember>>()
    const created: ApiNode[] = []
    for (const item of items) {
        const signature = item.kind === "function" ? item.signatures?.[0] : undefined
        if (!signature) continue
        for (const parameter of signature.p)
            for (const node of optionsOf(build, parameter.t))
                for (const [name, member] of node.members) owners.set(name, (owners.get(name) ?? new Map()).set(member.key, member))
        for (const node of createdOf(build, signature.r)) if (!created.includes(node)) created.push(node)
    }
    for (const [name, members] of owners) {
        if (members.size !== 1) continue
        if (!terms.options.has(name)) terms.options.set(name, new Map())
        terms.options.get(name)!.set(entry.key, [...members.values()][0]!)
    }
    terms.instances.set(entry.key, created)
}

function addCodes({ entries, terms }: Build, codes: Codes) {
    const reasons = new Map(codes.reasons.map((reason) => [reason.reason, reason.meaning]))
    for (const log of codes.logs) {
        const url = `/docs/codes/#${codeAnchor("log", log.code)}`
        entries[url] = { f: "code", t: escape(log.code), k: "Log record", d: escape(log.meaning), a: log.action && escape(log.action), lv: log.levels }
        terms.codes.set(log.code, url)
    }
    for (const error of codes.errors) {
        const url = `/docs/codes/#${codeAnchor("error", error.code)}`
        const kind = `Error code · ${error.error}`
        entries[url] = { f: "code", t: escape(error.code), k: kind, d: escape(error.meaning), a: error.action && escape(error.action) }
        if (!terms.codes.has(error.code)) terms.codes.set(error.code, url)
        // A family such as message.send.<reason> also names each of its codes, with the reason's own meaning
        for (const value of /<\w+>$/.test(error.code) ? (error.values ?? []) : []) {
            const code = error.code.replace(/<\w+>$/, value)
            const reason = reasons.get(value)
            entries[`code:${code}`] = {
                f: "code",
                t: escape(code),
                k: kind,
                x: reason && `<span class="peek-x-label">${escape(value)}</span> ${escape(firstSentence(reason))}`,
                p: url,
                u: url,
            }
            if (!terms.codes.has(code)) terms.codes.set(code, `code:${code}`)
        }
    }
}

function sourceHref(source: MeaningSource, terms: PeekTerms): string {
    if ("guide" in source) return `/docs/${source.guide}/${source.anchor ? `#${source.anchor}` : ""}`
    if ("codes" in source) return `/docs/codes/#${source.codes}`
    const [name, member] = source.api.split(".")
    const node = terms.declarations.get(name!)?.get(terms.entries[0]!)
    const key = member ? node?.members.get(member)?.key : node?.key
    if (!key) throw new Error(`A peek meaning cites ${source.api}, which the reference does not have`)
    return key
}

function addMeanings({ entries, terms }: Build, titles: Record<string, string>) {
    const link = (meaning: Meaning) => {
        const source = meaning.sources[0]!
        const u = sourceHref(source, terms)
        return "guide" in source ? { u, l: titles[source.guide] ? `Read in ${titles[source.guide]}` : "Read the guide" } : { u }
    }
    for (const meaning of [...httpStatuses, ...closeCodes])
        entries[meaning.key] = { f: "code", t: escape(meaning.title), k: meaning.kind, d: escape(meaning.meaning), a: meaning.action && escape(meaning.action), ...link(meaning) }
    for (const meaning of logLevels)
        entries[meaning.key] = { f: "level", t: escape(meaning.title), k: meaning.kind, d: escape(meaning.meaning), x: meaning.examples && escape(meaning.examples), ...link(meaning) }
    for (const status of httpStatuses) terms.http.set(status.status, status.key)
    for (const code of closeCodes) terms.close.set(code.code, code.key)
    for (const level of logLevels) terms.levels.set(level.title, level.key)
}

/** The glossary's terms with their definitions, from its ### headings */
export function parseGlossary(markdown: string): { term: string; slug: string; body: string }[] {
    const parts = markdown.replace(/^---[\s\S]*?\n---\n/, "").split(/^### +(.+)$/m)
    const terms: { term: string; slug: string; body: string }[] = []
    for (let index = 1; index < parts.length; index += 2) {
        const term = parts[index]!.trim()
        terms.push({ term, slug: slug(term), body: parts[index + 1]!.replace(/^#{1,2} .*$/gm, "").trim() })
    }
    return terms
}

const regexEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Terms whose word also means something else, and the words around it that tell the meanings apart. The client in
// OAuth's client secret, client ID and client credentials is the OAuth application, and the clients that show, hide or
// list something, a client that supports a feature and a mobile or desktop client are Fluxer's apps, not the SDK's
// client. A token described as a piece of text, such as an out-of-range or a parsed token, and every token in the
// reference comments of the SDK's Commands category, whose page is commands, is a piece of a command's text, while the
// guides and the other comments mean the credential
const otherMeanings: Record<string, { notBefore?: string; notAfter?: string; notForSymbol?: RegExp }> = {
    Client: { notBefore: "(?:secrets?|IDs?|credentials?|shows?|hides?|lists?|that\\s+supports?)\\b", notAfter: "\\b(?:mobile|desktop)\\s+" },
    Token: { notAfter: "\\b(?:out-of-range|decimal|numeric|positional|parsed|remaining|quoted)\\s+", notForSymbol: /^\/docs\/api\/[\w-]+\/commands\// },
}

// A term matches with its plural. The glossary writes common nouns in lowercase, such as "A shard is", and names such
// as Effect or Result capitalized. A term the definition never writes in lowercase is a name and matches capitalized only
function termPattern(term: string, definition: string): Omit<GlossaryTerm, "key" | "term"> {
    const lower = term.toLowerCase()
    // Code such as client.rest.request and link targets do not count as the term written in lowercase
    const prose = definition.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "]")
    const caseless = term !== lower && new RegExp(`(?<![\\w-])${regexEscape(lower)}`).test(prose)
    const stem = regexEscape(term).replace(/ /g, "\\s+")
    const forms = /[^aeiou]y$/i.test(term) ? `${stem.slice(0, -1)}(?:y|ies)` : `${stem}(?:s|es)?`
    const { notBefore, notAfter, notForSymbol } = Object.hasOwn(otherMeanings, term) ? otherMeanings[term]! : {}
    const pattern = `(?<![\\w.$/#@-])${notAfter ? `(?<!${notAfter})` : ""}${forms}(?![\\w-])${notBefore ? `(?!\\s+${notBefore})` : ""}`
    return { pattern: new RegExp(pattern, caseless ? "gi" : "g"), name: !caseless && /^[A-Z][a-z]+$/.test(term), ...(notForSymbol ? { notForSymbol } : {}) }
}

function addGlossary({ entries, terms }: Build, markdown: string) {
    for (const { term, slug: id, body } of parseGlossary(markdown)) {
        const url = `/docs/glossary/#${id}`
        entries[url] = { f: "term", t: escape(term), k: "Glossary", d: inlineHtml(firstSentence(body)) }
        terms.glossary.push({ key: url, term, ...termPattern(term, body) })
    }
}

// Every declaration has a peek, as signatures link to them all. Members are many, so only those prose names have one:
// options, and the members of what the functions create, such as the Client, and of namespaces such as errors, one
// step further for client.messages.send
function reachableMembers(build: Build, roots: ApiNode[], extra: string[]): Set<string> {
    const keep = new Set<string>(extra)
    for (const perEntry of build.terms.options.values()) for (const member of perEntry.values()) keep.add(member.key)
    for (const root of roots)
        for (const member of root.members.values()) {
            keep.add(member.key)
            const next = typeof member.next === "object" && "h" in member.next && member.next.h ? build.terms.byUrl.get(member.next.h) : undefined
            for (const inner of next?.members.values() ?? []) keep.add(inner.key)
        }
    return keep
}

export function buildPeek(sources: PeekSources): { index: PeekIndex; terms: PeekTerms } {
    const terms: PeekTerms = {
        declarations: new Map(),
        byUrl: new Map(),
        entries: [],
        options: new Map(),
        instances: new Map(),
        codes: new Map(),
        http: new Map(),
        close: new Map(),
        levels: new Map(),
        glossary: [],
        known: new Set(),
        hrefs: new Map(),
    }
    const entryPoints = sources.model.entries
    terms.entries = entryPoints.map((entry) => entry.key)
    const build: Build = { entries: {}, terms, firstEntry: entryPoints[0]!, items: new Map(), members: new Map(), memberKeys: new Set() }
    const itemsOf = (entry: Entry) => [...entry.categories.flatMap((category) => category.items), ...entry.uncategorized]
    const declarationsOf = (entry: Entry) => itemsOf(entry).filter((item): item is Declaration => item.kind !== "reexport")
    for (const entry of entryPoints) for (const item of declarationsOf(entry)) addApi(build, entry, item)
    for (const entry of entryPoints) for (const item of declarationsOf(entry)) addInherited(build, item)
    // A namespace such as errors is a constant whose type, ErrorTools, holds its members
    for (const entry of entryPoints)
        for (const item of declarationsOf(entry)) {
            const type = item.kind === "variable" && !item.members?.length && typeof item.type === "object" && "h" in item.type ? item.type.h : undefined
            const home = type ? terms.byUrl.get(type) : undefined
            if (home) terms.byUrl.get(item.url)!.members = home.members
        }
    for (const entry of entryPoints) addFunctions(build, entry, declarationsOf(entry))
    // A re-export names its home declaration, so Effect pages find the names the Effect entry point shares
    for (const entry of entryPoints)
        for (const item of itemsOf(entry)) {
            const node = item.kind === "reexport" ? terms.byUrl.get(item.url) : undefined
            if (node && !terms.declarations.get(item.name)?.has(entry.key)) terms.declarations.get(item.name)?.set(entry.key, node)
        }
    addCodes(build, sources.codes)
    addMeanings(build, sources.guideTitles ?? {})
    addGlossary(build, sources.glossary)

    const namespaces = entryPoints.flatMap((entry) => declarationsOf(entry).filter((item) => item.kind === "variable").map((item) => terms.byUrl.get(item.url)!))
    const roots = [...[...terms.instances.values()].flat(), ...namespaces.filter((node) => node.members.size)]
    const cited = [...httpStatuses, ...closeCodes].flatMap((meaning) => meaning.sources.filter((source) => "api" in source).map((source) => sourceHref(source, terms)))
    const keep = reachableMembers(build, roots, [...cited, ...(sources.links ?? [])])
    const entries: Record<string, PeekEntry> = {}
    for (const [key, entry] of Object.entries(build.entries)) {
        if (build.memberKeys.has(key) && !keep.has(key)) continue
        entries[key] = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as PeekEntry
        terms.known.add(key)
        if (!key.startsWith("/")) terms.hrefs.set(key, entry.u!)
    }
    return { index: { entries }, terms }
}
