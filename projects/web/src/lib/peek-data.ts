// The peek index and recogniser tables for this site's build, from the reference model, the code catalogue and the
// guides. Built once per build and shared by the peek endpoint and the reference pages' Markdown
import { codes, model } from "./reference"
import { buildPeek, type PeekIndex, type PeekTerms } from "./peek-index"

const guides = import.meta.glob<string>("@content/guides/*.md", { query: "?raw", import: "default", eager: true })

const slugOf = (path: string) => /([\w-]+)\.md$/.exec(path)?.[1] ?? path
const frontmatter = (source: string, field: string) => new RegExp(`^${field}:\\s*(.+)$`, "m").exec(/^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? "")?.[1]?.trim()

let built: { index: PeekIndex; terms: PeekTerms } | undefined

export function peekData(): { index: PeekIndex; terms: PeekTerms } {
    if (built) return built
    const sources = Object.entries(guides).map(([path, source]) => ({ slug: slugOf(path), source }))
    const glossary = sources.find((guide) => guide.slug === "glossary")?.source
    if (!glossary) throw new Error("The peek index needs content/guides/glossary.md")
    built = buildPeek({
        model,
        codes,
        glossary,
        guideTitles: Object.fromEntries(sources.map(({ slug, source }) => [slug, frontmatter(source, "navTitle") ?? frontmatter(source, "title") ?? slug])),
        // A guide's link to a member opens a peek too
        links: sources.flatMap(({ source }) => [...source.matchAll(/\]\((\/docs\/api\/[^)\s]+)\)/g)].map((match) => match[1]!)),
    })
    return built
}
