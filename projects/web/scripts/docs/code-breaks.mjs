// Break opportunities inside inline code. An identifier such as lifecycle.connectionEnded may only wrap where a reader
// sees a seam: before a dot, at a camelCase hump, after a slash, an underscore, a double colon, an opening parenthesis
// or a comma. Each seam becomes a <wbr>, which has no text, so copied text, search and screen readers keep the
// identifier whole. The styles keep a code span on one line whenever it fits, so the seams are used only by code that
// is longer than a whole line

// Neither side of a seam may be shorter than this, so a break never strands one letter
const shortest = 2

const word = /[A-Za-z0-9_$]/
const lower = /[a-z0-9]/
const upper = /[A-Z]/

/** The positions in text before which a line may break. In a code block a name holds together, whatever its humps */
export function seams(text, { block = false } = {}) {
    const points = []
    let last = 0
    for (let index = 1; index < text.length; index++) {
        const before = text[index - 1]
        const at = text[index]
        const after = text[index + 1] ?? ""
        const seam =
            // Before a member dot, the style manuals' rule for paths and URLs: the next line starts with .name. A dot
            // that starts a file's extension at the end of a path, as in AGENTS.md, keeps the file name whole
            (at === "." && /[\w$)\]>]/.test(before) && /[A-Za-z_$#]/.test(after) && !/^\.(md|js|ts|mjs|cjs|mts|cts|json|env|txt|yml|yaml|html|css|lock)$/.test(text.slice(index))) ||
            // At a camelCase hump, and before the last capital of an acronym that starts a word, as in HTTP|Client
            (!block && upper.test(at) && lower.test(before)) ||
            (!block && upper.test(at) && upper.test(before) && /[a-z]/.test(after)) ||
            // After a slash, an underscore, a double colon, an opening parenthesis or a comma with no space after it.
            // A comma between digits is part of a number
            (before === "/" && word.test(at) && !(block && /@[\w-]+\/$/.test(text.slice(0, index)))) ||
            (before === "_" && /[A-Za-z]/.test(at) && word.test(text[index - 2] ?? "")) ||
            (before === ":" && text[index - 2] === ":" && word.test(at)) ||
            (before === "(" && at !== ")") ||
            (before === "," && /[^\s\d]/.test(at))
        if (seam && index - last >= shortest && text.length - index >= shortest) {
            points.push(index)
            last = index
        }
    }
    return points
}

/** Splits text at its seams */
export function segments(text) {
    const parts = []
    let start = 0
    for (const point of seams(text)) {
        parts.push(text.slice(start, point))
        start = point
    }
    parts.push(text.slice(start))
    return parts
}

const escape = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character])

/** Escaped HTML of text with a <wbr> at each seam */
export const breakableHtml = (text) => segments(String(text)).map(escape).join("<wbr>")

/**
 * Escaped HTML of an HTTP route template such as /channels/{channel_id}/messages. It may break only after a slash, never
 * after the leading one: each segment is a route-part that the styles keep whole, so a segment such as refresh-urls
 * never breaks at its hyphen. Each {parameter} is marked, so the fixed words of the route stand out from what a caller
 * fills in
 */
