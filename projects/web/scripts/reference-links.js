import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

// Build-time links from API names to the generated reference of the same docs version.
// The index is read from that version's generated reference Markdown, so released snapshots link only to
// symbols and members their own reference contains

const identifier = /^[A-Za-z_$][\w$]*$/
const symbolDirectories = ["interfaces", "classes", "enums"]
// The reference's task index writes client methods as client.<namespace>.<method>, so client names the Client interface
const conventionalRoots = new Map([["client", "Client"]])
/** Generated links per page stay below this, so dense pages do not turn every code span into a link */
export const inlineLinkLimit = 60

const anchorLine = /^<a id="([^"]+)"><\/a>$/
const typeLink = /^\[`[^`]+`\]\((\/[^)\s]+)\)(?:\\<.*\\>)?$/
const cells = (line) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim())

/** Grouped symbols of an entry point page: functions, variables, type aliases and re-exports */
export function parseEntryPage(text, entry, base) {
    const symbols = new Map()
    const lines = text.split(/\r?\n/)
    let group = ""
    for (const [index, line] of lines.entries()) {
        group = /^### (Functions|Variables|Type Aliases|References)$/.exec(line)?.[1] ?? group
        const anchor = anchorLine.exec(line)
        const heading = anchor && /^#{3,4} ([^\s()]+)(?:\(\))?$/.exec(lines[index + 2] ?? "")
        if (!heading || !identifier.test(heading[1])) continue
        const next = lines.slice(index + 3).find((candidate) => candidate.trim()) ?? ""
        const reexport = /^Re-exports \[[^\]]+\]\((\/[^)\s]+)\)$/.exec(next)
        const variableType = /^> `const` \*\*[^*]+\*\*: (.+)$/.exec(next)
        symbols.set(heading[1], reexport
            ? { url: reexport[1], reexport: true }
            : { url: `${base}/modules/${entry}/#${anchor[1]}`, type: typeLink.exec(variableType?.[1] ?? "")?.[1], function: group === "Functions" })
    }
    return symbols
}

/** Members of a class, interface or enum page, from method headings and property table rows */
export function parseSymbolPage(text, url) {
    const members = new Map()
    const lines = text.split(/\r?\n/)
    let header = []
    for (const [index, line] of lines.entries()) {
        if (line.startsWith("| ") && /^\|\s*-+/.test(lines[index + 1] ?? "")) header = cells(line)
        const anchor = anchorLine.exec(line)
        const heading = anchor && /^### ([^\s()]+)(?:\(\))?$/.exec(lines[index + 2] ?? "")
        if (heading && identifier.test(heading[1])) {
            members.set(heading[1], { url: `${url}#${anchor[1]}` })
            continue
        }
        const row = /^\| <a id="([^"]+)"><\/a> `([^`]+?)\??` \|/.exec(line)
        if (!row || !identifier.test(row[2]) || members.has(row[2])) continue
        const typeColumn = header.indexOf("Type")
        members.set(row[2], { url: `${url}#${row[1]}`, type: typeColumn >= 0 ? typeLink.exec(cells(line)[typeColumn] ?? "")?.[1] : undefined })
    }
    return members
}

/** Parse one version's generated reference directory. Base is its public path, such as /docs/preview/api */
export async function readReferenceIndex(apiDirectory, base) {
    const entries = new Map()
    const pages = new Map()
    const entryOf = (name) => entries.get(name) ?? entries.set(name, new Map()).get(name)
    const list = async (directory) => {
        try { return await readdir(join(apiDirectory, directory)) }
        catch (error) { if (error.code === "ENOENT") return []; throw error }
    }
    for (const file of await list("modules")) {
        if (!file.endsWith(".md")) continue
        const entry = file.slice(0, -3)
        for (const [name, target] of parseEntryPage(await readFile(join(apiDirectory, "modules", file), "utf8"), entry, base))
            entryOf(entry).set(name, target)
    }
    for (const directory of symbolDirectories)
        for (const file of await list(directory)) {
            const match = /^([A-Za-z-]+)\.([^.]+)\.md$/.exec(file)
            if (!match || !identifier.test(match[2])) continue
            const url = `${base}/${directory}/${match[1]}.${match[2]}/`
            entryOf(match[1]).set(match[2], { url })
            pages.set(url, parseSymbolPage(await readFile(join(apiDirectory, directory, file), "utf8"), url))
        }
    // A re-export shares its target's kind and linked type, so members resolve through it too
    const targets = new Map([...entries.values()].flatMap((symbols) => [...symbols.values()])
        .filter((target) => !target.reexport).map((target) => [target.url, target]))
    for (const symbols of entries.values())
        for (const [name, target] of symbols) if (target.reexport && targets.has(target.url)) symbols.set(name, targets.get(target.url))
    return { entries, pages }
}

const indexes = new Map()

/** The cached reference index of the docs version directory that holds a page */
export function referenceIndexFor(context) {
    if (!indexes.has(context.root))
        indexes.set(context.root, readReferenceIndex(join(context.root, "api"), `/docs/${context.version}/api`))
    return indexes.get(context.root)
}

