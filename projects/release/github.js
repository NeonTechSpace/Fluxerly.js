// @ts-check

import { execFile } from "node:child_process"
import { appendFile, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readCandidate } from "./candidate.js"
import { sha256 } from "./content.js"
import { compareVersions, parseVersion } from "./planning.js"
import { redact } from "./redact.js"
import { inspectPublished } from "./recovery.js"
import { createRegistries } from "./registries.js"

const commitPattern = /^[a-f0-9]{40}$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const assetNames = ["notes.md", "docs.json", "candidate.json", "checksum.txt", "sdk.tgz"]
const sdkName = "@neontechspace/fluxerly"

// A GitHub request failure. HTTP 4xx responses definitely rejected the request, while network failures, timeouts and
// 5xx responses leave its outcome uncertain
export class GitHubCommandError extends Error {
    /**
     * @param {string} message
     * @param {number} [status]
     */
    constructor(message, status) {
        super(message)
        this.status = status
    }
}

/** @param {unknown} error */
export function isDefiniteRejection(error) {
    return error instanceof GitHubCommandError && error.status !== undefined && error.status >= 400 && error.status < 500
}

/**
 * @param {unknown} error
 * @param {string} operation
 */
function rejected(error, operation) {
    return new Error(
        `GitHub rejected the ${operation} with HTTP ${/** @type {GitHubCommandError} */ (error).status}. The request made no change. Resolve the cause, such as App permissions or tag rules, then rerun Release publish with the same candidate`,
    )
}

export async function announceRelease(candidate, directory, github, registries = createRegistries()) {
    const status = await inspectPublished(candidate, registries)
    if (!status.complete)
        throw new Error(
            status.npm === "different"
                ? "npm serves different bytes than the reviewed candidate, the release is not announced"
                : "npm version must be published before announcing the release",
        )
    return reconcileRelease(candidate, directory, github)
}

/**
 * Fails unless the commit is main or one of its ancestors, using a read-only comparison
 * @param {{ api(path: string): Promise<any> }} github
 * @param {string} commit
 */
export async function assertReachableFromMain(github, commit) {
    if (!commitPattern.test(commit)) throw new Error("Candidate source must be an exact commit")
    let comparison
    try {
        comparison = await github.api(`compare/main...${commit}`)
    } catch {
        throw new Error("Candidate source reachability from main could not be verified")
    }
    if (!["behind", "identical"].includes(comparison?.status) || comparison.ahead_by !== 0)
        throw new Error("Candidate source is not reachable from main, prepare a candidate from merged main source")
}

/**
 * Decides whether a push to main should prepare a candidate: The SDK version changed in the push and npm does not
 * have it yet
 * @param {{ before: string | undefined, after: string, readVersion: (commit: string) => Promise<string>, registries: any }} options
 */
export async function releaseTrigger({ before, after, readVersion, registries }) {
    if (!commitPattern.test(after)) throw new Error("Pushed commit must be an exact commit")
    const version = await readVersion(after)
    if (parseVersion(version).major < 1000) return { prepare: false, version, reason: "Not a public release version" }
    const previous = before && commitPattern.test(before) && !/^0+$/.test(before) ? await readVersion(before) : null
    if (previous === version) return { prepare: false, version, reason: "The push did not change the SDK version" }
    const inventory = await registries.inventory(sdkName, { allowMissing: true })
    if (inventory.npmVersions.includes(version)) return { prepare: false, version, reason: "npm already has this version" }
    return { prepare: true, version, reason: "The push changed the SDK version to one that npm does not have" }
}

export function validatePreparation(run, artifacts, { repository, runId, workflow }) {
    if (!repositoryPattern.test(repository) || !/^[1-9]\d*$/.test(String(runId)))
        throw new Error("Invalid preparation repository or run ID")
    if (
        run.id !== Number(runId) ||
        run.repository?.full_name !== repository ||
        run.head_repository?.full_name !== repository ||
        run.event !== "workflow_dispatch" ||
        run.status !== "completed" ||
        run.conclusion !== "success" ||
        run.path !== ".github/workflows/release-prepare.yml" ||
        run.workflow_id !== workflow.id ||
        workflow.path !== ".github/workflows/release-prepare.yml" ||
        !commitPattern.test(run.head_sha)
    )
        throw new Error("Preparation is not a successful manual run of this repository's release-prepare workflow")
    const candidates = artifacts.filter((artifact) => artifact.name.startsWith("release-candidate-"))
    if (candidates.length !== 1) throw new Error("Preparation must have exactly one named candidate artifact")
    const artifact = candidates[0]
    const sourceCommit = artifact.name.slice("release-candidate-".length)
    if (
        artifact.expired ||
        !commitPattern.test(sourceCommit) ||
        !Number.isSafeInteger(artifact.id) ||
        artifact.workflow_run?.id !== run.id ||
        artifact.workflow_run?.head_sha !== run.head_sha ||
        artifact.workflow_run?.repository_id !== run.repository.id ||
        artifact.workflow_run?.head_repository_id !== run.repository.id
    )
        throw new Error("Candidate artifact is expired or has inconsistent preparation provenance")
    // A dispatch run's head SHA identifies the workflow ref, not inputs.source_ref
    return { artifactId: artifact.id, artifactName: artifact.name, sourceCommit, workflowCommit: run.head_sha }
}

