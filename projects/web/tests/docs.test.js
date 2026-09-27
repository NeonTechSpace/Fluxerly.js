import assert from "node:assert/strict"
import test from "node:test"
import { access, readFile, readdir } from "node:fs/promises"
import { join, posix, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { channelTargets, defaultVersion, publishedSnapshotFiles, retainedVersions, validateSnapshot } from "../scripts/versions.js"
import { pageUrl } from "../scripts/reference-theme.js"
import { remarkReferenceAnchors } from "../scripts/reference-anchors.js"
import { findAll, hasClass, parseHtml, textContent } from "./html.js"

test("Channel pointers prefer Stable, use rolling prerelease paths and omit absent stages", () => {
    assert.deepEqual(channelTargets([]), [])
    assert.equal(channelTargets(["1000.0.0-canary.9", "1000.0.0-canary.10"])[0].version, "1000.0.0-canary.10")
    assert.deepEqual(channelTargets(["1000.0.0", "1000.1.0-rc.0", "1000.2.0-canary.0", "1000.2.0-canary.1"]), [
        { version: "1000.0.0", label: "Stable", path: "1000.0.0" },
        { version: "1000.1.0-rc.0", label: "RC", path: "rc" },
        { version: "1000.2.0-canary.1", label: "Canary", path: "canary" },
    ])
    for (const version of ["1000.0.0-alpha.0", "1000.0.0-beta.0"])
        assert.throws(() => channelTargets([version]), /canary or rc suffix/)
})

test("Latest source selection respects readiness before numerical version order", () => {
    for (const [versions, expected] of [
        [[], null],
        [["1000.2.0-canary.9", "1000.2.0-canary.10"], "1000.2.0-canary.10"],
        [["1000.0.0-canary.2", "1000.0.0-rc.0"], "1000.0.0-rc.0"],
        [["1000.1.0-rc.9", "1000.2.0-canary.10", "1000.1.0-rc.10"], "1000.1.0-rc.10"],
        [["1000.1.0-canary.0", "1000.0.0"], "1000.0.0"],
        [["1000.0.9", "1000.1.0-rc.10", "1000.2.0-canary.10", "1000.0.10"], "1000.0.10"],
    ]) assert.equal(defaultVersion(versions), expected)
})

test("Retention keeps all Stable versions and only the newest of each prerelease channel", () => {
    const versions = ["1000.0.0-canary.9", "1000.0.0-rc.0", "1000.0.0", "1000.0.0-canary.10",
        "1000.0.0-rc.1", "1000.0.1", "1000.1.0", "1001.0.0"]
    const original = [...versions]
    assert.deepEqual(retainedVersions(versions), ["1000.0.0", "1000.0.0-canary.10", "1000.0.0-rc.1",
        "1000.0.1", "1000.1.0", "1001.0.0"])
    assert.deepEqual(versions, original)
    assert.deepEqual(retainedVersions([]), [])
    assert.deepEqual(retainedVersions(["1000.1.0-canary.9", "1000.2.0-canary.0"]), ["1000.2.0-canary.0"])
})

test("Published content excludes a withdrawn guide without changing saved snapshots or other history", () => {
    const snapshot = { files: [
        { path: "migration.md", content: "Withdrawncontentmarker" },
        { path: "old-guide.md", content: "Preserved historical guide" },
        { path: "meta.json", content: JSON.stringify({ title: "Fixture", pages: ["index", "migration", "old-guide"] }) },
    ] }
    const original = structuredClone(snapshot)
    const files = publishedSnapshotFiles(snapshot)
    assert.deepEqual(snapshot, original)
    assert.deepEqual(files.map((file) => file.path), ["old-guide.md", "meta.json"])
    assert.deepEqual(files[0], original.files[1])
    assert.deepEqual(JSON.parse(files[1].content).pages, ["index", "old-guide"])
})

test("Snapshots reject traversal, duplicates, missing guides and invalid provenance", () => {
    const snapshot = {
        schemaVersion: 1,
        version: "1000.0.0-canary.0",
        sourceCommit: "1".repeat(40),
        files: ["index.md", "quick-start.md", "changelog.md"].map((path) => ({ path, content: "" })),
    }
    assert.equal(validateSnapshot(snapshot), snapshot)
    for (const { patch, reason } of [
        { patch: { files: [...snapshot.files, { path: "../escape.md", content: "" }] }, reason: /Invalid docs snapshot file/ },
        { patch: { files: [...snapshot.files, snapshot.files[0]] }, reason: /Invalid docs snapshot file/ },
        { patch: { files: [] }, reason: /Empty docs snapshot/ },
        { patch: { files: snapshot.files.slice(1) }, reason: /Incomplete docs snapshot/ },
        { patch: { sourceCommit: "main" }, reason: /Invalid docs provenance/ },
        { patch: { schemaVersion: 3 }, reason: /Invalid docs provenance/ },
        { patch: { version: "../escape" }, reason: /canary or rc suffix/ },
    ]) assert.throws(() => validateSnapshot({ ...snapshot, ...patch }), reason)
})

test("Generated symbol links preserve exact route and anchor identities", () => {
    assert.equal(pageUrl("/docs/preview/api/index.md"), "/docs/preview/api/")
    assert.equal(
        pageUrl("/docs/1000.0.0/api/interfaces/js-ts.Client.md#messages"),
        "/docs/1000.0.0/api/interfaces/js-ts.Client/#messages",
    )
    assert.equal(pageUrl("https://example.test/source.md"), "https://example.test/source.md")
})

test("Reference headings retain TypeDoc IDs without collisions with parameter headings", async () => {
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
    await remarkReferenceAnchors()(root, file)
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

test("Section headings avoid member anchors in property tables", async () => {
    // A member named properties shares its TypeDoc anchor with the Properties heading's slug
    const cell = (value) => ({ type: "tableCell", children: value })
    const root = {
        type: "root",
        children: [
            { type: "heading", depth: 2, children: [{ type: "text", value: "Properties" }] },
            { type: "table", children: [{ type: "tableRow", children: [
                cell([{ type: "html", value: '<a id="properties"></a>' }, { type: "inlineCode", value: "properties" }]),
            ] }] },
        ],
    }
    const file = { data: {} }
    await remarkReferenceAnchors()(root, file)
    assert.equal(root.children[0].data.hProperties.id, "properties-1")
    assert.deepEqual(file.data.toc.map((item) => item.url), ["#properties-1"])
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

const dist = fileURLToPath(new URL("../dist/", import.meta.url))
let builtSite
// One parse of the built site serves every check below. Each page keeps only the facts those checks read
function readBuiltSite() {
    builtSite ??= (async () => {
        const pages = new Map()
        for (const path of await inventory(dist, ".html")) {
            const tree = parseHtml(await readFile(path, "utf8"), { fragment: false })
            const route = relative(dist, path).replaceAll("\\", "/")
            const meta = findAll(tree, "meta")
            pages.set(route, {
                robots: meta.filter((node) => node.properties.name === "robots").map((node) => String(node.properties.content)),
                social: meta.filter((node) => /^(?:og|twitter):/.test(String(node.properties.property ?? node.properties.name ?? ""))).length,
                sitemaps: findAll(tree, (node) => node.tagName === "link" && (node.properties.rel ?? []).includes("sitemap")).length,
                ids: findAll(tree, (node) => node.properties.id !== undefined).map((node) => String(node.properties.id)),
                hrefs: findAll(tree, (node) => node.properties.href !== undefined).map((node) => String(node.properties.href)),
                // Inline code outside fenced examples, recorded as whether each element carries syntax tokens
                inlineCode: route.includes("/api/")
                    ? findAll(tree, (node, ancestors) => node.tagName === "code" && !ancestors.some((parent) => parent.tagName === "pre"))
                        .filter((node) => textContent(node).trim())
                        .map((node) => findAll(node, (inner) => inner.tagName === "span" && hasClass(inner, "syntax-token")).length > 0)
                    : [],
            })
        }
        assert.ok(pages.size > 0, "Build the documentation site before running the built-site checks")
        return pages
    })()
    return builtSite
}

test("Built pages are noindex without sitemap or social metadata", async () => {
    for (const [route, page] of await readBuiltSite()) {
        assert.ok(page.robots.some((content) => /\bnoindex\b/.test(content)), route)
        assert.equal(page.sitemaps, 0, route)
        assert.equal(page.social, 0, route)
    }
})

test("Every built internal link and fragment resolves to a unique anchor", async () => {
    const pages = await readBuiltSite()
    const failures = new Set()
    for (const [route, page] of pages) {
        assert.equal(new Set(page.ids).size, page.ids.length, `Duplicate HTML anchor in ${route}`)
        const base = new URL(route.replace(/index\.html$/, ""), "https://docs.test/")
        for (const href of page.hrefs) {
            const url = new URL(href, base)
            if (url.origin !== base.origin || !url.pathname.startsWith("/docs/")) continue
            const path = decodeURIComponent(url.pathname).slice(1)
            // Markdown twins and assistant indexes are files beside the HTML pages
            if (/\.(?:md|txt)$/.test(url.pathname)) {
                if (url.hash || !(await access(join(dist, path)).then(() => true, () => false)))
                    failures.add(`${route} -> ${url.pathname}${url.hash}`)
                continue
            }
            const target = pages.get(posix.join(path, "index.html"))
            if (!target || (url.hash && !target.ids.includes(decodeURIComponent(url.hash.slice(1)))))
                failures.add(`${route} -> ${url.pathname}${url.hash}`)
        }
    }
    assert.deepEqual([...failures], [])
    console.log(`Verified internal links and anchors across ${pages.size} rendered HTML pages`)
})

test("Public reference pages include entry-point symbols and exclude internal-only modules", async () => {
    const pages = await readBuiltSite()
    const routes = [...pages.keys()]
    // Older snapshots give each symbol a page. Current output groups functions and type aliases on entry points
    const symbol = (kind, name) => routes.some((route) => route.includes(`${kind}/js-ts.${name}/`)) ||
        [...pages].some(([route, page]) => route.endsWith("/api/modules/js-ts/index.html") && page.ids.includes(name.toLowerCase()))
    assert.ok(symbol("functions", "createClient"))
    assert.ok(symbol("types", "PermissionName"))
    assert.deepEqual(routes.filter((route) => /\/internal\/|\.Rest\/|\.Gateway\//.test(route)), [])
})

test("Generated reference inline code is syntax-coloured", async () => {
    const pages = await readBuiltSite()
    const coloured = [...pages.values()].flatMap((page) => page.inlineCode)
    assert.ok(coloured.length > 0)
    assert.deepEqual([...pages].filter(([, page]) => page.inlineCode.includes(false)).map(([route]) => route), [])
    console.log(`Verified syntax colouring across ${coloured.length} generated inline-code elements`)
})
