import assert from "node:assert/strict"
import { access, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { prepareCandidate, readCandidate } from "../candidate.js"
import { contentFingerprint } from "../content.js"
import { fixture, packages, stageFixture, write } from "./helpers.js"

test("Candidate checksum binds exact packages, notes and docs independently of the meaningful-byte guard", async () => {
    const root = await fixture("1000.0.0-rc.0")
    try {
        await write(
            join(root, "sdk/CHANGELOG.md"),
            "# SDK\n\n## 1000.0.0-rc.0\n\nNo code changes in this readiness promotion\n",
        )
        const docs = join(root, "snapshot.json")
        await write(docs, {
            schemaVersion: 1,
            version: "1000.0.0-rc.0",
            sourceCommit: "a".repeat(40),
            files: [{ path: "guides/index.md", content: "Guide\n" }],
        })
        const output = join(root, "candidate")
        const registries = {
            inventory: async () => ({ npmVersions: ["1000.0.0-canary.1"] }),
        }
        const prepared = await prepareCandidate({
            workspace: root,
            output,
            docs,
            bootstrap: true,
            registries,
            stage: stageFixture(),
        })
        const candidate = await readCandidate(output, { checksum: prepared.checksum })
        assert.equal(candidate.checksum, prepared.checksum)
        assert.equal(candidate.schema, 1)
        await assert.rejects(readCandidate(output, { checksum: "f".repeat(64) }), /externally reviewed/)
        assert.equal(candidate.contentFingerprint, contentFingerprint(packages("1000.0.0-canary.1")))
        assert.equal(candidate.channel, "rc")
        assert.equal(candidate.line, "1000.0")
        assert.deepEqual(await readFile(join(output, "docs.json")), await readFile(docs))
        await writeFile(join(output, "docs.json"), "Changed documentation snapshot")
        await assert.rejects(readCandidate(output), /contents do not match/)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Unavailable baseline and inventory fail before candidate staging", async () => {
    const root = await fixture("1000.0.1")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), "# SDK\n\n## 1000.0.1\n\nFix cancellation\n")
        let staged = false
        const stage = async () => {
            staged = true
        }
        await assert.rejects(
            prepareCandidate({
                workspace: root,
                output: join(root, "candidate"),
                registries: {
                    inventory: async () => ({ npmVersions: ["1000.0.0"] }),
                    baseline: async () => { throw new Error("Baseline unavailable") },
                },
                stage,
            }),
            /Baseline unavailable/,
        )
        await assert.rejects(
            prepareCandidate({
                workspace: root,
                output: join(root, "candidate"),
                registries: {
                    inventory: async () => {
                        throw new Error("Inventory unavailable")
                    },
                },
                stage,
            }),
            /unavailable/,
        )
        assert.equal(staged, false)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("An unchanged prepared version skips without an artifact or source mutation", async () => {
    const root = await fixture("1000.0.1")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), "# SDK\n\n## 1000.0.1\n\nFix cancellation\n")
        const manifest = await readFile(join(root, "sdk/package.json"))
        const notes = await readFile(join(root, "sdk/CHANGELOG.md"))
        const registries = {
            inventory: async () => ({ npmVersions: ["1000.0.0"] }),
            baseline: async () => ({
                version: "1000.0.0",
                contentFingerprint: contentFingerprint(packages("1000.0.0")),
            }),
        }
        const output = join(root, "candidate")
        const skipped = await prepareCandidate({ workspace: root, output, registries, stage: stageFixture() })
        assert.equal(skipped.skipped, true)
        assert.equal(skipped.version, "1000.0.1")
        await assert.rejects(access(output), { code: "ENOENT" })
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
        assert.deepEqual(await readFile(join(root, "sdk/CHANGELOG.md")), notes)
    } finally {
        await rm(root, { recursive: true })
    }
})
