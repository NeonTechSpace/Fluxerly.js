import assert from "node:assert/strict"
import test from "node:test"
import { readFile, readdir } from "node:fs/promises"
import { resolve, join, relative } from "node:path"
import { channelTargets, defaultVersion, validateSnapshot } from "../scripts/versions.mjs"
import { previewSettings } from "../scripts/preview-deploy.mjs"
import { pageUrl } from "../scripts/reference-theme.mjs"
import { remarkReferenceAnchors } from "../scripts/reference-anchors.mjs"

test("Channel pointers prefer stable, retain exact archives and omit absent stages", () => {
    assert.deepEqual(channelTargets([]), [{ version: "dev", label: "Canary" }])
    assert.equal(defaultVersion(["1000.1.0-canary.0", "1000.0.0"]), "1000.0.0")
    assert.equal(defaultVersion(["1000.0.0-canary.2", "1000.0.0-rc.0"]), "1000.0.0-rc.0")
    assert.equal(channelTargets(["1000.0.0-canary.9", "1000.0.0-canary.10"])[0].version, "1000.0.0-canary.10")
    assert.deepEqual(channelTargets(["1000.0.0", "1000.1.0-rc.0", "1000.2.0-canary.0", "1000.2.0-canary.1"]), [
        { version: "1000.0.0", label: "Stable" },
        { version: "1000.1.0-rc.0", label: "RC" },
        { version: "1000.2.0-canary.1", label: "Canary" },
    ])
    for (const version of ["1000.0.0-alpha.0", "1000.0.0-beta.0"]) assert.throws(() => channelTargets([version]))
})

test("Snapshots reject traversal, duplicates, missing guides and invalid provenance", () => {
    const snapshot = {
        schemaVersion: 1,
        version: "1000.0.0-canary.0",
        sourceCommit: "1".repeat(40),
        files: ["index.md", "quick-start.md", "changelog.md"].map((path) => ({ path, content: "" })),
    }
    assert.equal(validateSnapshot(snapshot), snapshot)
    assert.throws(() =>
        validateSnapshot({ ...snapshot, files: [...snapshot.files, { path: "../escape.md", content: "" }] }),
    )
    assert.throws(() => validateSnapshot({ ...snapshot, files: [...snapshot.files, snapshot.files[0]] }))
    assert.throws(() => validateSnapshot({ ...snapshot, files: [] }))
    assert.throws(() => validateSnapshot({ ...snapshot, sourceCommit: "main" }))
})

test("Temporary deployment rejects a production hostname and unsafe configuration", () => {
    const env = {
        CLOUDFLARE_ACCOUNT_ID: "1".repeat(32),
        CLOUDFLARE_API_TOKEN: "test-only",
        CLOUDFLARE_PAGES_PROJECT: "test-docs",
        CLOUDFLARE_PREVIEW_URL: "https://preview.example.test",
    }
    assert.equal(previewSettings(env).branch, "preview")
    assert.throws(() => previewSettings({ ...env, CLOUDFLARE_PREVIEW_URL: "https://example.test" }))
    assert.throws(() => previewSettings({ ...env, CLOUDFLARE_PREVIEW_URL: "https://preview.example.test/path" }))
    assert.throws(() => previewSettings({ ...env, CLOUDFLARE_API_TOKEN: "" }))
})

test("Generated symbol links preserve exact route and anchor identities", () => {
    assert.equal(pageUrl("/docs/dev/api/index.md"), "/docs/dev/api/")
    assert.equal(
        pageUrl("/docs/1000.0.0/api/interfaces/js-ts.Client.md#messages"),
        "/docs/1000.0.0/api/interfaces/js-ts.Client/#messages",
    )
    assert.equal(pageUrl("https://example.test/source.md"), "https://example.test/source.md")
})

test("Reference headings retain TypeDoc IDs without collisions with parameter headings", () => {
    const heading = () => ({ type: "heading", depth: 3, children: [{ type: "text", value: "operation" }] })
    const root = {
        type: "root",
        children: [
            heading(),
            {
                type: "paragraph",
                children: [
                    { type: "html", value: '<a id="operation">' },
                    { type: "html", value: "</a>" },
                ],
            },
            heading(),
        ],
    }
    const file = { data: {} }
    remarkReferenceAnchors()(root, file)
    assert.equal(root.children.length, 2)
    assert.deepEqual(
        root.children.map((node) => node.data.hProperties.id),
        ["operation-1", "operation"],
    )
    assert.deepEqual(
        file.data.toc.map((item) => item.url),
        ["#operation-1", "#operation"],
    )
})

async function inventory(root, extension) {
    const result = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) result.push(...(await inventory(path, extension)))
        else if (path.endsWith(extension)) result.push(path)
    }
    return result
}
const decode = (value) => value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&")

test("HTML link and anchor decoding preserves encoded entity text", () => {
    assert.equal(decode("&quot;&#39;&amp;"), "\"'&")
    assert.equal(decode("#&amp;quot;-&amp;#39;-&amp;amp;"), "#&quot;-&#39;-&amp;")
})

test("Every built internal link and fragment resolves, public docs exclude internal-only modules", async () => {
    const dist = resolve("dist")
    const files = await inventory(dist, ".html")
    const pages = new Map()
    for (const path of files) {
        const html = await readFile(path, "utf8")
        assert.ok(!/<link[^>]+rel="sitemap"|property="og:|name="twitter:/i.test(html), path)
        assert.match(html, /noindex/)
        const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => decode(match[1]))
        assert.equal(new Set(ids).size, ids.length, `Duplicate HTML anchor in ${path}`)
        pages.set(path, { html, ids: new Set(ids) })
    }
    const failures = new Set()
    for (const [path, { html }] of pages) {
        const base = new URL(
            relative(dist, path)
                .replaceAll("\\", "/")
                .replace(/index\.html$/, ""),
            "https://docs.test/",
        )
        for (const [, href] of html.matchAll(/\bhref="([^"]+)"/g)) {
            const url = new URL(decode(href), base)
            if (url.origin !== base.origin || !url.pathname.startsWith("/docs/")) continue
            const destination = join(dist, decodeURIComponent(url.pathname), "index.html")
            const target = pages.get(destination)
            if (!target || (url.hash && !target.ids.has(decodeURIComponent(url.hash.slice(1)))))
                failures.add(`${relative(dist, path)} -> ${url.pathname}${url.hash}`)
        }
    }
    assert.deepEqual([...failures], [])
    const routes = files.map((path) => relative(dist, path).replaceAll("\\", "/"))
    assert.ok(routes.some((route) => route.includes("functions/js-ts.createClient/")))
    assert.ok(routes.some((route) => route.includes("types/js-ts.PermissionName/")))
    assert.ok(!routes.some((route) => /\/internal\/|\.Rest\/|\.Gateway\//.test(route)))
    console.log(`Verified internal links and anchors across ${files.length} rendered HTML pages`)
    let inlineTypes = 0
    const uncoloured = []
    for (const path of pages.keys()) {
        if (!path.replaceAll("\\", "/").includes("/api/")) continue
        const html = (await readFile(path, "utf8")).replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/g, "")
        for (const [, content] of html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)) {
            if (!content.replace(/<[^>]*>/g, "").trim()) continue
            inlineTypes++
            if (!content.includes('class="syntax-token"')) uncoloured.push(relative(dist, path))
        }
    }
    assert.ok(inlineTypes > 0)
    assert.deepEqual([...new Set(uncoloured)], [])
    console.log(`Verified syntax colouring across ${inlineTypes} generated inline-code elements`)
})
