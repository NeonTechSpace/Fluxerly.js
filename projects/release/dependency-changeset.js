// @ts-check

import { isDeepStrictEqual } from "node:util"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createGithub } from "./github.js"

const sdkName = "@neontechspace/fluxerly"
const runtimeDependencies = new Set(["neverthrow", "ws"])
const manifestPath = "projects/sdk/package.json"
const fragmentPath = /^projects\/\.changeset\/[^/]+\.md$/

function stableVersion(value) {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return
    const parts = value.split(".").map(Number)
    return parts.every(Number.isSafeInteger) ? parts : undefined
}

function newer(before, after) {
    for (let index = 0; index < before.length; index++) {
        if (before[index] !== after[index]) return after[index] > before[index]
    }
    return false
}

function runtimePull(pull, repository) {
    return pull?.user?.login === "dependabot[bot]" && pull.user.type === "Bot" &&
        pull.base?.repo?.full_name === repository && pull.head?.repo?.full_name === repository &&
        pull.base?.ref === "main" && typeof pull.head?.ref === "string" &&
        pull.head.ref.startsWith("dependabot/npm_and_yarn/projects/sdk-runtime-") &&
        Number.isSafeInteger(pull.number) && pull.number > 0
}

function routineUpgrade(name, previous, next) {
    const from = stableVersion(previous)
    const to = stableVersion(next)
    return runtimeDependencies.has(name) && from && to && newer(from, to) &&
        from[0] === to[0] && (from[0] !== 0 || from[1] === to[1])
}

/**
 * Plan one patch Changeset for a same-repository runtime Dependabot update.
 * Only exact stable upgrades of the existing runtime group qualify. Existing
 * release notes, mixed changes, new dependencies and breaking upgrades stay manual.
 * Manifest contents and PR file metadata are data, never executable input
 * @param {{ repository: string, pull: any, files: any[], before: any, after: any }} input
 * @returns {{ skipped: true, reason: string } | { skipped: false, path: string, content: string, title: string, number: number }}
 */
export function planDependencyChangeset({ repository, pull, files, before, after }) {
    /** @returns {{ skipped: true, reason: string }} */
    const skip = (reason) => ({ skipped: true, reason })
    if (!runtimePull(pull, repository)) return skip("Not a same-repository SDK runtime Dependabot pull request")
    if (!Array.isArray(files) || files.length === 0 || files.length > 300)
        return skip("Missing or oversized pull request file inventory")
    if (files.some((file) => fragmentPath.test(file.filename) && !file.filename.endsWith("/README.md")))
        return skip("A release note was already changed, retain the reviewed note")
    if (files.some((file) => file.status !== "modified" || file.previous_filename !== undefined ||
        ![manifestPath, "projects/pnpm-lock.yaml"].includes(file.filename)))
        return skip("Mixed changes need manual release review")
    if (before?.name !== sdkName || after?.name !== sdkName)
        return skip("Unexpected SDK package identity")
    const { dependencies: previous, ...previousMetadata } = before
    const { dependencies: next, ...nextMetadata } = after
    if (!isDeepStrictEqual(previousMetadata, nextMetadata))
        return skip("Changes outside runtime dependencies need manual release review")
    if (!previous || !next || !isDeepStrictEqual(Object.keys(previous).sort(), Object.keys(next).sort()))
        return skip("Added or removed runtime dependencies need manual release review")
    const updates = []
    for (const name of Object.keys(next).sort()) {
        if (previous[name] === next[name]) continue
        if (!routineUpgrade(name, previous[name], next[name]))
            return skip("Breaking, ranged, prerelease or other dependency changes need manual release review")
        updates.push(`Update the SDK runtime dependency \`${name}\` from \`${previous[name]}\` to \`${next[name]}\``)
    }
    if (updates.length === 0) return skip("No runtime dependency upgrade")
    return {
        skipped: false,
        path: `projects/.changeset/runtime-dependencies-${pull.number}.md`,
        content: `---\n"${sdkName}": patch\n---\n\n${updates.join("\n\n")}\n`,
        title: `Record SDK runtime dependency updates from #${pull.number}`,
        number: pull.number,
    }
}

