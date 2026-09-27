import assert from "node:assert/strict"
import test from "node:test"
import { findReusableCheck } from "../reuse.js"

const repository = "owner/repo"
const tree = "a".repeat(40)

function run(id, overrides = {}) {
    const sha = String(id).padStart(40, "0")
    return {
        id,
        path: ".github/workflows/ci.yml",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        head_sha: sha,
        head_commit: { id: sha, tree_id: tree },
        repository: { full_name: repository },
        head_repository: { full_name: repository },
        ...overrides,
    }
}

function lookup(inventories, options = {}) {
    let clock = 0
    const listed = []
    return {
        listed,
        result: findReusableCheck({
            tree,
            runId: 100,
            repository,
            listRuns: async () => {
                const next = inventories[Math.min(listed.length, inventories.length - 1)]
                listed.push(next)
                return { workflow_runs: next }
            },
            now: () => clock,
            sleep: async (ms) => {
                clock += ms
            },
            ...options,
        }),
    }
}

test("A passing run for the same tree is reused, even from another commit", async () => {
    const { result } = lookup([[run(7, { event: "push" }), run(9)]])
    assert.deepEqual(await result, { runId: 9, runUrl: "https://github.com/owner/repo/actions/runs/9" })
})

test("Runs that did not check this tree in this repository are not evidence", async () => {
    const other = { full_name: "fork/repo" }
    const unrelated = [
        run(1, { head_commit: { id: run(1).head_sha, tree_id: "b".repeat(40) } }),
        // A pull_request run checked a merge commit, not its recorded head tree
        run(2, { event: "pull_request" }),
        run(3, { head_repository: other }),
        run(4, { repository: other }),
        run(5, { path: ".github/workflows/other.yml" }),
        run(6, { head_commit: { id: "f".repeat(40), tree_id: tree } }),
        run(100),
        run(101),
    ]
    assert.equal(await lookup([unrelated]).result, null)
})

test("The newest conclusive matching run decides, and a failure forces the full Check", async () => {
    assert.equal(await lookup([[run(5), run(8, { conclusion: "failure" })]]).result, null)
    const cancelled = await lookup([[run(5), run(8, { conclusion: "cancelled" })]]).result
    assert.equal(cancelled?.runId, 5)
})

test("An unfinished matching run is awaited and then reused instead of repeated", async () => {
    const { result, listed } = lookup([[run(8, { status: "in_progress", conclusion: null })], [run(8)]])
    assert.equal((await result)?.runId, 8)
    assert.equal(listed.length, 2)
})

test("A matching run that outlasts the wait bound leaves the full Check to run", async () => {
    const { result, listed } = lookup([[run(8, { status: "queued", conclusion: null })]], { waitMs: 90_000 })
    assert.equal(await result, null)
    assert.ok(listed.length > 1 && listed.length < 10)
})

test("An invalid inventory or missing identity is an error, which the caller treats as no reuse", async () => {
    await assert.rejects(findReusableCheck({ tree, runId: 1, repository, listRuns: async () => ({}) }))
    await assert.rejects(findReusableCheck({ tree: "HEAD", runId: 1, repository, listRuns: async () => ({ workflow_runs: [] }) }))
})
