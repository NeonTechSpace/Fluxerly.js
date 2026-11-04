// @ts-check

import { execFileSync } from "node:child_process"
import { appendFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { certificateName, readRunCertificate } from "./check-evidence.js"
import { createGithub } from "./github.js"
import { describeVersionChange, detectVersionChange } from "./version-change.js"

const shaPattern = /^[a-f0-9]{40}$/
const workflowPath = ".github/workflows/ci.yml"
// A pull_request run checks a merge commit but records the branch head, so the content it checked is unknown
const evidenceEvents = new Set(["push", "workflow_dispatch"])
// These conclusions say nothing about the content, so an older run can still decide
const inconclusive = new Set(["cancelled", "skipped", "stale"])

/** @typedef {{ runId: number, runAttempt: number, runUrl: string }} Reference */
/** @typedef {{ attempt: number, job: any, runStatus: string }} Evidence */

/**
 * Finds the newest conclusive result for the same git tree by completion time, read from the certificate job of the scope:
 * "check" for the whole Check, "npm" for the npm release checks. The rest of a run, which may still be going or be red,
 * does not matter. A run from before the certificate existed never counts. Identical trees include identical workflow
 * files. Only unfinished certificates of attempts started before the current attempt are awaited, preventing mutual waits
 * @param {{
 *   scope?: string,
 *   tree: string,
 *   runId: number,
 *   runStartedAt: string,
 *   repository: string,
 *   workflowId?: number,
 *   listRuns: () => Promise<any>,
 *   readCertificate: (run: any, deadline: number) => Promise<Evidence>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   progress?: (text: string) => void,
 *   waitMs?: number,
 * }} options
 * @returns {Promise<Reference | null>} Null when the checks of the scope must run
 */
export async function findReusableCheck({
    scope = "check",
    tree,
    runId,
    runStartedAt,
    repository,
    workflowId,
    listRuns,
    readCertificate,
    now = Date.now,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    progress = () => {},
    waitMs = 40 * 60_000,
}) {
    const certificate = certificateName(scope)
    if (!shaPattern.test(tree)) throw new Error("A git tree SHA is required")
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("The current run ID is required")
    const startedAt = Date.parse(runStartedAt)
    if (!Number.isFinite(startedAt)) throw new Error("The current Check attempt start time is required")
    const deadline = now() + waitMs
    // A certificate that finished, or whose run finished, never changes, so a later look reads it once more at most
    /** @type {Map<string, Evidence>} */
    const settled = new Map()
    /** @param {any} run */
    const evidenceOf = async (run) => {
        const key = `${run.id}:${run.run_attempt}`
        const kept = settled.get(key)
        if (kept) return kept
        const evidence = await readCertificate(run, deadline)
        if (evidence.attempt === run.run_attempt && (evidence.job?.status === "completed" || evidence.runStatus === "completed"))
            settled.set(key, evidence)
        return evidence
    }
    for (;;) {
        const data = await listRuns()
        if (!Array.isArray(data?.workflow_runs)) throw new Error("The Check run inventory is invalid")
        const matching = data.workflow_runs.filter(
            (run) =>
                Number.isSafeInteger(run?.id) &&
                run.id > 0 &&
                run.id !== runId &&
                run.path === workflowPath &&
                (workflowId === undefined || run.workflow_id === workflowId) &&
                evidenceEvents.has(run.event) &&
                run.repository?.full_name === repository &&
                run.head_repository?.full_name === repository &&
                run.head_commit?.id === run.head_sha &&
                run.head_commit?.tree_id === tree,
        )
        /** @type {{ run: any, evidence: Evidence }[]} */
        const read = []
        for (const run of matching) read.push({ run, evidence: await evidenceOf(run) })
        // Run IDs survive reruns. Attempt start times, not IDs, prevent two runs from awaiting each other
        const unfinished = read.filter(({ run, evidence }) => {
            if (evidence.job?.status === "completed") return false
            // A finished run without the certificate predates it. A certificate still going in a finished run is no evidence
            if (evidence.runStatus === "completed") {
                if (evidence.job) throw new Error(`The ${certificate} job of a finished Check run did not finish`)
                return false
            }
            const start = Date.parse(run.run_started_at ?? (run.run_attempt === 1 ? run.created_at : undefined))
            if (!Number.isFinite(start)) throw new Error("An unfinished Check attempt has no verified start time")
            return start < startedAt
        })
        if (unfinished.length) {
            if (now() >= deadline) return null
            progress(`Waiting for the ${certificate} job of Check run ${unfinished[0].run.id}, which checks identical content`)
            await sleep(Math.min(30_000, Math.max(1, deadline - now())))
            continue
        }
        const completed = read
            .filter(({ evidence }) => evidence.job?.status === "completed" && !inconclusive.has(evidence.job.conclusion))
            .map(({ run, evidence }) => {
                const completion = Date.parse(evidence.job.completed_at)
                if (!Number.isFinite(completion)) throw new Error(`A completed ${certificate} job has no verified completion time`)
                return { run, evidence, completion }
            })
            .sort((a, b) => b.completion - a.completion || b.run.id - a.run.id)
        const decisive = completed[0]
        if (!decisive || completed.some((item) => item.completion === decisive.completion && item.evidence.job.conclusion !== "success"))
            return null
        return {
            runId: decisive.run.id,
            runAttempt: decisive.evidence.attempt,
            runUrl: `https://github.com/${repository}/actions/runs/${decisive.run.id}`,
        }
    }
}

/**
 * The scope named on the command line, "check" unless given
 * @param {string[]} args
 */
export function parseScope(args) {
    if (args.length === 0) return "check"
    if (args.length !== 2 || args[0] !== "--scope") throw new Error("Only --scope npm|check is supported")
    certificateName(args[1])
    return args[1]
}

/**
 * The step outputs of one lookup. A reference is complete only with a numeric run ID and attempt and a URL, so a job reads
 * a reuse only from a lookup that succeeded and returned all three
 * @param {{ scope: string, tree: string, result: Reference | null, parent: Reference | null }} lookup
 */
export function lookupOutputs({ scope, tree, result, parent }) {
    return (
        `scope=${scope}\nreused=${result !== null}\nrun_id=${result?.runId ?? ""}\nrun_attempt=${result?.runAttempt ?? ""}\n` +
        `run_url=${result?.runUrl ?? ""}\ntree=${tree}\nversion_only=${parent !== null}\n` +
        `parent_run_id=${parent?.runId ?? ""}\nparent_run_attempt=${parent?.runAttempt ?? ""}\nparent_run_url=${parent?.runUrl ?? ""}\n`
    )
}

async function main() {
    const scope = parseScope(process.argv.slice(2))
    const certificate = certificateName(scope)
    const repository = process.env.GITHUB_REPOSITORY
    const runId = Number(process.env.GITHUB_RUN_ID)
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8", windowsHide: true }).trim()
    /** @type {Reference | null} */
    let result = null
    /** @type {Reference | null} */
    let parentCheck = null
    // Any lookup failure runs the checks of the scope, so reuse can only ever save work
    try {
        const github = createGithub(repository)
        const workflow = await github.api("actions/workflows/ci.yml")
        if (!Number.isSafeInteger(workflow?.id) || workflow.path !== workflowPath || workflow.state !== "active")
            throw new Error("The Check workflow identity could not be verified")
        const current = await github.api(`actions/runs/${runId}`)
        if (current.id !== runId || current.run_attempt !== Number(process.env.GITHUB_RUN_ATTEMPT))
            throw new Error("The current Check attempt could not be verified")
        // Both lookups share one wait bound, so they fit in the job's timeout together
        const deadline = Date.now() + 40 * 60_000
        /** @param {string} tree */
        const lookup = (tree) =>
            findReusableCheck({
                scope,
                waitMs: Math.max(0, deadline - Date.now()),
                tree,
                runId,
                runStartedAt: current.run_started_at ?? (current.run_attempt === 1 ? current.created_at : undefined),
                repository: repository ?? "",
                workflowId: workflow.id,
                listRuns: () => github.api("actions/workflows/ci.yml/runs?per_page=100&exclude_pull_requests=true"),
                readCertificate: (run, limit) =>
                    readRunCertificate({
                        scope,
                        runId: run.id,
                        attempt: run.run_attempt,
                        headSha: run.head_sha,
                        repository,
                        workflowPath,
                        deadline: limit,
                        read: (path) => github.api(path),
                    }),
                progress: console.log,
            })
        result = await lookup(tree)
        if (!result) {
            // A change of only release version files needs only the release checks, when the content it changes passed the
            // same scope. That run was full or version-only itself, so every such pass traces back to the actual checks
            const change = detectVersionChange()
            console.log(describeVersionChange(change))
            if (change.versionOnly && change.parent) {
                const parentTree = execFileSync("git", ["rev-parse", `${change.parent}^{tree}`], {
                    encoding: "utf8",
                    windowsHide: true,
                }).trim()
                parentCheck = await lookup(parentTree)
                console.log(
                    parentCheck
                        ? `The ${certificate} job of Check run ${parentCheck.runId} passed for the parent commit's tree ${parentTree}`
                        : `No passing ${certificate} job exists for the parent commit's tree ${parentTree}. Running the checks`,
                )
            }
        }
    } catch (error) {
        console.log(`Reuse lookup for the ${certificate} job failed, running its checks: ${error instanceof Error ? error.message : "Unknown error"}`)
    }
    console.log(
        result
            ? `The ${certificate} job of Check run ${result.runId} already passed for tree ${tree}. Reusing it`
            : parentCheck
              ? "Running only the release version checks"
              : `No reusable passing ${certificate} job exists for tree ${tree}. Running its checks`,
    )
    const output = process.env.GITHUB_OUTPUT
    if (output) await appendFile(output, lookupOutputs({ scope, tree, result, parent: parentCheck }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : "Check reuse lookup failed")
        process.exitCode = 1
    })
