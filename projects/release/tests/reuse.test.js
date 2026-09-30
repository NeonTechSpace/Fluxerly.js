import assert from "node:assert/strict"
import test from "node:test"
import { findReusableCheck } from "../reuse.js"

const repository = "owner/repo"
const tree = "a".repeat(40)
const timestamp = (seconds) => new Date(Date.UTC(2026, 8, 30, 0, 0, seconds)).toISOString()

function run(id, overrides = {}) {
    const sha = String(id).padStart(40, "0")
    return {
        id,
        run_attempt: 1,
        created_at: timestamp(id),
        run_started_at: timestamp(id),
        updated_at: timestamp(id + 1),
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
            runStartedAt: timestamp(100),
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
    ]
    assert.equal(await lookup([unrelated]).result, null)
})

test("The newest conclusive matching run decides, and a failure forces the full Check", async () => {
    assert.equal(await lookup([[run(5), run(8, { conclusion: "failure" })]]).result, null)
    const cancelled = await lookup([[run(5), run(8, { conclusion: "cancelled" })]]).result
    assert.equal(cancelled?.runId, 5)
})

test("Rerunning an older run cannot reuse success before a newer matching failure", async () => {
    const { result } = lookup([[run(90), run(101, { conclusion: "failure" }), run(100, { run_attempt: 2 })]], {
        runStartedAt: timestamp(110),
    })
    assert.equal(await result, null)
})

test("Completion time, not run ID, selects the newest conclusive result after reruns", async () => {
    const rerun = run(80, { run_attempt: 2, run_started_at: timestamp(110), updated_at: timestamp(120) })
    assert.equal((await lookup([[rerun, run(90, { conclusion: "failure" })]]).result)?.runId, 80)
    assert.equal(await lookup([[{ ...rerun, conclusion: "failure" }, run(90)]]).result, null)
})

test("An older run's later attempt is not awaited, and two runs never wait for each other", async () => {
    const older = run(90, { status: "in_progress", conclusion: null, run_attempt: 2, run_started_at: timestamp(110) })
    const earlier = lookup([[run(80), older]], { runStartedAt: timestamp(100), waitMs: 30_000 })
    assert.equal((await earlier.result)?.runId, 80)
    assert.equal(earlier.listed.length, 1)
    const newer = lookup([[run(100, { status: "in_progress", conclusion: null }), run(101)]], {
        runId: 90,
        runStartedAt: timestamp(110),
        waitMs: 30_000,
    })
    assert.equal(await newer.result, null)
    assert.equal(newer.listed.length, 2)
})

test("An unfinished matching run is awaited and then reused instead of repeated", async () => {
    const { result, listed } = lookup([[run(8, { status: "in_progress", conclusion: null })], [run(8)]])
    assert.equal((await result)?.runId, 8)
    assert.equal(listed.length, 2)
})

test("Completed newer-ID runs are evidence even when the current run predates them", async () => {
    assert.equal((await lookup([[run(101)]]).result)?.runId, 101)
})

test("Equal completion timestamps cannot hide a failure behind a successful higher-ID run", async () => {
    assert.equal(await lookup([[run(8), run(5, { conclusion: "failure", updated_at: run(8).updated_at })]]).result, null)
})

test("A queued first attempt uses creation time, while equal starts never wait for each other", async () => {
    const first = lookup([[run(8, { status: "queued", conclusion: null, run_started_at: null })], [run(8)]])
    assert.equal((await first.result)?.runId, 8)
    assert.equal(first.listed.length, 2)
    const simultaneous = lookup([[run(8, { status: "in_progress", conclusion: null, run_started_at: timestamp(100) })]])
    assert.equal(await simultaneous.result, null)
    assert.equal(simultaneous.listed.length, 1)
})

test("Missing completion or current-attempt start evidence leaves reuse unverified", async () => {
    await assert.rejects(lookup([[run(8, { updated_at: "invalid" })]]).result)
    await assert.rejects(lookup([[run(8, { status: "queued", conclusion: null, run_attempt: 2, run_started_at: null })]]).result)
    await assert.rejects(lookup([[run(8)]], { runStartedAt: "invalid" }).result)
})

test("A matching run that outlasts the wait bound leaves the full Check to run", async () => {
    const { result, listed } = lookup([[run(8, { status: "queued", conclusion: null })]], { waitMs: 90_000 })
    assert.equal(await result, null)
    assert.ok(listed.length > 1 && listed.length < 10)
})

test("An invalid inventory or missing identity is an error, which the caller treats as no reuse", async () => {
    const options = { tree, runId: 1, runStartedAt: timestamp(1), repository }
    await assert.rejects(findReusableCheck({ ...options, listRuns: async () => ({}) }), /inventory is invalid/)
    await assert.rejects(findReusableCheck({ ...options, tree: "HEAD", listRuns: async () => ({ workflow_runs: [] }) }), /git tree SHA/)
})
