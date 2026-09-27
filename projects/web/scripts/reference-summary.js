// Condense generated reference Markdown into names, signatures and first summary sentences.
// Search and assistant indexes use this instead of full reference text

import { isEntryPointTitle, referenceEntryForUrl } from "./reference-entries.js"

// Section headings that only group a page's own content
const structural = /^(?:Properties|Methods|Parameters|Returns|Type Parameters|Type Declaration|Type declaration|Examples?|Extends|Implements|Call Signature|Constructors?|Accessors|Index Signature|Indexable|Throws|See|Deprecated|Classes|Interfaces|Type Aliases|Variables|Functions|Enumerations?|Enumeration Members|Events|Hierarchy|Overrides|Inherited from|Implementation of|Get Signature|Set Signature)$/

/** Plain text for generated inline Markdown, keeping link and code labels */
export function plainText(markdown) {
    return markdown
        // Escaped type brackets are text, not HTML tags
        .replace(/\\</g, "&lt;").replace(/\\>/g, "&gt;")
        .replace(/<br\s*\/?>/g, " ")
        .replace(/&#160;|&nbsp;/g, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\\([<>|*_[\]`])/g, "$1")
        .replace(/[`*]/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .replace(/<\s/g, "<").replace(/\s>/g, ">")
        .trim()
}

/** The first sentence of a paragraph, which the house style may leave without a final period */
export function firstSentence(text) {
    const value = plainText(text)
    const end = value.search(/\.(?=\s+[A-Z])/)
    return (end < 0 ? value : value.slice(0, end)).replace(/\.$/, "")
}

const errorNames = (text) => [...new Set(plainText(text).match(/\b[A-Z][A-Za-z]*(?:Error|Failure|Defect)\b/g) ?? [])]
const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim())
const anchorOf = (text) => /<a id="([^"]+)"><\/a>/.exec(text)?.[1]

/** @typedef {{ anchor: string, name: string, depth: number, summary: string, signature: string, parameters: string[], errors: string[] }} ReferenceSection */
/** @typedef {{ anchor: string, name: string, owner: string | undefined, summary: string }} ReferenceProperty */

/**
 * Parse generated reference Markdown.
 * Sections are symbol or member headings with TypeDoc anchors. Properties are anchored table rows
 */
export function summarizeReference(markdown) {
    const lines = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").split(/\r?\n/)
    /** @type {{ summary: string, sections: ReferenceSection[], properties: ReferenceProperty[] }} */
    const page = { summary: "", sections: [], properties: [] }
    /** @type {ReferenceSection | null} */
    let section = null
    let pendingAnchor
    let fence = null
    let paragraph = []
    let table = null
    let subsection = null
    const target = () => section ?? page
    const flushParagraph = () => {
        if (!paragraph.length) return
        const text = paragraph.join(" ")
        paragraph = []
        const owner = target()
        if (!owner.summary && !subsection) owner.summary = firstSentence(text)
    }
    const flushTable = () => {
        if (!table) return
        const [header, ...rows] = table
        table = null
        const columns = cells(header).map(plainText)
        const description = columns.indexOf("Description")
        for (const row of rows) {
            const values = cells(row)
            const name = plainText(values[0] ?? "").replace(/\?$/, "")
            if (!name) continue
            const anchor = anchorOf(values[0] ?? "")
            if (anchor && (columns[0] === "Property" || columns[0] === "Member" || columns[0] === "Enumeration Member")) {
                page.properties.push({ anchor, name, owner: section?.name, summary: description >= 0 ? firstSentence(values[description] ?? "") : "" })
            } else if (section && (columns[0] === "Parameter" || columns[0] === "Type Parameter")) {
                if (columns[0] === "Parameter") section.parameters.push(name)
            }
        }
    }
    for (const line of lines) {
        if (fence) {
            if (line.trimStart().startsWith(fence)) fence = null
            continue
        }
        const opening = /^\s*(`{3,}|~{3,})/.exec(line)
        if (opening) {
            flushParagraph(); flushTable()
            fence = opening[1]
            continue
        }
        if (line.startsWith("|")) {
            flushParagraph()
            if (/^\|\s*:?-{3,}/.test(line)) continue
            table ??= []
            table.push(line)
            continue
        }
        flushTable()
        const anchor = /^<a id="([^"]+)"><\/a>$/.exec(line.trim())
        if (anchor) { flushParagraph(); pendingAnchor = anchor[1]; continue }
        const heading = /^(#{2,6})\s+(.+)$/.exec(line)
        if (heading) {
            flushParagraph()
            const text = plainText(heading[2])
            // Category sections move grouped symbols one level deeper
            if (pendingAnchor && heading[1].length <= 4 && !structural.test(text) && !pendingAnchor.startsWith("category-")) {
                section = { anchor: pendingAnchor, name: text.replace(/\(\)$/, ""), depth: heading[1].length, summary: "", signature: "", parameters: [], errors: [] }
                page.sections.push(section)
                subsection = null
            } else if (heading[1].length <= 3) {
                subsection = null
                if (heading[1].length === 2) section = null
            } else subsection = text
            pendingAnchor = undefined
            continue
        }
        if (!line.trim()) { flushParagraph(); continue }
        pendingAnchor = undefined
        if (line.startsWith(">")) {
            flushParagraph()
            const owner = target()
            const text = plainText(line.replace(/^>\s?/, ""))
            if (owner !== page && !owner.signature && !subsection) owner.signature = text
            if (owner !== page) owner.errors.push(...errorNames(line).filter((name) => !owner.errors.includes(name)))
            continue
        }
        if (/^\s*<\/?(?:details|summary)/.test(line) || line.trim() === "***") { flushParagraph(); continue }
        if (!line.trim()) { flushParagraph(); continue }
        paragraph.push(line)
    }
    flushParagraph(); flushTable()
    return page
}

