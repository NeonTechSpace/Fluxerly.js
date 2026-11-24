/**
 * Writes the SDK's essential rules into an application's AGENTS.md, which many coding agent tools load automatically.
 * Invariant: Only the text between the Fluxerly markers is replaced, so the rest of the file stays byte for byte
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createCliTheme, type CliStreamLike } from "./cli-theme.js"

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
export function localAgentsCommand(project: string, manager: AgentsPackageManager = "npm"): string {
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
    return agentsSection(guide, version, localAgentsCommand(project, manager))
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
    | { readonly error: string } {
    let target: AgentsTarget | undefined
    let checkOnly = false
    let printOnly = false
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (arg === "--check") {
            if (checkOnly) return { error: "The --check option was passed more than once" }
            checkOnly = true
        } else if (arg === "--print") {
            if (printOnly) return { error: "The --print option was passed more than once" }
            printOnly = true
        } else if (arg === "--target") {
            if (target !== undefined) return { error: "The --target option was passed more than once" }
            const next = args[index + 1]
            if (next === undefined)
                return {
                    error: "Missing value for --target. Supported targets are agents, skill, cursor, claude, gemini and all",
                }
            if (!validTargets.has(next as AgentsTarget))
                return {
                    error: `Unsupported --target value "${next}". Supported targets are agents, skill, cursor, claude, gemini and all`,
                }
            target = next as AgentsTarget
            index++
        } else return { error: `Unknown argument "${arg ?? ""}" for agents` }
    }
    if (checkOnly && printOnly) return { error: "The --check and --print options cannot be combined" }
    if ((checkOnly || printOnly) && target !== undefined)
        return { error: `The ${checkOnly ? "--check" : "--print"} option cannot be combined with --target` }
    if (printOnly) return { mode: "print" }
    if (checkOnly) return { mode: "check" }
    return { mode: "write", target: target ?? "agents" }
}

function applyAgentsTarget(
    chosen: AgentsTarget,
    project: string,
    packageRoot: string,
    writeLine: (text: string, kind?: "ok" | "note") => void,
): void {
    if (chosen === "agents" || chosen === "claude" || chosen === "gemini" || chosen === "all") {
        const result = writeAgentsSection(project, packageRoot)
        writeLine(agentsMessages[result.status], "ok")
        if (chosen === "agents") for (const note of result.notes) writeLine(note, "note")
    }
    if (chosen === "skill" || chosen === "all") {
        const skill = writeSkillFile(project, packageRoot)
        writeLine(`${statusVerb[skill.status]} .agents/skills/fluxerly/SKILL.md`, "ok")
    }
    if (chosen === "cursor") {
        const rule = writeCursorRule(project, packageRoot)
        writeLine(`${statusVerb[rule.status]} .cursor/rules/fluxerly.mdc`, "ok")
    }
    if (chosen === "claude") {
        const claude = linkInstructionFile(project, "CLAUDE.md", "@AGENTS.md")
        writeLine(
            claude === "current" ? "CLAUDE.md already references AGENTS.md" : "Linked AGENTS.md from CLAUDE.md",
            "ok",
        )
    }
    if (chosen === "gemini") {
        const gemini = linkInstructionFile(project, "GEMINI.md", "Read AGENTS.md for project and Fluxerly SDK rules")
        writeLine(
            gemini === "current" ? "GEMINI.md already references AGENTS.md" : "Linked AGENTS.md from GEMINI.md",
            "ok",
        )
    }
}

/** Run `fluxerly agents [--target agents|skill|cursor|claude|gemini|all] [--check] [--print]` */
export function runAgentsCommand(
    args: readonly string[],
    environment: {
        readonly project: string
        readonly packageRoot: string
        readonly output: NodeJS.WritableStream & CliStreamLike
        readonly errorOutput: NodeJS.WritableStream & CliStreamLike
        readonly env?: Readonly<Record<string, string | undefined>>
        readonly platform?: NodeJS.Platform
    },
): 0 | 1 | "usage" {
    const { project, packageRoot, output, errorOutput, env, platform } = environment
    const outTheme = createCliTheme(output, { env, platform })
    const errTheme = createCliTheme(errorOutput, { env, platform })
    const writeError = (text: string) =>
        errorOutput.write(
            errTheme.capabilities.color === "none"
                ? `${text}\n`
                : `${errTheme.error(`${errTheme.symbols.fail} ${text}`)}\n`,
        )
    const writeOut = (text: string, kind: "ok" | "note" = "ok") => {
        if (outTheme.capabilities.color === "none") {
            output.write(`${text}\n`)
            return
        }
        output.write(
            kind === "note"
                ? `${outTheme.gold(outTheme.symbols.warn)} ${outTheme.muted(text)}\n`
                : `${outTheme.success(outTheme.symbols.pass)} ${text}\n`,
        )
    }

    const parsed = parseAgentsArgs(args)
    if ("error" in parsed) {
        writeError(parsed.error)
        return "usage"
    }
    if (parsed.mode === "print") {
        output.write(`${formatAgentsSection(project, packageRoot)}\n`)
        return 0
    }
    const command = localAgentsCommand(project)
    if (parsed.mode === "check") {
        const status = checkAgentsSection(project, packageRoot)
        if (status === "current") {
            writeOut("The Fluxerly section in AGENTS.md is current", "ok")
            return 0
        }
        if (status === "broken") {
            writeError(
                `AGENTS.md has broken Fluxerly markers. Repair the file so one ${start} precedes one ${end}, then run ${command}`,
            )
            return 1
        }
        const reason =
            status === "missing"
                ? "AGENTS.md has no Fluxerly section"
                : "The Fluxerly section in AGENTS.md is out of date"
        writeError(`${reason}. Run ${command} to refresh it`)
        return 1
    }
    try {
        applyAgentsTarget(parsed.target, project, packageRoot, writeOut)
        return 0
    } catch (error) {
        if (!(error instanceof AgentsSectionError)) throw error
        const detail = `${error.message}. AGENTS.md was not changed. Remove duplicate or unmatched markers so one ${start} precedes one ${end}, then run ${command}`
        writeError(detail)
        return 1
    }
}
