// Recorded category passes, so a release run re-runs only what has not already passed on the same code. Each pass is
// stored with a hash of its inputs: All SDK source and compiler settings, the category's harness files and the shared
// fixtures they import, the live support code and runner, the SDK package manifest, the lockfile and the Fluxer pin.
// SDK source counts for every category, because the changed-file mapping picks likely categories, not every category
// whose checks run that code. A pass counts only while that hash still matches and for at most 14 days, so Fluxer-side
// changes are still caught. A failed, timed-out, recovered-only, skipped or throttled run of a category removes its
// pass. The record is the ignored `.env.test.passes.json` in the SDK folder
import { createHash } from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { categories, liveImporters } from "./categories.js"
import { stateRoot } from "./state-root.js"

export const passRecordsPath = join(fileURLToPath(stateRoot), ".env.test.passes.json")
/** A pass stops counting after this long */
export const passMaxAgeMs = 14 * 24 * 60 * 60 * 1_000
/** Repository paths that every category's input hash includes */
export const commonInputs = Object.freeze([
    /^projects\/sdk\/tests\/live\/(support\/[^/]+|run-all\.js)$/,
    /^projects\/sdk\/src\/.+\.ts$/,
    /^projects\/sdk\/tsconfig[^/]*\.json$/,
    /^projects\/sdk\/package\.json$/,
    /^projects\/pnpm-lock\.yaml$/,
    /^projects\/release\/upstream\/manifest\.json$/,
])
/** Repository paths that can be inputs at all. Other paths, such as docs and the website, never select a category */
export const candidateInputs =
    /^projects\/(sdk\/(src\/.+\.ts|tsconfig[^/]*\.json|tests\/live\/[^/]+\.m?js|tests\/live\/support\/[^/]+|package\.json)|pnpm-lock\.yaml|release\/upstream\/manifest\.json)$/

/**
 * The input paths of every category, from the candidate repository paths: The harness files of its checks and the
 * common inputs, which include all SDK source. Each list is sorted
 */
export function categoryInputs(paths, checks) {
    const candidates = paths.filter((path) => candidateInputs.test(path) && !path.includes(".test."))
    const common = candidates.filter((path) => commonInputs.some((pattern) => pattern.test(path)))
    const harnessFiles = new Set(
        [...checks.values()].flatMap((check) => check.commands.map((command) => command.harness)),
    )
    // Shared fixtures and helpers in tests/live run no check themselves, so they count for the harnesses importing them
    const helpers = new Map(
        candidates
            .map((path) => /^projects\/sdk\/tests\/live\/([a-z0-9-]+\.m?js)$/.exec(path)?.[1])
            .filter((file) => file !== undefined && !harnessFiles.has(file) && file !== "run-all.js")
            .map((file) => [`projects/sdk/tests/live/${file}`, liveImporters(file)]),
    )
    return Object.fromEntries(
        Object.entries(categories).map(([category, members]) => {
            const harnesses = new Set(
                members.flatMap((member) =>
                    checks
                        .get(member.split("@")[0])
                        .commands.map((command) => `projects/sdk/tests/live/${command.harness}`),
                ),
            )
            const uses = (path) =>
                [...(helpers.get(path) ?? [])].some((file) => harnesses.has(`projects/sdk/tests/live/${file}`))
            const inputs = candidates.filter((path) => harnesses.has(path) || common.includes(path) || uses(path))
            return [category, inputs.sort()]
        }),
    )
}

/** A hash of each path and its content as `read(path)` returns it, or a marker for a path that no longer exists */
export function inputHash(paths, read) {
    const hash = createHash("sha256")
    for (const path of paths) {
        let content
        try {
            content = read(path)
        } catch {
            // allow-silent: A deleted path still changes the hash through its marker
            content = Buffer.from("\0missing")
        }
        hash.update(path).update("\0").update(createHash("sha256").update(content).digest("hex")).update("\n")
    }
    return hash.digest("hex")
}

/** The stored passes, or none when the file is missing or unreadable, so a damaged record only causes a rerun */
export function loadPasses(path = passRecordsPath) {
    try {
        const value = JSON.parse(readFileSync(path, "utf8"))
        return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
    } catch {
        // allow-silent: Without a readable record every category runs
        return {}
    }
}

export function savePasses(passes, path = passRecordsPath) {
    writeFileSync(`${path}.tmp`, `${JSON.stringify(passes, null, 4)}\n`)
    renameSync(`${path}.tmp`, path)
}

/**
 * Which categories a release run can reuse and which it must run, with the reason: `fresh` when forced, `no pass`,
 * `inputs changed` or `expired`. A reused category carries the time of its pass
 */
export function reuseDecisions(passes, hashes, { now = Date.now(), fresh = false } = {}) {
    return Object.keys(hashes).map((category) => {
        const pass = passes[category]
        const at = Date.parse(pass?.passedAt)
        const reason = fresh
            ? "fresh"
            : !pass || !Number.isFinite(at)
              ? "no pass"
              : pass.hash !== hashes[category]
                ? "inputs changed"
                : now - at > passMaxAgeMs || at > now
                  ? "expired"
                  : undefined
        return reason ? { category, run: true, reason } : { category, run: false, passedAt: pass.passedAt }
    })
}

/**
 * The passes after a run. `results` are the run's check results by unit name, such as `reactions` or
 * `reactions@default`, with their status. A category every member of which passed in this run records a pass with
 * its hash from the start of the run. A category with any member that ran or was skipped without passing loses its
 * pass, and a throttled run records no pass and removes the pass of every category it touched
 */
export function updatePasses(passes, { hashes, results, throttled = false, now = Date.now() }) {
    const next = { ...passes }
    const status = new Map(results.map((result) => [result.name, result.status]))
    const memberStatus = (member) => status.get(member) ?? status.get(member.split("@")[0])
    for (const [category, members] of Object.entries(categories)) {
        const statuses = members.map(memberStatus)
        if (statuses.every((value) => value === undefined)) continue
        if (!throttled && statuses.every((value) => value === "pass"))
            next[category] = { hash: hashes[category], passedAt: new Date(now).toISOString() }
        else if (throttled || statuses.some((value) => value !== undefined && value !== "pass")) delete next[category]
    }
    return next
}
