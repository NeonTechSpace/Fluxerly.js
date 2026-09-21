import { createShikiHighlighter } from "@astrojs/markdown-remark/shiki"

let highlighter
const cache = new Map()
const plainText = (node) => node.type === "text" ? node.value : node.tagName === "br" ? "\n"
    : (node.children ?? []).map(plainText).join("")
const hasCode = (node) => node.tagName === "code" || (node.children ?? []).some(hasCode)

async function colorRanges(text, declaration) {
    const prefix = declaration ? "interface Reference {\n" : "type Reference = "
    const suffix = declaration ? "\n}" : ";"
    const source = prefix + text + suffix
    if (!cache.has(source)) cache.set(source, (async () => {
        highlighter ??= createShikiHighlighter({ theme: "github-dark" })
        const tree = await (await highlighter).codeToHast(source, "ts")
        if (plainText(tree) !== source) throw new Error("Signature highlighting changed source text")
        const ranges = []
        let offset = 0
        function visit(node, style = "") {
            style = node.properties?.style ?? style
            if (node.type === "text") {
                const start = Math.max(offset, prefix.length)
                const end = Math.min(offset + node.value.length, prefix.length + text.length)
                const foreground = /(?:^|;)color:([^;]+)/.exec(style)?.[1]
                if (end > start) ranges.push({ start: start - prefix.length, end: end - prefix.length, style: foreground ? `color:${foreground}` : "" })
                offset += node.value.length
            } else for (const child of node.children ?? []) visit(child, style)
        }
        visit(tree)
        return ranges
    })())
    return cache.get(source)
}

// Apply the syntax token ranges to existing text nodes, retaining links and anchors
async function color(node, declaration = false) {
    const text = plainText(node)
    if (!text.trim()) return
    const ranges = await colorRanges(text, declaration)
    let offset = 0
    function visit(parent) {
        parent.children = parent.children.flatMap((child) => {
            if (child.type === "text") {
                const start = offset
                offset += child.value.length
                return ranges.filter((range) => range.start < offset && range.end > start).map((range) => ({
                    type: "element", tagName: "span", properties: { style: range.style, className: ["syntax-token"] },
                    children: [{ type: "text", value: child.value.slice(Math.max(0, range.start - start), Math.min(child.value.length, range.end - start)) }],
                }))
            }
            if (child.tagName === "br") offset++
            else if (child.children) visit(child)
            return [child]
        })
    }
    visit(node)
    if (plainText(node) !== text) throw new Error("Signature highlighting lost source text")
}

export function rehypeSignatureColors() {
    return async function transform(root) {
        async function visit(node) {
            if (node.tagName === "pre") return
            if (node.tagName === "blockquote") {
                for (const child of node.children ?? []) {
                    if (child.tagName === "p" && (hasCode(child) || child.children?.some((part) => part.tagName === "strong")))
                        await color(child, child.children.some((part) => part.tagName === "strong"))
                }
                return
            }
            if (node.tagName === "code") { await color(node); return }
            for (const child of node.children ?? []) await visit(child)
        }
        await visit(root)
    }
}
