// @ts-check

// Read-only comparison of pinned upstream Fluxer protocol documents with the upstream default branch
import { createHash } from "node:crypto"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const manifestPath = fileURLToPath(new URL("./upstream/manifest.json", import.meta.url))
const commitPattern = /^[a-f0-9]{40}$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const maximumBytes = 32 * 1024 * 1024
const listLimit = 30

/**
 * @typedef {{ path: string, sha256: string }} PinnedFile
 * @typedef {{ repository: string, branch: string, commit: string, files: { openapi: PinnedFile, gatewayEvents: PinnedFile } }} Manifest
 * @typedef {{ resolveCommit(repository: string, branch: string): Promise<string>, fetchFile(repository: string, commit: string, path: string): Promise<Buffer> }} Source
 */

const sha256 = (/** @type {Buffer} */ bytes) => createHash("sha256").update(bytes).digest("hex")

/** @param {any} manifest @returns {Manifest} */
export function validateManifest(manifest) {
    const files = manifest?.files
    if (
        !repositoryPattern.test(manifest?.repository ?? "") ||
        typeof manifest.branch !== "string" ||
        !commitPattern.test(manifest.commit ?? "") ||
        !files ||
        Object.keys(files).sort().join(",") !== "gatewayEvents,openapi" ||
        Object.values(files).some(
            (file) =>
                typeof file?.path !== "string" ||
                file.path.startsWith("/") ||
                file.path.split("/").includes("..") ||
                !/^[a-f0-9]{64}$/.test(file.sha256 ?? ""),
        )
    )
        throw new Error("Upstream manifest is invalid")
    return manifest
}

/**
 * Lists OpenAPI component schemas that were added, removed or changed
 * @param {any} before
 * @param {any} after
 */
export function schemaChanges(before, after) {
    const previous = before?.components?.schemas ?? {}
    const current = after?.components?.schemas ?? {}
    const names = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort()
    return {
        added: names.filter((name) => !(name in previous)),
        removed: names.filter((name) => !(name in current)),
        changed: names.filter(
            (name) => name in previous && name in current && JSON.stringify(previous[name]) !== JSON.stringify(current[name]),
        ),
    }
}

/**
 * Reads gateway Dispatch event names from the events document headings
 * @param {string} markdown
 */
