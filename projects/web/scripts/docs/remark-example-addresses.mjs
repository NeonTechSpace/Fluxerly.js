// An address Markdown links by itself from bare text, such as https://example.test in a doc comment, is a link only when it leads
// somewhere. When its host is a name reserved for examples or the local machine (RFC 2606 and RFC 6761), or a bare name with no dot
// such as host, it reads as code instead. A link the author wrote, as [text](url) or <url>, stays as written. Guides, the reference's
// comments and the changelog all use this, so each follows the same rule

const reservedEndings = [".test", ".example", ".invalid", ".localhost"]
const reservedNames = ["example.com", "example.net", "example.org"]

/** Whether an address's host is reserved for examples or the local machine, or has no dot */
export function exampleAddress(href) {
    let host
    try {
        host = new URL(href).hostname.toLowerCase().replace(/\.$/, "")
    } catch {
        return false
    }
    if (!host) return false
    if (!host.includes(".")) return true
    if (reservedEndings.some((ending) => host.endsWith(ending))) return true
    return reservedNames.some((name) => host === name || host.endsWith(`.${name}`))
}

// GFM's literal autolinks start at the address itself. A link the author wrote starts with [ or <
function autolinkedFromText(node, source) {
    const start = node.position?.start?.offset
    if (typeof start !== "number" || typeof source !== "string") return false
    return /^(?:https?:\/\/|www\.)/i.test(source.slice(start, start + 8))
}

export default function remarkExampleAddresses() {
    return (tree, file) => {
        const source = typeof file?.value === "string" ? file.value : String(file?.value ?? "")
        const visit = (node) => {
            if (!node.children) return
            node.children = node.children.map((child) => {
                if (child.type === "link" && autolinkedFromText(child, source) && exampleAddress(child.url)) {
                    const text = child.children?.map((part) => part.value ?? "").join("") || child.url
                    return { type: "inlineCode", value: text, position: child.position }
                }
                visit(child)
                return child
            })
        }
        visit(tree)
    }
}
