// Highlight prose without changing Markdown paragraph boundaries
export function remarkProse() {
    return highlight
}

const keywords = /\b(?:HTTPS?|WSS?|REST|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|\d+(?:,\d{3})*(?:\.\d+)*(?:%)?)\b/g
const excluded = new Set(["code", "inlineCode", "html", "blockquote", "link", "linkReference", "image", "imageReference"])

function highlight(node) {
    if (excluded.has(node.type) || !Array.isArray(node.children)) return
    node.children = node.children.flatMap((child) => {
        if (child.type !== "text") {
            highlight(child)
            return [child]
        }
        const parts = []
        let offset = 0
        for (const match of child.value.matchAll(keywords)) {
            if (match.index > offset) parts.push({ type: "text", value: child.value.slice(offset, match.index) })
            const kind = /^\d/.test(match[0]) ? "number" : match[0].includes("_") ? "constant" : "keyword"
            parts.push({
                type: "emphasis",
                data: { hName: "span", hProperties: { className: [`prose-${kind}`] } },
                children: [{ type: "text", value: match[0] }],
            })
            offset = match.index + match[0].length
        }
        if (offset < child.value.length) parts.push({ type: "text", value: child.value.slice(offset) })
        return parts
    })
}
