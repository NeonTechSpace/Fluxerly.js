import type { APIContext } from "astro"
import { source } from "../../lib/source"
import { markdownTwinUrl, pageMarkdown } from "../../lib/assistant-docs"

type Page = ReturnType<typeof source.getPages>[number]

// Guides, the overview and the changelog have Markdown twins. Reference pages use llms-full.txt
export function getStaticPaths() {
    return source.getPages().filter((page) => page.slugs[1] !== "api").map((page) => ({
        params: { slug: markdownTwinUrl(page.slugs).slice("/docs/".length, -".md".length) },
        props: { page },
    }))
}
export function GET({ props }: APIContext<{ page: Page }>) {
    return new Response(pageMarkdown(props.page), { headers: { "content-type": "text/markdown; charset=utf-8" } })
}
