import type { APIContext } from "astro"
import { source } from "../../lib/source"
import { hasMarkdownTwin, markdownTwinUrl, pageMarkdown } from "../../lib/assistant-docs"

type Page = ReturnType<typeof source.getPages>[number]

// Guides, the overview, the changelog and the reference overview and task index have Markdown twins. Symbol pages
// stay HTML, and llms-reference.txt condenses them
export function getStaticPaths() {
    return source.getPages().filter(hasMarkdownTwin).map((page) => ({
        params: { slug: markdownTwinUrl(page.slugs).slice("/docs/".length, -".md".length) },
        props: { page },
    }))
}
export function GET({ props }: APIContext<{ page: Page }>) {
    return new Response(pageMarkdown(props.page), { headers: { "content-type": "text/markdown; charset=utf-8" } })
}