/** Version, served URL and entry point of a generated docs page, or undefined outside generated docs */
export function pageContext(path) {
    const normalized = String(path ?? "").replaceAll("\\", "/")
    const match = /\/content\/docs\/([a-z0-9][a-z0-9.-]*)\/((?:[^/]+\/)*[^/]+)\.mdx?$/.exec(normalized)
    if (!match) return undefined
    const [, version, page] = match
    const slug = page.replace(/(?:^|\/)index$/, "")
    const reference = /^api\/(?:modules\/([A-Za-z-]+)|(?:interfaces|classes|enums)\/([A-Za-z-]+)\.[^/]+)$/.exec(page)
    return {
        root: `${normalized.slice(0, match.index)}/content/docs/${version}`,
        version,
        url: `/docs/${version}/${slug ? `${slug}/` : ""}`,
        reference: page.startsWith("api/"),
        entry: reference?.[1] ?? reference?.[2],
    }
}

const effectEntry = (entry) => entry.startsWith("Effect")

/**
 * Entry points to search, in order. Reference pages prefer their own entry point. Other pages prefer the Effect
 * API when their examples import only from it, and the default API otherwise
 */
export function entryPreference(entry, effect = false) {
    if (entry === "testing") return ["testing", "js-ts"]
    if (entry === "Effect-testing") return ["Effect-testing", "Effect"]
    if (entry) return effectEntry(entry) ? ["Effect", "Effect-testing"] : ["js-ts", "testing"]
    return effect ? ["Effect", "Effect-testing"] : ["js-ts", "testing"]
}

/** Whether the code on a page imports from the Effect API and never from the default API */
export function importsOnlyEffect(sources) {
    const specifiers = sources.flatMap((source) =>
        [...source.matchAll(/\b(?:from\s*|import\s*\(\s*)["'](@neontechspace\/fluxerly(?:\/[\w/-]+)?)["']/g)].map((match) => match[1]))
    return specifiers.some((specifier) => specifier.startsWith("@neontechspace/fluxerly/effect")) &&
        !specifiers.some((specifier) => !specifier.startsWith("@neontechspace/fluxerly/effect"))
}

/** A top-level name in the first preferred entry point that has it, or in exactly one entry point otherwise */
export function lookupSymbol(index, name, preference) {
    for (const entry of preference) {
        const target = index.entries.get(entry)?.get(name)
        if (target) return target
    }
    const found = new Map()
    for (const symbols of index.entries.values()) {
        const target = symbols.get(name)
        if (target) found.set(target.url, target)
    }
    return found.size === 1 ? [...found.values()][0] : undefined
}

/** The member of a symbol's own page, or of the page of its linked type */
export function lookupMember(index, target, name) {
    const page = index.pages.get(target.url) ?? (target.type ? index.pages.get(target.type) : undefined)
    return page?.get(name)
}

/**
 * Resolve inline code that is exactly a public name, a member chain such as errors.apiCode or client.messages.send,
 * optionally written as a call with empty parentheses. A lowercase single word, such as text, is read as an API name
 * only when written as a call of a public function, so ordinary words and other APIs' methods stay plain
 */
export function resolveInlineCode(index, code, preference) {
    const match = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\(\))?$/.exec(code.trim())
    if (!match) return undefined
    const [root, ...members] = match[1].split(".")
    if (!members.length && conventionalRoots.has(root)) return undefined
    let target = lookupSymbol(index, conventionalRoots.get(root) ?? root, preference)
    if (!members.length && !/[A-Z]/.test(root) && !(match[2] && target?.function)) return undefined
    for (const member of members) target = target && lookupMember(index, target, member)
    return target?.url
}

const skipped = new Set(["heading", "link", "linkReference", "definition"])

/** Link inline code naming a public API to its reference, so it previews and opens like an authored link */
export function remarkReferenceLinks() {
    return async function transform(root, file) {
        const context = pageContext(file?.path)
        if (!context) return
        const index = await referenceIndexFor(context)
        const sources = []
        collect(root)
        const preference = entryPreference(context.entry, importsOnlyEffect(sources))
        let linked = 0
        visit(root, false)

        function collect(node) {
            if (node.type === "code") sources.push(node.value)
            else if (node.type === "html") sources.push(node.value)
            for (const child of node.children ?? []) collect(child)
        }
        function visit(node, signature) {
            if (!Array.isArray(node.children) || skipped.has(node.type)) return
            // Reference signatures already link their types
            const inSignature = signature || (context.reference && node.type === "blockquote")
            for (const [position, child] of node.children.entries()) {
                if (child.type !== "inlineCode" || inSignature) { visit(child, inSignature); continue }
                if (linked >= inlineLinkLimit) return
                const url = resolveInlineCode(index, child.value, preference)
                if (!url || url === context.url) continue
                node.children[position] = { type: "link", url, data: { hProperties: { "data-reference-link": "" } }, children: [child] }
                linked++
            }
        }
    }
}