export async function reconcileRelease(
    candidate,
    directory,
    github,
    {
        wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        now = () => performance.now(),
        visibilityTimeout = 60_000,
        delay = 5000,
    } = {},
) {
    if (!commitPattern.test(candidate.sourceCommit) || !candidate.docs)
        throw new Error("GitHub announcements require the checked source commit and documentation snapshot")
    if (!Number.isFinite(visibilityTimeout) || visibilityTimeout < 0 || !Number.isFinite(delay) || delay <= 0)
        throw new Error("Invalid GitHub release visibility deadline or delay")
    parseVersion(candidate.version)
    const tag = `v${candidate.version}`
    const notes = await readFile(join(directory, "notes.md"), "utf8")
    /** @type {Map<string, Buffer>} */
    const expected = new Map(
        await Promise.all(
            assetNames.map(async (name) => /** @type {[string, Buffer]} */ ([name, await readFile(join(directory, name))])),
        ),
    )
    async function readRelease(id) {
        const byId = id === undefined ? null : await github.releaseById(id)
        return byId ?? github.release(tag)
    }
    /**
     * @param {number | undefined} id
     * @param {(release: any) => boolean} [matches]
     */
    async function awaitVisibility(id, matches = () => true) {
        const started = now()
        for (;;) {
            const visible = await readRelease(id)
            if (visible && matches(visible)) return visible
            const remaining = visibilityTimeout - (now() - started)
            if (remaining <= 0) return visible
            await wait(Math.min(delay, remaining))
        }
    }
    async function awaitLatest() {
        const started = now()
        for (;;) {
            const latestRelease = await github.latest()
            if (latestRelease?.tag_name === tag) return true
            const remaining = visibilityTimeout - (now() - started)
            if (remaining <= 0) return false
            await wait(Math.min(delay, remaining))
        }
    }
    async function awaitTagCommit() {
        const started = now()
        for (;;) {
            const commit = await github.tagCommit(tag)
            if (commit === candidate.sourceCommit) return true
            if (commit !== null) return false
            const remaining = visibilityTimeout - (now() - started)
            if (remaining <= 0) return false
            await wait(Math.min(delay, remaining))
        }
    }
    let release = await github.release(tag)
    let createdHere = false
    if (!release) {
        const existingCommit = await github.tagCommit(tag)
        if (existingCommit !== null && existingCommit !== candidate.sourceCommit)
            throw new Error("Existing GitHub tag source conflicts with this candidate")
        let created
        try {
            created = await github.create({
                tag_name: tag,
                target_commitish: candidate.sourceCommit,
                name: tag,
                body: notes,
                draft: true,
                prerelease: candidate.channel !== "stable",
                make_latest: "false",
            })
        } catch (error) {
            if (isDefiniteRejection(error)) throw rejected(error, "release creation")
            // A network or server failure can follow a completed creation. Never create again here, read back instead
        }
        release = await awaitVisibility(created?.id)
        if (!release)
            throw new Error(
                "GitHub release creation is unconfirmed after a network or server failure, rerun Release publish with the same candidate to reconcile it",
            )
        createdHere = true
    }
    const taggedCommit = await github.tagCommit(tag)
    if (
        (taggedCommit !== candidate.sourceCommit &&
            !(taggedCommit === null && release.draft && release.target_commitish === candidate.sourceCommit)) ||
        release.tag_name !== tag ||
        release.name !== tag ||
        release.body !== notes ||
        release.prerelease !== (candidate.channel !== "stable")
    )
        throw new Error("Existing GitHub release tag, source, notes or readiness conflicts with this candidate")
    // The upload command resolves a draft by tag, not by release ID
    if (createdHere) {
        const tagVisible = await awaitVisibility(undefined, (item) => item.id === release.id)
        if (tagVisible?.id !== release.id)
            throw new Error("GitHub release tag is not visible for asset upload, rerun Release publish with the same candidate")
    }
    for (const asset of release.assets) {
        if (!expected.has(asset.name)) throw new Error("Existing GitHub release contains an unexpected asset")
    }
    for (const [name, bytes] of expected) {
        let matches = release.assets.filter((asset) => asset.name === name)
        if (matches.length > 1) throw new Error("GitHub release contains duplicate named assets")
        if (matches.length && matches[0].state !== "uploaded") {
            const incomplete = matches[0]
            try {
                await github.deleteAsset(incomplete.id)
            } catch (error) {
                if (isDefiniteRejection(error)) throw rejected(error, `${name} asset deletion`)
                // A failed upload can leave a starter asset. Confirm deletion before attempting its replacement
            }
            release = await awaitVisibility(release.id, (item) =>
                !item.assets.some((asset) => asset.id === incomplete.id),
            )
            if (!release || release.assets.some((asset) => asset.id === incomplete.id))
                throw new Error(
                    "GitHub release asset deletion is unconfirmed, rerun Release publish with the same candidate",
                )
            matches = release.assets.filter((asset) => asset.name === name)
        }
        if (!matches.length) {
            try {
                await github.upload(tag, join(directory, name))
            } catch (error) {
                if (isDefiniteRejection(error)) throw rejected(error, `${name} asset upload`)
                // Do not clobber an existing asset after an uncertain upload result
            }
            release = await awaitVisibility(release.id, (item) =>
                item.assets.some((asset) => asset.name === name && asset.state === "uploaded"),
            )
            if (!release)
                throw new Error(
                    "GitHub release asset contents are unconfirmed or conflicting, rerun Release publish with the same candidate",
                )
        }
        const assets = release.assets.filter((asset) => asset.name === name)
        if (
            assets.length !== 1 ||
            assets[0].state !== "uploaded" ||
            assets[0].size !== bytes.length ||
            sha256(await github.download(assets[0].id)) !== sha256(bytes)
        )
            throw new Error("GitHub release asset contents are unconfirmed or conflicting, rerun Release publish with the same candidate")
    }
    const versions = (await github.releases())
        .filter((item) => !item.draft && !item.prerelease)
        .map((item) => {
            try {
                parseVersion(item.tag_name.slice(1))
                return item.tag_name.startsWith("v") ? item.tag_name.slice(1) : null
            } catch {
                return null
            }
        })
        .filter(Boolean)
    const latest =
        candidate.channel === "stable" && versions.every((version) => compareVersions(candidate.version, version) >= 0)
    if (release.draft) {
        try {
            await github.update(release.id, {
                draft: false,
                target_commitish: candidate.sourceCommit,
                make_latest: latest ? "true" : "false",
            })
        } catch (error) {
            if (isDefiniteRejection(error)) throw rejected(error, "release publication update")
            // A network or server failure can follow a completed update. Reconcile without repeating it
        }
    } else if (latest && (await github.latest())?.tag_name !== tag) {
        try {
            await github.update(release.id, { make_latest: "true" })
        } catch (error) {
            if (isDefiniteRejection(error)) throw rejected(error, "latest-release update")
            // Confirm the latest-release state without issuing a second update
        }
    }
    const final = await awaitVisibility(release.id, (item) => !item.draft && item.assets.length === expected.size)
    if (
        !final ||
        final.draft ||
        final.body !== notes ||
        final.prerelease !== (candidate.channel !== "stable") ||
        !(await awaitTagCommit()) ||
        final.assets.length !== expected.size
    )
        throw new Error("GitHub release final readback does not match this candidate")
    for (const [name, bytes] of expected) {
        const asset = final.assets.find((item) => item.name === name)
        if (
            !asset ||
            asset.state !== "uploaded" ||
            asset.size !== bytes.length ||
            sha256(await github.download(asset.id)) !== sha256(bytes)
        )
            throw new Error("GitHub release final asset readback does not match this candidate")
    }
    if (latest && !(await awaitLatest()))
        throw new Error("GitHub latest-release readback failed, rerun Release publish with the same candidate")
    return { tag, sourceCommit: candidate.sourceCommit, url: final.html_url, latest }
}

