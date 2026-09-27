import type { Folder, Item, Node, Root } from "fumadocs-core/page-tree"
import { getBreadcrumbItems } from "fumadocs-core/breadcrumb"
import { entryPointUrl } from "../../scripts/reference-entries.js"

export type Breadcrumb = { name: string; url?: string }

const referenceRoot = /\/api\/?$/

// The sidebar renders the reference as its landing page and entry points, so symbol pages stay on the server.
// Released snapshots may list only the entry points that existed when they were generated
function compact(node: Node): Node {
    if (node.type !== "folder") return node
    // A folder's landing page is its index, or a listed child when its metadata names the index explicitly
    const landing = node.index ?? node.children.find((child): child is Item => child.type === "page" && referenceRoot.test(child.url))
    if (landing && referenceRoot.test(landing.url)) {
        const entries = node.children
            .flatMap((child) => child.type === "folder" ? child.children : [child])
            .filter((child) => child.type === "page" && (entryPointUrl.test(child.url) || (!node.index && child === landing)))
        return { ...node, children: entries } satisfies Folder
    }
    return { ...node, children: node.children.map(compact) }
}

function versionFolder(tree: Root, version: string) {
    const folders = tree.children.filter(
        (node): node is Folder => node.type === "folder" && node.root === "version" && node.$ref?.folder === version,
    )
    if (folders.length !== 1) throw new Error(`Documentation tree has no unique root for ${version}`)
    return folders[0]!
}

// Version switching uses explicit channel links. The page tree only needs the
// viewed version for its sidebar and previous/next links.
export function treeForVersion(tree: Root, version: string): Root {
    return { ...tree, children: [compact(versionFolder(tree, version))] }
}

// Breadcrumbs come from the complete version tree, including symbols the browser tree omits
export function breadcrumbsFor(tree: Root, version: string, url: string): Breadcrumb[] {
    const scoped: Root = { ...tree, children: [versionFolder(tree, version)] }
    return getBreadcrumbItems(url, scoped).map((item) => ({
        name: breadcrumbName(item.name, url),
        ...(item.url ? { url: item.url } : {}),
    }))
}

// Page tree names are typed as React nodes, but breadcrumbs render plain text.
// A rich name fails the build rather than rendering as "[object Object]"
function breadcrumbName(name: unknown, url: string): string {
    if (typeof name === "string") return name
    if (typeof name === "number") return String(name)
    throw new Error(`Breadcrumb for ${url} has a name that is not plain text`)
}
