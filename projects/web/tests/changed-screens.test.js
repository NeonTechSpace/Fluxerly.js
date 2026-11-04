import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { areasForChanges, baseFlag, changedPaths, repositoryRoot } from "../scripts/checks/changed.mjs"

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

// Catches: A CI run whose checkout sits on the pushed main compared HEAD with itself and tested no screen, or compared a
// pull request with a main that had moved on
test("a base commit makes the changed files those since that commit, and a missing base fails instead of testing nothing", () => {
    const folder = mkdtempSync(join(tmpdir(), "changed-base-"))
    try {
        const git = (/** @type {string[]} */ ...args) => execFileSync("git", args, { cwd: folder, encoding: "utf8" }).trim()
        git("init", "--quiet", "--initial-branch=main")
        git("config", "user.email", "check@example.com")
        git("config", "user.name", "Check")
        git("config", "commit.gpgsign", "false")
        writeFileSync(join(folder, "first.txt"), "first\n")
        git("add", ".")
        git("commit", "--quiet", "-m", "First")
        const base = git("rev-parse", "HEAD")
        writeFileSync(join(folder, "second.txt"), "second\n")
        git("add", ".")
        git("commit", "--quiet", "-m", "Second")
        // HEAD is main, so without a base nothing differs
        assert.deepEqual(changedPaths(folder), [])
        assert.deepEqual(changedPaths(folder, base), ["second.txt"])
        assert.throws(() => changedPaths(folder, "f".repeat(40)), /has no commit in common with HEAD/)
    } finally {
        rmSync(folder, { recursive: true, force: true })
    }
})

test("--base= names the base, and an empty one counts as none", () => {
    assert.equal(baseFlag(["--changed", "--base=abc123"]), "abc123")
    assert.equal(baseFlag(["--changed", "--base="]), undefined)
    assert.equal(baseFlag(["--changed"]), undefined)
})
