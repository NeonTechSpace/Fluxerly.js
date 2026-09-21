import { readdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join, relative, sep } from "node:path"

export async function writeHostingArtifacts(directory) {
    const root = directory instanceof URL ? fileURLToPath(directory) : directory
    const pages = []
    async function visit(folder) {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
            const path = join(folder, entry.name)
            if (entry.isDirectory()) await visit(path)
            else if (entry.name === "index.html") pages.push("/" + relative(root, folder).split(sep).join("/"))
        }
    }
    await visit(join(root, "docs"))
    if (!pages.includes("/docs/latest")) throw new Error("Build has no latest documentation root")
    const runtime = await readFile(new URL("./docs-routing.mjs", import.meta.url), "utf8")
    await writeFile(join(root, "_worker.js"), `${runtime}\nexport default createDocsHandler(${JSON.stringify(pages.sort())})\n`)
    await writeFile(join(root, "_routes.json"), JSON.stringify({
        version: 1,
        include: ["/", "/docs", "/docs/*"],
        exclude: [],
    }, null, 2) + "\n")
}

export function docsHosting() {
    return {
        name: "docs-hosting",
        hooks: { "astro:build:done": async ({ dir }) => writeHostingArtifacts(dir) },
    }
}