/**
 * Classifies a failed gh command from its redacted stderr
 * @param {string} stderr
 */
export function commandFailure(stderr) {
    const status = /\bHTTP (\d{3})\b/.exec(stderr)?.[1]
    return status
        ? new GitHubCommandError(`GitHub request failed with HTTP ${status}`, Number(status))
        : new GitHubCommandError("GitHub command failed or exceeded its deadline")
}

/**
 * Runs gh and surfaces its redacted stderr, so failures remain diagnosable without exposing tokens
 * @param {string[]} args
 * @param {{ input?: unknown, binary?: boolean, allowMissing?: boolean }} [options]
 * @returns {Promise<any>}
 */
function command(args, { input, binary = false, allowMissing = false } = {}) {
    return new Promise((resolve_, reject) => {
        const child = execFile(
            "gh",
            args,
            { encoding: binary ? "buffer" : "utf8", timeout: 60_000, maxBuffer: 128 * 1024 * 1024, windowsHide: true },
            (error, stdout, stderr) => {
                const diagnostics = redact(String(stderr ?? "")).trim()
                const failure = error ? commandFailure(diagnostics) : undefined
                const missing = allowMissing && failure?.status === 404
                if (diagnostics && !missing) process.stderr.write(`${diagnostics}\n`)
                if (failure) {
                    if (missing) resolve_(null)
                    else reject(failure)
                } else {
                    try {
                        resolve_(binary ? stdout : JSON.parse(String(stdout)))
                    } catch {
                        reject(new Error("GitHub command returned invalid JSON"))
                    }
                }
            },
        )
        if (input !== undefined) child.stdin?.end(JSON.stringify(input))
    })
}

