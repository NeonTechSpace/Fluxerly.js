import { loader, type StaticSource } from "fumadocs-core/source"
import { getCollection, type CollectionEntry } from "astro:content"
import { relative } from "node:path"

const files: StaticSource<{
    metaData: CollectionEntry<"meta">["data"]
    pageData: CollectionEntry<"docs">["data"] & { entry: CollectionEntry<"docs"> }
}>["files"] = []

for (const entry of await getCollection("docs")) {
    files.push({
        type: "page",
        path: relative("content/docs", entry.filePath!).replaceAll("\\", "/"),
        data: { ...entry.data, entry },
    })
}
for (const entry of await getCollection("meta")) {
    files.push({
        type: "meta",
        path: relative("content/docs", entry.filePath!).replaceAll("\\", "/"),
        data: entry.data,
    })
}

export const source = loader({
    baseUrl: "/docs",
    source: { files },
    pageTree: {
        transformers: [
            {
                file(node, path) {
                    const file = path ? this.storage.read(path) : undefined
                    const navTitle = file?.format === "page" ? file.data.navTitle : undefined
                    return navTitle ? { ...node, name: navTitle } : node
                },
            },
        ],
    },
})
