import assert from "node:assert/strict"
import test from "node:test"
import { breadcrumbsFor, treeForVersion } from "../src/lib/docs-tree.ts"
import { referenceEntries } from "../scripts/reference-entries.js"

const page = (name, url) => ({ type: "page", name, url })
// Released snapshots generated before the testing entry points list only the first two modules
const folder = (version, modules = referenceEntries.slice(0, 2)) => ({
    type: "folder",
    root: "version",
    name: version,
    $ref: { folder: version },
    children: [
        page("Overview", `/docs/${version}`),
        page("Quick start", `/docs/${version}/quick-start`),
        {
            type: "folder",
            name: "API reference",
            index: page("API reference", `/docs/${version}/api`),
            children: [
                { type: "folder", name: "Interfaces", children: [page("Client", `/docs/${version}/api/interfaces/js-ts.Client`)] },
                { type: "folder", name: "Modules", children: modules.map((entry) => page(entry.title, `/docs/${version}/api/modules/${entry.name}`)) },
                page("Find a method by task", `/docs/${version}/api/tasks`),
            ],
        },
    ],
})
const urls = (node) => [node.url, node.index?.url, ...(node.children ?? []).flatMap(urls)].filter(Boolean)

test("The docs island receives only the selected version and the reference entries its sidebar shows", () => {
    const latest = folder("1000.0.1")
    const old = folder("1000.0.0")
    const preview = folder("preview")
    const full = { type: "root", name: "Docs", children: [old, latest, preview] }
    const original = structuredClone(full)
    for (const selected of [old, latest, preview]) {
        const version = selected.$ref.folder
        const narrowed = treeForVersion(full, version)
        assert.equal(narrowed.children.length, 1)
        const sent = urls(narrowed.children[0])
        assert.ok(sent.includes(`/docs/${version}/quick-start`))
        assert.ok(sent.includes(`/docs/${version}/api`))
        assert.ok(sent.includes(`/docs/${version}/api/modules/js-ts`))
        assert.ok(sent.includes(`/docs/${version}/api/modules/Effect`))
        assert.ok(!sent.includes(`/docs/${version}/api/interfaces/js-ts.Client`))
        assert.ok(!sent.includes(`/docs/${version}/api/tasks`))
        assert.ok(sent.every((url) => url.startsWith(`/docs/${version}`)))
    }
    assert.deepEqual(full, original)
})

test("Every reference entry point reaches the sidebar, while older snapshots keep their own entry points", () => {
    const current = folder("preview", referenceEntries)
    const older = folder("1000.0.0")
    const tree = { type: "root", name: "Docs", children: [older, current] }
    const sent = urls(treeForVersion(tree, "preview").children[0])
    for (const { name } of referenceEntries) assert.ok(sent.includes(`/docs/preview/api/modules/${name}`))
    assert.ok(!sent.includes("/docs/preview/api/interfaces/js-ts.Client"))
    const released = urls(treeForVersion(tree, "1000.0.0").children[0])
    assert.deepEqual(released.filter((url) => url.includes("/api/modules/")),
        ["/docs/1000.0.0/api/modules/js-ts", "/docs/1000.0.0/api/modules/Effect"])
})

test("Reference folders that list their landing page as a child are trimmed the same way", () => {
    const version = folder("1000.0.0")
    const reference = version.children[2]
    // Snapshot metadata that names the index explicitly makes the landing page an ordinary child
    const listed = { ...reference, index: undefined, children: [reference.index, ...reference.children] }
    const tree = { type: "root", name: "Docs", children: [{ ...version, children: [...version.children.slice(0, 2), listed] }] }
    const sent = urls(treeForVersion(tree, "1000.0.0").children[0])
    assert.ok(sent.includes("/docs/1000.0.0/api"))
    assert.ok(sent.includes("/docs/1000.0.0/api/modules/js-ts"))
    assert.ok(!sent.includes("/docs/1000.0.0/api/interfaces/js-ts.Client"))
})

test("Deep symbol breadcrumbs come from the complete version tree", () => {
    const full = { type: "root", name: "Docs", children: [folder("1000.0.0"), folder("preview")] }
    assert.deepEqual(breadcrumbsFor(full, "preview", "/docs/preview/api/interfaces/js-ts.Client"), [
        { name: "API reference", url: "/docs/preview/api" },
        { name: "Interfaces" },
    ])
    assert.deepEqual(breadcrumbsFor(full, "preview", "/docs/preview/quick-start"), [])
})

test("A breadcrumb name that is not plain text fails instead of rendering an object", () => {
    const version = folder("preview")
    const interfaces = version.children[2].children[0]
    interfaces.name = { type: "span", props: { children: "Interfaces" } }
    const tree = { type: "root", name: "Docs", children: [version] }
    assert.throws(() => breadcrumbsFor(tree, "preview", "/docs/preview/api/interfaces/js-ts.Client"), /not plain text/)
})

test("Missing or duplicate version roots fail rather than hiding a published version", () => {
    const root = { name: "Docs", children: [folder("preview")] }
    assert.throws(() => treeForVersion(root, "1000.0.0"), /no unique root/)
    assert.throws(() => treeForVersion({ ...root, children: [folder("preview"), folder("preview")] }, "preview"), /no unique root/)
    assert.throws(() => breadcrumbsFor(root, "1000.0.0", "/docs/1000.0.0/api"), /no unique root/)
})
