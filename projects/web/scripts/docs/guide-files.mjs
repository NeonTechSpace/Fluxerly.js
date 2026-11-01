// The authored guides as the SDK's package check reads them: every guide in the sidebar's inventory, with its example markers filled in from
// the SDK's own examples, so the check compiles what readers see. It needs nothing generated
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const guidesRoot = fileURLToPath(new URL("../../content/guides/", import.meta.url))
const examplesRoot = fileURLToPath(new URL("../../../sdk/examples/", import.meta.url))

export async function authoredGuides() {
    const { groups } = JSON.parse(await readFile(join(guidesRoot, "meta.json"), "utf8"))
    const listed = groups.flatMap((group) => group.items).filter((item) => typeof item === "string")
    const files = (await readdir(guidesRoot)).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3))
    const unlisted = files.filter((slug) => slug !== "index" && !listed.includes(slug))
    if (unlisted.length) throw new Error(`Authored guides missing from the inventory: ${unlisted.join(", ")}`)
    const slugs = files.includes("index") ? ["index", ...listed] : listed
    return Promise.all(
        slugs.map(async (slug) => {
            const source = await readFile(join(guidesRoot, `${slug}.md`), "utf8")
            const parts = source.split(/(\{\{(?:starter:[\w.-]+|example:[\w-]+\/[\w.-]+)\}\})/)
            const filled = await Promise.all(
                parts.map(async (part) => {
                    const marker = /^\{\{(starter|example):(.+)\}\}$/.exec(part)
                    if (!marker) return part
                    const path = marker[1] === "starter" ? `starter/${marker[2]}` : marker[2]
                    return (await readFile(join(examplesRoot, path), "utf8")).trimEnd()
                }),
            )
            return { slug, content: filled.join("") }
        }),
    )
}
