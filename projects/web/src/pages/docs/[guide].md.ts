import type { APIRoute } from "astro"
import { asMarkdown, guides, singleGuideMarkdown } from "../../lib/ai-docs"

export function getStaticPaths() {
    return guides.map((guide) => ({ params: { guide: guide.slug }, props: { source: guide.source } }))
}

export const GET: APIRoute = ({ props }) => asMarkdown(singleGuideMarkdown((props as { source: string }).source))
