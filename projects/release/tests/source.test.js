import assert from "node:assert/strict"
import { access, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { contentFingerprint, exactFiles, readDirectory } from "../content.js"
import { selectBaseline } from "../planning.js"
import { applySourcePlan, changelogSection, readNightlyPlan, readSourcePlan, unreleasedNotes, versionSource } from "../source.js"
import { fixture, note, packages, stageFixture, write } from "./helpers.js"

test("A pending note added or edited during registry inspection leaves source and changelog unconsumed", async () => {
    for (const concurrent of [
        { id: "concurrent", text: "Concurrent release note" },
        { id: "reviewed", text: "Changed notes after release planning" },
    ]) {
        const root = await fixture()
        try {
            await note(root, "reviewed", "patch", "Reviewed release note")
            const manifest = await readFile(join(root, "sdk/package.json"))
            await assert.rejects(
                versionSource({
                    workspace: root,
                    options: { channel: "rc" },
                    registries: {
                        inventory: async () => {
                            await note(root, concurrent.id, "patch", concurrent.text)
                            return { npmVersions: [] }
                        },
                    },
                    stage: () => assert.fail("A channel without a published baseline has nothing to stage"),
                }),
                /inputs changed during the content guard/,
                concurrent.id,
            )
            assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
            await assert.rejects(access(join(root, "sdk/CHANGELOG.md")), { code: "ENOENT" })
            assert.match(await readFile(join(root, ".changeset", `${concurrent.id}.md`), "utf8"), new RegExp(concurrent.text))
            await access(join(root, ".changeset", "reviewed.md"))
        } finally {
            await rm(root, { recursive: true })
        }
    }
})

test("Changesets notes survive unchanged-code rc to stable promotion", async () => {
    const root = await fixture()
    try {
        await note(root, "first-generation", "major", "Introduce the first public SDK generation")
        const before = await readFile(join(root, "sdk/package.json"))
        const { plan } = await readSourcePlan(root, { channel: "rc" })
        assert.equal(plan.version, "1000.0.0-rc.1")
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), before)
        await applySourcePlan(root, { channel: "rc" })
        assert.deepEqual(JSON.parse(await readFile(join(root, ".changeset/pre.json"), "utf8")), {
            mode: "pre",
            tag: "rc",
            releaseBase: null,
        })
        await access(join(root, ".changeset/pre/first-generation.md"))
        await note(root, "preview-fix", "patch", "Fix cancellation during reconnect")
        assert.equal((await applySourcePlan(root, { channel: "rc" })).version, "1000.0.0-rc.2")
        assert.equal((await applySourcePlan(root, { channel: "stable" })).version, "1000.0.0")
        const notes = changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), "1000.0.0")
        for (const copy of ["Introduce the first public SDK generation", "Fix cancellation during reconnect"])
            assert.equal(notes.split(copy).length - 1, 1)
        await assert.rejects(access(join(root, ".changeset/pre/first-generation.md")), { code: "ENOENT" })
        await assert.rejects(access(join(root, ".changeset/pre.json")), { code: "ENOENT" })
        await assert.rejects(readSourcePlan(root, { channel: "stable" }), /needs a Changesets fragment/)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Initial prerelease changes preserve their notes without moving the stable target", async () => {
    const versions = [
        ["rc", "1000.0.0-rc.2"],
        ["stable", "1000.0.0"],
    ]
    for (const { type, companion } of [{ type: "patch" }, { type: "minor" }, { type: "major", companion: "patch" }]) {
        const root = await fixture("1000.0.0-rc.1")
        try {
            const id = `${type}-preview-change`
            const copy = `Describe the ${type} preview change`
            await note(root, id, type, copy)
            if (companion) await note(root, `${companion}-preview-fix`, companion, "Fix the preview implementation")
            const [[firstChannel, firstVersion], ...promotions] = versions
            // Planning is read-only and overrides the Changesets target with the first stable target
            const before = exactFiles(await readDirectory(root))
            const { plan, releasePlan } = await readSourcePlan(root, { channel: firstChannel })
            assert.deepEqual(
                [plan.version, plan.bump, plan.promotion, releasePlan.releases[0].newVersion],
                [firstVersion, type, false, firstVersion],
                type,
            )
            assert.deepEqual(exactFiles(await readDirectory(root)), before)
            assert.equal((await applySourcePlan(root, { channel: firstChannel })).version, firstVersion)
            await access(join(root, ".changeset", "pre", `${id}.md`))
            for (const [channel, version] of promotions)
                assert.equal((await applySourcePlan(root, { channel })).version, version)
            const stableVersion = versions.at(-1)[1]
            const notes = changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), stableVersion)
            assert.equal(notes.split(copy).length - 1, 1)
            await assert.rejects(access(join(root, ".changeset", "pre", `${id}.md`)), { code: "ENOENT" })
        } finally {
            await rm(root, { recursive: true })
        }
    }
})

