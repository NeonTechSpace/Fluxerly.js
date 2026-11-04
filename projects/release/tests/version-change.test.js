import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { assertVersionedSource } from "../source.js"
import { detectVersionChange } from "../version-change.js"
import { fixture, note, write } from "./helpers.js"

const cli = fileURLToPath(new URL("../version-change.js", import.meta.url))
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
const git = (cwd, ...args) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
        cwd,
        encoding: "utf8",
        env: gitEnv,
    }).trim()

const manifest = (version, extra = "") =>
    `{\n    "name": "@neontechspace/fluxerly",\n    "version": "${version}",\n    "private": true,${extra}\n    "type": "module"\n}\n`
const changelog = "# @neontechspace/fluxerly\n\n## 1000.0.0\n\n### Major Changes\n\n- First release\n"
const withSection = (version, text = changelog) =>
    text.replace("\n\n## ", `\n\n## ${version}\n\n### Patch Changes\n\n- abc1234: Fix a thing\n\n## `)
const noteText = (text) => `---\n"@neontechspace/fluxerly": patch\n---\n\n${text}\n`

const base = {
    "projects/sdk/package.json": manifest("1000.0.0"),
    "projects/sdk/CHANGELOG.md": changelog,
    "projects/sdk/src/index.ts": "export const value = 1\n",
    "projects/.changeset/config.json": "{}\n",
    "projects/.changeset/fix-a-thing.md": noteText("Fix a thing"),
    "projects/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
}

/**
 * Commits the base files, then applies the change as a second commit, where null deletes a file
 * @param {Record<string, string | null>} change
 */
async function repository(change, files = base) {
    const root = mkdtempSync(join(tmpdir(), "fluxerly-version-change-"))
    const apply = async (entries) => {
        for (const [path, text] of Object.entries(entries)) {
            if (text === null) await rm(join(root, path))
            else {
                await mkdir(dirname(join(root, path)), { recursive: true })
                await writeFile(join(root, path), text)
            }
        }
        git(root, "add", "--all")
        git(root, "commit", "--quiet", "--allow-empty", "-m", "change")
    }
    git(root, "init", "--quiet")
    await apply(files)
    await apply(change)
    return root
}

