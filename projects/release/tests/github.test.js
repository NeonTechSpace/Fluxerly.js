import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
    GitHubCommandError,
    createGithub,
    assertReachableFromMain,
    awaitPreparation,
    commandFailure,
    reconcileRelease,
    releaseTrigger,
    validatePreparation,
    verifyPreparation,
} from "../github.js"
import { parseVersion } from "../planning.js"

test("Atomic file commits bind the repository, exact head and one encoded addition", async () => {
    const oid = "c".repeat(40)
    const calls = []
    const github = createGithub("NeonTechSpace/Fluxerly.js", async (args, options) => {
        calls.push({ args, options })
        return { data: { createCommitOnBranch: { commit: { oid }, ref: { target: { oid } } } } }
    })
    const result = await github.commitOnBranch({ branch: "dependency-branch", head: "b".repeat(40), message: "Record dependency", path: "projects/.changeset/note.md", content: "A note\n" })
    assert.equal(result, oid)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args, ["api", "graphql", "--input", "-"])
    const input = calls[0].options.input.variables.input
    assert.deepEqual(input.branch, { repositoryNameWithOwner: "NeonTechSpace/Fluxerly.js", branchName: "dependency-branch" })
    assert.equal(input.expectedHeadOid, "b".repeat(40))
    assert.deepEqual(input.fileChanges, { additions: [{ path: "projects/.changeset/note.md", contents: Buffer.from("A note\n").toString("base64") }] })
})

test("An ambiguous atomic commit acknowledgement is reported without another mutation", async () => {
    let requests = 0
    const github = createGithub("NeonTechSpace/Fluxerly.js", async () => { requests++; return { data: {} } })
    await assert.rejects(github.commitOnBranch({ branch: "dependency-branch", head: "b".repeat(40), message: "Record dependency", path: "projects/.changeset/note.md", content: "A note\n" }), /unconfirmed/)
    assert.equal(requests, 1)
})

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

test("A scheduled nightly preparation is accepted like a manual one", () => {
    const { run, artifact, options } = preparation()
    assert.deepEqual(validatePreparation({ ...run, event: "schedule" }, [artifact], options), {
        artifactId: 40,
        artifactName: artifact.name,
        sourceCommit,
        workflowCommit,
    })
})

// A run that reports each listed status on successive reads and then stays on the last one, with a controlled clock
function polledRun(statuses) {
    const state = { reads: 0, elapsed: 0, waits: [] }
    state.read = async () => {
        const status = statuses[Math.min(state.reads++, statuses.length - 1)]
        return { ...preparation().run, status, conclusion: status === "completed" ? "success" : null }
    }
    state.options = {
        now: () => state.elapsed,
        wait: async (milliseconds) => {
            state.waits.push(milliseconds)
            state.elapsed += milliseconds
        },
        timeout: 25_000,
        delay: 10_000,
    }
    return state
}

test("Preparation is awaited until its run completes and never waits after completion", async () => {
    const finishing = polledRun(["queued", "in_progress", "completed"])
    const run = await awaitPreparation(finishing.read, finishing.options)
    assert.equal(run.status, "completed")
    assert.deepEqual([finishing.reads, finishing.waits], [3, [10_000, 10_000]])
    const { artifact, options } = preparation()
    assert.equal(validatePreparation(run, [artifact], options).artifactId, 40)
    const finished = polledRun(["completed"])
    await awaitPreparation(finished.read, finished.options)
    assert.deepEqual([finished.reads, finished.waits], [1, []])
})

test("An unfinished preparation is returned at the deadline and then fails validation", async () => {
    const running = polledRun(["in_progress"])
    const run = await awaitPreparation(running.read, running.options)
    assert.equal(run.status, "in_progress")
    // The last wait is shortened to the deadline and the run is read once more there
    assert.deepEqual(running.waits, [10_000, 10_000, 5000])
    assert.equal(running.elapsed, 25_000)
    assert.equal(running.reads, 4)
    const { artifact, options } = preparation()
    assert.throws(() => validatePreparation(run, [artifact], options), /not a successful manual or scheduled run/)
})

