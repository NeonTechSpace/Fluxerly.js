import assert from "node:assert/strict"
import test from "node:test"
import { certificateName, certificates, readJobs, readRunCertificate, selectCertificate } from "../check-evidence.js"

const headSha = "a".repeat(40)
const runId = 456
const workflowPath = ".github/workflows/ci.yml"
const repository = "owner/repo"
const job = (id, name, overrides = {}) => ({
    id, run_id: runId, head_sha: headSha, name, status: "completed", conclusion: "success", completed_at: "2026-11-04T00:00:00Z", ...overrides,
})
const run = (overrides = {}) => ({
    id: runId, head_sha: headSha, path: workflowPath, run_attempt: 1, status: "in_progress",
    repository: { full_name: repository }, head_repository: { full_name: repository }, ...overrides,
})
const pagePath = (attempt, page) => `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`

// A fake API whose answers come from tables, with a clock that moves only when a read takes time
function api({ jobs = {}, runs = [run()], readTime = 0 } = {}) {
    let time = 0
    let metaReads = 0
    const reads = []
    return {
        reads,
        now: () => time,
        advance: (ms) => { time += ms },
        read: async (path) => {
            reads.push(path)
            time += readTime
            if (path === `actions/runs/${runId}`) return runs[Math.min(metaReads++, runs.length - 1)]
            const answer = jobs[path]
            if (answer === undefined) throw new Error(`Unexpected read ${path}`)
            if (answer instanceof Error) throw answer
            return answer
        },
    }
}
const inventory = (list, total = list.length) => ({ total_count: total, jobs: list })
const certify = (fake, scope = "npm", extra = {}) =>
    readRunCertificate({ scope, runId, attempt: 1, headSha, read: fake.read, now: fake.now, deadline: 60_000, repository, workflowPath, ...extra })

test("The scope table is closed to the two certificates and rejects every other name", () => {
    assert.deepEqual({ ...certificates }, { npm: "npm release checks", check: "check" })
    assert.equal(certificateName("npm"), "npm release checks")
    assert.equal(certificateName("check"), "check")
    for (const scope of ["", "NPM", "website", "toString", "__proto__", "constructor", undefined, null, 1, ["npm"]])
        assert.throws(() => certificateName(scope), /scope is not recognized/, String(scope))
    assert.throws(() => selectCertificate([], "website"), /scope is not recognized/)
})

test("The exact attempt's jobs are read and only the selected certificate decides", async () => {
    const fake = api({ jobs: { [pagePath(1, 1)]: inventory([job(1, "SDK checks", { conclusion: "failure" }), job(2, "npm release checks"), job(3, "check", { conclusion: "failure" })]) } })
    const npm = await certify(fake)
    assert.equal(npm.job.id, 2)
    assert.equal(npm.attempt, 1)
    assert.equal(npm.runStatus, "in_progress")
    assert.equal((await certify(api({ jobs: { [pagePath(1, 1)]: inventory([job(3, "check", { conclusion: "failure" })]) } }), "check")).job.conclusion, "failure")
    // The latest-jobs endpoint and other attempts are never read
    assert.deepEqual(fake.reads, [pagePath(1, 1), `actions/runs/${runId}`])
})

test("A certificate on the second page is found, and every page must agree on the inventory", async () => {
    const filler = Array.from({ length: 100 }, (_, index) => job(1000 + index, `Matrix job ${index}`))
    const fake = api({ jobs: { [pagePath(1, 1)]: inventory(filler, 101), [pagePath(1, 2)]: inventory([job(2, "npm release checks")], 101) } })
    assert.equal((await certify(fake)).job.id, 2)
    assert.deepEqual(fake.reads, [pagePath(1, 1), pagePath(1, 2), `actions/runs/${runId}`])
    const contradictory = api({ jobs: { [pagePath(1, 1)]: inventory(filler, 101), [pagePath(1, 2)]: inventory([job(2, "npm release checks")], 102) } })
    await assert.rejects(certify(contradictory), /changed between pages/)
})

test("Incomplete, oversized, duplicated and malformed inventories are rejected", async () => {
    const cases = [
        [{ [pagePath(1, 1)]: {} }, /incomplete or invalid/],
        [{ [pagePath(1, 1)]: { total_count: "1", jobs: [] } }, /incomplete or invalid/],
        [{ [pagePath(1, 1)]: { total_count: -1, jobs: [] } }, /incomplete or invalid/],
        [{ [pagePath(1, 1)]: inventory([job(2, "npm release checks")], 2) }, /incomplete or invalid/],
        [{ [pagePath(1, 1)]: inventory([], 1) }, /incomplete or invalid/],
        [{ [pagePath(1, 1)]: inventory([job(2, "npm release checks")], 1001) }, /incomplete or invalid/],
        [{ [pagePath(1, 1)]: inventory([job(2, "npm release checks"), job(3, "SDK checks")], 1) }, /more jobs than it declares/],
        [{ [pagePath(1, 1)]: inventory([job(2, "npm release checks"), job(2, "SDK checks")]) }, /repeats a job/],
        [{ [pagePath(1, 1)]: inventory([job(2, "npm release checks"), job(3, "npm release checks")]) }, /more than one npm release checks job/],
        [{ [pagePath(1, 1)]: inventory([job(2, "npm release checks", { run_id: 999 })]) }, /does not match/],
        [{ [pagePath(1, 1)]: inventory([job(2, "npm release checks", { head_sha: "b".repeat(40) })]) }, /does not match/],
        [{ [pagePath(1, 1)]: inventory([job(2, "npm release checks", { run_attempt: 2 })]) }, /does not match/],
        [{ [pagePath(1, 1)]: inventory([job(0, "npm release checks")]) }, /does not match/],
        [{ [pagePath(1, 1)]: inventory([job(2, "")]) }, /does not match/],
        [{ [pagePath(1, 1)]: inventory([job(2, "npm release checks", { status: "mystery" })]) }, /state is not recognized/],
        [{ [pagePath(1, 1)]: inventory([job(2, "npm release checks", { conclusion: null })]) }, /state is not recognized/],
    ]
    for (const [jobs, reason] of cases) await assert.rejects(certify(api({ jobs })), reason)
})