test("Later cycles retain their stable base, escalate once and preserve every cycle note", async () => {
    const root = await fixture("1000.2.3")
    try {
        const changes = [
            ["first-fix", "patch", "rc", "1000.2.4-rc.0"],
            ["another-fix", "patch", "rc", "1000.2.4-rc.1"],
            ["new-feature", "minor", "rc", "1000.3.0-rc.0"],
            ["another-feature", "minor", "rc", "1000.3.0-rc.1"],
            ["breaking-stable-api", "major", "rc", "1001.0.0-rc.0"],
            ["another-breaking-change", "major", "rc", "1001.0.0-rc.1"],
        ]
        for (const [id, type, channel, version] of changes) {
            await note(root, id, type, `Migration instructions for ${id}`)
            assert.equal((await applySourcePlan(root, { channel })).version, version)
            assert.deepEqual(JSON.parse(await readFile(join(root, ".changeset/pre.json"), "utf8")), {
                mode: "pre", tag: channel, releaseBase: "1000.2.3",
            })
            const section = changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), version)
            assert.match(section, new RegExp(`Migration instructions for ${id}`))
            for (const [previous] of changes.slice(0, changes.findIndex(([name]) => name === id)))
                assert.equal(section.includes(`Migration instructions for ${previous}`), false)
        }
        assert.equal((await applySourcePlan(root, { channel: "stable" })).version, "1001.0.0")
        const stable = changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), "1001.0.0")
        for (const [id] of changes) assert.equal(stable.split(`Migration instructions for ${id}`).length - 1, 1)
        await assert.rejects(access(join(root, ".changeset/pre.json")), { code: "ENOENT" })
        await note(root, "next-cycle", "minor", "Introduce a feature after the stable release")
        assert.equal((await applySourcePlan(root, { channel: "rc" })).version, "1001.1.0-rc.0")
        assert.equal(JSON.parse(await readFile(join(root, ".changeset/pre.json"), "utf8")).releaseBase, "1001.0.0")
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Missing, invalid or changed cycle state fails before consuming release inputs", async () => {
    const root = await fixture("1000.1.0-rc.0")
    try {
        await note(root, "preview-fix", "patch", "Fix the current preview")
        for (const releaseBase of [undefined, null, "1000.1.0", "1001.0.0", "1000.0.0-rc.0", false]) {
            await write(join(root, ".changeset/pre.json"), { mode: "pre", tag: "rc", releaseBase })
            const before = exactFiles(await readDirectory(root))
            await assert.rejects(applySourcePlan(root, { channel: "rc" }), /releaseBase/)
            assert.deepEqual(exactFiles(await readDirectory(root)), before)
        }
        await write(join(root, ".changeset/pre.json"), { mode: "pre", tag: "rc", releaseBase: "1000.0.0" })
        const prepared = await readSourcePlan(root, { channel: "rc" })
        await write(join(root, ".changeset/pre.json"), { mode: "pre", tag: "rc", releaseBase: "1000.0.1" })
        const before = exactFiles(await readDirectory(root))
        await assert.rejects(applySourcePlan(root, { channel: "rc" }, prepared), /inputs changed/)
        assert.deepEqual(exactFiles(await readDirectory(root)), before)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Target escalation cannot skip qualification of the new RC", async () => {
    const root = await fixture("1000.0.0")
    try {
        await note(root, "feature", "minor", "Add a feature")
        await applySourcePlan(root, { channel: "rc" })
        await note(root, "breaking", "major", "Change the stable API")
        const before = exactFiles(await readDirectory(root))
        await assert.rejects(applySourcePlan(root, { channel: "stable" }), /pending changes as a release candidate/)
        assert.deepEqual(exactFiles(await readDirectory(root)), before)
        assert.equal((await applySourcePlan(root, { channel: "rc" })).version, "1001.0.0-rc.0")
        assert.equal((await applySourcePlan(root, { channel: "stable" })).version, "1001.0.0")
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Removed channels cannot consume source versions or Changesets notes", async () => {
    const root = await fixture()
    try {
        await note(root, "first-generation", "major", "Introduce the first public SDK generation")
        const before = exactFiles(await readDirectory(root))
        for (const channel of ["alpha", "beta", "canary", "nightly"]) {
            await assert.rejects(applySourcePlan(root, { channel }), /Channel must be rc or stable/, channel)
            assert.deepEqual(exactFiles(await readDirectory(root)), before)
        }
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Explicit epoch entry conserves migration notes through stable", async () => {
    const root = await fixture("1001.4.2")
    try {
        await note(root, "epoch-two", "major", "Introduce Epoch 2 with the migration guide")
        assert.equal((await applySourcePlan(root, { channel: "rc", epoch: 2000 })).version, "2000.0.0-rc.0")
        assert.equal((await applySourcePlan(root, { channel: "stable" })).version, "2000.0.0")
        assert.match(
            changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), "2000.0.0"),
            /migration guide/,
        )
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Reintroduced Changeset IDs cannot overwrite archived prerelease notes during RC preparation", async () => {
    for (const reintroduced of [
        { type: "major", text: "Introduce the first public SDK generation" },
        { type: "patch", text: "Edited cherry-picked note with the same ID" },
    ]) {
        const root = await fixture()
        try {
            await note(root, "same-id", "major", "Introduce the first public SDK generation")
            await applySourcePlan(root, { channel: "rc" })
            await note(root, "same-id", reintroduced.type, reintroduced.text)
            const before = exactFiles(await readDirectory(root))
            await assert.rejects(applySourcePlan(root, { channel: "rc" }), /Changeset ID collision.*same-id/)
            assert.deepEqual(exactFiles(await readDirectory(root)), before)
            assert.equal(JSON.parse(await readFile(join(root, "sdk/package.json"), "utf8")).version, "1000.0.0-rc.1")
        } finally {
            await rm(root, { recursive: true })
        }
    }
})

