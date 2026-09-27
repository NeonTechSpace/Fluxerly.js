import { llmsRoot } from "../lib/assistant-docs"
import { searchVersions } from "../lib/search-index"

export function GET() {
    return new Response(llmsRoot(searchVersions()), { headers: { "content-type": "text/plain; charset=utf-8" } })
}
