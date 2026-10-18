import assert from "node:assert/strict"
import { access, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { prepareCandidate, readCandidate } from "../candidate.js"
import { contentFingerprint } from "../content.js"
import { currentSnapshotSchema } from "../../web/scripts/transform-schemas.js"
import { fixture, note, packages, stageFixture, write } from "./helpers.js"

test("Candidate checksum binds exact packages, notes and docs independently of the meaningful-byte guard", async () => {
    const root = await fixture("1000.0.0-rc.0")
    try {
        await write(
            join(root, "sdk/CHANGELOG.md"),
            "# SDK\n\n## 1000.0.0-rc.0\n\nNo code changes in this readiness promotion\n",
        )
        const docs = join(root, "snapshot.json")
        // The website owns snapshot schemas, so a candidate accepts the one its generator writes
        await write(docs, {
            schemaVersion: currentSnapshotSchema,
            version: "1000.0.0-rc.0",
            sourceCommit: "a".repeat(40),
            files: [{ path: "guides/index.md", content: "Guide\n" }],
        })
        const output = join(root, "candidate")
        const registries = {
            inventory: async () => ({ npmVersions: ["1000.0.0-nightly.1"] }),
        }
        const prepared = await prepareCandidate({
            workspace: root,
            output,
            docs,
            registries,
            stage: stageFixture(),
        })
        const candidate = await readCandidate(output, { checksum: prepared.checksum })
        assert.equal(candidate.checksum, prepared.checksum)
        assert.equal(candidate.schema, 1)
        await assert.rejects(readCandidate(output, { checksum: "f".repeat(64) }), /externally reviewed/)
        assert.equal(candidate.contentFingerprint, contentFingerprint(packages("1000.0.0-nightly.1")))
        assert.equal(candidate.channel, "rc")
        assert.equal(candidate.line, "1000.0")
        assert.deepEqual(await readFile(join(output, "docs.json")), await readFile(docs))
        for (const name of ["sdk.tgz", "npm/dist/index.js", "notes.md", "docs.json"]) {
            const path = join(output, name)
            const original = await readFile(path)
            await writeFile(path, `Changed ${name}`)
            await assert.rejects(readCandidate(output), /contents do not match/, name)
            await writeFile(path, original)
        }
        assert.equal((await readCandidate(output)).checksum, prepared.checksum)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Unavailable baseline and inventory fail before candidate staging", async () => {
    const root = await fixture("1000.0.0-rc.1")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), "# SDK\n\n## 1000.0.0-rc.1\n\nFix cancellation\n")
        let staged = false
        const stage = async () => {
            staged = true
        }
        await assert.rejects(
            prepareCandidate({
                workspace: root,
                output: join(root, "candidate"),
                registries: {
                    inventory: async () => ({ npmVersions: ["1000.0.0-rc.0"] }),
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
    const root = await fixture("1000.0.0-rc.1")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), "# SDK\n\n## 1000.0.0-rc.1\n\nFix cancellation\n")
        const manifest = await readFile(join(root, "sdk/package.json"))
        const notes = await readFile(join(root, "sdk/CHANGELOG.md"))
        const registries = {
            inventory: async () => ({ npmVersions: ["1000.0.0-rc.0"] }),
            baseline: async () => ({
                version: "1000.0.0-rc.0",
                contentFingerprint: contentFingerprint(packages("1000.0.0-rc.0")),
            }),
        }
        const output = join(root, "candidate")
        const skipped = await prepareCandidate({ workspace: root, output, registries, stage: stageFixture() })
        assert.equal(skipped.skipped, true)
        assert.equal(skipped.version, "1000.0.0-rc.1")
        await assert.rejects(access(output), { code: "ENOENT" })
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
        assert.deepEqual(await readFile(join(root, "sdk/CHANGELOG.md")), notes)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A stable candidate must carry exactly the bytes of the newest published RC of its version", async () => {
    const root = await fixture("1000.0.0")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), "# SDK\n\n## 1000.0.0\n\nFirst stable release\n")
        const docs = join(root, "snapshot.json")
        await write(docs, { schemaVersion: 1, version: "1000.0.0", sourceCommit: "a".repeat(40), files: [] })
        const registries = {
            inventory: async () => ({ npmVersions: ["1000.0.0-nightly.3", "1000.0.0-rc.0", "1000.0.0-rc.1"] }),
            baseline: async (_name, version) => ({
                version,
                contentFingerprint: contentFingerprint(packages(version)),
            }),
        }
        const changed = join(root, "changed")
        await assert.rejects(
            prepareCandidate({ workspace: root, output: changed, docs, registries, stage: stageFixture("export const value = 2\n") }),
            /Stable content differs from 1000.0.0-rc.1/,
        )
        await assert.rejects(access(changed), { code: "ENOENT" })
        await assert.rejects(
            prepareCandidate({
                workspace: root,
                output: join(root, "unqualified"),
                docs,
                registries: { ...registries, inventory: async () => ({ npmVersions: ["1000.0.0-nightly.3"] }) },
                stage: stageFixture(),
            }),
            /publish 1000.0.0-rc.N first/,
        )
        const output = join(root, "promoted")
        const prepared = await prepareCandidate({ workspace: root, output, docs, registries, stage: stageFixture() })
        assert.equal(prepared.skipped, undefined)
        assert.equal(prepared.baseline, "1000.0.0-rc.1")
        const candidate = await readCandidate(output, { checksum: prepared.checksum })
        assert.equal(candidate.version, "1000.0.0")
        assert.equal(candidate.baseline.version, "1000.0.0-rc.1")
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A patch Stable needs no RC, but matches a pending RC of its version and never passes a lower one", async () => {
    const root = await fixture("1000.0.1")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), "# SDK\n\n## 1000.0.1\n\nFix cancellation\n")
        const docs = join(root, "snapshot.json")
        await write(docs, { schemaVersion: 1, version: "1000.0.1", sourceCommit: "a".repeat(40), files: [] })
        const registries = (npmVersions) => ({
            inventory: async () => ({ npmVersions }),
            baseline: async (_name, version) => ({ version, contentFingerprint: contentFingerprint(packages(version)) }),
        })
        const changed = join(root, "changed")
        await assert.rejects(
            prepareCandidate({
                workspace: root,
                output: changed,
                docs,
                registries: registries(["1000.0.0", "1000.0.1-rc.0"]),
                stage: stageFixture("export const value = 2\n"),
            }),
            /Stable content differs from 1000.0.1-rc.0/,
        )
        await assert.rejects(access(changed), { code: "ENOENT" })
        await assert.rejects(
            prepareCandidate({
                workspace: root,
                output: join(root, "pending"),
                docs,
                registries: registries(["1000.0.0-rc.0"]),
                stage: stageFixture(),
            }),
            /1000.0.0-rc.0 is pending/,
        )
        const output = join(root, "direct")
        const prepared = await prepareCandidate({
            workspace: root,
            output,
            docs,
            registries: registries(["1000.0.0"]),
            stage: stageFixture("export const value = 2\n"),
        })
        assert.equal(prepared.baseline, null)
        assert.equal((await readCandidate(output, { checksum: prepared.checksum })).baseline, null)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A nightly candidate versions the next RC target from the npm inventory without reviewed notes or source changes", async () => {
    const root = await fixture("1000.2.3")
    try {
        // Nightly builds need neither versioned fragments nor a changelog section
        await note(root, "feature", "minor", "Add a feature")
        const manifest = await readFile(join(root, "sdk/package.json"))
        const fragment = await readFile(join(root, ".changeset/feature.md"))
        const version = "1000.3.0-nightly.2"
        const docs = join(root, "snapshot.json")
        await write(docs, { schemaVersion: 1, version, sourceCommit: "a".repeat(40), files: [] })
        const registries = {
            inventory: async () => ({
                npmVersions: ["1000.2.3", "1000.3.0-nightly.0", "1000.3.0-nightly.1", "1000.2.4-nightly.5"],
            }),
            baseline: async (_name, baseline) => ({
                version: baseline,
                contentFingerprint: contentFingerprint(packages(baseline, "export const value = 0\n")),
            }),
        }
        const output = join(root, "candidate")
        const prepared = await prepareCandidate({
            workspace: root,
            output,
            docs,
            channel: "nightly",
            number: 2,
            registries,
            stage: stageFixture(),
        })
        assert.deepEqual(
            [prepared.version, prepared.channel, prepared.line, prepared.baseline],
            [version, "nightly", "1000.3", "1000.3.0-nightly.1"],
        )
        const candidate = await readCandidate(output, { checksum: prepared.checksum })
        assert.deepEqual([candidate.version, candidate.channel, candidate.line], [version, "nightly", "1000.3"])
        assert.equal(candidate.baseline.version, "1000.3.0-nightly.1")
        // The notes lead with a nightly disclaimer and then list the unreleased changes
        const notes = await readFile(join(output, "notes.md"), "utf8")
        const [disclaimer, ...changes] = notes.split("\n\n")
        assert.notEqual(disclaimer.trim(), "")
        assert.equal(changes.join("\n\n"), "### Minor Changes\n\n- Add a feature\n")
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
        assert.deepEqual(await readFile(join(root, ".changeset/feature.md")), fragment)
        await assert.rejects(access(join(root, "sdk/CHANGELOG.md")), { code: "ENOENT" })
        // The documentation snapshot must carry the nightly version, not the source version
        await write(docs, { schemaVersion: 1, version: "1000.2.3", sourceCommit: "a".repeat(40), files: [] })
        const mismatched = join(root, "mismatched")
        await assert.rejects(
            prepareCandidate({ workspace: root, output: mismatched, docs, channel: "nightly", number: 2, registries, stage: stageFixture() }),
            /Documentation snapshot does not match/,
        )
        await assert.rejects(access(mismatched), { code: "ENOENT" })
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A nightly candidate of an RC cycle omits archived notes and skips content unchanged from the previous nightly or the published source", async () => {
    const root = await fixture("1000.0.0-rc.1")
    try {
        await write(join(root, ".changeset/pre/released.md"), '---\n"@neontechspace/fluxerly": major\n---\n\nAlready in an RC\n')
        const registries = (npmVersions, content) => ({
            inventory: async () => ({ npmVersions }),
            baseline: async (_name, version) => ({ version, contentFingerprint: contentFingerprint(packages(version, content)) }),
        })
        const output = join(root, "candidate")
        const prepared = await prepareCandidate({
            workspace: root,
            output,
            channel: "nightly",
            number: 0,
            // The published source version holds other bytes, so this nightly carries new content
            registries: registries(["1000.0.0-rc.0", "1000.0.0-rc.1"], "export const value = 0\n"),
            stage: stageFixture(),
        })
        assert.deepEqual([prepared.version, prepared.baseline], ["1000.0.0-nightly.0", null])
        const notes = await readFile(join(output, "notes.md"), "utf8")
        assert.doesNotMatch(notes, /###|Already in an RC/)
        assert.equal(notes.split("\n\n").filter((paragraph) => paragraph.trim() !== "").length, 2)
        const unchanged = join(root, "unchanged")
        const skipped = await prepareCandidate({
            workspace: root,
            output: unchanged,
            channel: "nightly",
            number: 4,
            registries: registries(["1000.0.0-rc.1", "1000.0.0-nightly.0"]),
            stage: stageFixture(),
        })
        assert.deepEqual(
            [skipped.skipped, skipped.version, skipped.channel, skipped.line, skipped.baseline],
            [true, "1000.0.0-nightly.4", "nightly", "1000.0", "1000.0.0-nightly.0"],
        )
        await assert.rejects(access(unchanged), { code: "ENOENT" })
        // Without an earlier nightly, bytes that match the source's published RC are not published again
        const released = join(root, "released")
        const matching = await prepareCandidate({
            workspace: root,
            output: released,
            channel: "nightly",
            number: 5,
            registries: registries(["1000.0.0-rc.0", "1000.0.0-rc.1"]),
            stage: stageFixture(),
        })
        assert.deepEqual([matching.skipped, matching.version, matching.baseline], [true, "1000.0.0-nightly.5", "1000.0.0-rc.1"])
        assert.match(matching.reason, /match 1000.0.0-rc.1/)
        await assert.rejects(access(released), { code: "ENOENT" })
        // A nightly published after the source release, such as a since reverted change, keeps the next nightly due
        const times = (source, nightly) => ({
            inventory: async () => ({
                npmVersions: ["1000.0.0-rc.1", "1000.0.0-nightly.2"],
                npmTimes: { "1000.0.0-rc.1": source, "1000.0.0-nightly.2": nightly },
            }),
            baseline: async (_name, version) => ({
                version,
                contentFingerprint: contentFingerprint(
                    packages(version, version.includes("nightly") ? "export const value = 3\n" : undefined),
                ),
            }),
        })
        const reverted = await prepareCandidate({
            workspace: root,
            output: join(root, "reverted"),
            channel: "nightly",
            number: 8,
            registries: times("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
            stage: stageFixture(),
        })
        assert.deepEqual([reverted.skipped, reverted.version], [undefined, "1000.0.0-nightly.8"])
        // An older nightly than the source release still leaves the source's bytes as already published
        const superseded = await prepareCandidate({
            workspace: root,
            output: join(root, "superseded"),
            channel: "nightly",
            number: 9,
            registries: times("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
            stage: stageFixture(),
        })
        assert.deepEqual([superseded.skipped, superseded.baseline], [true, "1000.0.0-rc.1"])
        // Unknown publication order publishes rather than risk keeping a newer nightly's build on the tag
        const unknown = await prepareCandidate({
            workspace: root,
            output: join(root, "unknown"),
            channel: "nightly",
            number: 10,
            registries: times("not a time", "2026-01-01T00:00:00.000Z"),
            stage: stageFixture(),
        })
        assert.deepEqual([unknown.skipped, unknown.version], [undefined, "1000.0.0-nightly.10"])
        // A failed lookup of the source's published bytes stops before anything is staged
        const failed = join(root, "failed")
        await assert.rejects(
            prepareCandidate({
                workspace: root,
                output: failed,
                channel: "nightly",
                number: 7,
                registries: {
                    inventory: async () => ({ npmVersions: ["1000.0.0-rc.1"] }),
                    baseline: async () => {
                        throw new Error("registry unavailable")
                    },
                },
                stage: stageFixture(),
            }),
            /registry unavailable/,
        )
        await assert.rejects(access(failed), { code: "ENOENT" })
        // An unpublished source version has nothing to match
        const pending = await prepareCandidate({
            workspace: root,
            output: join(root, "pending"),
            channel: "nightly",
            number: 6,
            registries: registries(["1000.0.0-rc.0"]),
            stage: stageFixture(),
        })
        assert.deepEqual([pending.skipped, pending.version], [undefined, "1000.0.0-nightly.6"])
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Only a nightly candidate selects its channel or takes a number, and it takes no release line", async () => {
    const root = await fixture("1000.0.0-rc.1")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), "# SDK\n\n## 1000.0.0-rc.1\n\nFix cancellation\n")
        const registries = new Proxy({}, { get: () => assert.fail("Rejected options must not read registries") })
        const stage = () => assert.fail("Rejected options must not stage")
        const output = join(root, "candidate")
        for (const channel of ["rc", "stable", "canary"])
            await assert.rejects(
                prepareCandidate({ workspace: root, output, channel, registries, stage }),
                /Only a nightly candidate selects its channel/,
                channel,
            )
        await assert.rejects(
            prepareCandidate({ workspace: root, output, channel: "nightly", line: "1000.0", registries, stage }),
            /takes no release line/,
        )
        await assert.rejects(
            prepareCandidate({ workspace: root, output, number: 3, registries, stage }),
            /Only a nightly candidate takes a number/,
        )
        await assert.rejects(access(output), { code: "ENOENT" })
    } finally {
        await rm(root, { recursive: true })
    }
})
