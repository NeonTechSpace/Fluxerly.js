// Typed access to the SDK reference model that scripts/docs/extract.mjs writes. The extractor decides every URL and anchor,
// so pages read them from the model instead of rebuilding them
import modelSource from "@content/reference/model.json?raw"
import { titleCase } from "./title-case"
import codesSource from "@content/reference/codes.json?raw"
import linksSource from "@content/reference/links.json?raw"

/** A type. Intrinsic and literal types are plain strings, a reference is { r, h?, a? }, every other node names its kind in k */
export type Type =
    | string
    | { r: string; h?: string; a?: Type[] }
    | { k: "union" | "and" | "tuple"; t: Type[] }
    | { k: "arr" | "optional" | "rest" | "query"; t: Type }
    | { k: "named"; n: string; o?: 1; t: Type }
    | { k: "op"; op: string; t: Type }
    | { k: "idx"; o: Type; i: Type }
    | { k: "cond"; c: Type; e: Type; y: Type; f: Type }
    | { k: "mapped"; p: string; c: Type; t: Type; ro?: string; opt?: string; as?: Type }
    | { k: "infer"; n: string; c?: Type }
    | { k: "pred"; n: string; as?: 1; t?: Type }
    | { k: "tpl"; h: string; tail: [Type, string][] }
    | { k: "raw"; s: string }
    | ObjectType

export interface ObjectType {
    k: "obj"
    m?: Member[]
    s?: Signature[]
    x?: { n: string; kt: Type; t: Type; r?: 1 }[]
}

export interface Doc {
    summary?: string
    remarks?: string
    examples?: string[]
    returns?: string
    see?: string[]
    defaultValue?: string
    deprecated?: string
}

export interface TypeParameter {
    n: string
    c?: Type
    d?: Type
}

export interface Parameter {
    n: string
    t: Type
    o?: 1
    r?: 1
    dv?: string
    d?: string
}

export interface Signature {
    tp?: TypeParameter[]
    p: Parameter[]
    r: Type
    doc?: Doc
}

export interface Member {
    kind: "property" | "method" | "constructor" | "accessor"
    name: string
    /** Present on members that pages anchor: those of declarations, not of nested object types */
    anchor?: string
    optional?: true
    readonly?: true
    static?: true
    abstract?: true
    type?: Type
    signatures?: Signature[]
    doc?: Doc
}

export interface InheritedGroup {
    from: string
    h?: string
    m: { n: string; a: string; h: string }[]
}

export type DeclarationKind = "function" | "variable" | "class" | "interface" | "type"

export interface Declaration {
    kind: DeclarationKind
    name: string
    anchor: string
    url: string
    /** Classes and each entry point's Client interface have their own page */
    page?: true
    doc?: Doc
    tp?: TypeParameter[]
    signatures?: Signature[]
    extends?: Type[]
    implements?: Type[]
    const?: true
    type?: Type
    members?: Member[]
    inherited?: InheritedGroup[]
}

export interface Reexport {
    kind: "reexport"
    name: string
    anchor: string
    /** The declaration's home, in another entry point */
    url: string
    home: string
    of: DeclarationKind
    summary?: string
}

export type Item = Declaration | Reexport

export interface Category {
    title: string
    slug: string
    url: string
    /** The category's leading names: functions and classes, then the most referenced */
    top: string[]
    items: Item[]
}

export interface TaskGroup {
    name: string
    url: string
    rows: { task: string; method: string; url: string }[]
}

export interface Entry {
    key: string
    title: string
    importPath: string
    url: string
    doc: Doc
    categories: Category[]
    uncategorized: Item[]
    tasks?: TaskGroup[]
}

export interface Codes {
    errors: { code: string; error: string; url?: string; meaning: string; action?: string; values?: string[] }[]
    reasons: { reason: string; meaning: string }[]
    logs: { code: string; levels: string[]; meaning: string; action?: string }[]
}

export const model: { entries: Entry[] } = JSON.parse(modelSource)
for (const entry of model.entries) {
    entry.title = titleCase(entry.title)
    for (const category of entry.categories) category.title = titleCase(category.title)
}
export const codes: Codes = JSON.parse(codesSource)
/** Previous docs paths, after /docs/{{version}}/ and without a trailing slash, mapped to their URLs here */
export const legacyLinks: Record<string, string> = JSON.parse(linksSource)

export const referenceUrl = "/docs/api/"
export const tasksUrl = "/docs/api/tasks/"
export const endpointsUrl = "/docs/api/endpoints/"
export const codesUrl = "/docs/codes/"

export const isReexport = (item: Item): item is Reexport => item.kind === "reexport"

export function entryByKey(key: string): Entry {
    const entry = model.entries.find((candidate) => candidate.key === key)
    if (!entry) throw new Error(`Unknown reference entry point ${key}`)
    return entry
}

/** Every declaration that has its own page, with the category it belongs to */
export function symbolPages(): { entry: Entry; category?: Category; declaration: Declaration }[] {
    return model.entries.flatMap((entry) => [
        ...entry.categories.flatMap((category) =>
            category.items.filter((item): item is Declaration => !isReexport(item) && !!item.page).map((declaration) => ({ entry, category, declaration })),
        ),
        ...entry.uncategorized.filter((item): item is Declaration => !isReexport(item) && !!item.page).map((declaration) => ({ entry, declaration })),
    ])
}

export function categoryPages(): { entry: Entry; category: Category }[] {
    return model.entries.flatMap((entry) => entry.categories.map((category) => ({ entry, category })))
}

/** The page path below /docs/api/<entry>/ for a category or a symbol page */
export const pageSlug = (url: string) => url.split("/").filter(Boolean).at(-1) ?? ""

export const kindTitles: Record<DeclarationKind | "reexport", string> = {
    function: "Functions",
    variable: "Variables",
    class: "Classes",
    interface: "Interfaces",
    type: "Type Aliases",
    reexport: "Re-Exports",
}

const kindOrder: (DeclarationKind | "reexport")[] = ["function", "variable", "class", "interface", "type", "reexport"]

/** A page's items grouped by kind, in the order the extractor anchored them */
export function groupByKind(items: Item[]): { kind: DeclarationKind | "reexport"; items: Item[] }[] {
    return kindOrder.map((kind) => ({ kind, items: items.filter((item) => item.kind === kind) })).filter((group) => group.items.length)
}

// Layout contract shared with the guides

export interface TocItem {
    depth: 2 | 3
    text: string
    id: string
}

/** The first sentence of a Markdown summary, as the extractor derives task rows */
export function firstSentence(markdown = ""): string {
    const paragraph = (markdown.split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim()
    const end = paragraph.search(/\.(?=\s+[A-Z])/)
    return (end < 0 ? paragraph : paragraph.slice(0, end)).replace(/\.$/, "")
}
