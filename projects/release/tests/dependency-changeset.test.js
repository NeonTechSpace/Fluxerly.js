import assert from "node:assert/strict"
import { test } from "node:test"
import { addDependencyChangeset, dependencyChangesetForCheck, planDependencyChangeset } from "../dependency-changeset.js"

const repository = "NeonTechSpace/Fluxerly.js"
function fixture() {
    const before = {
        name: "@neontechspace/fluxerly", version: "1000.0.0-rc.4", private: true,
        dependencies: { neverthrow: "8.2.0", ws: "8.21.3" },
        devDependencies: { vitest: "5.0.2" }, peerDependencies: { effect: "^4.0.0" },
    }
    const after = structuredClone(before)
    after.dependencies.ws = "8.22.0"
    return {
        repository,
        pull: {
            number: 9, user: { login: "dependabot[bot]", type: "Bot" },
            base: { ref: "main", repo: { full_name: repository } },
            head: { ref: "dependabot/npm_and_yarn/projects/sdk-runtime-example", repo: { full_name: repository } },
        },
        files: [{ filename: "projects/sdk/package.json", status: "modified" }, { filename: "projects/pnpm-lock.yaml", status: "modified" }],
        before, after,
    }
}

test("A routine runtime upgrade produces a patch release note with the actual versions", () => {
    const input = fixture()
    const plan = planDependencyChangeset(input)
    assert.equal(plan.skipped, false)
    assert.equal(plan.path, "projects/.changeset/runtime-dependencies-9.md")
    assert.match(plan.content, /"@neontechspace\/fluxerly": patch/)
    assert.match(plan.content, /`ws` from `8\.21\.3` to `8\.22\.0`/)
    assert.deepEqual(input, fixture(), "Planning must not mutate the metadata inputs")
})

test("Grouped runtime updates share one note and manifest key ordering does not matter", () => {
    const input = fixture()
    input.after.dependencies = { ws: "8.22.0", neverthrow: "8.3.0" }
    const plan = planDependencyChangeset(input)
    assert.equal(plan.skipped, false)
    assert.match(plan.content, /`neverthrow` from `8\.2\.0` to `8\.3\.0`/)
    assert.match(plan.content, /`ws` from `8\.21\.3` to `8\.22\.0`/)
})

test("Existing, modified and removed release notes preserve the manual release decision", () => {
    for (const status of ["added", "modified", "removed"]) {
        const input = fixture()
        input.files.push({ filename: "projects/.changeset/reviewed-note.md", status })
        assert.equal(planDependencyChangeset(input).skipped, true, status)
    }
})

test("Spoofed authors, forks, other groups and changed SDK code cannot authorize a note", () => {
    const mutations = [
        (input) => { input.pull.user.type = "User" },
        (input) => { input.pull.user.login = "other-bot[bot]" },
        (input) => { input.pull.head.repo.full_name = "attacker/Fluxerly.js" },
        (input) => { input.pull.base.repo.full_name = "other/Fluxerly.js" },
        (input) => { input.pull.base.ref = "other" },
        (input) => { input.pull.head.ref = "dependabot/npm_and_yarn/projects/npm-example" },
        (input) => { input.files.push({ filename: "projects/sdk/src/index.ts", status: "modified" }) },
        (input) => { input.files[0].status = "renamed"; input.files[0].previous_filename = ".github/workflows/ci.yml" },
        (input) => { input.files[1].status = "removed" },
        (input) => { input.after.peerDependencies.effect = "^5.0.0" },
        (input) => { input.after.devDependencies.vitest = "5.0.3" },
    ]
    for (const mutate of mutations) {
        const input = fixture()
        mutate(input)
        assert.equal(planDependencyChangeset(input).skipped, true)
    }
})

test("Major, zero-major breaking, prerelease, ranged and downgraded dependencies stay manual", () => {
    for (const [from, to] of [
        ["8.21.3", "9.0.0"], ["0.1.0", "0.2.0"], ["8.21.3", "8.22.0-beta.1"],
        ["8.21.3", "^8.22.0"], ["8.21.3", "8.21.2"], ["8.21.3", "08.22.0"],
    ]) {
        const input = fixture()
        input.before.dependencies.ws = from
        input.after.dependencies.ws = to
        assert.equal(planDependencyChangeset(input).skipped, true, `${from} to ${to}`)
    }
})

test("Development-only, lockfile-only, added and removed runtime dependencies create no note", () => {
    const unchanged = fixture()
    unchanged.after = structuredClone(unchanged.before)
    assert.equal(planDependencyChangeset(unchanged).skipped, true)
    const added = fixture()
    added.after.dependencies.newPackage = "1.0.0"
    assert.equal(planDependencyChangeset(added).skipped, true)
    const removed = fixture()
    delete removed.after.dependencies.neverthrow
    assert.equal(planDependencyChangeset(removed).skipped, true)
})

