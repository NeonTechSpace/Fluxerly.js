/**
 * Writes the SDK's essential rules into an application's AGENTS.md, which many coding agent tools load automatically.
 * Invariant: Only the text between the Fluxerly markers is replaced, so the rest of the file stays byte for byte
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const start = "<!-- fluxerly:start -->"
const end = "<!-- fluxerly:end -->"
const rulesStart = "<!-- fluxerly-rules:start -->"
const rulesEnd = "<!-- fluxerly-rules:end -->"

/** Outcome of one run, with the notes to print for the user */
export interface AgentsSectionResult {
    readonly status: "created" | "added" | "updated" | "current"
    readonly file: string
    readonly notes: readonly string[]
}

/** Thrown when AGENTS.md or the packaged guide cannot be updated safely, so no file was changed */
export class AgentsSectionError extends Error {
    override readonly name = "AgentsSectionError"
}

/** A package manager that can install and run the SDK */
export type AgentsPackageManager = "npm" | "pnpm" | "bun"

// The recorded command must run the installed copy and never download one, since the unscoped fluxerly package on npm is
// not this SDK. A lockfile names the project's manager. Without one, as in a new starter, the manager that ran the
// command is used
function refreshCommand(project: string, manager: AgentsPackageManager = "npm") {
    if (existsSync(join(project, "pnpm-lock.yaml"))) return "pnpm exec fluxerly agents"
    if (existsSync(join(project, "bun.lock")) || existsSync(join(project, "bun.lockb")))
        return "bunx --no-install fluxerly agents"
    return {
        npm: "npx --no fluxerly agents",
        pnpm: "pnpm exec fluxerly agents",
        bun: "bunx --no-install fluxerly agents",
    }[manager]
}

function between(text: string, open: string, close: string, where: string) {
    const first = text.indexOf(open)
    const last = text.indexOf(close)
    if (first < 0 && last < 0) return undefined
    if (first < 0 || last < first || text.indexOf(open, first + 1) >= 0 || text.indexOf(close, last + 1) >= 0)
        throw new AgentsSectionError(`${where} must contain exactly one ${open} followed by one ${close}`)
    return { first, last: last + close.length, inner: text.slice(first + open.length, last) }
}

/** Build the section for one SDK version from the rules in the packaged agent guide */
function agentsSection(guide: string, version: string, command: string) {
    const rules = between(guide, rulesStart, rulesEnd, "The packaged agent guide")
    if (!rules) throw new AgentsSectionError("The packaged agent guide has no rules section")
    return [
        start,
        "## Fluxerly",
        "",
        `These rules come from @neontechspace/fluxerly ${version}. When \`node_modules/@neontechspace/fluxerly/package.json\` shows another version, run \`${command}\` to refresh this section`,
        "",
        "Read `node_modules/@neontechspace/fluxerly/agents/AGENTS.md` for the complete guide before writing code with the SDK. Its task map names the declaration file for each common task",
        "",
        rules.inner.trim(),
        end,
    ].join("\n")
}

/** The section for `project` built from the installed package at `packageRoot` */
function packagedSection(project: string, packageRoot: string, manager?: AgentsPackageManager) {
    const guide = readFileSync(join(packageRoot, "agents/AGENTS.md"), "utf8").replaceAll("\r\n", "\n")
    const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }
    return agentsSection(guide, version, refreshCommand(project, manager))
}

/**
 * The AGENTS.md text that writeAgentsSection creates when `project` has none. `manager` picks the refresh command when
 * the project has no lockfile yet
 */
export function newAgentsFile(project: string, packageRoot: string, manager?: AgentsPackageManager): string {
    return `# Agent instructions\n\n${packagedSection(project, packageRoot, manager)}\n`
}

/**
 * Add or refresh the Fluxerly section in `project`/AGENTS.md, creating the file when it is missing.
 * Line endings follow the existing file. Nothing is written when the section is already current or a marker is broken
 */
export function writeAgentsSection(project: string, packageRoot: string): AgentsSectionResult {
    const file = join(project, "AGENTS.md")
    const notes = [...linkNotes(project)]
    if (!existsSync(file)) {
        writeFileSync(file, newAgentsFile(project, packageRoot))
        return { status: "created", file, notes }
    }
    const section = packagedSection(project, packageRoot)
    const current = readFileSync(file, "utf8")
    const newline = current.includes("\r\n") ? "\r\n" : "\n"
    const written = section.replaceAll("\n", newline)
    const existing = between(current, start, end, "AGENTS.md")
    if (!existing) {
        const separator =
            current.length === 0 || current.endsWith(newline + newline)
                ? ""
                : current.endsWith(newline)
                  ? newline
                  : newline + newline
        writeFileSync(file, `${current}${separator}${written}${newline}`)
        return { status: "added", file, notes }
    }
    const next = current.slice(0, existing.first) + written + current.slice(existing.last)
    if (next === current) return { status: "current", file, notes }
    writeFileSync(file, next)
    return { status: "updated", file, notes }
}

// Some tools read their own instruction file instead of AGENTS.md. Their files are reported, never changed
function* linkNotes(project: string) {
    for (const [name, fix] of [
        ["CLAUDE.md", "add a line containing @AGENTS.md to it"],
        ["GEMINI.md", "reference AGENTS.md from it"],
    ] as const) {
        const path = join(project, name)
        if (existsSync(path) && !readFileSync(path, "utf8").includes("AGENTS.md"))
            yield `${name} does not mention AGENTS.md, so tools that read ${name} can miss these rules. To connect them, ${fix}`
    }
}
