import type { APIContext } from "astro"
import { llmsFull } from "../../../lib/assistant-docs"
import { searchVersions } from "../../../lib/search-index"

export function getStaticPaths() {
    return searchVersions().map((version) => ({ params: { version } }))
}
export function GET({ params }: APIContext) {
    return new Response(llmsFull(params.version!), { headers: { "content-type": "text/plain; charset=utf-8" } })
}
