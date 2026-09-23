import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { reconcileRelease, validatePreparation } from "../github.js"

const sourceCommit = "a".repeat(40)
const workflowCommit = "b".repeat(40)
const repository = "NeonTechSpace/Fluxerly.js"
function preparation() {
    const workflow = { id: 10, path: ".github/workflows/release-prepare.yml" }
    const run = {
        id: 20,
        repository: { id: 30, full_name: repository },
        head_repository: { full_name: repository },
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        path: workflow.path,
        workflow_id: workflow.id,
        head_sha: workflowCommit,
    }
    const artifact = {
        id: 40,
        name: `release-candidate-${sourceCommit}`,
        expired: false,
        workflow_run: { id: 20, head_sha: workflowCommit, repository_id: 30, head_repository_id: 30 },
    }
    return { run, artifact, options: { repository, runId: "20", workflow } }
}

test("Selected checkout identity is distinct from dispatch workflow head SHA", () => {
    const { run, artifact, options } = preparation()
    assert.deepEqual(validatePreparation(run, [artifact], options), {
        artifactId: 40,
        artifactName: artifact.name,
        sourceCommit,
        workflowCommit,
    })
})

test("Failed, foreign, unexpected-workflow and ambiguous preparation artifacts are rejected", () => {
    const { run, artifact, options } = preparation()
    for (const patch of [
        { conclusion: "failure" },
        { event: "push" },
        { path: ".github/workflows/ci.yml" },
        { head_repository: { full_name: "attacker/fork" } },
        { workflow_id: 99 },
    ])
        assert.throws(() => validatePreparation({ ...run, ...patch }, [artifact], options))
    assert.throws(() => validatePreparation(run, [artifact, { ...artifact, id: 41 }], options))
    assert.throws(() => validatePreparation(run, [{ ...artifact, expired: true }], options))
    assert.throws(() =>
        validatePreparation(
            run,
            [{ ...artifact, workflow_run: { ...artifact.workflow_run, head_sha: sourceCommit } }],
            options,
        ),
    )
})

async function fixture(t, { version = "1000.0.0", existing, newer = false } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "fluxerly-github-test-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const names = ["notes.md", "docs.json", "candidate.json", "checksum.txt", "sdk.tgz"]
    for (const name of names)
        await writeFile(join(directory, name), name === "notes.md" ? "Reviewed notes\n" : `Exact ${name}`)
    const candidate = {
        version,
        channel: version.includes("-") ? "rc" : "stable",
        sourceCommit,
        docs: { path: "docs.json" },
    }
    let release = existing ?? null
    const bytes = new Map()
    const mutations = []
    let latestTag = newer ? "v2000.0.0" : null
    let uncertainUpload = false
    let uncertainCreation = false
    const github = {
        async release() {
            return release ? structuredClone(release) : null
        },
        async releaseById(id) {
            return release?.id === id ? structuredClone(release) : null
        },
        async create(input) {
            mutations.push("create")
            release = { ...input, id: 1, assets: [], html_url: "https://github.com/example/release" }
            if (uncertainCreation) throw new Error("Connection lost after create")
            return structuredClone(release)
        },
        async tagCommit() {
            return release ? (release.sourceCommit ?? sourceCommit) : null
        },
        async upload(tag, path) {
            const name = path.split(/[\\/]/).at(-1)
            mutations.push(`upload:${name}`)
            const id = release.assets.length + 1
            const value = await readFile(path)
            bytes.set(id, value)
            release.assets.push({ id, name, size: value.length, state: "uploaded" })
            if (uncertainUpload) {
                uncertainUpload = false
                throw new Error("Connection lost after upload")
            }
        },
        async download(id) {
            return bytes.get(id)
        },
        async releases() {
            return newer ? [{ tag_name: "v2000.0.0", draft: false, prerelease: false }] : []
        },
        async update(id, patch) {
            mutations.push("publish")
            Object.assign(release, patch)
            if (patch.make_latest === "true") latestTag = release.tag_name
        },
        async latest() {
            return { tag_name: latestTag }
        },
    }
    return {
        candidate,
        directory,
        github,
        mutations,
        bytes,
        setUncertainUpload() {
            uncertainUpload = true
        },
        setUncertainCreation() {
            uncertainCreation = true
        },
        corruptAsset() {
            bytes.set(1, Buffer.from("Wrong bytes"))
        },
        getRelease() {
            return release
        },
    }
}

