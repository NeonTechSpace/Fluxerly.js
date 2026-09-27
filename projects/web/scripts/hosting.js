import { readdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join, relative, sep } from "node:path"
import { createDocsHandler } from "./docs-routing.js"

/**
 * @param {string | URL} directory Build output directory
 * @param {{ latest?: string | null }} [options] The published path that /docs/latest/ redirects to
 */
export async function writeHostingArtifacts(directory, { latest = null } = {}) {
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
    pages.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    // Validate the inventory and latest target with the same policy the worker uses
    createDocsHandler(pages, latest)
    const runtime = await readFile(new URL("./docs-routing.js", import.meta.url), "utf8")
    await writeFile(join(root, "_worker.js"), `${runtime}\nexport default createDocsHandler(${JSON.stringify(pages)}, ${JSON.stringify(latest)})\n`)
    await writeFile(join(root, "_routes.json"), JSON.stringify({
        version: 1,
        include: ["/", "/docs", "/docs/*"],
        exclude: [],
    }, null, 2) + "\n")
}

export async function latestDocsPath() {
    const versions = JSON.parse(await readFile(new URL("../content/versions.json", import.meta.url), "utf8"))
    return versions.latestPath ? `/docs/${versions.latestPath}` : null
}

export function docsHosting() {
    return {
        name: "docs-hosting",
        hooks: { "astro:build:done": async ({ dir }) => writeHostingArtifacts(dir, { latest: await latestDocsPath() }) },
    }
}
