import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { generate, generateVersion, webRoot } from "../scripts/generate.js"

test("Public generation without a published snapshot fails before replacing existing output", async () => {
    const released = await mkdtemp(join(tmpdir(), "fluxerly-empty-releases-"))
    if (dirname(resolve(released)) !== resolve(tmpdir())) throw new Error("Unexpected release fixture directory")
    const versionsPath = join(webRoot, "content/versions.json")
    const before = await readFile(versionsPath)
    const docsMetaPath = join(webRoot, "content/docs/meta.json")
    const docsBefore = await readFile(docsMetaPath)
    try {
        await assert.rejects(generate({ releasesDirectory: released, publicBuild: true }), /requires an imported published snapshot/)
        assert.deepEqual(await readFile(versionsPath), before)
        assert.deepEqual(await readFile(docsMetaPath), docsBefore)
    } finally {
        await rm(released, { recursive: true, force: true })
    }
})

test("Nightly snapshots name their version and list pending notes above the release history", async () => {
    const output = await mkdtemp(join(tmpdir(), "fluxerly-nightly-docs-"))
    if (dirname(resolve(output)) !== resolve(tmpdir())) throw new Error("Unexpected nightly fixture directory")
    const version = "1000.1.0-nightly.20261019.3"
    const source = await readFile(join(webRoot, "../sdk/CHANGELOG.md"), "utf8")
    const [title] = source.split("\n", 1)
    // The released history starts at the first version heading below the title
    const history = source.slice(source.indexOf("\n## ") + 1)
    assert.match(title, /^# /)
    assert.ok(history.startsWith("## "))
    const notes = "### Minor Changes\n\n- abc1234: Synthetic pending note\n"
    try {
        for (const unreleased of [notes, ""]) {
            const target = join(output, unreleased ? "with-notes" : "without-notes")
            await generateVersion(version, target, { unreleased })
            assert.ok((await readFile(join(target, "index.md"), "utf8")).includes(`**${version}**`))
            const changelog = await readFile(join(target, "changelog.md"), "utf8")
            assert.ok(changelog.includes(version))
            // Pending notes sit between the changelog title and the released history, which stays complete
            const unreleasedAt = changelog.indexOf(`${title}\n\n## Unreleased\n\n`)
            const historyAt = changelog.indexOf(`\n${history}`)
            assert.ok(unreleasedAt >= 0 && historyAt > unreleasedAt, unreleased ? "with notes" : "without notes")
            const section = changelog.slice(unreleasedAt + `${title}\n\n## Unreleased\n\n`.length, historyAt + 1)
            if (unreleased) assert.equal(section, `${notes}\n`)
            else assert.doesNotMatch(section, /^\s*$|^## /)
            assert.equal(changelog.split("\n## Unreleased\n").length, 2)
        }
    } finally {
        await rm(output, { recursive: true, force: true })
    }
})