const base = "a".repeat(40)
const head = "b".repeat(40)
const tree = "c".repeat(40)
const commit = "d".repeat(40)
function provider({ existing = false, edited = false, removed = false, raced = false, dispatched = false, rejectUpdate = false } = {}) {
    const input = fixture()
    input.pull.state = "open"
    input.pull.merged = false
    input.pull.base.sha = base
    input.pull.head.sha = head
    const note = planDependencyChangeset(input)
    const state = { current: head, reads: 0, calls: [], runs: dispatched ? [{ head_sha: head, event: "workflow_dispatch" }] : [] }
    const file = (content) => ({ encoding: "base64", content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) })
    const api = async (path, options = {}) => {
        state.calls.push({ path, options })
        if (path === "pulls/9") {
            state.reads++
            const pull = structuredClone(input.pull)
            if (raced && state.reads > 1) pull.head.sha = "e".repeat(40)
            return pull
        }
        if (path.startsWith("pulls/9/files?"))
            return [...input.files, ...((existing || removed) ? [{ filename: note.path, status: removed ? "removed" : "added" }] : [])]
        if (path === `contents/projects/sdk/package.json?ref=${base}`) return file(JSON.stringify(input.before))
        if (path === `contents/projects/sdk/package.json?ref=${head}`) return file(JSON.stringify(input.after))
        if (path === `contents/${note.path}?ref=${head}`) return existing ? file(edited ? "Reviewed replacement note" : note.content) : null
        if (path === `git/commits/${head}`) return { tree: { sha: tree } }
        if (path === "git/trees") return { sha: tree }
        if (path === "git/commits") return { sha: commit }
        if (path.startsWith("git/refs/heads/")) {
            if (rejectUpdate) throw new Error("Concurrent branch update rejected")
            state.current = options.input.sha
            return { object: { sha: state.current } }
        }
        if (path.startsWith("git/ref/heads/")) return { object: { sha: state.current } }
        if (path.startsWith("actions/workflows/ci.yml/runs?")) return { workflow_runs: state.runs }
        if (path === "actions/workflows/ci.yml/dispatches") return undefined
        throw new Error(`Unexpected request: ${path}`)
    }
    return { input, state, api }
}

const writes = (state) => state.calls.filter(({ options }) => options.method)

test("The writer adds only the planned note to the observed head and dispatches Check", async () => {
    const { state, api } = provider()
    const result = await addDependencyChangeset({ repository, number: 9, api })
    assert.equal(result.head, commit)
    const calls = writes(state)
    assert.deepEqual(calls.map(({ path }) => path), [
        "git/trees", "git/commits", "git/refs/heads/dependabot%2Fnpm_and_yarn%2Fprojects%2Fsdk-runtime-example", "actions/workflows/ci.yml/dispatches",
    ])
    assert.equal(calls[0].options.input.base_tree, tree)
    assert.equal(calls[0].options.input.tree.length, 1)
    assert.equal(calls[0].options.input.tree[0].path, "projects/.changeset/runtime-dependencies-9.md")
    assert.deepEqual(calls[1].options.input.parents, [head])
    assert.deepEqual(calls[2].options.input, { sha: commit, force: false })
    assert.equal(calls[3].options.input.ref, "dependabot/npm_and_yarn/projects/sdk-runtime-example")
})

test("Dry-run plans and existing edited or removed notes never write", async () => {
    for (const options of [{ dryRun: true }, { existing: true, edited: true }, { removed: true }]) {
        const { state, api } = provider(options)
        await addDependencyChangeset({ repository, number: 9, api, dryRun: options.dryRun })
        assert.deepEqual(writes(state), [], JSON.stringify(options))
    }
})

test("A rerun resumes Check dispatch after an existing automatic note, without another commit", async () => {
    const { state, api } = provider({ existing: true })
    const result = await addDependencyChangeset({ repository, number: 9, api })
    assert.equal(result.skipped, true)
    assert.deepEqual(writes(state).map(({ path }) => path), ["actions/workflows/ci.yml/dispatches"])
    const alreadyDispatched = provider({ existing: true, dispatched: true })
    await addDependencyChangeset({ repository, number: 9, api: alreadyDispatched.api })
    assert.deepEqual(writes(alreadyDispatched.state), [])
})

test("Concurrent PR or ref updates fail without overwriting a branch or dispatching checks", async () => {
    const raced = provider({ raced: true })
    await assert.rejects(addDependencyChangeset({ repository, number: 9, api: raced.api }), /changed during/)
    assert.equal(writes(raced.state).some(({ path }) => path.startsWith("git/refs/")), false)
    const rejected = provider({ rejectUpdate: true })
    await assert.rejects(addDependencyChangeset({ repository, number: 9, api: rejected.api }), /Concurrent branch/)
    assert.equal(writes(rejected.state).some(({ path }) => path.includes("dispatches")), false)
    assert.equal(rejected.state.current, head)
})

test("An unconfirmed commit acknowledgement never reaches a branch update", async () => {
    const { state, api } = provider()
    const broken = (path, options) => path === "git/commits" ? Promise.resolve({}) : api(path, options)
    await assert.rejects(addDependencyChangeset({ repository, number: 9, api: broken }), /commit acknowledgement/)
    assert.equal(writes(state).some(({ path }) => path.startsWith("git/refs/")), false)
})

