// The docs' hover peeks as one JSON file, which src/lib/docs-peek.ts fetches on a reader's first hover
import type { APIRoute } from "astro"
import { peekData } from "../../lib/peek-data"

export const GET: APIRoute = () => new Response(JSON.stringify(peekData().index), { headers: { "content-type": "application/json" } })
