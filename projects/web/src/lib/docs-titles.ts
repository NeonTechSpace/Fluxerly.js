import { getCollection } from "astro:content"
import { titleQualifiers } from "./docs-meta"
import { guideGroup } from "./docs-nav"
import { categoryPages, model, symbolPages } from "./reference"

// The docs pages whose titles come from the guides and the reference model, each with the steps that can tell it apart
// from another page of the same name: a guide by its group, a reference page by its entry point and category, and an
// entry point's front page as its overview. Worked out once per build, for every page at once
let qualifiers: Promise<Map<string, string>> | undefined

export async function docsTitleQualifier(href: string): Promise<string | undefined> {
    qualifiers ??= getCollection("guides", (entry) => entry.id !== "index").then((guides) =>
        titleQualifiers([
            ...guides.map((entry) => ({ href: `/docs/${entry.id}/`, title: entry.data.title, context: [guideGroup(entry.id) ?? "Guides"] })),
            ...model.entries.map((entry) => ({ href: entry.url, title: entry.title, context: ["Overview"] })),
            ...categoryPages().map(({ entry, category }) => ({ href: category.url, title: category.title, context: [entry.title, "Symbols"] })),
            ...symbolPages().map(({ entry, category, declaration }) => ({
                href: declaration.url,
                title: declaration.name,
                context: [entry.title, ...(category ? [category.title] : [])],
            })),
        ]),
    )
    return (await qualifiers).get(href)
}
