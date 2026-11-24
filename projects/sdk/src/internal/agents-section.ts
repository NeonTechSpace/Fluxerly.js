/**
 * Writes the SDK's essential rules into an application's AGENTS.md, which many coding agent tools load automatically.
 * Invariant: Only the text between the Fluxerly markers is replaced, so the rest of the file stays byte for byte
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

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
export function writeAgentsSection(
    project: string,
    packageRoot: string,
    manager?: AgentsPackageManager,
): AgentsSectionResult {
    const file = join(project, "AGENTS.md")
    const notes = [...linkNotes(project)]
    if (!existsSync(file)) {
        writeFileSync(file, newAgentsFile(project, packageRoot, manager))
        return { status: "created", file, notes }
    }
    const section = packagedSection(project, packageRoot, manager)
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

export type AgentsTarget = "agents" | "skill" | "cursor" | "claude" | "gemini" | "all"
export type AgentsCheckStatus = "current" | "missing" | "stale" | "broken"

/** Read-only freshness check for AGENTS.md against the installed SDK version */
export function checkAgentsSection(project: string, packageRoot: string): AgentsCheckStatus {
    const file = join(project, "AGENTS.md")
    if (!existsSync(file)) return "missing"
    const current = readFileSync(file, "utf8")
    let existing
    try {
        existing = between(current, start, end, "AGENTS.md")
    } catch (error) {
        if (error instanceof AgentsSectionError) return "broken"
        throw error
    }
    if (!existing) return "missing"
    const newline = current.includes("\r\n") ? "\r\n" : "\n"
    const actual = current.slice(existing.first, existing.last)
    const hasLockfile =
        existsSync(join(project, "pnpm-lock.yaml")) ||
        existsSync(join(project, "bun.lock")) ||
        existsSync(join(project, "bun.lockb"))
    const managers: readonly (AgentsPackageManager | undefined)[] = hasLockfile ? [undefined] : ["npm", "pnpm", "bun"]
    return managers.some(
        (manager) => packagedSection(project, packageRoot, manager).replaceAll("\n", newline) === actual,
    )
        ? "current"
        : "stale"
}

/** Render the compact Fluxerly section for stdout (--print) */
function formatAgentsSection(project: string, packageRoot: string): string {
    return packagedSection(project, packageRoot)
}

function writeIfChanged(file: string, content: string): "created" | "updated" | "current" {
    if (!existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, content)
        return "created"
    }
    if (readFileSync(file, "utf8") === content) return "current"
    writeFileSync(file, content)
    return "updated"
}

function writeSkillFile(
    project: string,
    packageRoot: string,
): { status: "created" | "updated" | "current"; file: string } {
    const guide = readFileSync(join(packageRoot, "agents/AGENTS.md"), "utf8").replaceAll("\r\n", "\n")
    const content = [
        "---",
        "name: fluxerly",
        "description: Build, configure and test Fluxer bots with @neontechspace/fluxerly in JavaScript, TypeScript or Effect",
        "---",
        "",
        guide.trim(),
        "",
    ].join("\n")
    const file = join(project, ".agents/skills/fluxerly/SKILL.md")
    return { status: writeIfChanged(file, content), file }
}

function writeCursorRule(
    project: string,
    packageRoot: string,
): { status: "created" | "updated" | "current"; file: string } {
    const section = packagedSection(project, packageRoot)
    const content = [
        "---",
        "description: Rules for building and testing Fluxer bots with @neontechspace/fluxerly",
        "alwaysApply: true",
        "---",
        "",
        section,
        "",
    ].join("\n")
    const file = join(project, ".cursor/rules/fluxerly.mdc")
    return { status: writeIfChanged(file, content), file }
}

function linkInstructionFile(
    project: string,
    name: "CLAUDE.md" | "GEMINI.md",
    line: string,
): "created" | "updated" | "current" {
    const file = join(project, name)
    if (!existsSync(file)) {
        writeFileSync(file, `${line}\n`)
        return "created"
    }
    const current = readFileSync(file, "utf8")
    if (current.includes("AGENTS.md")) return "current"
    const newline = current.includes("\r\n") ? "\r\n" : "\n"
    const prefix = current === "" || current.endsWith("\n") ? current : `${current}${newline}`
    writeFileSync(file, `${prefix}${line}${newline}`)
    return "updated"
}

