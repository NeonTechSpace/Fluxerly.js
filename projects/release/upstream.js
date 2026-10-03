// @ts-check

// Comparison of upstream Fluxer protocol documents with a reviewed pin or a previous observation
import { createHash } from "node:crypto"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const manifestPath = fileURLToPath(new URL("./upstream/manifest.json", import.meta.url))
const commitPattern = /^[a-f0-9]{40}$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const maximumBytes = 32 * 1024 * 1024
const listLimit = 30
// A regenerated upstream document can change hundreds of schemas, so details stop here to keep the job summary readable
const detailedLimit = 40
const detailLimit = 6
const methods = ["get", "put", "post", "patch", "delete", "options", "head", "trace"]
const schemaPrefix = "#/components/schemas/"
// Security schemes a bot or OAuth2 application can hold. An operation without a requirement needs no token
const applicationSchemes = new Set(["botToken", "oauth2Token", "bearerToken"])
const wordingKeys = new Set(["description", "summary", "example", "examples", "title"])
// Keys under these maps are field names, so a field named description is structure, not wording
const nameMaps = new Set(["properties", "patternProperties", "$defs", "definitions"])
// Values under these keys are data, so a title inside a default value is structure, not wording
const literalKeys = new Set(["default", "const", "enum"])
// Order carries no meaning in these lists, so they compare as sets. Other lists, such as a default value, compare by position
const setKeys = new Set(["enum", "required", "type", "tokens"])

/**
 * @typedef {{ path: string, sha256: string }} PinnedFile
 * @typedef {{ repository: string, branch: string, commit: string, files: { openapi: PinnedFile, gatewayEvents: PinnedFile }, rateLimits: PinnedFile }} Manifest
 * @typedef {{
 *     resolveCommit(repository: string, branch: string): Promise<string>,
 *     fetchFile(repository: string, commit: string, path: string): Promise<Buffer>,
 *     listDirectory(repository: string, commit: string, directory: string): Promise<{ path: string, type: string }[]>,
 * }} Source
 * @typedef {{ added: string[], removed: string[], changed: { name: string, details: string[] }[], wordingOnly: string[] }} ChangeGroup
 * @typedef {{ application: ChangeGroup, userOnly: ChangeGroup }} SurfaceChanges
 * @typedef {{ manifest: Manifest, kind: "previous-run" | "repository-pin", reason?: string }} Baseline
 */

const sha256 = (/** @type {Buffer} */ bytes) => createHash("sha256").update(bytes).digest("hex")
const compare = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0)
const pinnedPath = (/** @type {any} */ file) =>
    typeof file?.path === "string" &&
    !file.path.startsWith("/") &&
    !file.path.split("/").includes("..") &&
    /^[a-f0-9]{64}$/.test(file.sha256 ?? "")

/** @param {any} manifest @returns {Manifest} */
export function validateManifest(manifest) {
    const files = manifest?.files
    if (
        !repositoryPattern.test(manifest?.repository ?? "") ||
        typeof manifest.branch !== "string" ||
        !commitPattern.test(manifest.commit ?? "") ||
        !files ||
        Object.keys(files).sort().join(",") !== "gatewayEvents,openapi" ||
        !Object.values(files).every(pinnedPath) ||
        !pinnedPath(manifest.rateLimits)
    )
        throw new Error("Upstream manifest is invalid")
    return manifest
}

/**
 * Lists structural differences as dotted paths. Lists of plain values under set-valued keys, such as enum and required,
 * compare as sets
 * @param {any} before
 * @param {any} after
 * @param {string} path
 * @param {string[]} out
 * @param {string} [key]
 */
function differences(before, after, path, out, key) {
    if (JSON.stringify(before) === JSON.stringify(after)) return out
    const plain = (/** @type {unknown} */ item) => item === null || typeof item !== "object"
    if (
        key !== undefined &&
        setKeys.has(key) &&
        Array.isArray(before) &&
        Array.isArray(after) &&
        before.every(plain) &&
        after.every(plain)
    ) {
        const member = (/** @type {unknown} */ item) => (typeof item === "string" ? item : show(item))
        const added = after.filter((item) => !before.includes(item)).map((item) => `+ ${member(item)}`)
        const removed = before.filter((item) => !after.includes(item)).map((item) => `- ${member(item)}`)
        if (added.length || removed.length) out.push(`${path}: ${[...added, ...removed].join(", ")}`)
        return out
    }
    const container = (/** @type {unknown} */ value) => value !== null && typeof value === "object"
    if (container(before) && container(after) && Array.isArray(before) === Array.isArray(after)) {
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            const next = Array.isArray(before) ? `${path}[${key}]` : path ? `${path}.${key}` : key
            if (!(key in before)) out.push(`+ ${next}`)
            else if (!(key in after)) out.push(`- ${next}`)
            else differences(before[key], after[key], next, out, Array.isArray(before) ? undefined : key)
        }
        return out
    }
    out.push(`${path || "value"}: ${show(before)} -> ${show(after)}`)
    return out
}

