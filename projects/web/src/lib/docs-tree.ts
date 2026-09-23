import type { Root } from "fumadocs-core/page-tree"

// Version switching uses explicit channel links. The page tree only needs the
// viewed version for its sidebar, breadcrumbs, and previous/next links.
export function treeForVersion(tree: Root, version: string): Root {
    const folders = tree.children.filter(
        (node) => node.type === "folder" && node.root === "version" && node.$ref?.folder === version,
    )
    if (folders.length !== 1) throw new Error(`Documentation tree has no unique root for ${version}`)
    return { ...tree, children: folders }
}