export const routeHtml = (path) =>
    "/" +
    String(path)
        .replace(/^\//, "")
        .split("/")
        .map((segment) => `<span class="${/^\{[^}]+\}$/.test(segment) ? "route-part route-param" : "route-part"}">${escape(segment)}</span>`)
        .join("/<wbr>")

/** Escaped HTML of a label that is one identifier, such as a heading in an outline. Text with spaces breaks at its spaces */
export const identifierHtml = (text) => (/\s/.test(String(text)) ? escape(text) : breakableHtml(text))

const unescape = (value) => value.replace(/&(lt|gt|quot|#39|amp);/g, (_, name) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[name])

/** Rendered HTML of a short piece of code, such as a heading's name or a link around it, with seams in its text */
export const seamHtml = (html) =>
    String(html)
        .split(/(<[^>]*>)/)
        .map((part) => (part.startsWith("<") ? part : breakableHtml(unescape(part))))
        .join("")

const isCode = (node) => node.type === "element" && node.tagName === "code"

const wbr = () => ({ type: "element", tagName: "wbr", properties: {}, children: [] })

// A path written as plain prose, such as node_modules/@scope/name/file.md, is one word to the browser and runs past a
// phone's edge. It gets the same seams as code, so it breaks after a slash and never inside a word part
const prosePath = /[^\s/]*\/[^\s]*\/[^\s]*/g

function pathSeams(text) {
    const parts = []
    let last = 0
    for (const match of text.matchAll(prosePath)) {
        if (match[0].length < 24) continue
        parts.push({ type: "text", value: text.slice(last, match.index) })
        segments(match[0]).forEach((part, index) => parts.push(...(index ? [wbr()] : []), { type: "text", value: part }))
        last = match.index + match[0].length
    }
    if (!parts.length) return null
    parts.push({ type: "text", value: text.slice(last) })
    return parts.filter((part) => part.type !== "text" || part.value)
}

// Inline code and long paths in prose. Code blocks keep their own lines, and the command chips are raw HTML until the
// end of the pipeline
function addSeams(node, insidePre) {
    if (!Array.isArray(node.children)) return
    const pre = insidePre || (node.type === "element" && node.tagName === "pre")
    if (isCode(node) && !pre) {
        node.children = node.children.flatMap((child) => {
            if (child.type !== "text") return [child]
            return segments(child.value).flatMap((part, index) => [...(index ? [wbr()] : []), { type: "text", value: part }])
        })
        return
    }
    if (!pre) {
        node.children = node.children.flatMap((child) => (child.type === "text" ? (pathSeams(child.value) ?? [child]) : [child]))
    }
    for (const child of node.children) addSeams(child, pre)
}

/** Rehype plugin that adds the seams to every inline code element */
export default function rehypeCodeBreaks() {
    return (tree) => addSeams(tree, false)
}

/** Highlighter step that marks each code line with its indent, so the turned part of a long line can hang past it */
export const codeLineIndent = {
    name: "code-line-indent",
    line(node, line) {
        const lead = /^[ \t]*/.exec(this.source.split("\n")[line - 1] ?? "")?.[0] ?? ""
        const width = lead.replace(/\t/g, "    ").length
        if (width > 0) node.properties.style = `--indent:${width}ch`
    },
}

/** A block longer than this is cut to its first lines, with a button for the rest. Long code buried a page, most of all on a phone */
export const longCodeLines = 28
export const shownCodeLines = 16

/** Marks every long block in a page and adds its button, which sits beside the code, not in it, so it stays in place while a phone
 * scrolls the code sideways. The two languages of one example count as one block, so switching language never changes its size */
export function remarkLongCode() {
    const lineCount = (node) => node.value.trimEnd().split("\n").length
    const button = (node) => {
        const show = `Show All ${lineCount(node)} Lines`
        return { type: "html", value: `<button type="button" class="code-more" data-code-more data-pagefind-ignore aria-expanded="false" data-show="${show}" data-hide="Show Less">${show}</button>` }
    }
    const visit = (parent) => {
        if (!parent.children) return
        const pairs = []
        parent.children.forEach((child, index) => {
            if (child.type !== "code") return
            const between = parent.children[index - 1]
            const previous = parent.children[index - 2]
            if (between?.type === "html" && previous?.type === "code" && between.value.includes('data-lang-variant="ts"')) pairs.at(-1).push(child)
            else pairs.push([child])
        })
        for (const block of pairs) {
            if (Math.max(...block.map(lineCount)) <= longCodeLines) continue
            for (const node of block) {
                node.meta = "collapse"
                parent.children.splice(parent.children.indexOf(node) + 1, 0, button(node))
            }
        }
        parent.children.forEach(visit)
    }
    return (tree) => visit(tree)
}

/** Highlighter step that puts the later lines of a block marked "collapse" in an element that stays hidden until asked for or found */
export const collapseLongCode = {
    name: "collapse-long-code",
    code(node) {
        if (this.options.meta?.__raw !== "collapse") return
        let lines = 0
        const split = node.children.findIndex((child) => child.type === "element" && ++lines > shownCodeLines)
        if (split < 0) return
        node.children = [...node.children.slice(0, split), { type: "element", tagName: "span", properties: { class: "code-rest", hidden: "until-found" }, children: node.children.slice(split) }]
    },
}
