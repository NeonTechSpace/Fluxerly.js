import assert from "node:assert/strict"
import { test } from "node:test"
import { areasForChanges, repositoryRoot } from "../scripts/checks/changed.mjs"

const reach = (path) => {
    const { areas } = areasForChanges([path], repositoryRoot)
    return areas === "all" ? "all" : [...areas].sort()
}

// Catches: A --changed screen check that skipped the pages a change can break, or ran everything for a change no screen shows
test("changed files reach the screens their pages import", () => {
    assert.deepEqual(reach("projects/web/src/pages/404.astro"), ["missing"])
    assert.deepEqual(reach("projects/web/src/styles/docs.css"), ["docs"])
    assert.ok(reach("projects/web/src/components/Header.astro").includes("home"))
    assert.ok(reach("projects/web/src/components/Header.astro").includes("docs"))
    assert.ok(reach("projects/sdk/src/client.ts").includes("docs"))
    assert.equal(reach("projects/web/astro.config.mjs"), "all")
    assert.equal(reach("projects/web/src/not-imported-by-any-page.ts"), "all")
    assert.deepEqual(reach("projects/web/tests/style-rules.test.ts"), [])
    assert.deepEqual(reach("projects/release/upstream.js"), [])
    // The pin feeds the endpoint map and every docs page's Fluxer commit line
    assert.ok(reach("projects/release/upstream/manifest.json").includes("docs"))
})
