// @ts-check
// Root-relative Markdown link lint for repository documents: node scripts/docs-links.mjs
// Verifies that every /path and /path#heading link in repository Markdown resolves to an existing file or folder, and
// that every heading fragment matches a GitHub-style heading slug in the target document. Checks its own samples first
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../../", import.meta.url))
// Repository-owned Markdown documents (website guides use site-root /docs/ routes checked by website tests)
const targetPattern = /^(?:AGENTS\.md|REVIEW\.md|docs\/[^/]+\.md|projects\/(?:sdk|web|release)\/(?:AGENTS|README)\.md|projects\/sdk\/tests\/live\/README\.md)$/

/**
 * GitHub-compatible heading anchor slug
 * @param {string} raw
 */
export function headingSlug(raw) {
    return raw
        .trim()
        .toLowerCase()
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-")
}

/**
 * Heading slugs in one Markdown file, with GitHub duplicate suffixes (-1, -2)
 * @param {string} text
 */
export function headingSlugs(text) {
    const slugs = new Set()
    /** @type {Map<string, number>} */
    const counts = new Map()
    let fence = ""
    for (const line of text.split(/\r?\n/)) {
        const fenceMatch = /^(`{3,}|~{3,})/.exec(line.trimStart())
        if (fenceMatch) {
            if (!fence) fence = fenceMatch[1][0]
            else if (fenceMatch[1][0] === fence) fence = ""
            continue
        }
        if (fence) continue
        const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
        if (!heading) continue
        const base = headingSlug(heading[1])
        const seen = counts.get(base) ?? 0
        counts.set(base, seen + 1)
        slugs.add(seen === 0 ? base : `${base}-${seen}`)
    }
    return slugs
}

/**
 * Every root-relative Markdown link target in one document, ignoring fenced and inline code
 * @param {string} text
 */
export function extractRootLinks(text) {
    /** @type {{ line: number, target: string }[]} */
    const links = []
    let fence = ""
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        const fenceMatch = /^(`{3,}|~{3,})/.exec(line.trimStart())
        if (fenceMatch) {
            if (!fence) fence = fenceMatch[1][0]
            else if (fenceMatch[1][0] === fence) fence = ""
            continue
        }
        if (fence) continue
        const withoutInlineCode = line.replace(/`[^`]*`/g, "")
        for (const match of withoutInlineCode.matchAll(/!?\[[^\]]*\]\((\/[^)\s]+)\)/g))
            links.push({ line: index + 1, target: match[1] })
    }
    return links
}

/**
 * @param {string} file
 * @param {string} text
 * @param {(path: string) => boolean} hasPath
 * @param {(path: string) => string | undefined} readDoc
 */
export function checkDocument(file, text, hasPath, readDoc) {
    /** @type {string[]} */
    const problems = []
    for (const { line, target } of extractRootLinks(text)) {
        const hash = target.indexOf("#")
        const rawPath = (hash === -1 ? target : target.slice(0, hash)).replace(/^\/+/, "").replace(/\/+$/, "")
        const fragment = hash === -1 ? undefined : target.slice(hash + 1)
        if (!rawPath || !hasPath(rawPath)) {
            problems.push(`${file}:${line} missing target ${target}`)
            continue
        }
        if (fragment !== undefined) {
            const doc = readDoc(rawPath)
            if (doc === undefined) {
                problems.push(`${file}:${line} fragment ${target} does not point to a Markdown file`)
                continue
            }
            if (!headingSlugs(doc).has(fragment))
                problems.push(`${file}:${line} missing heading #${fragment} in /${rawPath}`)
        }
    }
    return problems
}

function selfTest() {
    const docs = new Map([["docs/SAMPLE.md", "# Main Title\n\n## Sub Section\n\n## Sub Section\n"]])
    const hasPath = (/** @type {string} */ p) => docs.has(p) || p === "projects/sdk"
    const readDoc = (/** @type {string} */ p) => docs.get(p)
    const bad = [
        "[broken](/docs/NOPE.md)",
        "[bad anchor](/docs/SAMPLE.md#missing)",
        "[dir anchor](/projects/sdk/#nope)",
    ]
    const good = [
        "[ok](/docs/SAMPLE.md)",
        "[ok anchor](/docs/SAMPLE.md#sub-section)",
        "[ok duplicate anchor](/docs/SAMPLE.md#sub-section-1)",
        "[ok dir](/projects/sdk/)",
        "`[code](/docs/NOT-A-LINK.md)`",
        "```md\n[fenced](/docs/NOT-A-LINK.md)\n```",
    ]
    const errors = []
    for (const sample of bad)
        if (checkDocument("sample.md", sample, hasPath, readDoc).length !== 1)
            errors.push(`Scanner sample not reported once: ${JSON.stringify(sample)}`)
    for (const sample of good)
        if (checkDocument("sample.md", sample, hasPath, readDoc).length !== 0)
            errors.push(`Scanner sample wrongly reported: ${JSON.stringify(sample)}`)
    return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const problems = [...selfTest()]
    const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: repoRoot,
        encoding: "utf8",
    })
        .split("\0")
        .filter((file) => targetPattern.test(file))
    if (tracked.length === 0) problems.push("No repository Markdown documents matched")
    /** @type {Map<string, string | undefined>} */
    const cache = new Map()
    const hasPath = (/** @type {string} */ p) => existsSync(resolve(repoRoot, p))
    const readDoc = (/** @type {string} */ p) => {
        if (cache.has(p)) return cache.get(p)
        const full = resolve(repoRoot, p)
        const content = existsSync(full) && statSync(full).isFile() && p.endsWith(".md") ? readFileSync(full, "utf8") : undefined
        cache.set(p, content)
        return content
    }
    for (const file of tracked) {
        const full = resolve(repoRoot, file)
        if (!existsSync(full)) continue
        problems.push(...checkDocument(file, readFileSync(full, "utf8"), hasPath, readDoc))
    }
    if (problems.length > 0) {
        console.error(`Broken repository Markdown links:\n${problems.join("\n")}`)
        process.exitCode = 1
    } else console.log(`All root-relative links valid in ${tracked.length} repository Markdown files`)
}
