// @ts-check

import { execFileSync } from "node:child_process"
import { appendFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { compareVersions } from "./planning.js"
import { assertVersionedSource } from "./source.js"

const manifestPath = "projects/sdk/package.json"
const changelogPath = "projects/sdk/CHANGELOG.md"
const changesets = "projects/.changeset/"
const versionLine = /^(\s*)"version": "([^"]+)"(,?)$/
const regular = "100644"

/**
 * @typedef {{ status: string, srcMode: string, dstMode: string, srcBlob: string, dstBlob: string, path: string }} Entry
 * @typedef {{ versionOnly: true, from: string, to: string } | { versionOnly: false, reason: string }} VersionChange
 */

/**
 * Parses `git diff --raw -z --no-renames --no-abbrev`
 * @param {string} raw
 * @returns {Entry[]}
 */
export function parseRawDiff(raw) {
    const fields = raw.split("\0")
    if (fields.at(-1) === "") fields.pop()
    /** @type {Entry[]} */
    const entries = []
    for (let index = 0; index < fields.length; index += 2) {
        const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([A-Z])$/.exec(fields[index])
        const path = fields[index + 1]
        if (!match || path === undefined) throw new Error("The git change list is not in the expected raw format")
        const [, srcMode, dstMode, srcBlob, dstBlob, status] = match
        entries.push({ status, srcMode, dstMode, srcBlob, dstBlob, path })
    }
    return entries
}

/**
 * The version lines of a manifest change, when it changes only the top-level version line
 * @param {string} before
 * @param {string} after
 */
function manifestVersions(before, after) {
    const old = before.split("\n")
    const lines = after.split("\n")
    if (old.length !== lines.length) return null
    const changed = lines.flatMap((line, index) => (line === old[index] ? [] : [index]))
    if (changed.length !== 1) return null
    const from = versionLine.exec(old[changed[0]])
    const to = versionLine.exec(lines[changed[0]])
    if (!from || !to || from[1] !== to[1] || from[3] !== to[3]) return null
    // Only one line changed, so the top-level version moving with it shows that line is the top-level field
    if (JSON.parse(before).version !== from[2] || JSON.parse(after).version !== to[2]) return null
    try {
        if (compareVersions(to[2], from[2]) <= 0) return null
    } catch {
        return null
    }
    return { from: from[2], to: to[2] }
}

/**
 * Whether the changelog only gained the section for the new version
 * @param {string} before
 * @param {string} after
 * @param {string} version
 */
function addsOnlySection(before, after, version) {
    const heading = `## ${version}`
    const lines = after.split("\n")
    const start = lines.indexOf(heading)
    if (start < 0 || lines.indexOf(heading, start + 1) >= 0 || before.split("\n").includes(heading)) return false
    const next = lines.findIndex((line, index) => index > start && line.startsWith("## "))
    return [...lines.slice(0, start), ...lines.slice(next < 0 ? lines.length : next)].join("\n") === before
}

/**
 * Decides whether a change touches only what a version pull request writes: The top-level version line of the SDK
 * manifest, a new changelog section for that version, consumed Changesets notes, notes moved unchanged into pre/ and
 * the prerelease state file. Anything else, including any other manifest line, is not a version-only change
 * @param {Entry[]} entries
 * @param {(blob: string) => string} read Reads a blob's text
 * @returns {VersionChange}
 */
export function classifyVersionChange(entries, read) {
    /** @param {string} reason @returns {VersionChange} */
    const no = (reason) => ({ versionOnly: false, reason })
    const deleted = new Map(
        entries
            .filter((entry) => entry.status === "D" && entry.srcMode === regular)
            .map((entry) => [entry.path, entry.srcBlob]),
    )
    const moved = new Set()
    /** @type {Entry | null} */
    let manifest = null
    /** @type {Entry | null} */
    let changelog = null
    for (const entry of entries) {
        const { status, path } = entry
        if (status !== "D" && entry.dstMode !== regular) return no(`${path} is not a regular file`)
        if (status !== "A" && entry.srcMode !== regular) return no(`${path} was not a regular file`)
        if (path === manifestPath && status === "M") manifest = entry
        else if (path === changelogPath && status === "M") changelog = entry
        else if (path === `${changesets}pre.json` && ["A", "M", "D"].includes(status)) continue
        else if (path.startsWith(changesets)) {
            const name = path.slice(changesets.length)
            const note = /^(pre\/)?([^/]+\.md)$/.exec(name)
            if (!note || note[2] === "README.md") return no(`${path} is not a Changesets note`)
            if (status === "D") continue
            // Changesets moves a note into pre/ without changing it
            const source = `${changesets}${note[2]}`
            if (status !== "A" || !note[1] || deleted.get(source) !== entry.dstBlob || moved.has(source))
                return no(`${path} is not a Changesets note moved unchanged into pre/`)
            moved.add(source)
        } else return no(`${path} is not a release version file`)
    }
    if (!manifest) return no(`${manifestPath} has no version change`)
    if (!changelog) return no(`${changelogPath} has no new version section`)
    const versions = manifestVersions(read(manifest.srcBlob), read(manifest.dstBlob))
    if (!versions) return no(`${manifestPath} changes more than a higher top-level version`)
    if (!addsOnlySection(read(changelog.srcBlob), read(changelog.dstBlob), versions.to))
        return no(`${changelogPath} changes more than adding the ${versions.to} section`)
    return { versionOnly: true, ...versions }
}

/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) =>
    execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true })

/**
 * Compares HEAD with its first parent. With an expected parent, any other parent is not a version-only change, so a
 * push that brought several commits runs every check
 * @param {{ cwd?: string, parent?: string }} [options]
 * @returns {VersionChange & { parent?: string }}
 */
export function detectVersionChange({ cwd = process.cwd(), parent: expected } = {}) {
    const parent = git(["rev-parse", "--verify", "HEAD^1^{commit}"], cwd).trim()
    if (expected !== undefined && expected !== parent)
        return { versionOnly: false, reason: "The change does not start from HEAD's first parent" }
    const raw = git(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", parent, "HEAD", "--"], cwd)
    const entries = parseRawDiff(raw)
    if (entries.length === 0) return { versionOnly: false, reason: "Nothing changed from the parent commit" }
    return { ...classifyVersionChange(entries, (blob) => git(["cat-file", "blob", blob], cwd)), parent }
}

/** @param {VersionChange} change */
export const describeVersionChange = (change) =>
    change.versionOnly
        ? `Only release version files changed, for ${change.from} to ${change.to}`
        : `Not a version-only change: ${change.reason}`

async function main() {
    const [action, ...args] = process.argv.slice(2)
    if (action === "check") {
        if (args.length) throw new Error("check takes no arguments")
        const version = await assertVersionedSource(resolve(fileURLToPath(import.meta.url), "../.."))
        console.log(`The SDK version ${version}, its changelog section and the Changesets state agree`)
    } else if (action === "detect") {
        if (args.length > 2 || (args.length && args[0] !== "--parent"))
            throw new Error("detect takes only --parent COMMIT")
        /** @type {VersionChange} */
        let change
        // A failed detection runs every check, so it can only ever cost time
        try {
            if (args.length && !/^[a-f0-9]{40}$/.test(args[1] ?? "")) throw new Error("The expected parent is not a commit SHA")
            change = detectVersionChange({ parent: args[1] })
        } catch (error) {
            change = { versionOnly: false, reason: error instanceof Error ? error.message : "Detection failed" }
        }
        console.log(describeVersionChange(change))
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version_only=${change.versionOnly}\n`)
    } else throw new Error("Use check or detect")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : "Version change check failed")
        process.exitCode = 1
    })
