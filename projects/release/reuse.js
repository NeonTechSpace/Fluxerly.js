// @ts-check

import { execFileSync } from "node:child_process"
import { appendFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createGithub } from "./github.js"

const shaPattern = /^[a-f0-9]{40}$/
const workflowPath = ".github/workflows/ci.yml"
// A pull_request run checks a merge commit but records the branch head, so the content it checked is unknown
const evidenceEvents = new Set(["push", "workflow_dispatch"])
// These conclusions say nothing about the content, so an older run can still decide
const inconclusive = new Set(["cancelled", "skipped", "stale"])

/**
 * Finds the newest conclusive Check result for the same git tree by completion time. Identical trees include identical
 * workflow files. Only unfinished attempts started before the current attempt are awaited, preventing mutual waits
 * @param {{
 *   tree: string,
 *   runId: number,
 *   runStartedAt: string,
 *   repository: string,
 *   listRuns: () => Promise<any>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   progress?: (text: string) => void,
 *   waitMs?: number,
 * }} options
 * @returns {Promise<{ runId: number, runUrl: string } | null>} Null when the full Check must run
 */
export async function findReusableCheck({
    tree,
    runId,
    runStartedAt,
    repository,
    listRuns,
    now = Date.now,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    progress = () => {},
    waitMs = 40 * 60_000,
}) {
    if (!shaPattern.test(tree)) throw new Error("A git tree SHA is required")
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("The current run ID is required")
    const startedAt = Date.parse(runStartedAt)
    if (!Number.isFinite(startedAt)) throw new Error("The current Check attempt start time is required")
    const deadline = now() + waitMs
    for (;;) {
        const data = await listRuns()
        if (!Array.isArray(data?.workflow_runs)) throw new Error("The Check run inventory is invalid")
        const matching = data.workflow_runs.filter(
            (run) =>
                Number.isSafeInteger(run?.id) &&
                run.id > 0 &&
                run.id !== runId &&
                run.path === workflowPath &&
                evidenceEvents.has(run.event) &&
                run.repository?.full_name === repository &&
                run.head_repository?.full_name === repository &&
                run.head_commit?.id === run.head_sha &&
                run.head_commit?.tree_id === tree,
        )
        // Run IDs survive reruns. Attempt start times, not IDs, prevent two runs from awaiting each other
        const unfinished = matching.filter((run) => {
            if (run.status === "completed") return false
            const start = Date.parse(run.run_started_at ?? (run.run_attempt === 1 ? run.created_at : undefined))
            if (!Number.isFinite(start)) throw new Error("An unfinished Check attempt has no verified start time")
            return start < startedAt
        })
        if (unfinished.length) {
            if (now() >= deadline) return null
            progress(`Waiting for Check run ${unfinished[0].id}, which checks identical content`)
            await sleep(Math.min(30_000, Math.max(1, deadline - now())))
            continue
        }
        const completed = matching
            .filter((run) => run.status === "completed" && !inconclusive.has(run.conclusion))
            .map((run) => {
                // The workflow-runs API exposes completion as updated_at, including the latest rerun attempt
                const completion = Date.parse(run.updated_at)
                if (!Number.isFinite(completion)) throw new Error("A completed Check run has no verified completion time")
                return { run, completion }
            })
            .sort((a, b) => b.completion - a.completion || b.run.id - a.run.id)
        const decisive = completed[0]
        if (!decisive || completed.some((item) => item.completion === decisive.completion && item.run.conclusion !== "success"))
            return null
        return { runId: decisive.run.id, runUrl: `https://github.com/${repository}/actions/runs/${decisive.run.id}` }
    }
}

async function main() {
    const repository = process.env.GITHUB_REPOSITORY
    const runId = Number(process.env.GITHUB_RUN_ID)
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8", windowsHide: true }).trim()
    /** @type {{ runId: number, runUrl: string } | null} */
    let result = null
    // Any lookup failure runs the full Check, so reuse can only ever save work
    try {
        const github = createGithub(repository)
        const current = await github.api(`actions/runs/${runId}`)
        if (current.id !== runId || current.run_attempt !== Number(process.env.GITHUB_RUN_ATTEMPT))
            throw new Error("The current Check attempt could not be verified")
        result = await findReusableCheck({
            tree,
            runId,
            runStartedAt: current.run_started_at ?? (current.run_attempt === 1 ? current.created_at : undefined),
            repository: repository ?? "",
            listRuns: () => github.api("actions/workflows/ci.yml/runs?per_page=100&exclude_pull_requests=true"),
            progress: console.log,
        })
    } catch (error) {
        console.log(`Check reuse lookup failed, running the full Check: ${error instanceof Error ? error.message : "Unknown error"}`)
    }
    console.log(
        result
            ? `Check run ${result.runId} already passed for tree ${tree}. Reusing it`
            : `No reusable passing Check exists for tree ${tree}. Running the full Check`,
    )
    const output = process.env.GITHUB_OUTPUT
    if (output)
        await appendFile(output, `reused=${result !== null}\nrun_url=${result?.runUrl ?? ""}\ntree=${tree}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : "Check reuse lookup failed")
        process.exitCode = 1
    })
