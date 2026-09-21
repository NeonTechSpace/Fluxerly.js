import { execFileSync } from "node:child_process"
import { appendFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const repository = "NeonTechSpace/Fluxerly.js"
const workflowPath = ".github/workflows/ci.yml"
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0

function readGitHub(path, timeout) {
    try {
        return JSON.parse(execFileSync("gh", ["api", "--hostname", "github.com", path], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
            timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
        }))
    } catch {
        throw new Error("Exact-source Check evidence is unavailable, no Preview upload is authorized")
    }
}

export async function requireCheckedSource(source, io = {}) {
    if (!/^[a-f0-9]{40}$/.test(source ?? "")) throw new Error("An exact checkout source commit is required")
    const read = io.read ?? readGitHub
    const now = io.now ?? Date.now
    const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const progress = io.progress ?? (() => {})
    const deadline = now() + 600_000
    const timeout = () => Math.max(1, Math.min(30_000, deadline - now()))
    const base = `repos/${repository}/actions/workflows/ci.yml`
    const workflow = await read(base, timeout())
    if (!positiveInteger(workflow?.id) || workflow.path !== workflowPath || workflow.state !== "active")
        throw new Error("The required Check workflow identity is not verified")
    // Do not filter for success: A newer failed run must not reuse an older passing result
    const endpoint = `${base}/runs?head_sha=${source}&branch=main&event=push&per_page=100`
    for (let attempt = 0; attempt < 31 && now() < deadline; attempt++) {
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
            if (run.status === "completed") {
                if (run.conclusion !== "success")
                    throw new Error(`Check run ${run.id} did not pass, no Preview upload is authorized`)
                if (now() >= deadline) break
                return { sourceCommit: source, runId: run.id, runAttempt: run.run_attempt,
                    runUrl: `https://github.com/${repository}/actions/runs/${run.id}` }
            }
            if (!["queued", "in_progress", "waiting", "pending", "requested"].includes(run.status))
                throw new Error("The Check run state is not recognized")
            progress(`Waiting for Check run ${run.id} to finish for the exact checkout`)
        } else progress("Waiting for the exact checkout's main push Check run to appear")
        if (attempt < 30 && now() < deadline) await sleep(Math.min(20_000, deadline - now()))
    }
    throw new Error("The exact-source Check gate timed out, no Preview upload is authorized")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim()
        const result = await requireCheckedSource(source, { progress: console.log })
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
            `run_id=${result.runId}\nrun_url=${result.runUrl}\nsource_commit=${result.sourceCommit}\n`)
        console.log(`Reused successful Check run ${result.runId}, attempt ${result.runAttempt}, for ${source}`)
    } catch (error) {
        console.error(error.message)
        process.exitCode = 1
    }
}
