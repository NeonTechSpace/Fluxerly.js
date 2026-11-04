// @ts-check

// Reads the result of one certificate job of one attempt of a Check run. A certificate is a job that only passes when
// all the coverage of its scope passed, so readers never rebuild that decision from the producer jobs behind it. The
// scope table is closed: Callers name a scope, never a job

/** The only scopes, and the job whose result certifies each one @type {Readonly<Record<string, string>>} */
export const certificates = Object.freeze({ npm: "npm release checks", check: "check" })

const shaPattern = /^[a-f0-9]{40}$/
const pageSize = 100
const maxPages = 10
// A rerun can start while jobs are read, and each change restarts the read, so a run that keeps changing is not evidence
const maxAttemptChanges = 5
const knownStates = new Set(["queued", "in_progress", "completed", "waiting", "pending", "requested"])
/** @param {unknown} value */
const positiveInteger = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0

/**
 * The name of the job that certifies a scope
 * @param {unknown} scope
 * @returns {string}
 */
export function certificateName(scope) {
    if (typeof scope !== "string" || !Object.hasOwn(certificates, scope)) throw new Error("The evidence scope is not recognized")
    return certificates[scope]
}

/**
 * @typedef {{
 *   id: number,
 *   run_id: number,
 *   head_sha: string,
 *   name: string,
 *   status: string,
 *   conclusion?: string | null,
 *   completed_at?: string | null,
 *   run_attempt?: number,
 * }} Job
 */

/**
 * Reads every job of one exact attempt, page by page, until the declared inventory is complete
 * @param {{
 *   read: (path: string) => Promise<any>,
 *   runId: number,
 *   attempt: number,
 *   headSha: string,
 *   now: () => number,
 *   deadline: number,
 * }} options Paths are relative to the repository
 * @returns {Promise<Job[]>}
 */
export async function readJobs({ read, runId, attempt, headSha, now, deadline }) {
    /** @type {Job[]} */
    const jobs = []
    const ids = new Set()
    let total
    for (let page = 1; ; page++) {
        if (page > maxPages) throw new Error("The Check job inventory exceeded the pagination bound")
        if (now() >= deadline) throw new Error("The Check evidence read timed out")
        const data = await read(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${pageSize}&page=${page}`)
        if (!Array.isArray(data?.jobs) || !Number.isSafeInteger(data.total_count) || data.total_count < 0 ||
            data.total_count > maxPages * pageSize || data.jobs.length > pageSize)
            throw new Error("The Check job inventory is incomplete or invalid")
        if (total === undefined) total = data.total_count
        else if (total !== data.total_count) throw new Error("The Check job inventory changed between pages")
        for (const job of data.jobs) {
            if (!positiveInteger(job?.id) || job.run_id !== runId || job.head_sha !== headSha ||
                typeof job.name !== "string" || job.name === "" || typeof job.status !== "string" ||
                (job.run_attempt !== undefined && job.run_attempt !== attempt))
                throw new Error("A Check job does not match the run attempt it was read for")
            if (ids.has(job.id)) throw new Error("The Check job inventory repeats a job")
            ids.add(job.id)
            jobs.push(job)
        }
        if (jobs.length > total) throw new Error("The Check job inventory holds more jobs than it declares")
        if (jobs.length === total) return jobs
        if (data.jobs.length < pageSize) throw new Error("The Check job inventory is incomplete or invalid")
    }
}

/**
 * The one job that certifies the scope, or null when the complete inventory lacks it
 * @param {Job[]} jobs
 * @param {unknown} scope
 * @returns {Job | null}
 */
export function selectCertificate(jobs, scope) {
    const name = certificateName(scope)
    const matches = jobs.filter((job) => job.name === name)
    if (matches.length > 1) throw new Error(`The Check run has more than one ${name} job`)
    const job = matches[0]
    if (!job) return null
    if (!knownStates.has(job.status) || (job.status === "completed" && typeof job.conclusion !== "string"))
        throw new Error(`The ${name} job state is not recognized`)
    return job
}

/**
 * Reads the certificate of one run for one scope from the jobs of its latest attempt. The run is read again afterwards:
 * When a rerun started meanwhile, the certificate is discarded and the new attempt is read, within the same deadline.
 * An attempt's jobs are never combined with another attempt's
 * @param {{
 *   scope: string,
 *   runId: number,
 *   attempt: number,
 *   headSha: string,
 *   read: (path: string) => Promise<any>,
 *   deadline: number,
 *   now?: () => number,
 *   repository?: string,
 *   workflowPath?: string,
 * }} options Paths are relative to the repository
 * @returns {Promise<{ attempt: number, job: Job | null, runStatus: string }>} A null job means the attempt has no such job
 */
export async function readRunCertificate({ scope, runId, attempt, headSha, read, deadline, now = Date.now, repository, workflowPath }) {
    certificateName(scope)
    if (!positiveInteger(runId) || !positiveInteger(attempt)) throw new Error("The Check run and attempt numbers are required")
    if (!shaPattern.test(headSha)) throw new Error("The Check run source commit is required")
    let current = attempt
    for (let changes = 0; ; changes++) {
        const job = selectCertificate(await readJobs({ read, runId, attempt: current, headSha, now, deadline }), scope)
        if (now() >= deadline) throw new Error("The Check evidence read timed out")
        const run = await read(`actions/runs/${runId}`)
        if (run?.id !== runId || run.head_sha !== headSha || (workflowPath !== undefined && run.path !== workflowPath) ||
            (repository !== undefined && (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository)))
            throw new Error("The Check run changed identity while its jobs were read")
        if (!positiveInteger(run.run_attempt) || run.run_attempt < current || typeof run.status !== "string")
            throw new Error("The Check run attempt could not be verified")
        if (run.run_attempt === current) return { attempt: current, job, runStatus: run.status }
        if (changes >= maxAttemptChanges) throw new Error("The Check run kept changing attempts while its jobs were read")
        current = run.run_attempt
    }
}