test("Renaming another file into the automatic note path cannot hide a mixed change", async () => {
    const { api, state } = provider()
    const renamed = (path, options) => path.startsWith("pulls/9/files?")
        ? Promise.resolve([
            { filename: "projects/sdk/package.json", status: "modified" },
            { filename: "projects/.changeset/runtime-dependencies-9.md", status: "renamed", previous_filename: ".github/workflows/ci.yml" },
        ])
        : api(path, options)
    assert.equal((await addDependencyChangeset({ repository, number: 9, api: renamed })).skipped, true)
    assert.deepEqual(writes(state), [])
})

function checkedProvider(options) {
    const original = provider(options)
    const run = {
        event: "pull_request", status: "completed", conclusion: "success",
        repository: { full_name: repository }, head_repository: { full_name: repository },
        path: ".github/workflows/ci.yml", head_sha: head, head_branch: original.input.pull.head.ref,
    }
    const pulls = [structuredClone(original.input.pull)]
    const api = (path, options) => {
        if (path === "actions/runs/90") return Promise.resolve(run)
        if (path === `commits/${head}/pulls?per_page=100`) return Promise.resolve(pulls)
        return original.api(path, options)
    }
    return { ...original, run, pulls, api }
}

test("A completed Check for the exact current runtime PR reaches the constrained writer", async () => {
    const { api, state } = checkedProvider()
    const result = await dependencyChangesetForCheck({ repository, runId: 90, api })
    assert.equal(result.head, commit)
    assert.equal(writes(state).at(-1).path, "actions/workflows/ci.yml/dispatches")
})

test("Forks, failed or unfinished runs, dispatches and other workflows never reach the writer", async () => {
    const changes = [
        (run) => { run.head_repository.full_name = "attacker/Fluxerly.js" },
        (run) => { run.repository.full_name = "other/Fluxerly.js" },
        (run) => { run.conclusion = "failure" },
        (run) => { run.status = "in_progress" },
        (run) => { run.event = "workflow_dispatch" },
        (run) => { run.path = ".github/workflows/other.yml" },
        (run) => { run.head_branch = "dependabot/npm_and_yarn/projects/npm-example" },
        (run) => { run.head_sha = "invalid" },
    ]
    for (const change of changes) {
        const { api, run, state } = checkedProvider()
        change(run)
        assert.equal((await dependencyChangesetForCheck({ repository, runId: 90, api })).skipped, true)
        assert.deepEqual(state.calls, [])
    }
})

test("Stale heads, closed or ambiguous PRs preserve branches without a note", async () => {
    for (const kind of ["stale", "closed", "ambiguous"]) {
        const { api, input, pulls, state } = checkedProvider()
        if (kind === "stale") input.pull.head.sha = "e".repeat(40)
        if (kind === "closed") pulls[0].state = "closed"
        if (kind === "ambiguous") pulls.push({ ...structuredClone(pulls[0]), number: 10 })
        assert.equal((await dependencyChangesetForCheck({ repository, runId: 90, api })).skipped, true)
        assert.deepEqual(writes(state), [], kind)
    }
})

test("A partial branch update resumes only Check dispatch for the exact automatic note child", async () => {
    const { api, input, pulls, state } = checkedProvider({ existing: true })
    input.pull.head.sha = commit
    pulls[0].head.sha = commit
    state.current = commit
    const recovered = (path, options) => {
        if (path === `git/commits/${commit}`)
            return Promise.resolve({ message: "Record SDK runtime dependency updates", parents: [{ sha: head }] })
        if (path === `compare/${head}...${commit}`)
            return Promise.resolve({ files: [{ filename: "projects/.changeset/runtime-dependencies-9.md", status: "added" }] })
        return api(path.replace(`?ref=${commit}`, `?ref=${head}`), options)
    }
    await dependencyChangesetForCheck({ repository, runId: 90, api: recovered })
    assert.deepEqual(writes(state).map(({ path }) => path), ["actions/workflows/ci.yml/dispatches"])
})

test("Recovery rejects source edits and commits that are not the sole automatic note child", async () => {
    for (const kind of ["source", "parent", "message", "rename", "edited-note"]) {
        const { api, input, pulls, state } = checkedProvider({ existing: true, edited: kind === "edited-note" })
        input.pull.head.sha = commit
        pulls[0].head.sha = commit
        state.current = commit
        const recovered = (path, options) => {
            if (path === `git/commits/${commit}`)
                return Promise.resolve({
                    message: kind === "message" ? "Unrelated commit" : "Record SDK runtime dependency updates\n",
                    parents: [{ sha: kind === "parent" ? base : head }],
                })
            if (path === `compare/${head}...${commit}`)
                return Promise.resolve({ files: [{
                    filename: kind === "source" ? "projects/sdk/src/index.ts" : "projects/.changeset/runtime-dependencies-9.md",
                    status: kind === "rename" ? "renamed" : "added",
                }] })
            return api(path.replace(`?ref=${commit}`, `?ref=${head}`), options)
        }
        assert.equal((await dependencyChangesetForCheck({ repository, runId: 90, api: recovered })).skipped, true, kind)
        assert.deepEqual(writes(state), [], kind)
    }
})