/**
 * @param {string | undefined} repository
 * @param {typeof command} [request]
 */
export function createGithub(repository, request = command) {
    if (!repository || !repositoryPattern.test(repository)) throw new Error("Invalid GitHub repository")
    const root = `repos/${repository}`
    /**
     * @param {string} path
     * @param {{ input?: unknown, method?: string, binary?: boolean, empty?: boolean, allowMissing?: boolean }} [options]
     * Binary requests ask for raw asset bytes. Empty requests keep the JSON Accept header and skip parsing a body-less response
     */
    function api(path, { input, method, binary, empty, allowMissing } = {}) {
        const args = ["api", `${root}/${path}`, "-H", "X-GitHub-Api-Version: 2022-11-28"]
        if (method) args.push("--method", method)
        if (input) args.push("--input", "-")
        if (binary) args.push("-H", "Accept: application/octet-stream")
        return request(args, { input, binary: binary || empty, allowMissing })
    }
    /**
     * @param {string} path
     * @param {string} [key]
     */
    async function pages(path, key) {
        const result = []
        for (let page = 1; page <= 100; page++) {
            const response = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
            const values = key ? response[key] : response
            if (!Array.isArray(values)) throw new Error("GitHub inventory is invalid")
            result.push(...values)
            if (values.length < 100) return result
        }
        throw new Error("GitHub inventory exceeded the pagination bound")
    }
    return {
        api,
        /**
         * Append one file with an atomic expected-head condition, including protection
         * against concurrent branch rewinds. The provider owns commit and ref creation
         * @this {void}
         * @param {{ branch: string, head: string, message: string, path: string, content: string }} change
         * @returns {Promise<string>}
         */
        async commitOnBranch(change) {
            const query = "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } ref { target { oid } } } }"
            const result = await request(["api", "graphql", "--input", "-"], { input: {
                query, variables: { input: {
                    branch: { repositoryNameWithOwner: repository, branchName: change.branch },
                    expectedHeadOid: change.head,
                    message: { headline: change.message },
                    fileChanges: { additions: [{ path: change.path, contents: Buffer.from(change.content).toString("base64") }] },
                } },
            } })
            const created = result?.data?.createCommitOnBranch
            if (!commitPattern.test(created?.commit?.oid ?? "") || created.ref?.target?.oid !== created.commit.oid)
                throw new Error("Atomic branch commit is unconfirmed, inspect the branch before rerunning")
            return created.commit.oid
        },
        /** @param {string} runId */
        artifacts: (runId) => pages(`actions/runs/${runId}/artifacts`, "artifacts"),
        /** @param {string} tag */
        async release(tag) {
            const published = await api(`releases/tags/${encodeURIComponent(tag)}`, { allowMissing: true })
            if (published) return published
            // The tag endpoint only promises published releases, drafts require the authenticated inventory
            const matches = (await pages("releases")).filter((release) => release.tag_name === tag)
            if (matches.length > 1) throw new Error("GitHub has ambiguous releases for this tag")
            return matches[0] ?? null
        },
        /** @param {number} id */
        releaseById: (id) => api(`releases/${id}`, { allowMissing: true }),
        /** @param {object} input */
        create: (input) => api("releases", { method: "POST", input }),
        /**
         * @param {number} id
         * @param {object} input
         */
        update: (id, input) => api(`releases/${id}`, { method: "PATCH", input }),
        releases: () => pages("releases"),
        latest: () => api("releases/latest", { allowMissing: true }),
        /** @param {string} tag */
        async tagCommit(tag) {
            const ref = await api(`git/ref/tags/${encodeURIComponent(tag)}`, { allowMissing: true })
            if (!ref) return null
            let object = ref.object
            for (let depth = 0; depth < 8 && object.type === "tag"; depth++)
                object = (await api(`git/tags/${object.sha}`)).object
            if (object.type !== "commit" || !commitPattern.test(object.sha))
                throw new Error("Release tag does not resolve to a commit")
            return object.sha
        },
        /** @param {string} commit */
        async sdkVersion(commit) {
            const file = await api(`contents/projects/sdk/package.json?ref=${commit}`)
            if (file?.encoding !== "base64" || typeof file.content !== "string")
                throw new Error("SDK manifest could not be read from GitHub")
            const version = JSON.parse(Buffer.from(file.content, "base64").toString("utf8")).version
            if (typeof version !== "string") throw new Error("SDK manifest has no version")
            return version
        },
        /** @param {number} id */
        deleteAsset: (id) => api(`releases/assets/${id}`, { method: "DELETE", empty: true }),
        /** @param {number} id */
        download: (id) => api(`releases/assets/${id}`, { binary: true }),
        /**
         * @param {string} tag
         * @param {string} path
         */
        upload: (tag, path) => command(["release", "upload", tag, path, "--repo", repository], { binary: true }),
    }
}