/** @param {unknown} value */
function show(value) {
    const text =
        typeof value === "string" && value.startsWith(schemaPrefix) ? value.slice(schemaPrefix.length) : JSON.stringify(value)
    return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

/**
 * @param {any} value
 * @param {string} [parent]
 * @returns {any}
 */
function withoutWording(value, parent) {
    if (Array.isArray(value)) return value.map((item) => withoutWording(item))
    if (value === null || typeof value !== "object") return value
    const names = parent !== undefined && nameMaps.has(parent)
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => names || !wordingKeys.has(key))
            .map(([key, item]) => [key, !names && literalKeys.has(key) ? item : withoutWording(item, names ? undefined : key)]),
    )
}

/**
 * Compares named entries and sorts each change into the application-reachable or user-only group
 * @param {Map<string, unknown>} previous
 * @param {Map<string, unknown>} current
 * @param {(name: string) => boolean} reachable
 * @returns {SurfaceChanges}
 */
function compareEntries(previous, current, reachable) {
    const group = () => /** @type {ChangeGroup} */ ({ added: [], removed: [], changed: [], wordingOnly: [] })
    const result = { application: group(), userOnly: group() }
    for (const name of [...new Set([...previous.keys(), ...current.keys()])].sort(compare)) {
        const before = previous.get(name)
        const after = current.get(name)
        if (JSON.stringify(before) === JSON.stringify(after)) continue
        const target = reachable(name) ? result.application : result.userOnly
        if (before === undefined) target.added.push(name)
        else if (after === undefined) target.removed.push(name)
        else {
            const details = differences(withoutWording(before), withoutWording(after), "", [])
            if (details.length) target.changed.push({ name, details })
            else target.wordingOnly.push(name)
        }
    }
    return result
}

/** @param {any} spec */
function operations(spec) {
    /** @type {Map<string, { tokens: string[], requirements: string[], operation: any }>} */
    const found = new Map()
    for (const [path, item] of Object.entries(spec?.paths ?? {}))
        for (const method of methods) {
            const operation = item?.[method]
            if (!operation) continue
            const { security = spec.security ?? [], ...rest } = operation
            const tokens = [...new Set(security.flatMap((/** @type {object} */ requirement) => Object.keys(requirement)))]
            // Each alternative a caller can satisfy, with its required scopes, so a changed scope counts as a change
            const requirements = security.map((/** @type {Record<string, string[]>} */ requirement) =>
                Object.entries(requirement)
                    .map(([scheme, scopes]) => (scopes?.length ? `${scheme} (${[...scopes].sort(compare).join(", ")})` : scheme))
                    .sort(compare)
                    .join(" + ") || "no token",
            )
            found.set(`${method.toUpperCase()} ${path}`, { tokens, requirements, operation: rest })
        }
    return found
}

const reachableBy = (/** @type {string[] | undefined} */ tokens) =>
    tokens !== undefined && (tokens.length === 0 || tokens.some((token) => applicationSchemes.has(token)))

/**
 * Names every component schema reachable through $ref from an operation a bot, OAuth2 application or anonymous caller can use
 * @param {any} spec
 * @param {ReturnType<typeof operations>} found
 */
function reachableSchemas(spec, found) {
    const schemas = spec?.components?.schemas ?? {}
    /** @type {string[]} */
    const pending = []
    const collect = (/** @type {unknown} */ value) =>
        JSON.stringify(value, (key, item) => {
            if (key === "$ref" && typeof item === "string" && item.startsWith(schemaPrefix))
                pending.push(item.slice(schemaPrefix.length))
            return item
        })
    for (const { tokens, operation } of found.values()) if (reachableBy(tokens)) collect(operation)
    const seen = new Set()
    while (pending.length) {
        const name = /** @type {string} */ (pending.pop())
        if (seen.has(name) || !Object.hasOwn(schemas, name)) continue
        seen.add(name)
        collect(schemas[name])
    }
    return seen
}

