import type { APIRoute } from "astro"
import { asMarkdown, guideMarkdown, guides } from "../../lib/ai-docs"

export function getStaticPaths() {
    return guides.map((guide) => ({ params: { guide: guide.slug }, props: { source: guide.source } }))
}

export const GET: APIRoute = ({ props }) => asMarkdown(guideMarkdown((props as { source: string }).source))