async function manifest(api, ref) {
    const file = await api(`contents/${manifestPath}?ref=${ref}`)
    if (file?.encoding !== "base64" || typeof file.content !== "string" || file.size > 65_536)
        throw new Error("SDK manifest is missing or exceeds the metadata bound")
    const bytes = Buffer.from(file.content, "base64")
    if (bytes.length > 65_536) throw new Error("SDK manifest exceeds the metadata bound")
    return JSON.parse(bytes.toString("utf8"))
}

async function pullFiles(api, number) {
    const files = []
    for (let page = 1; page <= 3; page++) {
        const next = await api(`pulls/${number}/files?per_page=100&page=${page}`)
        if (!Array.isArray(next)) throw new Error("Invalid pull request file inventory")
        files.push(...next)
        if (next.length < 100) return files
    }
    throw new Error("Pull request file inventory exceeds the automation bound")
}

async function ensureCheck(api, branch, head) {
    const current = await api(`git/ref/heads/${encodeURIComponent(branch)}`)
    if (current?.object?.sha !== head) throw new Error("Dependency branch moved before Check dispatch")
    const runs = await api(`actions/workflows/ci.yml/runs?branch=${encodeURIComponent(branch)}&per_page=100`)
    if (!Array.isArray(runs?.workflow_runs)) throw new Error("Invalid Check run inventory")
    if (runs.workflow_runs.some((run) => run.head_sha === head && run.event === "workflow_dispatch")) return
    await api("actions/workflows/ci.yml/dispatches", { method: "POST", input: { ref: branch }, empty: true })
}

async function commitNote(api, pull, path, content) {
    const parent = await api(`git/commits/${pull.head.sha}`)
    if (!/^[a-f0-9]{40}$/.test(parent?.tree?.sha ?? "")) throw new Error("Invalid dependency commit tree")
    const tree = await api("git/trees", {
        method: "POST", input: { base_tree: parent.tree.sha, tree: [{ path, mode: "100644", type: "blob", content }] },
    })
    if (!/^[a-f0-9]{40}$/.test(tree?.sha ?? "")) throw new Error("Invalid Changeset tree acknowledgement")
    const commit = await api("git/commits", {
        method: "POST", input: { message: "Record SDK runtime dependency updates", tree: tree.sha, parents: [pull.head.sha] },
    })
    if (!/^[a-f0-9]{40}$/.test(commit?.sha ?? "")) throw new Error("Invalid Changeset commit acknowledgement")
    const latest = await api(`pulls/${pull.number}`)
    if (latest.state !== "open" || latest.head?.sha !== pull.head.sha)
        throw new Error("Dependency pull request changed during Changeset preparation")
    const updated = await api(`git/refs/heads/${encodeURIComponent(pull.head.ref)}`, {
        method: "PATCH", input: { sha: commit.sha, force: false },
    })
    if (updated?.object?.sha !== commit.sha) throw new Error("Changeset branch update is unconfirmed")
    return commit.sha
}

/**
 * Add one note to the verified Dependabot branch without checking out or executing its code.
 * The new commit has the observed head as its sole parent, and a non-force ref update
 * refuses concurrent branch changes. An existing note is never overwritten. Reruns
 * reconcile an already-added automatic note and a Check dispatch without retrying failed tests
 * @param {{ repository: string, number: number, api: ReturnType<typeof createGithub>["api"], expectedHead?: string, dryRun?: boolean }} options
 */
