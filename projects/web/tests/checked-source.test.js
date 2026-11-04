import assert from "node:assert/strict"
import test from "node:test"
import { parseArguments, readGitHub, requireCheckedSource } from "../scripts/checked-source.js"

const source = "a".repeat(40)
const workflow = { id: 123, path: ".github/workflows/ci.yml", state: "active" }
const run = {
    id: 456, workflow_id: 123, path: workflow.path, head_sha: source,
    head_branch: "main", event: "push", repository: { full_name: "NeonTechSpace/Fluxerly.js" },
    head_repository: { full_name: "NeonTechSpace/Fluxerly.js" }, run_attempt: 1,
    status: "completed", conclusion: "success",
}
const inventory = (runs) => ({ total_count: runs.length, workflow_runs: runs })
const names = { check: "check", npm: "npm release checks" }
// A job of the run with the state a certificate has when the run is in that state, unless a test says otherwise
const ids = new Map()
const certificate = (of, name, patch = {}) => ({
    id: of.id * 1000 + (ids.get(name) ?? ids.set(name, ids.size + 1).get(name)), run_id: of.id, head_sha: source, name,
    status: of.status, conclusion: of.conclusion ?? null, completed_at: "2026-11-04T00:00:00Z", ...patch,
})
const page = (jobs, total = jobs.length) => ({ total_count: total, jobs })

// Answers each request by its path. The Check runs come from `responses` in turn, and the jobs and metadata of a run from
// the run as the latest inventory listed it, unless `options.jobs` or `options.runs` replace them
function fixture(responses = [inventory([run])], options = {}) {
    let time = 0, index = 0
    let latest = []
    const reads = [], progress = [], sleeps = []
    const io = {
        now: () => time,
        sleep: async (ms) => { sleeps.push(ms); time += ms },
        progress: (message) => progress.push(message),
        read: async (path, timeout) => {
            reads.push({ path, timeout })
            if (path.endsWith("/actions/workflows/ci.yml")) return options.workflow ?? workflow
            time += options.readTime ?? 0
            if (path.includes("/runs?head_sha=")) {
                const data = responses[Math.min(index++, responses.length - 1)]
                latest = data.workflow_runs ?? []
                return data
            }
            const jobs = path.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100&page=(\d+)$/)
            if (jobs) {
                const of = latest.find((entry) => entry.id === Number(jobs[1]))
                if (options.jobs) return options.jobs(of, Number(jobs[2]), Number(jobs[3]))
                return page([certificate(of, "SDK checks", { conclusion: "success", status: "completed" }),
                    certificate(of, names.check), certificate(of, names.npm, options.npm?.(of) ?? {})])
            }
            const meta = path.match(/\/actions\/runs\/(\d+)$/)
            if (meta) return (options.runs ?? ((of) => of))(latest.find((entry) => entry.id === Number(meta[1])))
            throw new Error(`Unexpected read ${path}`)
        },
    }
    return { io, reads, progress, sleeps }
}
const kinds = (f) => f.reads.map(({ path }) => path.replace(/^repos\/[^/]+\/[^/]+\/actions\//, "").replace(/[a-f0-9]{40}/, "SHA").replace(/\d+/g, "N"))

test("Exact-source CI reuse verifies workflow, repository, branch, source and current attempt", async () => {
    const f = fixture([inventory([{ ...run, run_attempt: 2 }])])
    assert.deepEqual(await requireCheckedSource(source, f.io), {
        sourceCommit: source, runId: run.id, runAttempt: 2, evidenceScope: "check",
        runUrl: "https://github.com/NeonTechSpace/Fluxerly.js/actions/runs/456",
    })
    assert.deepEqual(kinds(f), ["workflows/ci.yml", "workflows/ci.yml/runs?head_sha=SHA&branch=main&event=push&per_page=N",
        "runs/N/attempts/N/jobs?per_page=N&page=N", "runs/N"])
    assert.match(f.reads[2].path, /\/actions\/runs\/456\/attempts\/2\/jobs\?per_page=100&page=1$/)
    const query = new URL(f.reads[1].path, "https://api.github.test/").searchParams
    assert.equal(query.get("head_sha"), source)
    assert.equal(query.get("branch"), "main")
    assert.equal(query.get("event"), "push")
    assert.equal(query.get("per_page"), "100")
    // Filtering by status would let an older passing run hide a newer failed one
    assert.equal(query.has("status"), false)
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
        assert.ok(!kinds(f).some((kind) => kind.startsWith("runs/")), "No job is read for a run of another identity")
    }
})

test("Failed, cancelled, skipped or unknown completed certificates fail immediately", async () => {
    for (const scope of ["check", "npm"])
        for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "timed_out", "action_required"]) {
            const f = fixture([inventory([run])], { npm: () => ({ conclusion }), jobs: (of) => page([certificate(of, names[scope], { conclusion })]) })
            await assert.rejects(requireCheckedSource(source, f.io, { scope }), /456 did not pass/, `${scope} ${conclusion}`)
            assert.deepEqual(f.sleeps, [])
        }
    const f = fixture([inventory([run])], { jobs: (of) => page([certificate(of, names.check, { conclusion: null })]) })
    await assert.rejects(requireCheckedSource(source, f.io), /state is not recognized/)
})