test("The largest inventory is read to its last page, and no inventory is read past the bound", async () => {
    const full = (page) => Array.from({ length: 100 }, (_, index) => job(page * 1000 + index, `Matrix job ${page}-${index}`))
    const jobs = {}
    for (let page = 1; page <= 10; page++) jobs[pagePath(1, page)] = inventory(page === 10 ? [...full(page).slice(1), job(2, "npm release checks")] : full(page), 1000)
    const fake = api({ jobs })
    assert.equal((await certify(fake)).job.id, 2)
    assert.equal(fake.reads.length, 11)
    // A declared total above the bound is refused before a second page is read
    const oversized = api({ jobs: { [pagePath(1, 1)]: inventory(full(1), 1001) } })
    await assert.rejects(certify(oversized), /incomplete or invalid/)
    assert.deepEqual(oversized.reads, [pagePath(1, 1)])
})

test("A complete inventory without the certificate reports no certificate instead of guessing", async () => {
    const fake = api({ jobs: { [pagePath(1, 1)]: inventory([job(1, "SDK checks"), job(3, "check")]) } })
    assert.equal((await certify(fake)).job, null)
    assert.equal((await certify(api({ jobs: { [pagePath(1, 1)]: inventory([]) } }))).job, null)
})

test("A rerun that starts while the jobs are read discards the old certificate and reads the new attempt", async () => {
    const fake = api({
        jobs: {
            [pagePath(1, 1)]: inventory([job(2, "npm release checks")]),
            [pagePath(2, 1)]: inventory([job(12, "npm release checks", { conclusion: "failure", run_attempt: 2 })]),
        },
        runs: [run({ run_attempt: 2 }), run({ run_attempt: 2 })],
    })
    const result = await certify(fake)
    assert.equal(result.attempt, 2)
    assert.equal(result.job.conclusion, "failure")
    assert.deepEqual(fake.reads, [pagePath(1, 1), `actions/runs/${runId}`, pagePath(2, 1), `actions/runs/${runId}`])
    // Attempts never go back, and a run that keeps changing is not evidence
    await assert.rejects(certify(api({ jobs: { [pagePath(2, 1)]: inventory([job(2, "npm release checks")]) }, runs: [run({ run_attempt: 1 })] }), "npm", { attempt: 2 }), /could not be verified/)
    const jobs = {}
    const runs = []
    for (let attempt = 1; attempt <= 8; attempt++) {
        jobs[pagePath(attempt, 1)] = inventory([job(attempt, "npm release checks")])
        runs.push(run({ run_attempt: attempt + 1 }))
    }
    jobs[pagePath(9, 1)] = inventory([job(9, "npm release checks")])
    await assert.rejects(certify(api({ jobs, runs })), /kept changing attempts/)
})

test("A run whose identity changes during the read is rejected", async () => {
    const jobs = { [pagePath(1, 1)]: inventory([job(2, "npm release checks")]) }
    for (const patch of [
        { id: 1 }, { head_sha: "b".repeat(40) }, { path: ".github/workflows/other.yml" },
        { repository: { full_name: "other/repo" } }, { head_repository: { full_name: "other/repo" } },
    ])
        await assert.rejects(certify(api({ jobs, runs: [run(patch)] })), /changed identity/)
    for (const patch of [{ run_attempt: 0 }, { run_attempt: "1" }, { status: undefined }])
        await assert.rejects(certify(api({ jobs, runs: [run(patch)] })), /could not be verified/)
})

test("Invalid arguments fail before any read", async () => {
    const fake = api()
    for (const patch of [{ scope: "website" }, { runId: 0 }, { attempt: 1.5 }, { headSha: "main" }])
        await assert.rejects(certify(fake, "npm", patch))
    assert.deepEqual(fake.reads, [])
})

test("The deadline bounds every read, and a slow read cannot return a late certificate", async () => {
    const jobs = { [pagePath(1, 1)]: inventory([job(2, "npm release checks")]) }
    // Each read takes a minute against a deadline of one minute
    await assert.rejects(certify(api({ jobs, readTime: 60_000 })), /timed out/)
    // The inventory is read in time but the run re-read would start late
    await assert.rejects(certify(api({ jobs, readTime: 30_000 }), "npm", { deadline: 30_000 }), /timed out/)
    const expired = api({ jobs })
    await assert.rejects(certify(expired, "npm", { deadline: 0 }), /timed out/)
    assert.deepEqual(expired.reads, [])
    await assert.rejects(readJobs({ read: expired.read, runId, attempt: 1, headSha, now: expired.now, deadline: 0 }), /timed out/)
})

test("API failures surface as errors and never as a missing certificate", async () => {
    await assert.rejects(certify(api({ jobs: { [pagePath(1, 1)]: new Error("Unavailable") } })), /Unavailable/)
    await assert.rejects(certify(api({ jobs: { [pagePath(1, 1)]: inventory([job(2, "npm release checks")]) }, runs: [undefined] })), /changed identity/)
})