/**
 * Compares two OpenAPI documents by operation and component schema, separating wording-only edits and user-only surface
 * @param {any} before
 * @param {any} after
 */
export function openapiChanges(before, after) {
    const previous = operations(before)
    const current = operations(after)
    const reachable = new Set([...reachableSchemas(before, previous), ...reachableSchemas(after, current)])
    const described = (/** @type {ReturnType<typeof operations>} */ found) =>
        new Map([...found].map(([name, { requirements, operation }]) => [name, { tokens: requirements, ...operation }]))
    const other = [
        ...Object.keys({ ...before, ...after }).filter((key) => !["paths", "components"].includes(key)),
        ...Object.keys({ ...before?.components, ...after?.components })
            .filter((key) => key !== "schemas")
            .map((key) => `components.${key}`),
    ].filter((key) => {
        const read = (/** @type {any} */ spec) => key.split(".").reduce((value, part) => value?.[part], spec)
        return JSON.stringify(read(before)) !== JSON.stringify(read(after))
    })
    return {
        endpoints: compareEntries(
            described(previous),
            described(current),
            (name) => reachableBy(previous.get(name)?.tokens) || reachableBy(current.get(name)?.tokens),
        ),
        schemas: compareEntries(
            new Map(Object.entries(before?.components?.schemas ?? {})),
            new Map(Object.entries(after?.components?.schemas ?? {})),
            (name) => reachable.has(name),
        ),
        other: other.sort(compare),
    }
}

/**
 * Splits the gateway events document into Dispatch event sections, each running to the next level two or three heading
 * @param {string} markdown
 */
