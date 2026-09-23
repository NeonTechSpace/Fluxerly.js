import { execFile } from "node:child_process"
import { appendFile, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readCandidate } from "./candidate.js"
import { sha256 } from "./content.js"
import { compareVersions, parseVersion } from "./planning.js"
import { inspectPublished } from "./recovery.js"
import { createRegistries } from "./registries.js"

const commitPattern = /^[a-f0-9]{40}$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const assetNames = ["notes.md", "docs.json", "candidate.json", "checksum.txt", "sdk.tgz"]

export async function announceRelease(candidate, directory, github, registries = createRegistries()) {
    const status = await inspectPublished(candidate, registries)
    if (!status.complete) throw new Error("npm version must be published before announcing the release")
    return reconcileRelease(candidate, directory, github)
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
    const expected = new Map(
        await Promise.all(assetNames.map(async (name) => [name, await readFile(join(directory, name))])),
    )
    async function readRelease(id) {
        const byId = id === undefined ? null : await github.releaseById(id)
        return byId ?? github.release(tag)
    }
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
        } catch {
            // A failed response can follow a completed creation. Never create again here
        }
        release = await awaitVisibility(created?.id)
        if (!release) throw new Error("GitHub release creation is unconfirmed, retry the same candidate")
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
            throw new Error("GitHub release tag is not visible for asset upload, retry the same candidate")
    }
    for (const asset of release.assets) {
        if (!expected.has(asset.name)) throw new Error("Existing GitHub release contains an unexpected asset")
    }
    for (const [name, bytes] of expected) {
        const matches = release.assets.filter((asset) => asset.name === name)
        if (matches.length > 1) throw new Error("GitHub release contains duplicate named assets")
        if (!matches.length) {
            try {
                await github.upload(tag, join(directory, name))
            } catch {
                // Do not clobber an existing asset after an uncertain upload result
            }
            release = await awaitVisibility(release.id, (item) =>
                item.assets.some((asset) => asset.name === name && asset.state === "uploaded"),
            )
            if (!release)
                throw new Error("GitHub release asset contents are unconfirmed or conflicting, retry the same candidate")
        }
        const assets = release.assets.filter((asset) => asset.name === name)
        if (
            assets.length !== 1 ||
            assets[0].state !== "uploaded" ||
            assets[0].size !== bytes.length ||
            sha256(await github.download(assets[0].id)) !== sha256(bytes)
        )
            throw new Error("GitHub release asset contents are unconfirmed or conflicting, retry the same candidate")
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
        } catch {
            // A failed response can follow a completed update. Reconcile without repeating it
        }
    } else if (latest && (await github.latest())?.tag_name !== tag) {
        try {
            await github.update(release.id, { make_latest: "true" })
        } catch {
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
        throw new Error("GitHub latest-release readback failed, retry this candidate")
    return { tag, sourceCommit: candidate.sourceCommit, url: final.html_url, latest }
}

function command(args, { input, binary = false, allowMissing = false } = {}) {
    return new Promise((resolve_, reject) => {
        const child = execFile(
            "gh",
            args,
            { encoding: binary ? "buffer" : "utf8", timeout: 60_000, maxBuffer: 128 * 1024 * 1024, windowsHide: true },
            (error, stdout, stderr) => {
                if (error) {
                    if (allowMissing && /\(HTTP 404\)/.test(String(stderr))) resolve_(null)
                    else reject(new Error("GitHub command failed or exceeded its deadline"))
                } else {
                    try {
                        resolve_(binary ? stdout : JSON.parse(stdout))
                    } catch {
                        reject(new Error("GitHub command returned invalid JSON"))
                    }
                }
            },
        )
        if (input !== undefined) child.stdin.end(JSON.stringify(input))
    })
}

export function createGithub(repository) {
    if (!repositoryPattern.test(repository)) throw new Error("Invalid GitHub repository")
    const root = `repos/${repository}`
    function api(path, { input, method, binary, allowMissing } = {}) {
        const args = ["api", `${root}/${path}`, "-H", "X-GitHub-Api-Version: 2022-11-28"]
        if (method) args.push("--method", method)
        if (input) args.push("--input", "-")
        if (binary) args.push("-H", "Accept: application/octet-stream")
        return command(args, { input, binary, allowMissing })
    }
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
        artifacts: (runId) => pages(`actions/runs/${runId}/artifacts`, "artifacts"),
        async release(tag) {
            const published = await api(`releases/tags/${encodeURIComponent(tag)}`, { allowMissing: true })
            if (published) return published
            // The tag endpoint only promises published releases, drafts require the authenticated inventory
            const matches = (await pages("releases")).filter((release) => release.tag_name === tag)
            if (matches.length > 1) throw new Error("GitHub has ambiguous releases for this tag")
            return matches[0] ?? null
        },
        releaseById: (id) => api(`releases/${id}`, { allowMissing: true }),
        create: (input) => api("releases", { method: "POST", input }),
        update: (id, input) => api(`releases/${id}`, { method: "PATCH", input }),
        releases: () => pages("releases"),
        latest: () => api("releases/latest", { allowMissing: true }),
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
        download: (id) => api(`releases/assets/${id}`, { binary: true }),
        upload: (tag, path) => command(["release", "upload", tag, path, "--repo", repository], { binary: true }),
    }
}

async function main() {
    const github = createGithub(process.env.GITHUB_REPOSITORY)
    const action = process.argv[2]
    if (action === "preparation") {
        const runId = process.env.PREPARATION_RUN_ID
        if (!/^[1-9]\d*$/.test(runId ?? "")) throw new Error("Preparation needs a numeric run ID")
        const run = await github.api(`actions/runs/${runId}`)
        const workflow = await github.api("actions/workflows/release-prepare.yml")
        const result = validatePreparation(run, await github.artifacts(runId), {
            repository: process.env.GITHUB_REPOSITORY,
            runId,
            workflow,
        })
        if ((await github.api(`commits/${result.sourceCommit}`)).sha !== result.sourceCommit)
            throw new Error("Selected candidate source does not resolve in this repository")
        for (const [name, value] of Object.entries(result))
            await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
    } else if (["inspect", "announce"].includes(action)) {
        const directory = resolve(process.env.CANDIDATE_DIRECTORY)
        const checksum = process.env.CANDIDATE_CHECKSUM
        if (!/^[a-f0-9]{64}$/.test(checksum ?? "")) throw new Error("Externally reviewed checksum is required")
        const candidate = await readCandidate(directory, { checksum })
        if (candidate.sourceCommit !== process.env.CANDIDATE_SOURCE_COMMIT || !candidate.docs)
            throw new Error("Candidate source does not match its preparation artifact")
        if (action === "announce") {
            const result = await announceRelease(candidate, directory, github)
            console.log(JSON.stringify(result))
        } else
            console.log(JSON.stringify({ version: candidate.version, sourceCommit: candidate.sourceCommit, checksum }))
    } else throw new Error("Use preparation, inspect or announce")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : "GitHub release operation failed")
        process.exitCode = 1
    })
