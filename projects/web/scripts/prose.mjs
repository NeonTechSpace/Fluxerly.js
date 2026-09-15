// Highlight prose without changing Markdown paragraph boundaries
export function remarkProse() {
    return highlight
}

const technicalVocabulary = [
    "OAuth2",
    "OAuth",
    "Node\\.js",
    "JavaScript",
    "TypeScript",
    "WebSockets?",
    "UTF-8",
    "APIs?",
    "SDKs?",
    "JSON",
    "HTML",
    "XML",
    "ESM",
    "URLs?",
    "URI",
    "HTTPS?",
    "WSS?",
    "REST",
    "CLI",
    "pnpm",
    "npm",
]
const tokenStart = "(?<![#$\\p{L}\\p{N}_])"
const tokenEnd = "(?![#$\\p{L}\\p{N}_])"
const numberStart = "(?<![#$\\p{L}\\p{N}_,.])"
const numberEnd = "(?![#$\\p{L}\\p{N}_,]|\\.[#$\\p{L}\\p{N}_])"
const keywords = new RegExp(
    `${tokenStart}(?:${technicalVocabulary.join("|")}|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)${tokenEnd}|${numberStart}\\d+(?:,\\d{3})*(?:\\.\\d+)*(?:%)?${numberEnd}`,
    "gu",
)
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
