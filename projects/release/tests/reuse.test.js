import assert from "node:assert/strict"
import test from "node:test"
import { findReusableCheck, lookupOutputs, parseScope } from "../reuse.js"

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
        workflow_id: 77,
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

// What the certificate job says when the run is in the state its listing shows, at the time the listing says it finished
const derive = (entry) => ({
    attempt: entry.run_attempt,
    runStatus: entry.status,
    job:
        entry.status === "completed"
            ? { status: "completed", conclusion: entry.conclusion, completed_at: entry.updated_at }
            : { status: entry.status, conclusion: null, completed_at: null },
})
// A certificate that finished with this result while the run itself may be in any state
const certificate = (conclusion, completedAt, runStatus = "in_progress") => ({
    attempt: 1,
    runStatus,
    job: { status: "completed", conclusion, completed_at: completedAt },
})
// A run that holds no such job, such as one from before the certificate existed
const historical = { attempt: 1, runStatus: "completed", job: null }

function lookup(inventories, options = {}) {
    const { certificates = {}, ...rest } = options
    let clock = 0
    const listed = []
    const reads = []
    return {
        listed,
        reads,
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
            readCertificate: async (entry, deadline) => {
                reads.push({ id: entry.id, deadline })
                const given = certificates[entry.id]
                return typeof given === "function" ? given(entry) : (given ?? derive(entry))
            },
            now: () => clock,
            sleep: async (ms) => {
                clock += ms
            },
            ...rest,
        }),
    }
}
const reference = (runId, runAttempt = 1) => ({ runId, runAttempt, runUrl: `https://github.com/owner/repo/actions/runs/${runId}` })

test("A passing run for the same tree is reused, even from another commit", async () => {
    const { result } = lookup([[run(7, { event: "push" }), run(9)]])
    assert.deepEqual(await result, reference(9))
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
    const found = lookup([unrelated])
    assert.equal(await found.result, null)
    assert.deepEqual(found.reads, [], "No certificate is read for a run that is not evidence")
    // Another workflow with the same path is not the active Check workflow either
    assert.equal(await lookup([[run(8, { workflow_id: 99 })]], { workflowId: 77 }).result, null)
    assert.deepEqual(await lookup([[run(8)]], { workflowId: 77 }).result, reference(8))
})

