import assert from "node:assert/strict"
import { access, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { contentFingerprint, exactFiles, readDirectory } from "../content.js"
import { applySourcePlan, changelogSection, readSourcePlan, versionSource } from "../source.js"
import { fixture, note, packages, stageFixture, write } from "./helpers.js"

test("Release version creates and consumes the initial canary Changeset", async () => {
    const root = await fixture()
    try {
        const result = await versionSource({
            workspace: root,
            options: { channel: "canary", bootstrap: true },
            registries: { inventory: async () => ({ npmVersions: [] }) },
            stage: () => assert.fail("First canary bootstrap has no published baseline to stage"),
        })
        assert.equal(result.version, "1000.0.0-canary.0")
        assert.equal(JSON.parse(await readFile(join(root, "sdk/package.json"), "utf8")).version, result.version)
        const note = await readFile(join(root, ".changeset", "pre", "initial-canary.md"), "utf8")
        assert.equal(
            note,
            '---\n"@neontechspace/fluxerly": patch\n---\n\nInitial canary release of Fluxerly.js for testing and feedback\n',
        )
        await assert.rejects(access(join(root, ".changeset", "initial-canary.md")), { code: "ENOENT" })
        const changelog = changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), result.version)
        assert.match(changelog, /Initial canary release of Fluxerly\.js for testing and feedback/)
        assert.doesNotMatch(changelog, /No changes/)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Initial canary note creation rejects a concurrent deterministic note", async () => {
    const root = await fixture()
    try {
        await assert.rejects(
            versionSource({
                workspace: root,
                options: { channel: "canary", bootstrap: true },
                registries: {
                    inventory: async () => {
                        await note(
                            root,
                            "initial-canary",
                            "patch",
                            "Initial canary release of Fluxerly.js for testing and feedback",
                        )
                        return { npmVersions: [] }
                    },
                },
                stage: () => assert.fail("First canary bootstrap has no published baseline to stage"),
            }),
            /Initial canary Changeset already exists/,
        )
        assert.equal(JSON.parse(await readFile(join(root, "sdk/package.json"), "utf8")).version, "0.0.0")
        assert.match(
            await readFile(join(root, ".changeset", "initial-canary.md"), "utf8"),
            /Initial canary release of Fluxerly\.js for testing and feedback/,
        )
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A concurrent different pending note leaves source and changelog unconsumed", async () => {
    const root = await fixture()
    try {
        const manifest = await readFile(join(root, "sdk/package.json"))
        await assert.rejects(
            versionSource({
                workspace: root,
                options: { channel: "canary", bootstrap: true },
                registries: {
                    inventory: async () => {
                        await note(root, "concurrent", "patch", "Concurrent release note")
                        return { npmVersions: [] }
                    },
                },
                stage: () => assert.fail("First canary bootstrap has no published baseline to stage"),
            }),
            /inputs changed during the content guard/,
        )
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
        await assert.rejects(access(join(root, "sdk/CHANGELOG.md")), { code: "ENOENT" })
        assert.match(await readFile(join(root, ".changeset", "concurrent.md"), "utf8"), /Concurrent release note/)
        await access(join(root, ".changeset", "initial-canary.md"))
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Release version preserves a normal pending initial-canary Changeset", async () => {
    const root = await fixture()
    try {
        await note(root, "first-generation", "major", "Describe the first public SDK generation")
        const result = await versionSource({
            workspace: root,
            options: { channel: "canary", bootstrap: true },
            registries: { inventory: async () => ({ npmVersions: [] }) },
            stage: () => assert.fail("First canary bootstrap has no published baseline to stage"),
        })
        assert.equal(result.version, "1000.0.0-canary.0")
        await access(join(root, ".changeset", "pre", "first-generation.md"))
        await assert.rejects(access(join(root, ".changeset", "pre", "initial-canary.md")), { code: "ENOENT" })
        assert.match(
            changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), result.version),
            /Describe the first public SDK generation/,
        )
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Changesets notes survive unchanged-code canary to rc to stable promotion", async () => {
    const root = await fixture()
    try {
        await note(root, "first-generation", "major", "Introduce the first public SDK generation")
        const before = await readFile(join(root, "sdk/package.json"))
        const { plan } = await readSourcePlan(root, { channel: "canary" })
        assert.equal(plan.version, "1000.0.0-canary.0")
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), before)
        await applySourcePlan(root, { channel: "canary" })
        assert.deepEqual(JSON.parse(await readFile(join(root, ".changeset/pre.json"), "utf8")), {
            mode: "pre",
            tag: "canary",
            releaseBase: null,
        })
        await access(join(root, ".changeset/pre/first-generation.md"))
        await note(root, "preview-fix", "patch", "Fix cancellation during reconnect")
        assert.equal((await applySourcePlan(root, { channel: "canary" })).version, "1000.0.0-canary.1")
        assert.equal((await applySourcePlan(root, { channel: "rc" })).version, "1000.0.0-rc.0")
        assert.deepEqual(JSON.parse(await readFile(join(root, ".changeset/pre.json"), "utf8")), {
            mode: "pre",
            tag: "rc",
            releaseBase: null,
        })
        assert.equal((await applySourcePlan(root, { channel: "stable" })).version, "1000.0.0")
        const notes = changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), "1000.0.0")
        for (const copy of ["Introduce the first public SDK generation", "Fix cancellation during reconnect"])
            assert.equal(notes.split(copy).length - 1, 1)
        await assert.rejects(access(join(root, ".changeset/pre/first-generation.md")), { code: "ENOENT" })
        await assert.rejects(access(join(root, ".changeset/pre.json")), { code: "ENOENT" })
        await assert.rejects(readSourcePlan(root, { channel: "stable" }), /Changesets fragment/)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Initial-cycle breaking notes preserve the first stable target during readiness promotion", async () => {
    const root = await fixture("1000.0.0-canary.1")
    try {
        await note(root, "breaking-preview", "major", "Change the preview API")
        await note(root, "preview-fix", "patch", "Fix the preview implementation")
        const before = exactFiles(await readDirectory(root))
        const { plan, releasePlan } = await readSourcePlan(root, { channel: "rc" })
        assert.equal(plan.version, "1000.0.0-rc.0")
        assert.equal(plan.bump, "major")
        assert.equal(plan.promotion, true)
        assert.equal(releasePlan.releases[0].newVersion, plan.version)
        assert.deepEqual(exactFiles(await readDirectory(root)), before)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Initial prerelease changes preserve their notes without moving the stable target", async () => {
    for (const { type, versions } of [
        {
            type: "patch",
            versions: [
                ["canary", "1000.0.0-canary.2"],
                ["rc", "1000.0.0-rc.0"],
                ["stable", "1000.0.0"],
            ],
        },
        {
            type: "minor",
            versions: [
                ["rc", "1000.0.0-rc.0"],
                ["stable", "1000.0.0"],
            ],
        },
        {
            type: "major",
            versions: [
                ["rc", "1000.0.0-rc.0"],
                ["stable", "1000.0.0"],
            ],
        },
    ]) {
        const root = await fixture("1000.0.0-canary.1")
        try {
            const id = `${type}-preview-change`
            const copy = `Describe the ${type} preview change`
            await note(root, id, type, copy)
            const [[firstChannel, firstVersion], ...promotions] = versions
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
            ["first-fix", "patch", "canary", "1000.2.4-canary.0"],
            ["another-fix", "patch", "canary", "1000.2.4-canary.1"],
            ["new-feature", "minor", "canary", "1000.3.0-canary.0"],
            ["another-feature", "minor", "rc", "1000.3.0-rc.0"],
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
        assert.equal((await applySourcePlan(root, { channel: "canary" })).version, "1001.1.0-canary.0")
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
        await assert.rejects(applySourcePlan(root, { channel: "stable" }), /changed release target/)
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
        for (const channel of ["alpha", "beta"]) {
            await assert.rejects(applySourcePlan(root, { channel }), /Channel must be canary, rc or stable/)
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
        assert.equal((await applySourcePlan(root, { channel: "canary", epoch: 2000 })).version, "2000.0.0-canary.0")
        await applySourcePlan(root, { channel: "rc" })
        await applySourcePlan(root, { channel: "stable" })
        assert.match(
            changelogSection(await readFile(join(root, "sdk/CHANGELOG.md"), "utf8"), "2000.0.0"),
            /migration guide/,
        )
    } finally {
        await rm(root, { recursive: true })
    }
})

test("Reintroduced Changeset IDs cannot overwrite archived canary notes during RC preparation", async () => {
    for (const reintroduced of [
        { type: "major", text: "Introduce the first public SDK generation" },
        { type: "patch", text: "Edited cherry-picked note with the same ID" },
    ]) {
        const root = await fixture()
        try {
            await note(root, "same-id", "major", "Introduce the first public SDK generation")
            await applySourcePlan(root, { channel: "canary" })
            await note(root, "same-id", reintroduced.type, reintroduced.text)
            const before = exactFiles(await readDirectory(root))
            await assert.rejects(applySourcePlan(root, { channel: "rc" }), /Changeset ID collision.*same-id/)
            assert.deepEqual(exactFiles(await readDirectory(root)), before)
            assert.equal(JSON.parse(await readFile(join(root, "sdk/package.json"), "utf8")).version, "1000.0.0-canary.0")
        } finally {
            await rm(root, { recursive: true })
        }
    }
})

test("A repeated cherry-picked SDK change is rejected before consuming its fragment or version", async () => {
    const root = await fixture("1000.0.0-canary.1")
    try {
        await note(root, "cherry-picked-fix", "patch", "Fix cancellation during reconnect")
        const manifest = await readFile(join(root, "sdk/package.json"))
        const fragment = await readFile(join(root, ".changeset/cherry-picked-fix.md"))
        const registries = {
            inventory: async () => ({ npmVersions: ["1000.0.0-canary.1"] }),
            baseline: async () => ({ contentFingerprint: contentFingerprint(packages("1000.0.0-canary.1")) }),
        }
        const skipped = await versionSource({
            workspace: root,
            options: { channel: "canary" },
            registries,
            stage: stageFixture(),
        })
        assert.equal(skipped.skipped, true)
        assert.equal(skipped.version, "1000.0.0-canary.1")
        assert.equal(skipped.baseline, "1000.0.0-canary.1")
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

test("A fragment edited during registry inspection cannot be consumed under an old content guard", async () => {
    const root = await fixture()
    try {
        await note(root, "first-generation", "major", "Introduce the first public SDK generation")
        const manifest = await readFile(join(root, "sdk/package.json"))
        const registries = {
            inventory: async () => {
                await note(root, "first-generation", "major", "Changed notes after release planning")
                return { npmVersions: [] }
            },
        }
        await assert.rejects(
            versionSource({
                workspace: root,
                options: { channel: "canary", bootstrap: true },
                registries,
                stage: stageFixture(),
            }),
            /inputs changed during/,
        )
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
        assert.match(await readFile(join(root, ".changeset/first-generation.md"), "utf8"), /Changed notes after/)
    } finally {
        await rm(root, { recursive: true })
    }
})

test("A same-channel rebuild without notes is a verified successful skip, changed bytes need notes", async () => {
    for (const version of ["1000.0.0-canary.1", "1000.0.0"]) {
        const root = await fixture(version)
        try {
            const channel = version.includes("-canary") ? "canary" : "stable"
            const manifest = await readFile(join(root, "sdk/package.json"))
            const registries = {
                inventory: async () => ({ npmVersions: [version] }),
                baseline: async () => ({ version, contentFingerprint: contentFingerprint(packages(version)) }),
            }
            const skipped = await versionSource({
                workspace: root,
                options: { channel },
                registries,
                stage: stageFixture(),
            })
            assert.equal(skipped.skipped, true)
            assert.equal(skipped.version, version)
            assert.equal(skipped.baseline, version)
            await assert.rejects(
                versionSource({
                    workspace: root,
                    options: { channel },
                    registries,
                    stage: stageFixture("export const value = 2\n"),
                }),
                /no pending Changesets fragment/,
            )
            assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
        } finally {
            await rm(root, { recursive: true })
        }
    }
})

test("An absent source publication safeguard is rejected before source versioning", async () => {
    const root = await fixture()
    try {
        await write(join(root, "sdk/package.json"), {
            name: "@neontechspace/fluxerly",
            version: "0.0.0",
            private: false,
        })
        await note(root, "first-generation", "major", "Introduce the first public SDK generation")
        const manifest = await readFile(join(root, "sdk/package.json"))
        await assert.rejects(applySourcePlan(root, { channel: "canary" }), /private publication safeguard/)
        assert.deepEqual(await readFile(join(root, "sdk/package.json")), manifest)
        await assert.rejects(access(join(root, "sdk/CHANGELOG.md")), { code: "ENOENT" })
    } finally {
        await rm(root, { recursive: true })
    }
})