export function eventSections(markdown) {
    /** @type {Map<string, string[]>} */
    const sections = new Map()
    /** @type {string[] | undefined} */
    let lines
    for (const line of markdown.split(/\r?\n/)) {
        const match = /^###\s+(?:<span[^>]*><\/span>\s*)?([A-Z][A-Z0-9_]*)\s*$/.exec(line)
        if (match) sections.set(match[1], (lines = []))
        else if (/^#{1,3}\s/.test(line)) lines = undefined
        else lines?.push(line)
    }
    return sections
}

/**
 * Keys each table row by its subsection heading and first cell, so a changed type or description marks that field
 * @param {string[]} lines
 */
function tableRows(lines) {
    /** @type {Map<string, string>} */
    const rows = new Map()
    let table = ""
    let header = true
    for (const line of lines) {
        const heading = /^####\s+(.+?)\s*$/.exec(line)
        if (heading) table = `${heading[1]} > `
        if (!line.startsWith("|")) {
            header = true
            continue
        }
        if (header || /^\|\s*:?-{3,}/.test(line)) {
            header = false
            continue
        }
        const field = (line.split("|")[1] ?? "").replace(/<sup>.*?<\/sup>/g, "").trim()
        rows.set(`${table}${field}`, line.trim())
    }
    return rows
}

/**
 * Compares Dispatch event sections, separating field table changes from edits to their text
 * @param {string} before
 * @param {string} after
 */
export function eventChanges(before, after) {
    const previous = eventSections(before)
    const current = eventSections(after)
    const result = {
        ...listChanges([...previous.keys()], [...current.keys()]),
        /** @type {{ name: string, details: string[] }[]} */
        fields: [],
        /** @type {string[]} */
        textOnly: [],
    }
    for (const [name, lines] of [...current].sort(([a], [b]) => compare(a, b))) {
        const old = previous.get(name)
        if (!old || old.join("\n") === lines.join("\n")) continue
        const oldRows = tableRows(old)
        const rows = tableRows(lines)
        const details = [...new Set([...oldRows.keys(), ...rows.keys()])].flatMap((key) =>
            !oldRows.has(key) ? [`+ ${key}`] : !rows.has(key) ? [`- ${key}`] : oldRows.get(key) !== rows.get(key) ? [`~ ${key}`] : [],
        )
        if (details.length) result.fields.push({ name, details })
        else result.textOnly.push(name)
    }
    return result
}

/**
 * Reads rate-limit bucket templates that carry resource parameters, such as `channel:read::channel_id`.
 * Limit values are ignored, because the SDK pins only bucket identity and parameters
 * @param {string[]} sources
 */
export function rateLimitBuckets(sources) {
    const buckets = new Set()
    for (const source of sources)
        for (const match of source.matchAll(/\bbucket:\s*(['"`])([^'"`\n]*::[^'"`\n]*)\1/g)) buckets.add(match[2])
    return [...buckets].sort(compare)
}

/**
 * @param {Manifest} manifest
 * @param {Source} source
 * @param {string} commit
 */
async function readBuckets(manifest, source, commit) {
    const directory = manifest.rateLimits.path
    const entries = await source.listDirectory(manifest.repository, commit, directory)
    if (entries.some(({ path }) => !path.startsWith(`${directory}/`) || path.split("/").includes("..")))
        throw new Error("Upstream rate-limit listing is outside its directory")
    // Only the top level is read, so a nested entry fails the check instead of hiding its buckets
    if (entries.some(({ type }) => type !== "file"))
        throw new Error("Upstream rate-limit directory contains a subdirectory or other non-file entry. Extend the check to read it")
    const paths = entries.map(({ path }) => path).sort(compare)
    const sources = []
    for (const path of paths.filter((path) => path.endsWith(".ts")))
        sources.push((await source.fetchFile(manifest.repository, commit, path)).toString("utf8"))
    return rateLimitBuckets(sources)
}

/**
 * @param {string[]} before
 * @param {string[]} after
 */
function listChanges(before, after) {
    return { added: after.filter((name) => !before.includes(name)), removed: before.filter((name) => !after.includes(name)) }
}

/**
 * Compares the baseline documents and rate-limit buckets with the upstream branch. Only when a hash changed are the
 * baseline copies also read, to describe the difference. Observation mode also signals a changed commit
 * @param {Manifest} manifest
 * @param {Source} source
 * @param {{ compareCommit?: boolean }} [options]
 */
export async function checkUpstream(manifest, source, { compareCommit = false } = {}) {
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
    const buckets = await readBuckets(manifest, source, commit)
    const bucketHash = sha256(Buffer.from(buckets.join("\n")))
    const rateLimits = {
        path: manifest.rateLimits.path,
        pinned: manifest.rateLimits.sha256,
        current: bucketHash,
        changed: bucketHash !== manifest.rateLimits.sha256,
    }
    const pinned = async (/** @type {PinnedFile} */ file) =>
        (await source.fetchFile(manifest.repository, manifest.commit, file.path)).toString("utf8")
    /** @type {{ openapi?: ReturnType<typeof openapiChanges>, events?: ReturnType<typeof eventChanges>, buckets?: ReturnType<typeof listChanges> }} */
    const details = {}
    if (files.openapi.changed)
        details.openapi = openapiChanges(
            JSON.parse(await pinned(manifest.files.openapi)),
            JSON.parse(files.openapi.bytes.toString("utf8")),
        )
    if (files.gatewayEvents.changed)
        details.events = eventChanges(await pinned(manifest.files.gatewayEvents), files.gatewayEvents.bytes.toString("utf8"))
    if (rateLimits.changed) details.buckets = listChanges(await readBuckets(manifest, source, manifest.commit), buckets)
    return {
        repository: manifest.repository,
        pinnedCommit: manifest.commit,
        commit,
        drift: (compareCommit && commit !== manifest.commit) || rateLimits.changed || Object.values(files).some((file) => file.changed),
        files: Object.fromEntries(
            Object.entries(files).map(([key, { path, pinned, current, changed }]) => [key, { path, pinned, current, changed }]),
        ),
        rateLimits,
        ...details,
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
 * @param {string} [indent]
 */
function nameList(label, names, indent = "") {
    if (!names.length) return []
    const shown = names.slice(0, listLimit).map(escape).join(", ")
    return [`${indent}- ${label} (${names.length}): ${shown}${names.length > listLimit ? `, and ${names.length - listLimit} more` : ""}`]
}

/**
 * @param {string} label
 * @param {{ name: string, details: string[] }[]} entries
 */
function detailedList(label, entries) {
    if (!entries.length) return []
    const lines = [`- ${label} (${entries.length}):`]
    for (const { name, details } of entries.slice(0, detailedLimit)) {
        const more = details.length > detailLimit ? `; and ${details.length - detailLimit} more` : ""
        lines.push(`  - ${escape(name)}: ${details.slice(0, detailLimit).map(escape).join("; ")}${more}`)
    }
    lines.push(
        ...nameList(
            "Not detailed",
            entries.slice(detailedLimit).map(({ name }) => name),
            "  ",
        ),
    )
    return lines
}

/**
 * @param {string} title
 * @param {SurfaceChanges} changes
 */
function surfaceReport(title, { application, userOnly }) {
    const reachable = [
        ...nameList("Added", application.added),
        ...nameList("Removed", application.removed),
        ...detailedList("Changed", application.changed),
        ...nameList("Wording only", application.wordingOnly),
    ]
    const other = [
        ...nameList("Added", userOnly.added),
        ...nameList("Removed", userOnly.removed),
        ...nameList(
            "Changed",
            userOnly.changed.map(({ name }) => name),
        ),
        ...nameList("Wording only", userOnly.wordingOnly),
    ]
    if (!reachable.length && !other.length) return []
    return [
        `### ${title}`,
        "",
        ...(reachable.length ? ["Usable with a bot token, an OAuth2 token or no token:", "", ...reachable, ""] : []),
        ...(other.length ? ["User session or admin only:", "", ...other, ""] : []),
    ]
}

/**
 * @param {Awaited<ReturnType<typeof checkUpstream>>} result
 * @param {Pick<Baseline, "kind" | "reason">} [baseline]
 */
export function renderReport(result, baseline = { kind: "repository-pin" }) {
    const kind = baseline.kind === "previous-run" ? "Previous run" : "Repository pin"
    const lines = [
        "## Upstream Fluxer drift",
        "",
        result.drift ? "Upstream changed since the comparison baseline" : "No upstream drift from the comparison baseline",
        "",
        `Baseline: ${kind}`,
        "",
        ...(baseline.reason ? [`Baseline fallback: ${escape(baseline.reason)}`, ""] : []),
        `Baseline commit: ${escape(result.pinnedCommit)}`,
        "",
        `Current upstream commit: ${escape(result.commit)}`,
        "",
        `[Commit range](https://github.com/${result.repository}/compare/${result.pinnedCommit}...${result.commit})`,
        "",
        "| Document | Result |",
        "| --- | --- |",
        ...Object.values(result.files).map((file) => `| ${escape(file.path)} | ${file.changed ? "changed" : "unchanged"} |`),
        `| Rate-limit buckets in ${escape(result.rateLimits.path)} | ${result.rateLimits.changed ? "changed" : "unchanged"} |`,
        "",
    ]
    if (result.openapi) {
        const endpoints = surfaceReport("REST endpoints", result.openapi.endpoints)
        const schemas = surfaceReport("Component schemas", result.openapi.schemas)
        lines.push(...endpoints, ...schemas)
        if (result.openapi.other.length) lines.push("### Other OpenAPI sections", "", ...nameList("Changed", result.openapi.other), "")
        if (!endpoints.length && !schemas.length && !result.openapi.other.length)
            lines.push("### OpenAPI", "", "- Only formatting changed", "")
    }
    if (result.events) {
        const details = [
            ...nameList("Added", result.events.added),
            ...nameList("Removed", result.events.removed),
            ...detailedList("Field tables changed", result.events.fields),
            ...nameList("Text only", result.events.textOnly),
        ]
        lines.push("### Gateway Dispatch events", "", ...(details.length ? details : ["- Only text outside event sections changed"]), "")
    }
    if (result.buckets) {
        lines.push(
            "### Rate-limit buckets with resource parameters",
            "",
            ...nameList("Added", result.buckets.added),
            ...nameList("Removed", result.buckets.removed),
            "",
        )
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

/** @param {string} accept */
function githubHeaders(accept) {
    /** @type {Record<string, string>} */
    const headers = { accept, "x-github-api-version": "2022-11-28" }
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    return headers
}

const encodePath = (/** @type {string} */ path) => path.split("/").map(encodeURIComponent).join("/")

/** @type {Source} */
const githubSource = {
    async resolveCommit(repository, branch) {
        const url = `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(branch)}`
        return (await download(url, githubHeaders("application/vnd.github.sha"))).toString("utf8").trim()
    },
    fetchFile(repository, commit, path) {
        if (!commitPattern.test(commit)) throw new Error("Upstream files are read only at exact commits")
        return download(`https://raw.githubusercontent.com/${repository}/${commit}/${encodePath(path)}`, {})
    },
    async listDirectory(repository, commit, directory) {
        if (!commitPattern.test(commit)) throw new Error("Upstream files are read only at exact commits")
        const url = `https://api.github.com/repos/${repository}/contents/${encodePath(directory)}?ref=${commit}`
        const entries = JSON.parse((await download(url, githubHeaders("application/vnd.github+json"))).toString("utf8"))
        if (!Array.isArray(entries)) throw new Error("Upstream directory listing is invalid")
        if (entries.some((entry) => typeof entry?.path !== "string" || typeof entry.type !== "string"))
            throw new Error("Upstream directory listing is invalid")
        return entries.map(({ path, type }) => ({ path, type }))
    },
}

/** @param {string[]} args */
function parseArguments(args) {
    /** @type {{ update?: boolean, baseline?: string, record?: string }} */
    const options = {}
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (arg === "--update" && !options.update) options.update = true
        else if ((arg === "--baseline" || arg === "--record") && options[arg.slice(2)] === undefined) {
            const path = args[++index]
            if (!path || path.startsWith("--")) throw new Error(`${arg} requires a file path`)
            options[arg.slice(2)] = path
        } else throw new Error("Use --update or --baseline <file> and --record <file>, with each argument at most once")
    }
    if (options.update && (options.baseline || options.record))
        throw new Error("Use --update separately from --baseline and --record")
    return options
}

/**
 * @param {Manifest} manifest
 * @param {string | undefined} path
 * @returns {Promise<Baseline>}
 */
async function readBaseline(manifest, path) {
    if (!path) return { manifest, kind: "repository-pin" }
    let text
    try {
        text = await readFile(path, "utf8")
    } catch {
        return { manifest, kind: "repository-pin", reason: "Previous-run baseline file is missing or unreadable" }
    }
    let value
    try {
        value = JSON.parse(text)
    } catch {
        return { manifest, kind: "repository-pin", reason: "Previous-run baseline file is not valid JSON" }
    }
    try {
        const previous = validateManifest(value)
        if (
            previous.repository !== manifest.repository ||
            previous.branch !== manifest.branch ||
            previous.files.openapi.path !== manifest.files.openapi.path ||
            previous.files.gatewayEvents.path !== manifest.files.gatewayEvents.path ||
            previous.rateLimits.path !== manifest.rateLimits.path
        ) throw new Error("Baseline target differs from the repository manifest")
        return { manifest: previous, kind: "previous-run" }
    } catch {
        return { manifest, kind: "repository-pin", reason: "Previous-run baseline is invalid or targets different upstream documents" }
    }
}

/**
 * @param {Manifest} manifest
 * @param {Awaited<ReturnType<typeof checkUpstream>>} result
 * @returns {Manifest}
 */
function observation(manifest, result) {
    const file = (/** @type {string} */ key) => ({ path: result.files[key].path, sha256: result.files[key].current })
    return {
        repository: manifest.repository,
        branch: manifest.branch,
        commit: result.commit,
        files: { openapi: file("openapi"), gatewayEvents: file("gatewayEvents") },
        rateLimits: { path: result.rateLimits.path, sha256: result.rateLimits.current },
    }
}

/**
 * Runs the CLI check with injectable upstream reads for offline behavior tests
 * @param {string[]} args
 * @param {{ source?: Source, manifestFile?: string, summaryFile?: string }} [dependencies]
 */
export async function runUpstream(args, {
    source = githubSource,
    manifestFile = manifestPath,
    summaryFile = process.env.GITHUB_STEP_SUMMARY,
} = {}) {
    const options = parseArguments(args)
    const manifest = validateManifest(JSON.parse(await readFile(manifestFile, "utf8")))
    const baseline = await readBaseline(manifest, options.baseline)
    const result = await checkUpstream(baseline.manifest, source, { compareCommit: options.baseline !== undefined })
    const observed = observation(baseline.manifest, result)
    if (options.update) {
        await writeFile(manifestFile, JSON.stringify(observed, null, 4) + "\n")
        return { exitCode: 0, report: `Pinned ${manifest.repository} at ${result.commit}`, result, baseline }
    }
    if (options.record) await writeFile(options.record, JSON.stringify(observed, null, 4) + "\n")
    const report = renderReport(result, baseline)
    if (summaryFile) await appendFile(summaryFile, report + "\n")
    return { exitCode: result.drift ? 1 : 0, report, result, baseline }
}

async function main() {
    const { exitCode, report } = await runUpstream(process.argv.slice(2))
    console.log(report)
    process.exitCode = exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : "Upstream drift check failed")
        process.exitCode = 1
    })
