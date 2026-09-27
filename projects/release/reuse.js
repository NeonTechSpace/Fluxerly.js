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
 * Finds an earlier successful Check run for the same git tree. Identical trees include identical workflow files, so
 * that run executed the same checks on the same content. An unfinished matching run is awaited rather than repeated
 * @param {{
 *   tree: string,
 *   runId: number,
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
    repository,
    listRuns,
    now = Date.now,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    progress = () => {},
    waitMs = 40 * 60_000,
}) {
    if (!shaPattern.test(tree)) throw new Error("A git tree SHA is required")
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("The current run ID is required")
    const deadline = now() + waitMs
    for (;;) {
        const data = await listRuns()
        if (!Array.isArray(data?.workflow_runs)) throw new Error("The Check run inventory is invalid")
        // Only older runs count, so two matching runs never wait for each other
        const decisive = data.workflow_runs
            .filter(
                (run) =>
                    Number.isSafeInteger(run?.id) &&
                    run.id < runId &&
                    run.path === workflowPath &&
                    evidenceEvents.has(run.event) &&
                    run.repository?.full_name === repository &&
                    run.head_repository?.full_name === repository &&
                    run.head_commit?.id === run.head_sha &&
                    run.head_commit?.tree_id === tree &&
                    !(run.status === "completed" && inconclusive.has(run.conclusion)),
            )
            .sort((a, b) => b.id - a.id)[0]
        if (!decisive) return null
        if (decisive.status === "completed")
            return decisive.conclusion === "success"
                ? { runId: decisive.id, runUrl: `https://github.com/${repository}/actions/runs/${decisive.id}` }
                : null
        if (now() >= deadline) return null
        progress(`Waiting for Check run ${decisive.id}, which checks identical content`)
        await sleep(Math.min(30_000, Math.max(1, deadline - now())))
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
        result = await findReusableCheck({
            tree,
            runId,
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
            : `No earlier passing Check exists for tree ${tree}. Running the full Check`,
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
