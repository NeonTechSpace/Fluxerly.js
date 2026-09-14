import { createSearchAPI } from "fumadocs-core/search/server"
import { structure } from "fumadocs-core/mdx-plugins"
import { source } from "../../../lib/source"
import type { APIContext } from "astro"

export function getStaticPaths() {
    return [...new Set(source.getPages().map((page) => page.slugs[0]))].map((version) => ({ params: { version } }))
}
export async function GET({ params }: APIContext) {
    const pages = source.getPages().filter((page) => page.slugs[0] === params.version)
    const api = createSearchAPI("advanced", {
        indexes: pages.map((page) => ({
            id: page.url,
            url: page.url,
            title: page.data.title,
            description: page.data.description,
            tag: params.version,
            structuredData: structure(page.data.entry.body ?? ""),
        })),
    })
    return api.staticGET()
}