async function classify(change, files) {
    const root = await repository(change, files)
    try {
        return detectVersionChange({ cwd: root })
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

const stable = {
    "projects/sdk/package.json": manifest("1000.0.1"),
    "projects/sdk/CHANGELOG.md": withSection("1000.0.1"),
    "projects/.changeset/fix-a-thing.md": null,
}

test("A Stable version change, which consumes the notes and adds one changelog section, is version-only", async () => {
    const change = await classify(stable)
    assert.equal(change.versionOnly, true, change.reason)
    assert.equal(change.from, "1000.0.0")
    assert.equal(change.to, "1000.0.1")
    // Leaving prerelease removes the state file and the archived notes
    const prerelease = {
        ...base,
        "projects/sdk/package.json": manifest("1000.0.1-nightly.0"),
        "projects/.changeset/pre.json": "{}\n",
        "projects/.changeset/pre/older.md": noteText("Older"),
    }
    const exit = await classify(
        { ...stable, "projects/.changeset/pre.json": null, "projects/.changeset/pre/older.md": null },
        prerelease,
    )
    assert.equal(exit.versionOnly, true, exit.reason)
})

test("A new epoch that moves notes unchanged into pre/ and writes the prerelease state is version-only", async () => {
    const change = await classify({
        "projects/sdk/package.json": manifest("2000.0.0-nightly.0"),
        "projects/sdk/CHANGELOG.md": withSection("2000.0.0-nightly.0"),
        "projects/.changeset/fix-a-thing.md": null,
        "projects/.changeset/pre/fix-a-thing.md": noteText("Fix a thing"),
        "projects/.changeset/pre.json": '{ "mode": "pre" }\n',
    })
    assert.equal(change.versionOnly, true, change.reason)
})

test("Any other change runs every check, including another manifest line or a different changelog edit", async () => {
    const cases = {
        "another manifest field": { ...stable, "projects/sdk/package.json": manifest("1000.0.1", '\n    "sideEffects": false,') },
        "a reformatted manifest": { ...stable, "projects/sdk/package.json": manifest("1000.0.1").replace('"version": ', '"version":  ') },
        "a lower version": { ...stable, "projects/sdk/package.json": manifest("999.0.0") },
        "no version change": { "projects/sdk/CHANGELOG.md": withSection("1000.0.1"), "projects/.changeset/fix-a-thing.md": null },
        "no changelog section": { ...stable, "projects/sdk/CHANGELOG.md": null },
        "a section for another version": { ...stable, "projects/sdk/CHANGELOG.md": withSection("1000.0.2") },
        "an edited older section": { ...stable, "projects/sdk/CHANGELOG.md": withSection("1000.0.1").replace("First release", "First") },
        "a source file": { ...stable, "projects/sdk/src/index.ts": "export const value = 2\n" },
        "the lockfile": { ...stable, "projects/pnpm-lock.yaml": "lockfileVersion: '9.1'\n" },
        "the Changesets config": { ...stable, "projects/.changeset/config.json": '{ "commit": true }\n' },
        "a new note": { ...stable, "projects/.changeset/new-note.md": noteText("New") },
        "a note edited on its way into pre/": {
            ...stable,
            "projects/.changeset/pre/fix-a-thing.md": noteText("Fix another thing"),
        },
        "a workflow": { ...stable, ".github/workflows/ci.yml": "name: Check\n" },
    }
    for (const [name, change] of Object.entries(cases)) {
        const result = await classify(change)
        assert.equal(result.versionOnly, false, name)
        assert.equal(typeof result.reason, "string", name)
    }
    // Only a nested version line changes, so the top-level version stays where it was
    const nested = (version) => manifest("1000.0.0", `\n    "publishConfig": {\n        "version": "${version}"\n    },`)
    const result = await classify(
        { ...stable, "projects/sdk/package.json": nested("1.0.1") },
        { ...base, "projects/sdk/package.json": nested("1.0.0") },
    )
    assert.equal(result.versionOnly, false)
})

test("The detect command reports a version-only push only when it starts from HEAD's first parent", async () => {
    const root = await repository(stable)
    const directory = mkdtempSync(join(tmpdir(), "fluxerly-version-output-"))
    try {
        const parent = git(root, "rev-parse", "HEAD^1")
        let runs = 0
        const detect = (...args) => {
            const output = join(directory, `output-${runs++}`)
            const result = spawnSync(process.execPath, [cli, "detect", ...args], {
                cwd: root,
                encoding: "utf8",
                env: { ...gitEnv, GITHUB_OUTPUT: output },
                timeout: 30_000,
            })
            assert.equal(result.status, 0, result.stderr)
            return readFileSync(output, "utf8")
        }
        assert.equal(detect("--parent", parent), "version_only=true\n")
        assert.equal(detect(), "version_only=true\n")
        // A push that brought several commits starts elsewhere, and a bad input fails toward every check
        assert.equal(detect("--parent", "f".repeat(40)), "version_only=false\n")
        assert.equal(detect("--parent", "main"), "version_only=false\n")
    } finally {
        rmSync(root, { recursive: true, force: true })
        rmSync(directory, { recursive: true, force: true })
    }
})

test("A versioned source needs its version's changelog section, matching prerelease state and no pending notes", async () => {
    const root = await fixture("1000.0.1")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), withSection("1000.0.1"))
        assert.equal(await assertVersionedSource(root), "1000.0.1")
        await note(root, "left-over", "patch", "Left over")
        await assert.rejects(assertVersionedSource(root), /pending Changesets notes/)
        await rm(join(root, ".changeset/left-over.md"))
        await write(join(root, "sdk/CHANGELOG.md"), changelog)
        await assert.rejects(assertVersionedSource(root), /no candidate version section/)
        await write(join(root, "sdk/CHANGELOG.md"), withSection("1000.0.1"))
        await write(join(root, ".changeset/pre.json"), { mode: "pre", tag: "nightly", releaseBase: null })
        await assert.rejects(assertVersionedSource(root), /leftover prerelease state/)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})
