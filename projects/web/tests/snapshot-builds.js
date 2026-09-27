import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "astro"
import { generate, webRoot } from "../scripts/generate.js"

const exists = (path) => access(path).then(() => true, () => false)

/**
 * Build public documentation from release snapshots and check every retained version's served pages.
 * The generated content directory is left in the public state, so callers restore it afterward
 */
export async function checkSnapshotBuild({ releasesDirectory, outDir }) {
    await generate({ releasesDirectory, publicBuild: true })
    const metadata = JSON.parse(await readFile(join(webRoot, "content/versions.json"), "utf8"))
    assert.ok(metadata.versions.length > 0, "No retained snapshot was imported")
    await build({ root: webRoot, outDir, logLevel: "warn" })
    const searchFiles = await readdir(join(outDir, "api/search"))
    const served = []
    for (const version of metadata.versions) {
        const path = metadata.targets.find((target) => target.version === version)?.path ?? version
        for (const page of ["", "quick-start/", "changelog/", "api/"])
            assert.ok(await exists(join(outDir, "docs", path, page, "index.html")), `${version} is missing /docs/${path}/${page}`)
        for (const file of ["llms.txt", "llms-full.txt", "llms-reference.txt", "quick-start.md"])
            assert.ok(await exists(join(outDir, "docs", path, file)), `${version} is missing /docs/${path}/${file}`)
        assert.ok(searchFiles.some((name) => name.startsWith(`${path}.`)), `${version} has no search index`)
        served.push(path)
    }
    // Latest is only a worker redirect, never a generated copy
    assert.ok(!(await exists(join(outDir, "docs/latest"))))
    if (metadata.latestPath) {
        const worker = await readFile(join(outDir, "_worker.js"), "utf8")
        assert.ok(worker.includes(JSON.stringify(`/docs/${metadata.latestPath}`)), "The worker does not redirect latest to its selected path")
    }
    return { versions: metadata.versions, served, latestPath: metadata.latestPath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const releasesDirectory = resolve(process.argv[2] ?? join(webRoot, "released"))
    // Astro moves prerendered assets, so isolated output must share the cache's filesystem
    const temporaryParent = join(webRoot, ".astro")
    await mkdir(temporaryParent, { recursive: true })
    const root = await mkdtemp(join(temporaryParent, "snapshots-"))
    if (dirname(root) !== resolve(temporaryParent)) throw new Error("Unexpected snapshot build directory")
    try {
        const result = await checkSnapshotBuild({ releasesDirectory, outDir: join(root, "dist") })
        console.log(JSON.stringify(result))
    } finally {
        // Restore generated development content even if a snapshot fails to build
        await generate()
        await rm(root, { recursive: true, force: true })
    }
}