test("An unchanged-content cherry-pick with a pending note skips without consuming its fragment or version", async () => {
    const root = await fixture("1000.0.0-rc.1")
    try {
        await note(root, "cherry-picked-fix", "patch", "Fix cancellation during reconnect")
        const manifest = await readFile(join(root, "sdk/package.json"))
        const fragment = await readFile(join(root, ".changeset/cherry-picked-fix.md"))
        const registries = {
            inventory: async () => ({ npmVersions: ["1000.0.0-rc.1"] }),
            baseline: async () => ({ contentFingerprint: contentFingerprint(packages("1000.0.0-rc.1")) }),
        }
        const skipped = await versionSource({
            workspace: root,
            options: { channel: "rc" },
            registries,
            stage: stageFixture(),
        })
        assert.equal(skipped.skipped, true)
        assert.equal(skipped.version, "1000.0.0-rc.1")
        assert.equal(skipped.baseline, "1000.0.0-rc.1")
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
        assert.deepEqual(await readFile(join(root, ".changeset/cherry-picked-fix.md")), fragment)
        await assert.rejects(access(join(root, "sdk/CHANGELOG.md")), { code: "ENOENT" })
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Partial source preparation cannot silently discard or consume leftover prerelease notes", async () => {
    const root = await fixture("1000.0.0")
    try {
        await write(
            join(root, ".changeset/pre/leftover.md"),
            '---\n"@neontechspace/fluxerly": patch\n---\n\nFix cancellation\n',
        )
        await assert.rejects(readSourcePlan(root, { channel: "stable" }), /leftover prerelease state/)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A same-channel rebuild without notes is a verified successful skip, changed bytes need notes", async () => {
    const version = "1000.0.0-rc.1"
    const root = await fixture(version)
    try {
        const manifest = await readFile(join(root, "sdk/package.json"))
        const registries = {
            inventory: async () => ({ npmVersions: [version] }),
            baseline: async () => ({ version, contentFingerprint: contentFingerprint(packages(version)) }),
        }
        const skipped = await versionSource({
            workspace: root,
            options: { channel: "rc" },
            registries,
            stage: stageFixture(),
        })
        assert.equal(skipped.skipped, true)
        assert.equal(skipped.version, version)
        assert.equal(skipped.baseline, version)
        await assert.rejects(
            versionSource({
                workspace: root,
                options: { channel: "rc" },
                registries,
                stage: stageFixture("export const value = 2\n"),
            }),
            /no pending Changesets fragment/,
        )
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("An absent source publication safeguard is rejected before source versioning", async () => {
    const root = await fixture()
    try {
        await write(join(root, "sdk/package.json"), {
            name: "@neontechspace/fluxerly",
            version: "1000.0.0-rc.0",
            private: false,
        })
        await note(root, "first-generation", "major", "Introduce the first public SDK generation")
        const manifest = await readFile(join(root, "sdk/package.json"))
        await assert.rejects(applySourcePlan(root, { channel: "rc" }), /private publication safeguard/)
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
        await assert.rejects(access(join(root, "sdk/CHANGELOG.md")), { code: "ENOENT" })
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Stable versioning promotes only the published RC bytes and never consumes source for other content", async () => {
    const root = await fixture("1000.0.0-rc.1")
    try {
        await note(root, "first-generation", "major", "Introduce the first public SDK generation")
        await applySourcePlan(root, { channel: "rc" })
        const registries = {
            inventory: async () => ({ npmVersions: ["1000.0.0-rc.1", "1000.0.0-rc.2"] }),
            baseline: async (_name, version) => ({ version, contentFingerprint: contentFingerprint(packages(version)) }),
        }
        const before = exactFiles(await readDirectory(root))
        await assert.rejects(
            versionSource({
                workspace: root,
                options: { channel: "stable" },
                registries,
                stage: stageFixture("export const value = 2\n"),
            }),
            /Stable content differs from 1000.0.0-rc.2/,
        )
        await assert.rejects(
            versionSource({
                workspace: root,
                options: { channel: "stable" },
                registries: { ...registries, inventory: async () => ({ npmVersions: ["1000.0.0-nightly.4"] }) },
                stage: stageFixture(),
            }),
            /publish 1000.0.0-rc.N first/,
        )
        assert.deepEqual(exactFiles(await readDirectory(root)), before)
        const promoted = await versionSource({ workspace: root, options: { channel: "stable" }, registries, stage: stageFixture() })
        assert.equal(promoted.version, "1000.0.0")
        assert.match(changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), "1000.0.0"), /first public SDK/)
        await note(root, "stable-fix", "patch", "Fix cancellation")
        const pending = exactFiles(await readDirectory(root))
        await assert.rejects(
            versionSource({ workspace: root, options: { channel: "stable" }, registries, stage: stageFixture() }),
            /1000.0.0-rc.2 is pending, publish 1000.0.0 as Stable first/,
        )
        assert.deepEqual(exactFiles(await readDirectory(root)), pending)
        // Once the RC is released as Stable, a patch goes straight to Stable with no RC and no content baseline
        const released = { ...registries, inventory: async () => ({ npmVersions: ["1000.0.0-rc.1", "1000.0.0-rc.2", "1000.0.0"] }) }
        const direct = await versionSource({
            workspace: root,
            options: { channel: "stable" },
            registries: released,
            stage: stageFixture("export const value = 2\n"),
        })
        assert.equal(direct.version, "1000.0.1")
        assert.match(changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), "1000.0.1"), /Fix cancellation/)
        await assert.rejects(access(join(root, ".changeset/stable-fix.md")), { code: "ENOENT" })
        await note(root, "stable-break", "major", "Change the stable API")
        await assert.rejects(
            versionSource({ workspace: root, options: { channel: "stable" }, registries: released, stage: stageFixture() }),
            /1001.0.0 is a new major version or epoch, publish it as a release candidate/,
        )
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A nightly plans above a pending RC without changing source, and a small release then goes straight to Stable", async () => {
    const root = await fixture("1000.2.3")
    try {
        let npmVersions = ["1000.2.3", "1000.2.4-rc.0"]
        const registries = {
            inventory: async () => ({ npmVersions }),
            baseline: async (_name, version) => ({ version, contentFingerprint: contentFingerprint(packages(version)) }),
        }
        await note(root, "feature", "minor", "Add a feature")
        const before = exactFiles(await readDirectory(root))
        const nightly = await readNightlyPlan(root, npmVersions)
        assert.deepEqual(nightly, {
            currentVersion: "1000.2.3",
            version: "1000.3.0-nightly.0",
            channel: "nightly",
            line: "1000.3",
        })
        assert.equal(selectBaseline({ npmVersions, version: nightly.version, channel: nightly.channel }), null)
        assert.deepEqual(exactFiles(await readDirectory(root)), before)
        await assert.rejects(
            versionSource({ workspace: root, options: { channel: "stable" }, registries, stage: stageFixture() }),
            /1000.2.4-rc.0 is pending/,
        )
        assert.deepEqual(exactFiles(await readDirectory(root)), before)
        npmVersions = [...npmVersions, "1000.2.4", nightly.version]
        assert.equal((await readNightlyPlan(root, npmVersions)).version, "1000.3.0-nightly.1")
        const stable = await versionSource({
            workspace: root,
            options: { channel: "stable" },
            registries,
            stage: stageFixture("export const value = 3\n"),
        })
        assert.equal(stable.version, "1000.3.0")
        assert.match(changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), "1000.3.0"), /Add a feature/)
        await assert.rejects(access(join(root, ".changeset/pre.json")), { code: "ENOENT" })
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A nightly plan reads the source's release state without changing it and rejects inconsistent sources", async () => {
    const root = await fixture("1000.0.0-rc.1")
    try {
        await write(join(root, ".changeset/pre/first-generation.md"), '---\n"@neontechspace/fluxerly": major\n---\n\nIntroduce the SDK\n')
        await note(root, "preview-fix", "patch", "Fix cancellation")
        const before = exactFiles(await readDirectory(root))
        const npmVersions = ["1000.0.0-rc.0", "1000.0.0-rc.1", "1000.0.0-nightly.3", "1000.0.0-canary.9"]
        assert.deepEqual(await readNightlyPlan(root, npmVersions), {
            currentVersion: "1000.0.0-rc.1",
            version: "1000.0.0-nightly.4",
            channel: "nightly",
            line: "1000.0",
        })
        assert.deepEqual(exactFiles(await readDirectory(root)), before)
        await assert.rejects(readNightlyPlan(root, undefined), /inventory is unavailable/)
        await write(join(root, ".changeset/pre.json"), { mode: "pre", tag: "rc", releaseBase: "1000.0.1" })
        await assert.rejects(readNightlyPlan(root, npmVersions), /releaseBase/)
        await rm(join(root, ".changeset/pre.json"))
        await assert.rejects(readNightlyPlan(root, npmVersions), /prerelease state disagree/)
        await write(join(root, ".changeset/pre.json"), { mode: "pre", tag: "rc", releaseBase: null })
        await write(join(root, ".changeset/other.md"), '---\n"fluxerly-docs": patch\n---\n\nWebsite change\n')
        await assert.rejects(readNightlyPlan(root, npmVersions), /only the SDK package/)
        await rm(join(root, ".changeset/other.md"))
        const manifest = JSON.parse(await readFile(join(root, "sdk/package.json"), "utf8"))
        await write(join(root, "sdk/package.json"), { ...manifest, private: false })
        await assert.rejects(readNightlyPlan(root, npmVersions), /private publication safeguard/)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Unreleased notes format pending fragments as changelog sections and omit archived prerelease notes", async () => {
    const root = await fixture("1000.2.3")
    try {
        assert.equal(await unreleasedNotes(root), "")
        await note(root, "fix", "patch", "Fix cancellation")
        await note(root, "feature", "minor", "Add a feature\n\nDescribe its options\nacross two lines")
        await note(root, "break", "major", "Change the stable API")
        assert.equal(
            await unreleasedNotes(root),
            [
                "### Major Changes",
                "",
                "- Change the stable API",
                "",
                "### Minor Changes",
                "",
                "- Add a feature",
                "",
                "    Describe its options",
                "    across two lines",
                "",
                "### Patch Changes",
                "",
                "- Fix cancellation",
                "",
            ].join("\n"),
        )
    } finally {
        await rm(root, { recursive: true })
    }
    const cycle = await fixture("1000.0.0-rc.1")
    try {
        await write(join(cycle, ".changeset/pre/released.md"), '---\n"@neontechspace/fluxerly": minor\n---\n\nAlready in an RC\n')
        assert.equal(await unreleasedNotes(cycle), "")
        await note(cycle, "fix", "patch", "Fix cancellation")
        assert.equal(await unreleasedNotes(cycle), "### Patch Changes\n\n- Fix cancellation\n")
    } finally {
        await rm(cycle, { recursive: true })
    }
})