test("A lost create/upload response is reconciled by exact readback and rerun does not upload again", async (t) => {
    const f = await fixture(t)
    f.setUncertainCreation()
    f.setUncertainUpload()
    const result = await reconcileRelease(f.candidate, f.directory, f.github)
    assert.equal(result.latest, true)
    assert.equal(f.getRelease().draft, false)
    assert.equal(f.mutations.filter((value) => value.startsWith("upload:")).length, 5)
    await reconcileRelease(f.candidate, f.directory, f.github)
    assert.equal(f.mutations.filter((value) => value.startsWith("upload:")).length, 5)
    assert.equal(f.mutations.filter((value) => value === "publish").length, 1)
})

test("A successful create response uses its ID while tag and list reads lag", async (t) => {
    const f = await fixture(t)
    let elapsed = 0
    let idReads = 0
    let tagReads = 0
    const release = f.github.release
    const releaseById = f.github.releaseById
    f.github.release = async () => ++tagReads <= 4 ? null : release()
    f.github.releaseById = async (id) => {
        idReads++
        return idReads <= 3 ? null : releaseById(id)
    }
    const result = await reconcileRelease(f.candidate, f.directory, f.github, {
        now: () => elapsed,
        wait: async (milliseconds) => { elapsed += milliseconds },
    })
    assert.equal(result.tag, "v1000.0.0")
    assert.equal(f.mutations.filter((value) => value === "create").length, 1)
    assert.ok(elapsed >= 15_000)
})

test("A lost create response waits for delayed tag visibility without creating twice", async (t) => {
    const f = await fixture(t)
    f.setUncertainCreation()
    let elapsed = 0
    let invisibleReads = 3
    const release = f.github.release
    f.github.release = async (...args) => invisibleReads-- > 0 ? null : release(...args)
    await reconcileRelease(f.candidate, f.directory, f.github, {
        now: () => elapsed,
        wait: async (milliseconds) => { elapsed += milliseconds },
    })
    assert.equal(f.mutations.filter((value) => value === "create").length, 1)
    assert.ok(elapsed >= 10_000)
})

test("A lost upload response waits for delayed asset visibility without uploading twice", async (t) => {
    const f = await fixture(t)
    f.setUncertainUpload()
    let elapsed = 0
    let staleReads = 2
    const releaseById = f.github.releaseById
    f.github.releaseById = async (id) => {
        const item = await releaseById(id)
        if (item?.assets.length && staleReads-- > 0) item.assets = []
        return item
    }
    await reconcileRelease(f.candidate, f.directory, f.github, {
        now: () => elapsed,
        wait: async (milliseconds) => { elapsed += milliseconds },
    })
    assert.equal(f.mutations.filter((value) => value === "upload:notes.md").length, 1)
    assert.ok(elapsed >= 10_000)
})

test("An in-progress asset waits for uploaded state without a second upload", async (t) => {
    const f = await fixture(t)
    let elapsed = 0
    let pendingReads = 2
    const releaseById = f.github.releaseById
    f.github.releaseById = async (id) => {
        const item = await releaseById(id)
        if (item?.assets.length && pendingReads-- > 0) item.assets[0].state = "new"
        return item
    }
    await reconcileRelease(f.candidate, f.directory, f.github, {
        now: () => elapsed,
        wait: async (milliseconds) => { elapsed += milliseconds },
    })
    assert.equal(f.mutations.filter((value) => value === "upload:notes.md").length, 1)
    assert.ok(elapsed >= 10_000)
})

test("An invisible asset fails explicitly at the deadline without a second upload", async (t) => {
    const f = await fixture(t)
    let elapsed = 0
    const releaseById = f.github.releaseById
    f.github.releaseById = async (id) => {
        const item = await releaseById(id)
        if (item?.assets.length) item.assets = []
        return item
    }
    await assert.rejects(reconcileRelease(f.candidate, f.directory, f.github, {
        visibilityTimeout: 10_000,
        now: () => elapsed,
        wait: async (milliseconds) => { elapsed += milliseconds },
    }), /asset contents are unconfirmed/)
    assert.equal(f.mutations.filter((value) => value === "upload:notes.md").length, 1)
    assert.equal(elapsed, 10_000)
})

test("A lost publish update response is reconciled without repeating the update", async (t) => {
    const f = await fixture(t)
    const update = f.github.update
    f.github.update = async (...args) => {
        await update(...args)
        throw new Error("Response lost after update")
    }
    await reconcileRelease(f.candidate, f.directory, f.github)
    assert.equal(f.getRelease().draft, false)
    assert.equal(f.mutations.filter((value) => value === "publish").length, 1)
})