/**
 * Fumadocs search entries for a reference page.
 * Entry point pages contribute one entry per grouped symbol, so a symbol ranks as its own result.
 * They are found by URL, because released snapshots keep the entry titles they were generated with
 */
export function referenceSearchEntries(markdown, { title, url }) {
    if (!referenceEntryForUrl(url)) {
        const { summary, structuredData } = referenceSearchData(markdown, title)
        return [{ id: url, url, title, description: summary, structuredData }]
    }
    const page = summarizeReference(markdown)
    const entries = [{ id: url, url, title, description: page.summary, structuredData: { headings: [], contents: [] } }]
    for (const section of page.sections) {
        const properties = page.properties.filter((property) => property.owner === section.name)
        const details = [
            section.parameters.length ? `Parameters: ${section.parameters.join(", ")}` : "",
            section.errors.length ? `Errors: ${section.errors.join(", ")}` : "",
        ].filter(Boolean)
        entries.push({
            id: `${url}#${section.anchor}`,
            url: `${url}#${section.anchor}`,
            title: section.name,
            description: section.summary,
            // The entry URL already has the section fragment, so its properties are text rather than headings
            structuredData: {
                headings: [],
                contents: [
                    ...(details.length ? [{ heading: undefined, content: details.join(". ") }] : []),
                    ...properties.map((property) => ({ heading: undefined, content: [`${section.name}.${property.name}`, property.summary].filter(Boolean).join(". ") })),
                ],
            },
        })
    }
    return entries
}

/**
 * Fumadocs structured search data for a reference page:
 * headings for symbols, members and properties, with first summary sentences, parameter names and error tags
 */
export function referenceSearchData(markdown, title) {
    const page = summarizeReference(markdown)
    const headings = []
    const contents = []
    if (page.summary) contents.push({ heading: undefined, content: page.summary })
    // Word segmentation keeps Owner.member as one token, so headings carry the bare name for
    // member searches and the text carries the qualified name for Owner.member searches
    const qualified = (name, owner) => owner && owner !== name ? `${owner}.${name}` : name
    // Entry point pages hold grouped symbols. Other reference pages hold one symbol's members
    const entryPoint = isEntryPointTitle(title)
    const describe = (name, parts) => [name, ...parts.filter(Boolean)].join(". ")
    for (const section of page.sections) {
        headings.push({ id: section.anchor, content: section.name })
        contents.push({ heading: section.anchor, content: describe(entryPoint ? "" : qualified(section.name, title), [
            section.summary,
            section.parameters.length ? `Parameters: ${section.parameters.join(", ")}` : "",
            section.errors.length ? `Errors: ${section.errors.join(", ")}` : "",
        ]).replace(/^\. /, "") })
    }
    for (const property of page.properties) {
        headings.push({ id: property.anchor, content: property.name })
        contents.push({ heading: property.anchor, content: describe(qualified(property.name, entryPoint ? property.owner : title), [property.summary]) })
    }
    return { summary: page.summary, structuredData: { headings, contents } }
}
