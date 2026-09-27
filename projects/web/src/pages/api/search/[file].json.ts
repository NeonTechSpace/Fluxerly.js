import { searchIndex, searchVersions } from "../../../lib/search-index"
import type { APIContext } from "astro"

export async function getStaticPaths() {
    return Promise.all(searchVersions().map(async (version) => ({
        params: { file: (await searchIndex(version)).file },
        props: { version },
    })))
}
export async function GET({ props }: APIContext<{ version: string }>) {
    return new Response((await searchIndex(props.version)).body, { headers: { "content-type": "application/json" } })
}