test("Final tag verification waits for delayed Git ref visibility", async (t) => {
    const f = await fixture(t)
    let elapsed = 0
    let missingReads = 2
    const tagCommit = f.github.tagCommit
    f.github.tagCommit = async (...args) =>
        f.getRelease() && !f.getRelease().draft && missingReads-- > 0 ? null : tagCommit(...args)
    await reconcileRelease(f.candidate, f.directory, f.github, {
        now: () => elapsed,
        wait: async (milliseconds) => { elapsed += milliseconds },
    })
    assert.equal(elapsed, 10_000)
})

test("An unconfirmed publish update stops at the deadline without repeating the update", async (t) => {
    const f = await fixture(t)
    let elapsed = 0
    f.github.update = async () => {
        f.mutations.push("publish")
        throw new Error("Update failed")
    }
    await assert.rejects(reconcileRelease(f.candidate, f.directory, f.github, {
        visibilityTimeout: 10_000,
        now: () => elapsed,
        wait: async (milliseconds) => { elapsed += milliseconds },
    }), /final readback/)
    assert.equal(f.mutations.filter((value) => value === "publish").length, 1)
    assert.equal(elapsed, 10_000)
})

test("Older stable lines and prereleases never become latest", async (t) => {
    for (const options of [{ newer: true }, { version: "1000.0.0-rc.1" }]) {
        const f = await fixture(t, options)
        assert.equal((await reconcileRelease(f.candidate, f.directory, f.github)).latest, false)
        assert.equal(f.getRelease().make_latest, "false")
        assert.equal(f.getRelease().prerelease, options.version !== undefined)
    }
})

test("Existing source, notes, readiness and unexpected asset conflicts cannot be clobbered", async (t) => {
    const base = {
        id: 1,
        tag_name: "v1000.0.0",
        name: "v1000.0.0",
        body: "Reviewed notes\n",
        prerelease: false,
        draft: true,
        assets: [],
    }
    for (const patch of [
        { sourceCommit: workflowCommit },
        { body: "Different notes" },
        { prerelease: true },
        { assets: [{ name: "unreviewed.txt" }] },
    ]) {
        const f = await fixture(t, { existing: { ...base, ...patch } })
        await assert.rejects(reconcileRelease(f.candidate, f.directory, f.github), /conflicts|unexpected/)
        assert.deepEqual(f.mutations, [])
    }
})

test("Published asset byte mismatch blocks further mutation on retry", async (t) => {
    const f = await fixture(t)
    await reconcileRelease(f.candidate, f.directory, f.github)
    f.corruptAsset()
    const before = [...f.mutations]
    await assert.rejects(reconcileRelease(f.candidate, f.directory, f.github), /conflicting/)
    assert.deepEqual(f.mutations, before)
})

test("Draft recovery accepts an absent tag only with the exact candidate target commit", async (t) => {
    const f = await fixture(t)
    const realTagCommit = f.github.tagCommit
    f.github.tagCommit = async () => (f.getRelease()?.draft ? null : realTagCommit())
    await reconcileRelease(f.candidate, f.directory, f.github)
    assert.equal(f.getRelease().target_commitish, sourceCommit)
    const conflict = await fixture(t, {
        existing: {
            id: 1,
            tag_name: "v1000.0.0",
            name: "v1000.0.0",
            body: "Reviewed notes\n",
            prerelease: false,
            draft: true,
            target_commitish: workflowCommit,
            assets: [],
        },
    })
    conflict.github.tagCommit = async () => null
    await assert.rejects(reconcileRelease(conflict.candidate, conflict.directory, conflict.github), /conflicts/)
    assert.deepEqual(conflict.mutations, [])
})

test("An interrupted asset upload leaves a draft and retry resumes only missing assets", async (t) => {
    const f = await fixture(t)
    const upload = f.github.upload
    f.github.upload = async (tag, path) => {
        if (path.endsWith("docs.json")) throw new Error("No response before upload")
        return upload(tag, path)
    }
    await assert.rejects(reconcileRelease(f.candidate, f.directory, f.github, { visibilityTimeout: 0 }), /unconfirmed/)
    assert.equal(f.getRelease().draft, true)
    assert.deepEqual(f.mutations, ["create", "upload:notes.md"])
    f.github.upload = upload
    await reconcileRelease(f.candidate, f.directory, f.github)
    assert.equal(f.mutations.filter((value) => value === "upload:notes.md").length, 1)
    assert.equal(f.getRelease().draft, false)
})

test("A conflicting preexisting tag is rejected before creating any release", async (t) => {
    const f = await fixture(t)
    f.github.tagCommit = async () => workflowCommit
    await assert.rejects(reconcileRelease(f.candidate, f.directory, f.github), /conflicts/)
    assert.deepEqual(f.mutations, [])
})
