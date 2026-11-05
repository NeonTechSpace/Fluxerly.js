// A link that leaves the site opens in a new tab, as the site's own links to GitHub and npm do. Guides, the reference's comments and
// the changelog are Markdown, so this marks their links where they are rendered, and the docs' hover cards ask it too.
// tests/external-links.test.ts checks every built page
import { siteOrigin } from "./site-address.mjs"

const siteHost = new URL(siteOrigin).host

/** Whether a link's address leaves the site: a web address on another host */
export function leavesSite(href) {
    if (typeof href !== "string" || !/^(?:https?:)?\/\//i.test(href)) return false
    try {
        return new URL(href, `${siteOrigin}/`).host !== siteHost
    } catch {
        return false
    }
}

export default function rehypeExternalLinks() {
    const visit = (node) => {
        if (node.type === "element" && node.tagName === "a" && leavesSite(node.properties?.href)) {
            node.properties.target = "_blank"
            const rel = new Set([].concat(node.properties.rel ?? []).flatMap((value) => String(value).split(/\s+/)).filter(Boolean))
            rel.add("noopener")
            node.properties.rel = [...rel]
        }
        for (const child of node.children ?? []) visit(child)
    }
    return (tree) => visit(tree)
}