test("The newest matching run wins, even when an older run passed", async () => {
    const failed = { ...run, id: 789, conclusion: "failure" }
    const f = fixture([inventory([run, failed])])
    await assert.rejects(requireCheckedSource(source, f.io), /789 did not pass/)
    const waiting = fixture([
        inventory([{ ...run, id: 789, status: "in_progress", conclusion: null }, run]),
        inventory([{ ...run, id: 789 }, run]),
    ])
    assert.equal((await requireCheckedSource(source, waiting.io)).runId, 789)
    assert.deepEqual(waiting.sleeps, [20_000])
    assert.match(waiting.progress[0], /789/)
})

test("The npm certificate passes while website, workflow lint or the release trigger are running or failed", async () => {
    // The run is red or unfinished for jobs outside the certificate, but its npm release checks job passed
    for (const patch of [
        { status: "completed", conclusion: "failure" }, { status: "in_progress", conclusion: null },
        { status: "queued", conclusion: null }, { status: "completed", conclusion: "cancelled" },
    ]) {
        const unrelated = { ...run, ...patch }
        const f = fixture([inventory([unrelated])], { jobs: (of) => page([
            certificate(of, names.npm, { status: "completed", conclusion: "success" }),
            certificate(of, names.check, { conclusion: "failure" }), certificate(of, "Website and contribution checks", { conclusion: "failure" }),
            certificate(of, "Release preparation trigger", { status: "completed", conclusion: "failure" })]) })
        const result = await requireCheckedSource(source, f.io, { scope: "npm" })
        assert.deepEqual([result.runId, result.evidenceScope], [456, "npm"])
        assert.deepEqual(f.sleeps, [])
        // The same run is not evidence for the whole Check
        await assert.rejects(requireCheckedSource(source, fixture([inventory([unrelated])], { jobs: (of) => page([
            certificate(of, names.npm, { status: "completed", conclusion: "success" }),
            certificate(of, names.check, { status: "completed", conclusion: "failure" })]) }).io), /456 did not pass its check job/)
    }
})

test("The check certificate passes despite a failed release trigger, and fails on website or lint failures", async () => {
    const trigger = { ...run, conclusion: "failure" }
    const passed = fixture([inventory([trigger])], { jobs: (of) => page([
        certificate(of, names.check, { status: "completed", conclusion: "success" }),
        certificate(of, "Release preparation trigger", { status: "completed", conclusion: "failure" })]) })
    assert.equal((await requireCheckedSource(source, passed.io, { scope: "check" })).runId, 456)
    // The required job fails when the website checks or workflow lint failed, so the certificate carries that failure
    const failed = fixture([inventory([trigger])], { jobs: (of) => page([
        certificate(of, names.npm, { status: "completed", conclusion: "success" }),
        certificate(of, names.check, { status: "completed", conclusion: "failure" })]) })
    await assert.rejects(requireCheckedSource(source, failed.io, { scope: "check" }), /did not pass its check job/)
})

test("Each scope reads only its own certificate and a missing one is never replaced by another", async () => {
    const onlyCheck = (of) => page([certificate(of, names.check, { status: "completed", conclusion: "success" })])
    await assert.rejects(requireCheckedSource(source, fixture([inventory([run])], { jobs: onlyCheck }).io, { scope: "npm" }), /no completed npm release checks job/)
    // A finished run from before the certificate existed fails closed, even with a passing workflow conclusion
    const historical = fixture([inventory([run])], { jobs: (of) => page([certificate(of, "SDK checks")]) })
    await assert.rejects(requireCheckedSource(source, historical.io, { scope: "npm", allowMissing: true }), /no completed npm release checks job/)
    assert.deepEqual(historical.sleeps, [])
    await assert.rejects(requireCheckedSource(source, fixture().io, { scope: "website" }), /scope is not recognized/)
})

