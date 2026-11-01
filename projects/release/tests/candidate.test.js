import assert from "node:assert/strict"
import { access, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { prepareCandidate, readCandidate, shortEnoughForGitHub } from "../candidate.js"
import { contentFingerprint } from "../content.js"
import { snapshotSchema as currentSnapshotSchema } from "../../web/scripts/versions.js"
import { fixture, note, packages, stageFixture, write } from "./helpers.js"

test("Release notes too long for GitHub become a link to the changelog", () => {
    const fits = "x".repeat(120_000)
    assert.equal(shortEnoughForGitHub(fits), fits)
    const shortened = shortEnoughForGitHub("x".repeat(217_920))
    assert.ok(shortened.length < 1000)
    assert.match(shortened, /\/docs\/changelog\//)
})

test("Candidate checksum binds exact packages, notes and docs independently of the meaningful-byte guard", async () => {
    const root = await fixture("1000.0.0")
    try {
        await write(
            join(root, "sdk/CHANGELOG.md"),
            "# SDK\n\n## 1000.0.0\n\nNo code changes in this readiness promotion\n",
        )
        const docs = join(root, "snapshot.json")
        // The website owns snapshot schemas, so a candidate accepts the one its generator writes
        await write(docs, {
            schemaVersion: currentSnapshotSchema,
            version: "1000.0.0",
            sourceCommit: "a".repeat(40),
            files: [{ path: "guides/index.md", content: "Guide\n" }],
        })
        const output = join(root, "candidate")
        const registries = {
            inventory: async () => ({ npmVersions: ["1000.0.0-nightly.1"] }),
            baseline: async (_name, version) => ({ version, contentFingerprint: contentFingerprint(packages(version)) }),
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
        assert.equal(candidate.channel, "stable")
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
    const root = await fixture("1000.0.0")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), "# SDK\n\n## 1000.0.0\n\nFix cancellation\n")
        let staged = false
        const stage = async () => {
            staged = true
        }
        await assert.rejects(
            prepareCandidate({
                workspace: root,
                output: join(root, "candidate"),
                registries: {
                    inventory: async () => ({ npmVersions: ["1000.0.0-nightly.0"] }),
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
    const root = await fixture("1000.0.0-nightly.1")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), "# SDK\n\n## 1000.0.0-nightly.1\n\nFix cancellation\n")
        const manifest = await readFile(join(root, "sdk/package.json"))
        const notes = await readFile(join(root, "sdk/CHANGELOG.md"))
        const registries = {
            inventory: async () => ({ npmVersions: ["1000.0.0-nightly.0"] }),
            baseline: async () => ({
                version: "1000.0.0-nightly.0",
                contentFingerprint: contentFingerprint(packages("1000.0.0-nightly.0")),
            }),
        }
        const output = join(root, "candidate")
        const skipped = await prepareCandidate({ workspace: root, output, channel: "nightly", date: "20261019", number: 1, registries, stage: stageFixture() })
        assert.equal(skipped.skipped, true)
        assert.equal(skipped.version, "1000.0.0-nightly.20261019.1")
        await assert.rejects(access(output), { code: "ENOENT" })
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
        assert.deepEqual(await readFile(join(root, "sdk/CHANGELOG.md")), notes)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A stable candidate must carry exactly the bytes of the newest published nightly of its version", async () => {
    const root = await fixture("1000.0.0")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), "# SDK\n\n## 1000.0.0\n\nFirst stable release\n")
        const docs = join(root, "snapshot.json")
        await write(docs, { schemaVersion: 1, version: "1000.0.0", sourceCommit: "a".repeat(40), files: [] })
        const registries = {
            inventory: async () => ({ npmVersions: ["1000.0.0-nightly.3", "1000.0.0-nightly.20261019.1", "1000.0.0-rc.9"] }),
            baseline: async (_name, version) => ({
                version,
                contentFingerprint: contentFingerprint(packages(version, version === "1000.0.0-nightly.3" ? "export const value = 2\n" : undefined)),
            }),
        }
        const changed = join(root, "changed")
        await assert.rejects(
            prepareCandidate({ workspace: root, output: changed, docs, registries, stage: stageFixture("export const value = 2\n") }),
            /Stable content differs from 1000.0.0-nightly.20261019.1/,
        )
        await assert.rejects(access(changed), { code: "ENOENT" })
        await assert.rejects(
            prepareCandidate({
                workspace: root,
                output: join(root, "unqualified"),
                docs,
                registries: { ...registries, inventory: async () => ({ npmVersions: ["1000.0.0-rc.9"] }) },
                stage: stageFixture(),
            }),
            /No nightly of 1000.0.0/,
        )
        const output = join(root, "promoted")
        const prepared = await prepareCandidate({ workspace: root, output, docs, registries, stage: stageFixture() })
        assert.equal(prepared.skipped, undefined)
        assert.equal(prepared.baseline, "1000.0.0-nightly.20261019.1")
        const candidate = await readCandidate(output, { checksum: prepared.checksum })
        assert.equal(candidate.version, "1000.0.0")
        assert.equal(candidate.baseline.version, "1000.0.0-nightly.20261019.1")
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A patch Stable requires matching nightly content and ignores published rc versions", async () => {
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
                registries: registries(["1000.0.0", "1000.0.1-nightly.0"]),
                stage: stageFixture("export const value = 2\n"),
            }),
            /Stable content differs from 1000.0.1-nightly.0/,
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
            /No nightly of 1000.0.1/,
        )
        const output = join(root, "direct")
        const prepared = await prepareCandidate({
            workspace: root,
            output,
            docs,
            registries: registries(["1000.0.0", "1000.0.1-nightly.0", "1001.0.0-rc.9"]),
            stage: stageFixture(),
        })
        assert.equal(prepared.baseline, "1000.0.1-nightly.0")
        assert.equal((await readCandidate(output, { checksum: prepared.checksum })).baseline.version, "1000.0.1-nightly.0")
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A nightly candidate versions the next Stable target from the npm inventory without reviewed notes or source changes", async () => {
    const root = await fixture("1000.2.3")
    try {
        // Nightly builds need neither versioned fragments nor a changelog section
        await note(root, "feature", "minor", "Add a feature")
        const manifest = await readFile(join(root, "sdk/package.json"))
        const fragment = await readFile(join(root, ".changeset/feature.md"))
        const version = "1000.3.0-nightly.20261019.2"
        const docs = join(root, "snapshot.json")
        await write(docs, { schemaVersion: 1, version, sourceCommit: "a".repeat(40), files: [] })
        const registries = {
            inventory: async () => ({
                // Older numbered nightlies and the dated form share one inventory
                npmVersions: ["1000.2.3", "1000.3.0-nightly.0", "1000.3.0-nightly.1", "1000.3.0-nightly.20261018.7", "1000.2.4-nightly.5"],
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
            date: "20261019",
            number: 2,
            registries,
            stage: stageFixture(),
        })
        assert.deepEqual(
            [prepared.version, prepared.channel, prepared.line, prepared.baseline],
            [version, "nightly", "1000.3", "1000.3.0-nightly.20261018.7"],
        )
        const candidate = await readCandidate(output, { checksum: prepared.checksum })
        assert.deepEqual([candidate.version, candidate.channel, candidate.line], [version, "nightly", "1000.3"])
        assert.equal(candidate.baseline.version, "1000.3.0-nightly.20261018.7")
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
            prepareCandidate({ workspace: root, output: mismatched, docs, channel: "nightly", date: "20261019", number: 2, registries, stage: stageFixture() }),
            /Documentation snapshot does not match/,
        )
        await assert.rejects(access(mismatched), { code: "ENOENT" })
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A nightly target omits archived notes and skips content unchanged from the previous nightly", async () => {
    const root = await fixture("1000.0.0-nightly.0")
    try {
        await write(join(root, ".changeset/pre/released.md"), '---\n"@neontechspace/fluxerly": major\n---\n\nArchived target notes\n')
        const registries = (npmVersions, content) => ({
            inventory: async () => ({ npmVersions }),
            baseline: async (_name, version) => ({ version, contentFingerprint: contentFingerprint(packages(version, content)) }),
        })
        const output = join(root, "candidate")
        const prepared = await prepareCandidate({
            workspace: root,
            output,
            channel: "nightly",
            date: "20261019",
            number: 1,
            // Retired versions never supply a baseline or source fingerprint
            registries: {
                inventory: async () => ({ npmVersions: ["1000.0.0-rc.0", "1000.0.0-rc.1"] }),
                baseline: () => assert.fail("Retired versions and nightly targets cannot supply published source bytes"),
            },
            stage: stageFixture(),
        })
        assert.deepEqual([prepared.version, prepared.baseline], ["1000.0.0-nightly.20261019.1", null])
        const notes = await readFile(join(output, "notes.md"), "utf8")
        assert.doesNotMatch(notes, /###|Archived target notes/)
        assert.equal(notes.split("\n\n").filter((paragraph) => paragraph.trim() !== "").length, 2)
        const unchanged = join(root, "unchanged")
        const skipped = await prepareCandidate({
            workspace: root,
            output: unchanged,
            channel: "nightly",
            date: "20261019",
            number: 4,
            registries: registries(["1000.0.0-nightly.0", "1000.0.0-nightly.0"]),
            stage: stageFixture(),
        })
        assert.deepEqual(
            [skipped.skipped, skipped.version, skipped.channel, skipped.line, skipped.baseline],
            [true, "1000.0.0-nightly.20261019.4", "nightly", "1000.0", "1000.0.0-nightly.0"],
        )
        await assert.rejects(access(unchanged), { code: "ENOENT" })
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A nightly skips content already in its published Stable source according to publication order", async () => {
    const root = await fixture("1000.0.0")
    try {
        const registries = (npmVersions, content) => ({
            inventory: async () => ({ npmVersions }),
            baseline: async (_name, version) => ({ version, contentFingerprint: contentFingerprint(packages(version, content)) }),
        })
        // Without an earlier nightly, bytes that match the source's published Stable are not published again
        const released = join(root, "released")
        const matching = await prepareCandidate({
            workspace: root,
            output: released,
            channel: "nightly",
            date: "20261019",
            number: 5,
            registries: registries(["1000.0.0-rc.0", "1000.0.0"]),
            stage: stageFixture(),
        })
        assert.deepEqual([matching.skipped, matching.version, matching.baseline], [true, "1000.0.1-nightly.20261019.5", "1000.0.0"])
        assert.match(matching.reason, /match 1000.0.0/)
        await assert.rejects(access(released), { code: "ENOENT" })
        // A nightly published after the source release, such as a since reverted change, keeps the next nightly due
        const times = (source, nightly) => ({
            inventory: async () => ({
                npmVersions: ["1000.0.0", "1000.0.1-nightly.2"],
                npmTimes: { "1000.0.0": source, "1000.0.1-nightly.2": nightly },
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
            date: "20261019",
            number: 8,
            registries: times("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
            stage: stageFixture(),
        })
        assert.deepEqual([reverted.skipped, reverted.version], [undefined, "1000.0.1-nightly.20261019.8"])
        // An older nightly than the source release still leaves the source's bytes as already published
        const superseded = await prepareCandidate({
            workspace: root,
            output: join(root, "superseded"),
            channel: "nightly",
            date: "20261019",
            number: 9,
            registries: times("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
            stage: stageFixture(),
        })
        assert.deepEqual([superseded.skipped, superseded.baseline], [true, "1000.0.0"])
        // Unknown publication order publishes rather than risk keeping a newer nightly's build on the tag
        const unknown = await prepareCandidate({
            workspace: root,
            output: join(root, "unknown"),
            channel: "nightly",
            date: "20261019",
            number: 10,
            registries: times("not a time", "2026-01-01T00:00:00.000Z"),
            stage: stageFixture(),
        })
        assert.deepEqual([unknown.skipped, unknown.version], [undefined, "1000.0.1-nightly.20261019.10"])
        // A failed lookup of the source's published bytes stops before anything is staged
        const failed = join(root, "failed")
        await assert.rejects(
            prepareCandidate({
                workspace: root,
                output: failed,
                channel: "nightly",
                date: "20261019",
                number: 7,
                registries: {
                    inventory: async () => ({ npmVersions: ["1000.0.0"] }),
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
            date: "20261019",
            number: 6,
            registries: registries(["1000.0.0-rc.0"]),
            stage: stageFixture(),
        })
        assert.deepEqual([pending.skipped, pending.version], [undefined, "1000.0.1-nightly.20261019.6"])
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Only a nightly candidate selects its channel or takes a date and a number, and it takes no release line", async () => {
    const root = await fixture("1000.0.0-nightly.0")
    try {
        await write(join(root, "sdk/CHANGELOG.md"), "# SDK\n\n## 1000.0.0-nightly.0\n\nFix cancellation\n")
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
            /Only a nightly candidate takes a date and a number/,
        )
        await assert.rejects(
            prepareCandidate({ workspace: root, output, date: "20261019", registries, stage }),
            /Only a nightly candidate takes a date and a number/,
        )
        await assert.rejects(access(output), { code: "ENOENT" })
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Reviewed release refuses a nightly target before registry reads or staging", async (t) => {
    const root = await fixture("1000.0.0-nightly.0")
    t.after(() => rm(root, { recursive: true }))
    await assert.rejects(prepareCandidate({ workspace: root, output: join(root, "candidate"), registries: {}, stage: () => assert.fail("Must not stage") }), /source holds a nightly target/)
    await assert.rejects(access(join(root, "candidate")), { code: "ENOENT" })
})