test("Publication waits for its preparation and requires both the candidate and workflow commits on main", async () => {
    const stub = (comparisons) => {
        const running = polledRun(["in_progress", "completed"])
        const { artifact, options } = preparation()
        const reads = []
        const github = {
            artifacts: async (runId) => (runId === "20" ? [artifact] : []),
            api: async (path) => {
                reads.push(path)
                if (path === "actions/runs/20") return running.read()
                if (path === "actions/workflows/release-prepare.yml") return options.workflow
                if (path === `commits/${sourceCommit}`) return { sha: sourceCommit }
                const commit = /^compare\/main\.\.\.([a-f0-9]{40})$/.exec(path)?.[1]
                if (commit) return comparisons[commit]
                throw new Error(`Unexpected read ${path}`)
            },
        }
        return { github, reads, running }
    }
    const behind = { status: "behind", ahead_by: 0 }
    const ahead = { status: "ahead", ahead_by: 1 }
    const accepted = stub({ [sourceCommit]: behind, [workflowCommit]: behind })
    const result = await verifyPreparation(accepted.github, "20", repository, accepted.running.options)
    assert.deepEqual(result, { artifactId: 40, artifactName: `release-candidate-${sourceCommit}`, sourceCommit, workflowCommit })
    assert.deepEqual(accepted.running.waits, [10_000])
    assert.ok(accepted.reads.includes(`compare/main...${sourceCommit}`))
    assert.ok(accepted.reads.includes(`compare/main...${workflowCommit}`))
    const branchWorkflow = stub({ [sourceCommit]: behind, [workflowCommit]: ahead })
    await assert.rejects(
        verifyPreparation(branchWorkflow.github, "20", repository, branchWorkflow.running.options),
        /Preparation workflow commit is not reachable from main/,
    )
    const branchSource = stub({ [sourceCommit]: ahead, [workflowCommit]: behind })
    await assert.rejects(
        verifyPreparation(branchSource.github, "20", repository, branchSource.running.options),
        /Candidate source is not reachable from main/,
    )
    await assert.rejects(verifyPreparation(accepted.github, "x", repository), /numeric run ID/)
})