test("An unfinished run is awaited until its certificate completes, within the twenty-minute bound", async () => {
    const running = { ...run, status: "in_progress", conclusion: null }
    // The jobs are not listed yet, then queued, then running, then finished
    let reads = 0
    const f = fixture([inventory([running])], { jobs: (of) => {
        const step = reads++
        if (step === 0) return page([])
        const status = ["queued", "in_progress", "completed"][step - 1]
        return page([certificate(of, names.npm, status === "completed" ? { status, conclusion: "success" } : { status, conclusion: null })])
    } })
    const result = await requireCheckedSource(source, f.io, { scope: "npm" })
    assert.equal(result.runId, 456)
    assert.deepEqual(f.sleeps, [20_000, 20_000, 20_000])
    assert.equal(f.progress.length, 3)
    assert.match(f.progress[0], /npm release checks job of Check run 456/)
    const stuck = fixture([inventory([running])], { jobs: (of) => page([certificate(of, names.npm, { status: "in_progress", conclusion: null })]) })
    await assert.rejects(requireCheckedSource(source, stuck.io, { scope: "npm" }), /timed out/)
    assert.equal(stuck.sleeps.reduce((sum, value) => sum + value, 0), 1_200_000)
})

test("A certificate on a later page is found, and an inventory that does not add up is rejected", async () => {
    const filler = (of) => Array.from({ length: 100 }, (_, index) => certificate(of, `Job ${index}`, { id: 9000 + index }))
    const paged = fixture([inventory([run])], { jobs: (of, attempt, number) =>
        number === 1 ? page(filler(of), 101) : page([certificate(of, names.npm)], 101) })
    assert.equal((await requireCheckedSource(source, paged.io, { scope: "npm" })).runId, 456)
    assert.deepEqual(paged.reads.map(({ path }) => path.match(/jobs\?per_page=100&page=(\d+)$/)?.[1]).filter(Boolean), ["1", "2"])
    for (const jobs of [() => page([], 3), () => ({}), (of) => page([certificate(of, names.npm), certificate(of, names.npm, { id: 1 })])])
        await assert.rejects(requireCheckedSource(source, fixture([inventory([run])], { jobs }).io, { scope: "npm" }), /job inventory|more than one/)
    await assert.rejects(requireCheckedSource(source, fixture([inventory([run])], { jobs: (of) => page([certificate(of, names.npm, { run_id: 999 })]) }).io, { scope: "npm" }), /does not match/)
})

