import { createHash } from "node:crypto"
import { createSearchAPI, type AdvancedIndex } from "fumadocs-core/search/server"
import { structure } from "fumadocs-core/mdx-plugins"
import { source } from "./source"
import { referenceSearchEntries } from "../../scripts/reference-summary.js"

type Index = { body: string; file: string }
const indexes = new Map<string, Promise<Index>>()

// Generated symbol pages contribute names, first summary sentences, parameter names and error tags.
// Guides and the handwritten reference landing pages keep full text
export const isSymbolPage = (slugs: string[]) =>
    slugs[1] === "api" && slugs.length > 2 && slugs[2] !== "tasks"

async function build(version: string): Promise<Index> {
    const pages = source.getPages().filter((page) => page.slugs[0] === version)
    if (pages.length === 0) throw new Error(`No documentation pages for ${version}`)
    const api = createSearchAPI("advanced", {
        // Results are ranked by relevance, so the exported sort index would only add download size
        sort: { enabled: false },
        indexes: pages.flatMap((page): AdvancedIndex[] => {
            const body = page.data.entry.body ?? ""
            if (isSymbolPage(page.slugs))
                return referenceSearchEntries(body, { title: page.data.title, url: page.url }).map((entry) => ({ ...entry, tag: version }))
            const structuredData = structure(body)
            // The sidebar label is searchable and shown with the page title, so "Troubleshooting" finds its guide
            const label = page.data.navTitle && page.data.navTitle !== page.data.title ? page.data.navTitle : undefined
            if (label) structuredData.contents.unshift({ heading: undefined, content: label })
            return [{
                id: page.url, url: page.url, title: page.data.title, description: page.data.description, tag: version, structuredData,
                ...(label ? { breadcrumbs: [label] } : {}),
            }]
        }),
    })
    const body = await (await api.staticGET()).text()
    // The content hash lets browsers keep each index until the documentation changes
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 16)
    return { body, file: `${version}.${hash}` }
}

export function searchIndex(version: string) {
    let index = indexes.get(version)
    if (!index) {
        index = build(version)
        indexes.set(version, index)
    }
    return index
}

export async function searchIndexUrl(version: string) {
    return `/api/search/${(await searchIndex(version)).file}.json`
}

export function searchVersions() {
    return [...new Set(source.getPages().map((page) => page.slugs[0]!))]
}
