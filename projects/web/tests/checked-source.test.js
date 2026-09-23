import assert from "node:assert/strict"
import test from "node:test"
import { requireCheckedSource } from "../scripts/checked-source.js"

const source = "a".repeat(40)
const workflow = { id: 123, path: ".github/workflows/ci.yml", state: "active" }
const run = {
    id: 456, workflow_id: 123, path: workflow.path, head_sha: source,
    head_branch: "main", event: "push", repository: { full_name: "NeonTechSpace/Fluxerly.js" },
    head_repository: { full_name: "NeonTechSpace/Fluxerly.js" }, run_attempt: 1,
    status: "completed", conclusion: "success",
}
const inventory = (runs) => ({ total_count: runs.length, workflow_runs: runs })
function fixture(responses = [inventory([run])], options = {}) {
    let time = 0, index = 0
    const reads = [], progress = [], sleeps = []
    const io = {
        now: () => time,
        sleep: async (ms) => { sleeps.push(ms); time += ms },
        progress: (message) => progress.push(message),
        read: async (path, timeout) => {
            reads.push({ path, timeout })
            if (reads.length === 1) return options.workflow ?? workflow
            time += options.readTime ?? 0
            return responses[Math.min(index++, responses.length - 1)]
        },
    }
    return { io, reads, progress, sleeps }
}

test("Exact-source CI reuse verifies workflow, repository, branch, source and current attempt", async () => {
    const f = fixture([inventory([{ ...run, run_attempt: 2 }])])
    assert.deepEqual(await requireCheckedSource(source, f.io), {
        sourceCommit: source, runId: run.id, runAttempt: 2,
        runUrl: "https://github.com/NeonTechSpace/Fluxerly.js/actions/runs/456",
    })
    assert.equal(f.reads.length, 2)
    assert.match(f.reads[1].path, new RegExp(`head_sha=${source}&branch=main&event=push&per_page=100$`))
    assert.doesNotMatch(f.reads[1].path, /status=success/)
    assert.deepEqual(f.sleeps, [])
})

test("CI reuse cannot select a passing result from another identity or source", async () => {
    for (const patch of [
        { workflow_id: 999 }, { path: ".github/workflows/other.yml" },
        { head_sha: "b".repeat(40) }, { head_branch: "other" }, { event: "pull_request" },
        { repository: { full_name: "other/repo" } }, { head_repository: { full_name: "other/repo" } },
        { run_attempt: 0 }, { id: -1 },
    ]) {
        const f = fixture([inventory([{ ...run, ...patch }])])
        await assert.rejects(requireCheckedSource(source, f.io), /identity|match/)
        assert.deepEqual(f.sleeps, [])
    }
})

test("Failed, cancelled, skipped or unknown completed CI results fail immediately", async () => {
    for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "timed_out", null]) {
        const f = fixture([inventory([{ ...run, conclusion }])])
        await assert.rejects(requireCheckedSource(source, f.io), /did not pass/)
        assert.deepEqual(f.sleeps, [])
    }
})

test("The newest matching run wins, even when an older run passed", async () => {
    const f = fixture([inventory([run, { ...run, id: 789, conclusion: "failure" }])])
    await assert.rejects(requireCheckedSource(source, f.io), /789 did not pass/)
    const waiting = fixture([
        inventory([{ ...run, id: 789, status: "in_progress", conclusion: null }, run]),
        inventory([{ ...run, id: 789 }, run]),
    ])
    assert.equal((await requireCheckedSource(source, waiting.io)).runId, 789)
    assert.deepEqual(waiting.sleeps, [20_000])
    assert.match(waiting.progress[0], /789/)
})

test("Pending CI may appear and complete, but missing evidence has a bounded wait", async () => {
    const f = fixture([inventory([]), inventory([{ ...run, status: "queued" }]), inventory([run])])
    await requireCheckedSource(source, f.io)
    assert.deepEqual(f.sleeps, [20_000, 20_000])
    assert.equal(f.progress.length, 2)
    const missing = fixture([inventory([])])
    await assert.rejects(requireCheckedSource(source, missing.io), /timed out/)
    assert.equal(missing.sleeps.reduce((sum, value) => sum + value, 0), 600_000)
    assert.ok(missing.reads.length <= 32)
})

test("Invalid or incomplete inventories and disabled workflows never authorize upload", async () => {
    for (const data of [{}, { total_count: 101, workflow_runs: [run] },
        { total_count: 2, workflow_runs: [run] }, { total_count: -1, workflow_runs: [] }])
        await assert.rejects(requireCheckedSource(source, fixture([data]).io), /inventory/)
    for (const patch of [{ id: 0 }, { path: "other.yml" }, { state: "disabled_manually" }])
        await assert.rejects(requireCheckedSource(source,
            fixture(undefined, { workflow: { ...workflow, ...patch } }).io), /workflow identity/)
    await assert.rejects(requireCheckedSource(source,
        fixture([inventory([{ ...run, status: "unknown" }])]).io), /state is not recognized/)
})

test("Invalid source and deadline-expired evidence cannot be reused", async () => {
    const f = fixture()
    await assert.rejects(requireCheckedSource("main", f.io), /exact checkout/)
    assert.equal(f.reads.length, 0)
    const slow = fixture(undefined, { readTime: 600_000 })
    await assert.rejects(requireCheckedSource(source, slow.io), /timed out/)
    assert.deepEqual(slow.sleeps, [])
})

test("Preparation fallback requires a verified empty inventory, never failed or unreadable evidence", async () => {
    const missing = fixture([inventory([])])
    assert.equal(await requireCheckedSource(source, missing.io, { allowMissing: true }), null)
    assert.deepEqual(missing.sleeps, [])
    for (const data of [inventory([{ ...run, conclusion: "failure" }]), {},
        inventory([run, { ...run, id: 789, conclusion: "cancelled" }])])
        await assert.rejects(requireCheckedSource(source, fixture([data]).io, { allowMissing: true }))
    await assert.rejects(requireCheckedSource(source, { read: async () => { throw new Error("Unavailable") } },
        { allowMissing: true }), /Unavailable/)
    const queued = fixture([inventory([{ ...run, status: "queued", conclusion: null }]), inventory([run])])
    assert.equal((await requireCheckedSource(source, queued.io, { allowMissing: true })).runId, run.id)
    assert.deepEqual(queued.sleeps, [20_000])
})
