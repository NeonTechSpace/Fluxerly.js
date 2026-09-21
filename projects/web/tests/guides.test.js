import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authoredGuideNavigation, authoredGuides, guidesRoot } from "../scripts/generate.js"

const generatedPages = new Set(["index", "api", "changelog"])
const separator = /^---/

async function guideFixture(t, metadata, files) {
    const directory = await mkdtemp(join(tmpdir(), "fluxerly-guide-inventory-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    await writeFile(join(directory, "meta.json"), JSON.stringify(metadata))
    for (const file of files) await writeFile(join(directory, file), `# ${file}\n`)
    return directory
}

test("Authored guide inventory follows grouped navigation without fixing a guide count", async () => {
    const [guides, navigation, files] = await Promise.all([
        authoredGuides(),
        authoredGuideNavigation(),
        readdir(guidesRoot, { withFileTypes: true }),
    ])
    const guideFiles = files
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name.slice(0, -3))
    assert.deepEqual(
        guides.map((guide) => guide.slug),
        navigation.filter((page) => !separator.test(page) && !generatedPages.has(page)),
    )
    assert.deepEqual([...guides.map((guide) => guide.slug)].sort(), guideFiles.sort())
    assert.ok(guides.every((guide) => guide.content.length > 0))
    assert.deepEqual(navigation.filter((page) => separator.test(page)), [
        "---Getting started---",
        "---Bot guides---",
        "---Operations---",
        "---Effect---",
        "---Reference---",
    ])
})

test("Guide inventory rejects unsafe, duplicate, missing and unlisted Markdown pages", async (t) => {
    const duplicate = await guideFixture(t, { pages: ["quick-start", "quick-start"] }, ["quick-start.md"])
    await assert.rejects(authoredGuides(duplicate), /unsafe or duplicate/)

    const unsafe = await guideFixture(t, { pages: ["../quick-start"] }, ["quick-start.md"])
    await assert.rejects(authoredGuides(unsafe), /unsafe or duplicate/)

    const unlisted = await guideFixture(t, { pages: ["quick-start"] }, ["quick-start.md", "messages.md"])
    await assert.rejects(authoredGuides(unlisted), /not listed: messages\.md/)

    const missing = await guideFixture(t, { pages: ["missing-page"] }, ["quick-start.md"])
    await assert.rejects(authoredGuides(missing), /navigation references a missing page/)

    const invalid = await guideFixture(t, { pages: [42] }, ["quick-start.md"])
    await assert.rejects(authoredGuides(invalid), /unsafe or duplicate/)
})