test("A rerun starts while the jobs are read: Only the latest attempt's certificate counts", async () => {
    // The listing shows attempt 1, but the run has moved on to attempt 2 whose certificate failed
    const f = fixture([inventory([run])], {
        runs: (of) => ({ ...of, run_attempt: 2, status: "in_progress" }),
        jobs: (of, attempt) => page([certificate(of, names.npm, attempt === 1 ? {} : { conclusion: "failure" })]),
    })
    await assert.rejects(requireCheckedSource(source, f.io, { scope: "npm" }), /456 did not pass/)
    assert.deepEqual(kinds(f).filter((kind) => kind.startsWith("runs/N/attempts")), ["runs/N/attempts/N/jobs?per_page=N&page=N", "runs/N/attempts/N/jobs?per_page=N&page=N"])
    assert.match(f.reads[2].path, /attempts\/1\//)
    assert.match(f.reads[4].path, /attempts\/2\//)
    const identity = fixture([inventory([run])], { runs: (of) => ({ ...of, head_sha: "b".repeat(40) }) })
    await assert.rejects(requireCheckedSource(source, identity.io), /changed identity/)
})

test("A latest attempt without the certificate is rejected with the run link and the full re-run remedy, never an older attempt's pass", async () => {
    // Attempt 1 passed its npm release checks. Attempt 2 finished with only the jobs a partial re-run started
    for (const scope of ["npm", "check"]) {
        const attempts = fixture([inventory([{ ...run, run_attempt: 2 }])], { jobs: (of, attempt) => page(attempt === 1
            ? [certificate(of, names.npm), certificate(of, names.check)]
            : [certificate(of, "Website and contribution checks", { conclusion: "failure" })]) })
        await assert.rejects(requireCheckedSource(source, attempts.io, { scope }), (error) => {
            assert.match(error.message, new RegExp(`no completed ${names[scope]} job in attempt 2`))
            assert.ok(error.message.includes("re-run all jobs of https://github.com/NeonTechSpace/Fluxerly.js/actions/runs/456"))
            return true
        })
        assert.ok(!attempts.reads.some(({ path }) => path.includes("/attempts/1/")), "The first attempt is never read")
    }
})

test("Pending CI may appear and complete, but missing evidence has a bounded wait", async () => {
    const f = fixture([inventory([]), inventory([{ ...run, status: "queued" }]), inventory([run])])
    await requireCheckedSource(source, f.io)
    assert.deepEqual(f.sleeps, [20_000, 20_000])
    assert.equal(f.progress.length, 2)
    const missing = fixture([inventory([])])
    await assert.rejects(requireCheckedSource(source, missing.io), /timed out/)
    // Twenty minutes, so a Check started just before still finishes in time
    assert.equal(missing.sleeps.reduce((sum, value) => sum + value, 0), 1_200_000)
    assert.ok(missing.reads.length <= 62)
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
    const slow = fixture(undefined, { readTime: 1_200_000 })
    await assert.rejects(requireCheckedSource(source, slow.io), /timed out/)
    assert.deepEqual(slow.sleeps, [])
    // Reads that finish inside the bound but leave no time to return the certificate cannot reuse it
    const late = fixture(undefined, { readTime: 400_000 })
    await assert.rejects(requireCheckedSource(source, late.io), /timed out/)
})

test("Preparation fallback requires a verified empty inventory, never failed, missing or unreadable evidence", async () => {
    for (const scope of ["check", "npm"]) {
        const missing = fixture([inventory([])])
        assert.equal(await requireCheckedSource(source, missing.io, { allowMissing: true, scope }), null)
        assert.deepEqual(missing.sleeps, [])
        for (const [data, reason] of [
            [inventory([{ ...run, conclusion: "failure" }]), /456 did not pass/],
            [{}, /inventory is incomplete or invalid/],
            [inventory([run, { ...run, id: 789, conclusion: "cancelled" }]), /789 did not pass/],
        ]) await assert.rejects(requireCheckedSource(source, fixture([data]).io, { allowMissing: true, scope }), reason)
        await assert.rejects(requireCheckedSource(source, { read: async () => { throw new Error("Unavailable") } },
            { allowMissing: true, scope }), /Unavailable/)
        // Unreadable jobs are an API error, not an absent certificate
        const unreadable = fixture([inventory([run])], { jobs: () => { throw new Error("Jobs unavailable") } })
        await assert.rejects(requireCheckedSource(source, unreadable.io, { allowMissing: true, scope }), /Jobs unavailable/)
        const queued = fixture([inventory([{ ...run, status: "queued", conclusion: null }]), inventory([run])])
        assert.equal((await requireCheckedSource(source, queued.io, { allowMissing: true, scope })).runId, run.id)
        assert.deepEqual(queued.sleeps, [20_000])
    }
})

test("The command line takes a closed scope and the missing-evidence fallback, each once", () => {
    assert.deepEqual(parseArguments([]), { scope: "check", allowMissing: false })
    assert.deepEqual(parseArguments(["--scope", "npm", "--allow-missing"]), { scope: "npm", allowMissing: true })
    assert.deepEqual(parseArguments(["--allow-missing", "--scope", "check"]), { scope: "check", allowMissing: true })
    for (const args of [["--scope"], ["--scope", "website"], ["--scope", ""], ["--scope", "npm", "--scope", "check"],
        ["--allow-missing", "--allow-missing"], ["--scope=npm"], ["npm"], ["--job", "check"]])
        assert.throws(() => parseArguments(args), /supported|recognized/, args.join(" "))
})

test("Unavailable gh evidence surfaces redacted diagnostics instead of discarding them", () => {
    const token = `ghs_${"a".repeat(36)}`
    const logs = []
    const spawned = []
    const run = (command, args, options) => {
        spawned.push({ command, stdio: options.stdio })
        return { status: 1, stdout: "", stderr: `gh: Bad credentials (HTTP 401) for ${token}` }
    }
    assert.throws(() => readGitHub("repos/example", 1000, run, (text) => logs.push(text)), /evidence is unavailable/)
    assert.deepEqual(spawned, [{ command: "gh", stdio: ["ignore", "pipe", "pipe"] }])
    assert.match(logs.join(""), /Bad credentials \(HTTP 401\)/)
    assert.ok(!logs.join("").includes(token))
    const parsed = readGitHub("repos/example", 1000, () => ({ status: 0, stdout: '{"id":1}', stderr: "" }), (text) => logs.push(text))
    assert.deepEqual(parsed, { id: 1 })
})