export function eventNames(markdown) {
    const names = new Set()
    for (const line of markdown.split(/\r?\n/)) {
        const match = /^###\s+(?:<span[^>]*><\/span>\s*)?([A-Z][A-Z0-9_]*)\s*$/.exec(line)
        if (match) names.add(match[1])
    }
    return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * @param {string[]} before
 * @param {string[]} after
 */
function listChanges(before, after) {
    return { added: after.filter((name) => !before.includes(name)), removed: before.filter((name) => !after.includes(name)) }
}

/**
 * Compares the pinned documents with the upstream branch. Only when a hash changed are the pinned documents also read,
 * to describe the difference
 * @param {Manifest} manifest
 * @param {Source} source
 */
export async function checkUpstream(manifest, source) {
    validateManifest(manifest)
    const commit = await source.resolveCommit(manifest.repository, manifest.branch)
    if (!commitPattern.test(commit)) throw new Error("Upstream branch did not resolve to a commit")
    /** @type {Record<string, { path: string, pinned: string, current: string, changed: boolean, bytes: Buffer }>} */
    const files = {}
    for (const [key, file] of Object.entries(manifest.files)) {
        const bytes = await source.fetchFile(manifest.repository, commit, file.path)
        const current = sha256(bytes)
        files[key] = { path: file.path, pinned: file.sha256, current, changed: current !== file.sha256, bytes }
    }
    /** @type {{ schemas?: ReturnType<typeof schemaChanges>, events?: ReturnType<typeof listChanges> }} */
    const differences = {}
    if (files.openapi.changed) {
        const pinned = await source.fetchFile(manifest.repository, manifest.commit, manifest.files.openapi.path)
        differences.schemas = schemaChanges(JSON.parse(pinned.toString("utf8")), JSON.parse(files.openapi.bytes.toString("utf8")))
    }
    if (files.gatewayEvents.changed) {
        const pinned = await source.fetchFile(manifest.repository, manifest.commit, manifest.files.gatewayEvents.path)
        differences.events = listChanges(
            eventNames(pinned.toString("utf8")),
            eventNames(files.gatewayEvents.bytes.toString("utf8")),
        )
    }
    return {
        repository: manifest.repository,
        pinnedCommit: manifest.commit,
        commit,
        drift: Object.values(files).some((file) => file.changed),
        files: Object.fromEntries(
            Object.entries(files).map(([key, { path, pinned, current, changed }]) => [key, { path, pinned, current, changed }]),
        ),
        ...differences,
    }
}

/** @param {string} value */
function escape(value) {
    // oxlint-disable-next-line no-control-regex -- Control characters are replaced so upstream text cannot break the summary
    return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[&<>|`*_[\]\\]/g, (character) => `&#${character.charCodeAt(0)};`)
}

/**
 * @param {string} label
 * @param {string[]} names
 */
function nameList(label, names) {
    if (!names.length) return []
    const shown = names.slice(0, listLimit).map(escape).join(", ")
    return [`- ${label} (${names.length}): ${shown}${names.length > listLimit ? `, and ${names.length - listLimit} more` : ""}`]
}

/** @param {Awaited<ReturnType<typeof checkUpstream>>} result */
export function renderReport(result) {
    const lines = [
        "## Upstream Fluxer drift",
        "",
        result.drift
            ? "Upstream documents differ from the pinned manifest. Review the changes, then update the manifest"
            : "Upstream documents match the pinned manifest",
        "",
        `Pinned commit: ${escape(result.pinnedCommit)}`,
        "",
        `Current ${escape(result.repository)} commit: ${escape(result.commit)}`,
        "",
        "| Document | Result |",
        "| --- | --- |",
        ...Object.values(result.files).map((file) => `| ${escape(file.path)} | ${file.changed ? "changed" : "unchanged"} |`),
        "",
    ]
    if (result.schemas) {
        const { added, removed, changed } = result.schemas
        lines.push("### OpenAPI component schemas", "")
        const details = [...nameList("Added", added), ...nameList("Removed", removed), ...nameList("Changed", changed)]
        lines.push(...(details.length ? details : ["- Only content outside component schemas changed"]), "")
    }
    if (result.events) {
        const details = [...nameList("Added", result.events.added), ...nameList("Removed", result.events.removed)]
        lines.push("### Gateway Dispatch events", "")
        lines.push(...(details.length ? details : ["- Event names are unchanged, only their descriptions changed"]), "")
    }
    return lines.join("\n")
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 */
async function download(url, headers) {
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) })
    if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Upstream request returned HTTP ${response.status}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maximumBytes) throw new Error("Upstream document exceeds the byte limit")
    return bytes
}

/** @type {Source} */
const githubSource = {
    async resolveCommit(repository, branch) {
        /** @type {Record<string, string>} */
        const headers = { accept: "application/vnd.github.sha", "x-github-api-version": "2022-11-28" }
        if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
        const url = `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(branch)}`
        return (await download(url, headers)).toString("utf8").trim()
    },
    fetchFile(repository, commit, path) {
        if (!commitPattern.test(commit)) throw new Error("Upstream files are read only at exact commits")
        const encoded = path.split("/").map(encodeURIComponent).join("/")
        return download(`https://raw.githubusercontent.com/${repository}/${commit}/${encoded}`, {})
    },
}

async function main() {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args.length === 1 && args[0] !== "--update")) throw new Error("Use no arguments or --update")
    const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")))
    const result = await checkUpstream(manifest, githubSource)
    if (args[0] === "--update") {
        manifest.commit = result.commit
        for (const [key, file] of Object.entries(result.files))
            manifest.files[/** @type {keyof Manifest["files"]} */ (key)].sha256 = file.current
        await writeFile(manifestPath, JSON.stringify(manifest, null, 4) + "\n")
        console.log(`Pinned ${manifest.repository} at ${result.commit}`)
        return
    }
    const report = renderReport(result)
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report + "\n")
    console.log(report)
    if (result.drift) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : "Upstream drift check failed")
        process.exitCode = 1
    })