const validTargets = new Set<AgentsTarget>(["agents", "skill", "cursor", "claude", "gemini", "all"])
const agentsMessages = {
    created: "Created AGENTS.md with the Fluxerly section",
    added: "Added the Fluxerly section to AGENTS.md",
    updated: "Updated the Fluxerly section in AGENTS.md",
    current: "The Fluxerly section in AGENTS.md is already current",
}
const statusVerb = { created: "Created", updated: "Updated", current: "Already current" }

function parseAgentsArgs(
    args: readonly string[],
):
    | { readonly mode: "write"; readonly target: AgentsTarget }
    | { readonly mode: "check" }
    | { readonly mode: "print" }
    | "usage" {
    let target: AgentsTarget | undefined
    let checkOnly = false
    let printOnly = false
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (arg === "--check" && !checkOnly) checkOnly = true
        else if (arg === "--print" && !printOnly) printOnly = true
        else if (arg === "--target" && target === undefined) {
            const next = args[index + 1] as AgentsTarget | undefined
            if (!next || !validTargets.has(next)) return "usage"
            target = next
            index++
        } else return "usage"
    }
    if ((checkOnly && printOnly) || ((checkOnly || printOnly) && target !== undefined)) return "usage"
    if (printOnly) return { mode: "print" }
    if (checkOnly) return { mode: "check" }
    return { mode: "write", target: target ?? "agents" }
}

function applyAgentsTarget(
    chosen: AgentsTarget,
    project: string,
    packageRoot: string,
    output: NodeJS.WritableStream,
): void {
    if (chosen === "agents" || chosen === "claude" || chosen === "gemini" || chosen === "all") {
        const result = writeAgentsSection(project, packageRoot)
        output.write(`${agentsMessages[result.status]}\n`)
        if (chosen === "agents") for (const note of result.notes) output.write(`${note}\n`)
    }
    if (chosen === "skill" || chosen === "all") {
        const skill = writeSkillFile(project, packageRoot)
        output.write(`${statusVerb[skill.status]} .agents/skills/fluxerly/SKILL.md\n`)
    }
    if (chosen === "cursor") {
        const rule = writeCursorRule(project, packageRoot)
        output.write(`${statusVerb[rule.status]} .cursor/rules/fluxerly.mdc\n`)
    }
    if (chosen === "claude") {
        const claude = linkInstructionFile(project, "CLAUDE.md", "@AGENTS.md")
        output.write(
            `${claude === "current" ? "CLAUDE.md already references AGENTS.md" : "Linked AGENTS.md from CLAUDE.md"}\n`,
        )
    }
    if (chosen === "gemini") {
        const gemini = linkInstructionFile(project, "GEMINI.md", "Read AGENTS.md for project and Fluxerly SDK rules")
        output.write(
            `${gemini === "current" ? "GEMINI.md already references AGENTS.md" : "Linked AGENTS.md from GEMINI.md"}\n`,
        )
    }
}

/** Run `fluxerly agents [--target agents|skill|cursor|claude|gemini|all] [--check] [--print]` */
export function runAgentsCommand(
    args: readonly string[],
    environment: {
        readonly project: string
        readonly packageRoot: string
        readonly output: NodeJS.WritableStream
        readonly errorOutput: NodeJS.WritableStream
    },
): 0 | 1 | "usage" {
    const parsed = parseAgentsArgs(args)
    if (parsed === "usage") return "usage"
    const { project, packageRoot, output, errorOutput } = environment
    if (parsed.mode === "print") {
        output.write(`${formatAgentsSection(project, packageRoot)}\n`)
        return 0
    }
    if (parsed.mode === "check") {
        const status = checkAgentsSection(project, packageRoot)
        if (status === "current") {
            output.write("The Fluxerly section in AGENTS.md is current\n")
            return 0
        }
        const reasons = {
            missing: "AGENTS.md has no Fluxerly section",
            stale: "The Fluxerly section in AGENTS.md is out of date",
            broken: "AGENTS.md has broken Fluxerly markers",
        }
        errorOutput.write(`${reasons[status]}. Run fluxerly agents to refresh it\n`)
        return 1
    }
    try {
        applyAgentsTarget(parsed.target, project, packageRoot, output)
        return 0
    } catch (error) {
        if (!(error instanceof AgentsSectionError)) throw error
        errorOutput.write(`${error.message}. AGENTS.md was not changed\n`)
        return 1
    }
}
