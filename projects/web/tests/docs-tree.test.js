import assert from "node:assert/strict"
import test from "node:test"
import { treeForVersion } from "../src/lib/docs-tree.ts"

const folder = (version) => ({
    type: "folder",
    root: "version",
    name: version,
    $ref: { folder: version },
    children: [
        { type: "page", name: "Overview", url: `/docs/${version}` },
        {
            type: "folder",
            name: "API reference",
            children: [{ type: "page", name: "Symbol", url: `/docs/${version}/api/symbol` }],
        },
    ],
})

test("The docs island receives only the selected version without pruning its symbols", () => {
    const latest = folder("latest")
    const old = folder("1000.0.0")
    const preview = folder("preview")
    const full = { type: "root", name: "Docs", children: [old, latest, preview] }
    for (const selected of [old, latest, preview]) {
        const narrowed = treeForVersion(full, selected.$ref.folder)
        assert.deepEqual(narrowed.children, [selected])
        assert.equal(narrowed.children[0], selected)
        assert.equal(narrowed.children[0].children[1].children[0].url, `/docs/${selected.$ref.folder}/api/symbol`)
    }
    assert.deepEqual(full.children, [old, latest, preview])
})

test("Missing or duplicate version roots fail rather than hiding a published version", () => {
    const root = { name: "Docs", children: [folder("preview")] }
    assert.throws(() => treeForVersion(root, "1000.0.0"), /no unique root/)
    assert.throws(() => treeForVersion({ ...root, children: [folder("preview"), folder("preview")] }, "preview"), /no unique root/)
})
