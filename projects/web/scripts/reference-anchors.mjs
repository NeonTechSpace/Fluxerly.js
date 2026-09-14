import Slugger from "github-slugger"
import { remarkHeading } from "fumadocs-core/mdx-plugins"

// Move TypeDoc's explicit anchor onto its heading before Fumadocs extracts the TOC
// Keeping both the raw anchor and an auto-slugged heading creates duplicate IDs
export function remarkReferenceAnchors() {
    return function transform(root, file) {
        const reserved = new Set()
        visit(root)
        const slugger = new Slugger()
        return remarkHeading({
            slug: (_root, _heading, text) => {
                let id
                do {
                    id = slugger.slug(text)
                } while (reserved.has(id))
                reserved.add(id)
                return id
            },
        })(root, file)

        function visit(node) {
            if (!Array.isArray(node.children)) return
            for (let i = 0; i < node.children.length; i++) {
                const child = node.children[i]
                const html =
                    child.type === "html"
                        ? child.value
                        : child.type === "paragraph" && child.children.every((part) => part.type === "html")
                          ? child.children.map((part) => part.value).join("")
                          : ""
                const match = /^<a id="([\w.-]+)"><\/a>$/.exec(html.trim())
                const next = node.children[i + 1]
                if (match && next?.type === "heading") {
                    next.data ??= {}
                    next.data.hProperties ??= {}
                    next.data.hProperties.id = match[1]
                    if (reserved.has(match[1])) throw new Error(`Duplicate TypeDoc anchor: ${match[1]}`)
                    reserved.add(match[1])
                    node.children.splice(i--, 1)
                } else visit(child)
            }
        }
    }
}
