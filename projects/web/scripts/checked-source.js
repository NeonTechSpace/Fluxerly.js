import { execFileSync, spawnSync } from "node:child_process"
import { appendFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { certificateName, readRunCertificate } from "../../release/check-evidence.js"
import { redact } from "../../release/redact.js"

const repository = "NeonTechSpace/Fluxerly.js"
const workflowPath = ".github/workflows/ci.yml"
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0

// gh diagnostics are surfaced with token-like values redacted, so an unavailable gate remains diagnosable
export function readGitHub(path, timeout, run = spawnSync, log = (text) => process.stderr.write(text)) {
    const result = run("gh", ["api", "--hostname", "github.com", path], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    })
    const diagnostics = redact(String(result.stderr ?? "")).trim()
    if (diagnostics) log(`${diagnostics}\n`)
    if (result.error || result.status !== 0) throw new Error("Exact-source Check evidence is unavailable")
    try {
        return JSON.parse(result.stdout)
    } catch {
        throw new Error("Exact-source Check evidence is unavailable")
    }
}

const waitMs = 20 * 60_000
const pollMs = 20_000
// One read at the start and one after each pause, so the reads alone can't end the wait early
const attempts = waitMs / pollMs + 1

const pendingStates = ["queued", "in_progress", "waiting", "pending", "requested"]

/**
 * Requires the certificate job of the newest main-push Check run for the exact source to have passed: "check" for the
 * whole Check, "npm" for the npm release checks. The run itself may still be going, or be red for unrelated jobs
 */
export async function requireCheckedSource(source, io = {}, { allowMissing = false, scope = "check" } = {}) {
    const certificate = certificateName(scope)
    if (!/^[a-f0-9]{40}$/.test(source ?? "")) throw new Error("An exact checkout source commit is required")
    const read = io.read ?? readGitHub
    const now = io.now ?? Date.now
    const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const progress = io.progress ?? (() => {})
    // Long enough for a Check started just before this run, which takes over ten minutes when it tests every SDK group
    const deadline = now() + waitMs
    const timeout = () => Math.max(1, Math.min(30_000, deadline - now()))
    const base = `repos/${repository}/actions/workflows/ci.yml`
    const workflow = await read(base, timeout())
    if (!positiveInteger(workflow?.id) || workflow.path !== workflowPath || workflow.state !== "active")
        throw new Error("The required Check workflow identity is not verified")
    // Do not filter for success: A newer failed run must not reuse an older passing result
    const endpoint = `${base}/runs?head_sha=${source}&branch=main&event=push&per_page=100`
    for (let attempt = 0; attempt < attempts && now() < deadline; attempt++) {
        const data = await read(endpoint, timeout())
        if (!Array.isArray(data?.workflow_runs) || !Number.isSafeInteger(data.total_count) ||
            data.total_count < 0 || data.total_count > 100 || data.total_count !== data.workflow_runs.length)
            throw new Error("The exact-source Check run inventory is incomplete or invalid")
        if (data.workflow_runs.some((run) => !positiveInteger(run?.id)))
            throw new Error("The exact-source Check run identity is invalid")
        const run = [...data.workflow_runs].sort((a, b) => b.id - a.id)[0]
        if (run) {
            if (run.workflow_id !== workflow.id || run.path !== workflowPath ||
                run.head_sha !== source || run.head_branch !== "main" || run.event !== "push" ||
                run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
                !positiveInteger(run.run_attempt))
                throw new Error("The Check run does not match the exact main checkout and workflow")
            if (run.status !== "completed" && !pendingStates.includes(run.status))
                throw new Error("The Check run state is not recognized")
            // Only the certificate of the latest attempt decides. The rest of the run may be unfinished or failed
            const evidence = await readRunCertificate({
                scope, runId: run.id, attempt: run.run_attempt, headSha: source, repository, workflowPath, now, deadline,
                read: (path) => read(`repos/${repository}/${path}`, timeout()),
            })
            if (evidence.job?.status === "completed") {
                if (evidence.job.conclusion !== "success")
                    throw new Error(`Check run ${run.id} did not pass its ${certificate} job`)
                if (now() >= deadline) break
                return { sourceCommit: source, runId: run.id, runAttempt: evidence.attempt, evidenceScope: scope,
                    runUrl: `https://github.com/${repository}/actions/runs/${run.id}` }
            }
            // A finished run cannot produce a certificate it lacks, such as a run from before the certificate existed
            if (evidence.runStatus === "completed")
                throw new Error(`Check run ${run.id} has no completed ${certificate} job in attempt ${evidence.attempt}, so it is not evidence. ` +
                    `If the source's Check workflow defines that job, re-run all jobs of https://github.com/${repository}/actions/runs/${run.id} ` +
                    "so that its latest attempt holds it. A source from before the job existed cannot be used, select a reviewed descendant that has it")
            progress(`Waiting for the ${certificate} job of Check run ${run.id} to finish for the exact checkout`)
        } else {
            // Only a verified empty inventory permits full local validation instead
            if (allowMissing && now() < deadline) return null
            progress("Waiting for the exact checkout's main push Check run to appear")
        }
        if (attempt < attempts - 1 && now() < deadline) await sleep(Math.min(pollMs, deadline - now()))
    }
    throw new Error("The exact-source Check gate timed out")
}

/**
 * The options of the command line: A scope, "check" unless named, and whether a verified absence of evidence falls back
 * @param {string[]} args
 */
export function parseArguments(args) {
    let scope = "check"
    let named = false
    let allowMissing = false
    for (let index = 0; index < args.length; index++) {
        if (args[index] === "--allow-missing" && !allowMissing) allowMissing = true
        else if (args[index] === "--scope" && !named && index + 1 < args.length) {
            scope = args[++index]
            named = true
        } else throw new Error("Only --scope npm|check and --allow-missing are supported, each once")
    }
    certificateName(scope)
    return { scope, allowMissing }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim()
        const options = parseArguments(process.argv.slice(2))
        const result = await requireCheckedSource(source, { progress: console.log }, options)
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
            `reused=${result !== null}\nrun_id=${result?.runId ?? ""}\nrun_attempt=${result?.runAttempt ?? ""}\n` +
            `run_url=${result?.runUrl ?? ""}\nsource_commit=${source}\nevidence_scope=${options.scope}\n`)
        console.log(result
            ? `Reused the ${certificateName(options.scope)} job of Check run ${result.runId}, attempt ${result.runAttempt}, for ${source}`
            : "No main-push Check exists for this source. Full preparation checks are required")
    } catch (error) {
        console.error(error.message)
        process.exitCode = 1
    }
}
