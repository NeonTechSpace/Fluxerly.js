import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { elements, renderMarkdown } from "./html.js"
import { expectedGuideExamples } from "./guide-examples.ts"
import { authoredGuideNavigation, authoredGuides, guidesRoot } from "../scripts/generate.js"

const generatedPages = new Set(["index", "api", "changelog", "error-and-log-codes"])
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
    const byName = (a, b) => a.localeCompare(b)
    assert.deepEqual(guides.map((guide) => guide.slug).sort(byName), guideFiles.sort(byName))
    assert.ok(guides.every((guide) => guide.content.length > 0))
    // Section labels are editorial. Each separator is well-formed, unique and introduces at least one page
    const separators = navigation.filter((page) => separator.test(page))
    assert.ok(separators.length > 0)
    for (const label of separators) assert.match(label, /^---\S.*\S---$/)
    assert.equal(new Set(separators).size, separators.length)
    navigation.forEach((page, index) => {
        if (separator.test(page)) assert.ok(index + 1 < navigation.length && !separator.test(navigation[index + 1]), page)
    })
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

// Renders a guide with the website's Markdown pipeline and counts the code blocks a reader can see. A block is
// hidden when a <details> element without the open attribute encloses it, which the browser renders collapsed
async function visibleExamples(source) {
    const { tree } = await renderMarkdown(source)
    return elements(tree).filter(
        ({ node, ancestors }) =>
            node.tagName === "pre" && !ancestors.some((ancestor) => ancestor.tagName === "details" && !ancestor.properties?.open),
    ).length
}

// The browser test requires the visible count to equal the expected count, so a guide passes only when both agree
async function exampleCounts(...text) {
    const source = text.join("\n")
    return { visible: await visibleExamples(source), expected: expectedGuideExamples("guide", source) }
}

test("Rendered guide examples are counted only outside collapsed sections", async () => {
    // Open and collapsed sections
    assert.deepEqual(
        await exampleCounts("```js", "a()", "```", "", "<details>", "<summary>More</summary>", "", "```ts", "b()", "```", "", "</details>"),
        { visible: 1, expected: 2 },
    )
    assert.deepEqual(await exampleCounts("<details open>", "", "```js", "a()", "```", "", "</details>"), { visible: 1, expected: 1 })
    assert.deepEqual(
        await exampleCounts("<details>", "", "<details open>", "", "```js", "a()", "```", "", "</details>", "", "</details>"),
        { visible: 0, expected: 1 },
    )
    assert.deepEqual(
        await exampleCounts("<details open>", "", "<details>", "", "```js", "a()", "```", "", "</details>", "", "</details>"),
        { visible: 0, expected: 1 },
    )
    assert.deepEqual(
        await exampleCounts("<details>", "", "<details open>", "", "</details>", "", "```js", "a()", "```", "", "</details>"),
        { visible: 0, expected: 1 },
    )
    // Attribute text does not decide whether a section is open
    assert.deepEqual(await exampleCounts('<details title="Click to open">', "", "```js", "a()", "```", "", "</details>"), { visible: 0, expected: 1 })
    assert.deepEqual(await exampleCounts('<details title="Node >= 24" open>', "", "```js", "a()", "```", "", "</details>"), { visible: 1, expected: 1 })
    assert.deepEqual(await exampleCounts('<details data-note="a > b">', "", "```js", "a()", "```", "", "</details>"), { visible: 0, expected: 1 })
    // Markup that does not make a section
    assert.deepEqual(await exampleCounts("<!-- <details> -->", "", "```js", "a()", "```", "", "<!-- </details> -->"), { visible: 1, expected: 1 })
    assert.deepEqual(await exampleCounts("```text", "<details>", "```", "", "```js", "a()", "```"), { visible: 2, expected: 2 })
    assert.deepEqual(await exampleCounts("<details>", "", "Text </details>", "", "```js", "a()", "```"), { visible: 1, expected: 1 })
    // Indented and list-nested sections
    assert.deepEqual(await exampleCounts("  <details>", "  <summary>More</summary>", "", "```js", "a()", "```", "", "  </details>"), { visible: 0, expected: 1 })
    assert.deepEqual(await exampleCounts("<details>", "", "- Step", "", "  ```js", "  a()", "  ```", "", "</details>"), { visible: 0, expected: 0 })
    // A fence directly after the summary stays raw HTML, so no example is shown where one is expected
    assert.deepEqual(await exampleCounts("<details open>", "<summary>More</summary>", "```js", "a()", "```", "</details>"), { visible: 0, expected: 1 })
    // Tilde and indented fences are not counted by the browser rule, so a collapsed one agrees and a visible one does not
    assert.deepEqual(await exampleCounts("<details>", "", "~~~js", "a()", "~~~", "", "</details>"), { visible: 0, expected: 0 })
    assert.deepEqual(await exampleCounts("<details>", "", "    a()", "", "</details>"), { visible: 0, expected: 0 })
    assert.deepEqual(await exampleCounts("~~~js", "a()", "~~~"), { visible: 1, expected: 0 })
})

// A fast early guard for examples inside collapsed details sections. The browser test stays the authority for other
// hiding, such as CSS, the hidden attribute and named details groups
test("Authored guides show every example the browser test expects", async () => {
    for (const { slug } of await authoredGuides()) {
        const source = await readFile(join(guidesRoot, `${slug}.md`), "utf8")
        assert.equal(
            await visibleExamples(source),
            expectedGuideExamples(slug, source),
            `${slug}.md shows a different number of examples than the browser test expects. An example may be in a collapsed <details> section`,
        )
    }
})