test("Failed, foreign, unexpected-workflow and ambiguous preparation artifacts are rejected", () => {
    const { run, artifact, options } = preparation()
    for (const patch of [
        { conclusion: "failure" },
        { event: "push" },
        { event: "workflow_run" },
        { status: "in_progress", conclusion: null },
        { path: ".github/workflows/ci.yml" },
        { head_repository: { full_name: "attacker/fork" } },
        { workflow_id: 99 },
    ])
        assert.throws(
            () => validatePreparation({ ...run, ...patch }, [artifact], options),
            /not a successful manual or scheduled run/,
            JSON.stringify(patch),
        )
    assert.throws(
        () => validatePreparation(run, [artifact, { ...artifact, id: 41 }], options),
        /exactly one named candidate/,
    )
    for (const unbound of [
        { ...artifact, expired: true },
        { ...artifact, workflow_run: { ...artifact.workflow_run, head_sha: sourceCommit } },
    ])
        assert.throws(
            () => validatePreparation(run, [unbound], options),
            /expired or has inconsistent preparation provenance/,
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
        channel: parseVersion(version).channel,
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
        async deleteAsset(id) {
            mutations.push(`delete:${id}`)
            release.assets = release.assets.filter((asset) => asset.id !== id)
            bytes.delete(id)
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
    const result = await reconcileRelease(f.candidate, f.directory, f.github, {
        visibilityTimeout: 60_000,
        now: () => elapsed,
        wait: async (milliseconds) => { elapsed += milliseconds },
    })
    assert.deepEqual([result.tag, result.latest], ["v1000.0.0", true])
    assert.equal(missingReads < 0, true, "Both missing tag reads were observed")
    assert.ok(elapsed > 0 && elapsed < 60_000, `Waited ${elapsed} ms`)
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
    for (const options of [{ newer: true }, { version: "1000.0.0-rc.1" }, { version: "1000.1.0-nightly.0" }]) {
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

async function interruptedUpload(t) {
    const f = await fixture(t)
    const upload = f.github.upload
    f.github.upload = async (tag, path) => {
        if (path.endsWith("docs.json")) {
            f.getRelease().assets.push({ id: 99, name: "docs.json", size: 0, state: "starter" })
            throw new GitHubCommandError("Server error", 502)
        }
        return upload(tag, path)
    }
    await assert.rejects(reconcileRelease(f.candidate, f.directory, f.github, { visibilityTimeout: 0 }), /unconfirmed/)
    assert.equal(f.getRelease().draft, true)
    assert.deepEqual(f.mutations, ["create", "upload:notes.md"])
    f.github.upload = upload
    return f
}

test("A rerun replaces only an expected starter asset left by a failed upload", async (t) => {
    const f = await interruptedUpload(t)
    await reconcileRelease(f.candidate, f.directory, f.github)
    assert.equal(f.getRelease().draft, false)
    assert.deepEqual(f.mutations.filter((value) => value.startsWith("delete:")), ["delete:99"])
    assert.equal(f.mutations.filter((value) => value === "upload:notes.md").length, 1)
    assert.equal(f.mutations.filter((value) => value === "upload:docs.json").length, 1)
})

test("An uncertain asset deletion waits for absence without deleting or uploading twice", async (t) => {
    const f = await interruptedUpload(t)
    const deleteAsset = f.github.deleteAsset
    const releaseById = f.github.releaseById
    let staleReads = 2
    let elapsed = 0
    f.github.deleteAsset = async (id) => {
        await deleteAsset(id)
        throw new GitHubCommandError("Response lost", 502)
    }
    f.github.releaseById = async (id) => {
        const item = await releaseById(id)
        if (staleReads-- > 0) item.assets.push({ id: 99, name: "docs.json", size: 0, state: "starter" })
        return item
    }
    await reconcileRelease(f.candidate, f.directory, f.github, {
        now: () => elapsed,
        wait: async (milliseconds) => { elapsed += milliseconds },
    })
    assert.ok(elapsed >= 10_000)
    assert.equal(f.mutations.filter((value) => value === "delete:99").length, 1)
    assert.equal(f.mutations.filter((value) => value === "upload:docs.json").length, 1)
})

test("An unconfirmed asset deletion stops without a second delete or replacement upload", async (t) => {
    const f = await interruptedUpload(t)
    let elapsed = 0
    f.github.deleteAsset = async (id) => {
        f.mutations.push(`delete:${id}`)
        throw new GitHubCommandError("No response", 502)
    }
    await assert.rejects(reconcileRelease(f.candidate, f.directory, f.github, {
        visibilityTimeout: 10_000,
        now: () => elapsed,
        wait: async (milliseconds) => { elapsed += milliseconds },
    }), /asset deletion is unconfirmed/)
    assert.equal(elapsed, 10_000)
    assert.equal(f.mutations.filter((value) => value === "delete:99").length, 1)
    assert.equal(f.mutations.filter((value) => value === "upload:docs.json").length, 0)
})

test("A definite asset deletion rejection stops before replacement upload or readback", async (t) => {
    const f = await interruptedUpload(t)
    let elapsed = 0
    f.github.deleteAsset = async (id) => {
        f.mutations.push(`delete:${id}`)
        throw new GitHubCommandError("Rejected", 403)
    }
    await assert.rejects(reconcileRelease(f.candidate, f.directory, f.github, {
        now: () => elapsed,
        wait: async (milliseconds) => { elapsed += milliseconds },
    }), /rejected the docs.json asset deletion with HTTP 403/)
    assert.equal(elapsed, 0)
    assert.equal(f.mutations.filter((value) => value === "delete:99").length, 1)
    assert.equal(f.mutations.filter((value) => value === "upload:docs.json").length, 0)
})

test("GitHub command failures carry the HTTP status reported by gh", () => {
    assert.equal(commandFailure("gh: Validation Failed (HTTP 422)").status, 422)
    assert.equal(commandFailure("HTTP 502: Bad Gateway (https://uploads.github.com/)").status, 502)
    assert.equal(commandFailure("connect ETIMEDOUT").status, undefined)
})

test("A definite 4xx rejection stops reconciliation, while network and 5xx failures fall back to readback", async (t) => {
    for (const [operation, patch] of [
        ["release creation", (f) => { f.github.create = async () => { f.mutations.push("create"); throw new GitHubCommandError("Rejected", 403) } }],
        ["notes.md asset upload", (f) => { f.github.upload = async () => { f.mutations.push("upload"); throw new GitHubCommandError("Rejected", 422) } }],
        ["release publication update", (f) => { f.github.update = async () => { f.mutations.push("publish"); throw new GitHubCommandError("Rejected", 422) } }],
    ]) {
        const f = await fixture(t)
        patch(f)
        let elapsed = 0
        await assert.rejects(
            reconcileRelease(f.candidate, f.directory, f.github, {
                now: () => elapsed,
                wait: async (milliseconds) => { elapsed += milliseconds },
            }),
            new RegExp(`rejected the ${String(operation)} with HTTP 4\\d\\d`),
        )
        assert.equal(elapsed, 0, "A definite rejection must not wait for readback")
    }
    const f = await fixture(t)
    const create = f.github.create
    f.github.create = async (input) => {
        await create(input)
        throw new GitHubCommandError("Server error", 502)
    }
    assert.equal((await reconcileRelease(f.candidate, f.directory, f.github)).tag, "v1000.0.0")
    assert.equal(f.mutations.filter((value) => value === "create").length, 1)
})

test("Candidate sources must be reachable from main through a read-only comparison", async () => {
    const reads = []
    const github = (comparison) => ({
        api: async (path) => {
            reads.push(path)
            if (comparison instanceof Error) throw comparison
            return comparison
        },
    })
    await assertReachableFromMain(github({ status: "behind", ahead_by: 0 }), sourceCommit)
    await assertReachableFromMain(github({ status: "identical", ahead_by: 0 }), sourceCommit)
    assert.deepEqual(reads, [`compare/main...${sourceCommit}`, `compare/main...${sourceCommit}`])
    for (const comparison of [{ status: "ahead", ahead_by: 1 }, { status: "diverged", ahead_by: 2 }, {}])
        await assert.rejects(assertReachableFromMain(github(comparison), sourceCommit), /not reachable from main/)
    await assert.rejects(assertReachableFromMain(github(new Error("HTTP 404")), sourceCommit), /could not be verified/)
    await assert.rejects(assertReachableFromMain(github({ status: "identical", ahead_by: 0 }), "main"), /exact commit/)
    await assert.rejects(
        assertReachableFromMain(github({ status: "ahead", ahead_by: 1 }), sourceCommit, "Preparation workflow commit", "run Release prepare from main"),
        /^Error: Preparation workflow commit is not reachable from main, run Release prepare from main$/,
    )
})

test("Pushes prepare a candidate only when they change the SDK version to one npm lacks", async () => {
    const before = "c".repeat(40)
    const trigger = (versions, npmVersions = []) =>
        releaseTrigger({
            before,
            after: sourceCommit,
            readVersion: async (commit) => versions[commit],
            registries: { inventory: async () => ({ npmVersions }) },
        })
    assert.equal((await trigger({ [before]: "1000.0.0-rc.0", [sourceCommit]: "1000.0.0" })).prepare, true)
    assert.equal((await trigger({ [before]: "1000.0.0", [sourceCommit]: "1000.0.0" })).prepare, false)
    assert.equal((await trigger({ [before]: "1000.0.0-rc.0", [sourceCommit]: "1000.0.0" }, ["1000.0.0"])).prepare, false)
    const created = await releaseTrigger({
        before: "0".repeat(40),
        after: sourceCommit,
        readVersion: async () => "1000.0.1",
        registries: { inventory: async () => ({ npmVersions: [] }) },
    })
    assert.deepEqual([created.prepare, created.version], [true, "1000.0.1"])
})

test("A conflicting preexisting tag is rejected before creating any release", async (t) => {
    const f = await fixture(t)
    f.github.tagCommit = async () => workflowCommit
    await assert.rejects(reconcileRelease(f.candidate, f.directory, f.github), /conflicts/)
    assert.deepEqual(f.mutations, [])
})
