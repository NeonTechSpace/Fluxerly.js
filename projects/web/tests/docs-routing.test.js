import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createDocsHandler } from "../scripts/docs-routing.js"
import { writeHostingArtifacts } from "../scripts/hosting.js"

const pages = ["/docs/latest", "/docs/latest/quick-start", "/docs/latest/api/interfaces/Client",
    "/docs/1000.0.0", "/docs/1000.0.0/old-guide", "/docs/latest/space guide", "/docs/dev"]
const handler = createDocsHandler(pages)
const calls = []
const assets = { ASSETS: { fetch(request) { calls.push(request); return new Response("Asset", { status: 404 }) } } }
const request = (path, options) => new Request(`https://docs.example${path}`, options)

test("Entrances issue temporary HTTP redirects with query and noindex", async () => {
    for (const path of ["/", "/docs", "/docs/"]) {
        const response = await handler.fetch(request(path + "?from=link"), assets)
        assert.equal(response.status, 302)
        assert.equal(response.headers.get("location"), "/docs/latest/?from=link")
        assert.equal(response.headers.get("cache-control"), "no-store")
        assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow")
    }
})

test("Existing latest and historical pages delegate without rewriting", async () => {
    for (const path of pages) for (const suffix of ["", "/"]) {
        const incoming = request(path + suffix)
        const response = await handler.fetch(incoming, assets)
        assert.equal(response.status, 404)
        assert.equal(calls.at(-1), incoming)
    }
})

test("Broken pages select equivalent latest pages or its root without loops", async () => {
    for (const [path, target] of [
        ["/docs/unknown/quick-start", "/docs/latest/quick-start/"],
        ["/docs/1000.0.0/quick-start", "/docs/latest/quick-start/"],
        ["/docs/unknown/api/interfaces/Client", "/docs/latest/api/interfaces/Client/"],
        ["/docs/latest/missing", "/docs/latest/"],
        ["/docs/latest/missing/deeper", "/docs/latest/"],
        ["/docs/unknown/old-guide", "/docs/latest/"],
        ["/docs/quick-start", "/docs/latest/quick-start/"],
        ["/docs/unknown/space%20guide", "/docs/latest/space%20guide/"],
        ["/docs/%ZZ/path", "/docs/latest/"],
        ["/docs/unknown%2Fquick-start", "/docs/latest/"],
        ["/docs/unknown/%252Fquick-start", "/docs/latest/"],
        ["/docs/unknown//quick-start", "/docs/latest/"],
    ]) {
        const response = await handler.fetch(request(path), assets)
        assert.equal(response.status, 302, path)
        assert.equal(response.headers.get("location"), target, path)
        assert.equal((await handler.fetch(request(target), assets)).headers.get("location"), null)
    }
})

test("Assets, endpoints, unrelated routes and non-navigation methods never fall back", async () => {
    for (const path of ["/api/search/missing.json", "/_astro/missing.js", "/missing", "/docs/missing/file.js",
        "/docs/missing/assets/unknown", "/docs/latest/search", "/docs/missing/file.css", "/docs/missing/file.json"]) {
        assert.equal((await handler.fetch(request(path), assets)).headers.get("location"), null, path)
    }
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        assert.equal((await handler.fetch(request("/docs/missing", { method }), assets)).headers.get("location"), null)
    }
    for (const headers of [{ accept: "application/json" }, { "sec-fetch-dest": "script" }, { "sec-fetch-dest": "image" }]) {
        assert.equal((await handler.fetch(request("/docs/missing", { headers }), assets)).headers.get("location"), null)
    }
    assert.equal((await handler.fetch(request("/docs/missing", { method: "HEAD" }), assets)).status, 302)
})

test("Hosting artifacts inventory emitted pages and run independently of source files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fluxerly-routing-"))
    try {
        for (const page of pages) {
            const folder = join(directory, page.slice(1))
            await mkdir(folder, { recursive: true })
            await writeFile(join(folder, "index.html"), "<h1>Fixture</h1>")
        }
        await writeHostingArtifacts(directory)
        const routes = JSON.parse(await readFile(join(directory, "_routes.json"), "utf8"))
        assert.deepEqual(routes, { version: 1, include: ["/", "/docs", "/docs/*"], exclude: [] })
        // .mjs makes the isolated generated worker unambiguously ESM on Node
        const module = join(directory, "worker.mjs")
        await writeFile(module, await readFile(join(directory, "_worker.js")))
        const emitted = (await import(pathToFileURL(module).href)).default
        assert.equal((await emitted.fetch(request("/docs/unknown/quick-start"), assets)).headers.get("location"), "/docs/latest/quick-start/")
        assert.equal((await emitted.fetch(request("/docs/1000.0.0/old-guide"), assets)).headers.get("location"), null)
    } finally {
        if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error("Unexpected routing fixture directory")
        await rm(directory, { recursive: true, force: true })
    }
})