test("The newest conclusive matching run decides, and a failure forces the checks to run", async () => {
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

test("The certificate, not the run, decides: A run that is still going or red elsewhere is reused when its certificate passed", async () => {
    for (const unrelated of [{ status: "in_progress", conclusion: null }, { status: "queued", conclusion: null }, { status: "completed", conclusion: "failure" }]) {
        const entry = run(8, unrelated)
        const found = lookup([[entry]], { scope: "npm", certificates: { 8: certificate("success", timestamp(9), unrelated.status) } })
        assert.deepEqual(await found.result, reference(8), JSON.stringify(unrelated))
        assert.equal(found.listed.length, 1, "A passed certificate is not awaited for the rest of the run")
    }
    // The decision belongs to the scope: A red certificate in a run whose workflow passed is not reused
    assert.equal(await lookup([[run(8)]], { scope: "check", certificates: { 8: certificate("failure", timestamp(9), "completed") } }).result, null)
})

test("A failed certificate of the scope blocks an older success, and a passing one of another scope does not help", async () => {
    const older = run(5)
    const newer = run(8)
    const certificates = (conclusion) => ({ 5: certificate("success", timestamp(6), "completed"), 8: certificate(conclusion, timestamp(9), "completed") })
    for (const scope of ["npm", "check"]) {
        assert.equal(await lookup([[older, newer]], { scope, certificates: certificates("failure") }).result, null, scope)
        assert.equal(await lookup([[older, newer]], { scope, certificates: certificates("timed_out") }).result, null, scope)
        assert.equal((await lookup([[older, newer]], { scope, certificates: certificates("cancelled") }).result)?.runId, 5, scope)
        assert.equal((await lookup([[older, newer]], { scope, certificates: certificates("skipped") }).result)?.runId, 5, scope)
        assert.equal((await lookup([[older, newer]], { scope, certificates: certificates("success") }).result)?.runId, 8, scope)
    }
    // The two scopes are separate lookups: The reader is asked for the scope's own job
    const asked = []
    const found = lookup([[older]], { scope: "npm", readCertificate: async (entry) => (asked.push(entry.id), derive(entry)) })
    await found.result
    assert.deepEqual(asked, [5])
    await assert.rejects(
        findReusableCheck({ tree, runId: 1, runStartedAt: timestamp(1), repository, listRuns: async () => ({ workflow_runs: [] }), readCertificate: async () => historical, scope: "website" }),
        /scope is not recognized/,
    )
})

test("A run from before the certificate existed never counts, whatever its workflow concluded", async () => {
    assert.equal(await lookup([[run(5)]], { scope: "npm", certificates: { 5: historical } }).result, null)
    // It is skipped, so an older run that does hold a passing certificate can still decide
    const found = lookup([[run(5), run(8)]], { scope: "npm", certificates: { 5: certificate("success", timestamp(6), "completed"), 8: historical } })
    assert.equal((await found.result)?.runId, 5)
    // A failed certificate in a run is not hidden by the missing one of a newer run
    const failed = lookup([[run(5), run(8)]], { scope: "npm", certificates: { 5: certificate("failure", timestamp(6), "completed"), 8: historical } })
    assert.equal(await failed.result, null)
    // A finished run cannot hold a certificate that never finished
    await assert.rejects(lookup([[run(5)]], { certificates: { 5: { attempt: 1, runStatus: "completed", job: { status: "in_progress", conclusion: null, completed_at: null } } } }).result, /did not finish/)
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

test("An unfinished matching certificate is awaited and then reused instead of repeated", async () => {
    const { result, listed } = lookup([[run(8, { status: "in_progress", conclusion: null })], [run(8)]])
    assert.equal((await result)?.runId, 8)
    assert.equal(listed.length, 2)
    // A certificate that is queued or missing in a run that started earlier is awaited until it finishes
    let reads = 0
    const waiting = lookup([[run(8, { status: "in_progress", conclusion: null })]], {
        scope: "npm",
        certificates: { 8: () => (++reads < 3 ? { attempt: 1, runStatus: "in_progress", job: reads === 1 ? null : { status: "queued", conclusion: null } } : certificate("success", timestamp(9))) },
    })
    assert.equal((await waiting.result)?.runId, 8)
    assert.equal(waiting.listed.length, 3)
})

test("Completed newer-ID runs are evidence even when the current run predates them", async () => {
    assert.equal((await lookup([[run(101)]]).result)?.runId, 101)
})

test("Equal completion timestamps cannot hide a failure behind a successful higher-ID run", async () => {
    assert.equal(await lookup([[run(8), run(5, { conclusion: "failure", updated_at: run(8).updated_at })]]).result, null)
    const certificates = { 8: certificate("success", timestamp(9), "completed"), 5: certificate("failure", timestamp(9), "completed") }
    assert.equal(await lookup([[run(8), run(5)]], { scope: "npm", certificates }).result, null)
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
    await assert.rejects(lookup([[run(8)]], { certificates: { 8: certificate("success", null, "completed") } }).result, /completion time/)
})

test("A matching run that outlasts the wait bound leaves the checks to run", async () => {
    const { result, listed } = lookup([[run(8, { status: "queued", conclusion: null })]], { waitMs: 90_000 })
    assert.equal(await result, null)
    assert.ok(listed.length > 1 && listed.length < 10)
})

test("A settled certificate is read once, while a rerun or an unfinished one is read again", async () => {
    // Run 8 finishes on the second look. Run 5 was settled on the first and needs no new read
    const found = lookup([[run(5), run(8, { status: "in_progress", conclusion: null })], [run(5), run(8)]])
    assert.equal((await found.result)?.runId, 8)
    assert.deepEqual(found.reads.map(({ id }) => id), [5, 8, 8])
    // The deadline reaches the reader, so its reads share the lookup's bound
    assert.ok(found.reads.every(({ deadline }) => deadline === 40 * 60_000))
    // An attempt the listing did not show means the listing is stale: The evidence is not kept
    const stale = lookup([[run(5), run(8, { status: "in_progress", conclusion: null })], [run(5), run(8)]], {
        certificates: { 5: { ...certificate("success", timestamp(6), "completed"), attempt: 2 } },
    })
    await stale.result
    assert.equal(stale.reads.filter(({ id }) => id === 5).length, 2)
})

test("A reuse reports the attempt whose certificate was read", async () => {
    const found = lookup([[run(8)]], { certificates: { 8: { ...certificate("success", timestamp(9), "completed"), attempt: 3 } } })
    assert.deepEqual(await found.result, reference(8, 3))
})

test("An invalid inventory, unreadable certificate or missing identity is an error, which the caller treats as no reuse", async () => {
    const options = { tree, runId: 1, runStartedAt: timestamp(1), repository, readCertificate: async () => historical }
    await assert.rejects(findReusableCheck({ ...options, listRuns: async () => ({}) }), /inventory is invalid/)
    await assert.rejects(findReusableCheck({ ...options, tree: "HEAD", listRuns: async () => ({ workflow_runs: [] }) }), /git tree SHA/)
    await assert.rejects(lookup([[run(8)]], { certificates: { 8: () => { throw new Error("Jobs unavailable") } } }).result, /Jobs unavailable/)
})

test("The command line takes a closed scope and the outputs carry complete references", () => {
    assert.equal(parseScope([]), "check")
    assert.equal(parseScope(["--scope", "npm"]), "npm")
    for (const args of [["--scope"], ["--scope", "website"], ["npm"], ["--scope", "npm", "extra"], ["--scope=npm"]])
        assert.throws(() => parseScope(args), /supported|recognized/, args.join(" "))
    const outputs = (lookupResult) => Object.fromEntries(lookupOutputs({ scope: "npm", tree, ...lookupResult }).trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
    assert.deepEqual(outputs({ result: reference(9, 2), parent: null }), {
        scope: "npm", reused: "true", run_id: "9", run_attempt: "2", run_url: "https://github.com/owner/repo/actions/runs/9", tree,
        version_only: "false", parent_run_id: "", parent_run_attempt: "", parent_run_url: "",
    })
    assert.deepEqual(outputs({ result: null, parent: reference(4, 1) }), {
        scope: "npm", reused: "false", run_id: "", run_attempt: "", run_url: "", tree,
        version_only: "true", parent_run_id: "4", parent_run_attempt: "1", parent_run_url: "https://github.com/owner/repo/actions/runs/4",
    })
    assert.equal(outputs({ result: null, parent: null }).reused, "false")
})