/**
 * @param {Record<string, string | number | boolean>} values
 */
async function writeOutputs(values) {
    const path = process.env.GITHUB_OUTPUT
    if (!path) return
    for (const [name, value] of Object.entries(values)) {
        const text = String(value)
        if (/[\r\n]/.test(text)) throw new Error("Workflow output values must be single lines")
        await appendFile(path, `${name}=${text}\n`)
    }
}

/** @param {string | undefined} name */
function environment(name) {
    const value = name ? process.env[name] : undefined
    if (!value) throw new Error(`${name} is required`)
    return value
}

async function main() {
    const github = createGithub(process.env.GITHUB_REPOSITORY)
    const action = process.argv[2]
    if (action === "preparation") {
        const runId = process.env.PREPARATION_RUN_ID ?? ""
        if (!/^[1-9]\d*$/.test(runId)) throw new Error("Preparation needs a numeric run ID")
        const run = await github.api(`actions/runs/${runId}`)
        const workflow = await github.api("actions/workflows/release-prepare.yml")
        const result = validatePreparation(run, await github.artifacts(runId), {
            repository: environment("GITHUB_REPOSITORY"),
            runId,
            workflow,
        })
        if ((await github.api(`commits/${result.sourceCommit}`)).sha !== result.sourceCommit)
            throw new Error("Selected candidate source does not resolve in this repository")
        // The candidate commit is data for the tag target, so it must already be part of main
        await assertReachableFromMain(github, result.sourceCommit)
        await writeOutputs(result)
    } else if (action === "inspect" || action === "announce") {
        const directory = resolve(environment("CANDIDATE_DIRECTORY"))
        const checksum = process.env.CANDIDATE_CHECKSUM ?? ""
        if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Externally reviewed checksum is required")
        const candidate = await readCandidate(directory, { checksum })
        if (candidate.sourceCommit !== process.env.CANDIDATE_SOURCE_COMMIT || !candidate.docs)
            throw new Error("Candidate source does not match its preparation artifact")
        if (action === "announce") {
            const result = await announceRelease(candidate, directory, github)
            console.log(JSON.stringify(result))
        } else {
            console.log(JSON.stringify({ version: candidate.version, sourceCommit: candidate.sourceCommit, checksum }))
            await writeOutputs({ version: candidate.version })
        }
    } else if (action === "prepare-trigger") {
        const result = await releaseTrigger({
            before: process.env.BEFORE_SHA,
            after: environment("AFTER_SHA"),
            readVersion: (commit) => github.sdkVersion(commit),
            registries: createRegistries(),
        })
        console.log(JSON.stringify(result))
        await writeOutputs({ prepare: result.prepare, version: result.version })
    } else throw new Error("Use preparation, inspect, announce or prepare-trigger")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : "GitHub release operation failed")
        process.exitCode = 1
    })