export async function addDependencyChangeset({ repository, number, api, expectedHead, dryRun = false }) {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid dependency pull request number")
    const pull = await api(`pulls/${number}`)
    if (pull?.state !== "open" || pull.merged) return { skipped: true, reason: "Dependency pull request is not open" }
    if (pull.number !== number || !runtimePull(pull, repository))
        return { skipped: true, reason: "Not a same-repository SDK runtime Dependabot pull request" }
    if (expectedHead !== undefined && pull.head.sha !== expectedHead)
        return { skipped: true, reason: "Dependency branch changed since the completed Check" }
    if (!/^[a-f0-9]{40}$/.test(pull.head?.sha ?? "") || !/^[a-f0-9]{40}$/.test(pull.base?.sha ?? ""))
        throw new Error("Invalid dependency source commit")
    const files = await pullFiles(api, number)
    const path = `projects/.changeset/runtime-dependencies-${number}.md`
    if (files.some((file) => file.filename === path && file.previous_filename !== undefined))
        return { skipped: true, reason: "Renamed release notes need manual review" }
    const before = await manifest(api, pull.base.sha)
    const after = await manifest(api, pull.head.sha)
    const plan = planDependencyChangeset({ repository, pull, files: files.filter((file) => file.filename !== path), before, after })
    if (plan.skipped) return plan
    const existing = await api(`contents/${path}?ref=${pull.head.sha}`, { allowMissing: true })
    if (existing) {
        if (existing.encoding !== "base64" || typeof existing.content !== "string" ||
            Buffer.from(existing.content, "base64").toString("utf8") !== plan.content)
            return { skipped: true, reason: "Existing release note preserved" }
        if (!dryRun) await ensureCheck(api, pull.head.ref, pull.head.sha)
        return { skipped: true, reason: "Automatic release note already present", head: pull.head.sha }
    }
    if (files.some((file) => file.filename === path))
        return { skipped: true, reason: "An automatic release note was removed, retain the manual decision" }
    if (dryRun) return { ...plan, dryRun: true }
    const head = await commitNote(api, pull, path, plan.content)
    await ensureCheck(api, pull.head.ref, head)
    return { skipped: false, path, head, number }
}

/**
 * Resolve the dependency PR from a completed same-repository Check, without reading
 * artifacts, outputs or executable PR files. Only a successful pull-request run for
 * the exact current dependency head may reach the writer
 * @param {{ repository: string, runId: number, api: ReturnType<typeof createGithub>["api"], dryRun?: boolean }} options
 */
export async function dependencyChangesetForCheck({ repository, runId, api, dryRun = false }) {
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("Invalid dependency Check run ID")
    const run = await api(`actions/runs/${runId}`)
    if (
        run?.event !== "pull_request" || run.status !== "completed" || run.conclusion !== "success" ||
        run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
        run.path !== ".github/workflows/ci.yml" || !/^[a-f0-9]{40}$/.test(run.head_sha ?? "") ||
        typeof run.head_branch !== "string" || !run.head_branch.startsWith("dependabot/npm_and_yarn/projects/sdk-runtime-")
    ) return { skipped: true, reason: "Not a completed same-repository runtime dependency Check" }
    const pulls = await api(`commits/${run.head_sha}/pulls?per_page=100`)
    if (!Array.isArray(pulls) || pulls.length >= 100) throw new Error("Invalid or oversized dependency PR association")
    const eligible = pulls.filter((pull) => pull.state === "open" && runtimePull(pull, repository) &&
        pull.head.sha === run.head_sha && pull.head.ref === run.head_branch)
    if (eligible.length !== 1) return { skipped: true, reason: "No unique current dependency PR for this Check" }
    return addDependencyChangeset({ repository, number: eligible[0].number, api, expectedHead: run.head_sha, dryRun })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const repository = process.env.GITHUB_REPOSITORY
    const runId = Number(process.env.DEPENDENCY_CHECK_RUN_ID)
    dependencyChangesetForCheck({ repository: repository ?? "", runId, api: createGithub(repository).api, dryRun: process.argv.includes("--dry-run") })
        .then((result) => console.log(JSON.stringify(result)))
        .catch(() => { console.error("Dependency Changeset automation failed, inspect the source and branch state before rerunning"); process.exitCode = 1 })
}
