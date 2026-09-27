import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { createMarkdownProcessor, parseFrontmatter } from "@astrojs/markdown-remark"

// Astro's Markdown pipeline already ships this HTML parser, so tests reuse it instead of adding another
const astroRequire = createRequire(import.meta.resolve("@astrojs/markdown-remark"))
const { fromHtml } = await import(pathToFileURL(astroRequire.resolve("hast-util-from-html")).href)

/** Parse serialized HTML into a HAST root so tests can assert structure instead of markup text */
export function parseHtml(html, { fragment = true } = {}) {
    return fromHtml(html, { fragment })
}

/** Every element in document order, each with its ancestor elements */
export function elements(root) {
    const result = []
    const visit = (node, ancestors) => {
        for (const child of node.children ?? []) {
            if (child.type !== "element") continue
            result.push({ node: child, ancestors })
            visit(child, [...ancestors, child])
        }
    }
    visit(root, [])
    return result
}

/** Elements matching a tag name, or a predicate over the element and its ancestors */
export function findAll(root, match) {
    const test = typeof match === "string" ? (node) => node.tagName === match : match
    return elements(root).filter(({ node, ancestors }) => test(node, ancestors)).map(({ node }) => node)
}

export function find(root, match) {
    return findAll(root, match)[0]
}

/** DOM textContent: text values joined without layout whitespace */
export function textContent(node) {
    if (node.type === "text") return node.value
    return (node.children ?? []).map(textContent).join("")
}

/** Text with runs of whitespace collapsed, for comparing rendered sentences */
export function normalizedText(node) {
    return textContent(node).replace(/\s+/g, " ").trim()
}

export function hasClass(node, name) {
    return (node.properties?.className ?? []).includes(name)
}

export const isHeading = (node) => /^h[1-6]$/.test(node.tagName)

/** The first heading after the anchor element with the given ID, at any heading depth */
export function headingAfterAnchor(root, id) {
    const all = elements(root).map(({ node }) => node)
    const anchor = all.findIndex((node) => node.tagName === "a" && node.properties?.id === id)
    if (anchor < 0) return undefined
    return all.slice(anchor + 1).find(isHeading)
}

/** Elements between two anchor IDs in document order, for checking one generated section */
export function between(root, startId, endId) {
    const all = elements(root).map(({ node }) => node)
    const index = (id) => all.findIndex((node) => node.tagName === "a" && node.properties?.id === id)
    const start = index(startId)
    if (start < 0) throw new Error(`Missing anchor ${startId}`)
    const end = endId === undefined ? all.length : index(endId)
    if (end < 0) throw new Error(`Missing anchor ${endId}`)
    return all.slice(start + 1, end)
}

let markdown
/** Render generated Markdown with Astro's default pipeline and return its frontmatter and HTML tree */
export async function renderMarkdown(source) {
    markdown ??= createMarkdownProcessor()
    const { frontmatter, content } = parseFrontmatter(source)
    const { code } = await (await markdown).render(content)
    return { frontmatter, tree: parseHtml(code) }
}

/** Link targets with percent-encoding removed, so a documentation placeholder reads as authored */
export const href = (node) => decodeURI(node.properties?.href ?? "")
