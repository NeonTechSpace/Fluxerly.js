/**
 * Runs `fluxerly triage [--agent claude|codex|antigravity] [--model <id>] [--dir <folder>] [--print]`.
 * Collects redacted project and SDK facts alongside Fluxerly's triage playbook and either prints them for any
 * coding agent or starts an installed terminal coding agent (Claude Code, Codex or Antigravity) inside the bot
 * project to diagnose whether an issue belongs to project code, Fluxer or `@neontechspace/fluxerly`
 */

import { spawn } from "node:child_process"
import {
    constants as fsConstants,
    accessSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs"
import { arch, homedir, platform as osPlatform, release as osRelease, tmpdir } from "node:os"
import { basename, delimiter, isAbsolute, join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { createCliTheme, type CliStreamLike } from "./cli-theme.js"
import { collectProjectFacts, type DoctorStatus, type ProjectFacts } from "./doctor-command.js"
import { maskText, maskedMessage } from "./masking.js"

export type TriageAgentId = "claude" | "codex" | "antigravity"

export interface TriageAgentSpec {
    readonly id: TriageAgentId
    readonly command: string
    readonly label: string
    readonly stateDirEnv: string
    readonly defaultStateDir: string
    readonly promptArgs?: readonly string[]
}

export const triageAgents: readonly TriageAgentSpec[] = Object.freeze([
    {
        id: "claude",
        command: "claude",
        label: "Claude Code",
        stateDirEnv: "CLAUDE_CONFIG_DIR",
        defaultStateDir: ".claude",
    },
    {
        id: "codex",
        command: "codex",
        label: "Codex",
        stateDirEnv: "CODEX_HOME",
        defaultStateDir: ".codex",
    },
    {
        id: "antigravity",
        command: "agy",
        label: "Antigravity",
        stateDirEnv: "GEMINI_HOME",
        defaultStateDir: ".gemini",
        promptArgs: ["--prompt-interactive"],
    },
])

export interface TriageOptions {
    readonly agent?: TriageAgentId | undefined
    readonly model?: string | undefined
    readonly dir?: string | undefined
    readonly log?: string | undefined
    readonly run?: string | undefined
    readonly problem?: string | undefined
    readonly print: boolean
}

export interface TriageTraceResult {
    readonly command: string
    readonly exitCode: number | null
    readonly signal: NodeJS.Signals | null
    readonly timedOut: boolean
    readonly output: string
    readonly truncated: boolean
    readonly errorMessage?: string | undefined
}

interface TriageSessionFiles {
    readonly sessionDir: string
    readonly promptFilePath: string
    readonly contextFilePath: string
    readonly traceFilePath?: string | undefined
}

export interface TriageSpawnRequest {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly shell: boolean
}

export interface TriageEnvironment {
    readonly project: string
    readonly packageRoot: string
    readonly input: NodeJS.ReadableStream & { readonly isTTY?: boolean | undefined }
    readonly output: NodeJS.WritableStream & CliStreamLike
    readonly errorOutput: NodeJS.WritableStream & CliStreamLike
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly platform?: NodeJS.Platform
    readonly nodeVersion?: string
    readonly osRelease?: string
    readonly osArch?: string
    readonly homedir?: string
    readonly sessionRoot?: string
    readonly traceTimeoutMs?: number
    readonly detectCommand?: (command: string) => string | undefined
    readonly spawnSession?: (request: TriageSpawnRequest) => Promise<number>
    readonly runTraceCommand?: (
        command: string,
        options: {
            readonly cwd: string
            readonly env: Readonly<Record<string, string | undefined>>
            readonly timeoutMs: number
        },
    ) => Promise<TriageTraceResult>
}

const agentIds = new Set<string>(triageAgents.map((agent) => agent.id))

/** Parse `fluxerly triage` CLI arguments and return either validated options or a specific 1-line error */
export function parseTriageArguments(
    args: readonly string[],
): { readonly ok: true; readonly options: TriageOptions } | { readonly ok: false; readonly message: string } {
    let agent: TriageAgentId | undefined
    let model: string | undefined
    let dir: string | undefined
    let log: string | undefined
    let run: string | undefined
    const problemParts: string[] = []
    let print = false
    let afterSeparator = false

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!
        if (afterSeparator) {
            problemParts.push(arg)
            continue
        }
        if (arg === "--") {
            afterSeparator = true
            continue
        }
        if (arg === "--print") {
            if (print) return { ok: false, message: "The --print option was passed more than once" }
            print = true
        } else if (arg === "--agent") {
            if (agent !== undefined) return { ok: false, message: "The --agent option was passed more than once" }
            const value = args[++index]
            if (!value || value.startsWith("-"))
                return { ok: false, message: "The --agent option requires claude, codex or antigravity" }
            const normalized = value.toLowerCase()
            if (!agentIds.has(normalized))
                return {
                    ok: false,
                    message: `Unsupported --agent value "${value}". Supported agents are claude, codex and antigravity`,
                }
            agent = normalized as TriageAgentId
        } else if (arg === "--model") {
            if (model !== undefined) return { ok: false, message: "The --model option was passed more than once" }
            const value = args[++index]
            if (!value || value.startsWith("-"))
                return { ok: false, message: "The --model option requires a model identifier" }
            model = value
        } else if (arg === "--dir") {
            if (dir !== undefined) return { ok: false, message: "The --dir option was passed more than once" }
            const value = args[++index]
            if (!value || value.startsWith("-"))
                return { ok: false, message: "The --dir option requires a folder path" }
            dir = value
        } else if (arg === "--log") {
            if (log !== undefined) return { ok: false, message: "The --log option was passed more than once" }
            const value = args[++index]
            if (!value || value.startsWith("-"))
                return { ok: false, message: "The --log option requires a log file path" }
            log = value
        } else if (arg === "--run") {
            if (run !== undefined) return { ok: false, message: "The --run option was passed more than once" }
            const value = args[++index]
            if (!value || !value.trim())
                return { ok: false, message: "The --run option requires a command string to execute" }
            run = value.trim()
        } else if (arg.startsWith("-")) {
            return { ok: false, message: `Unknown argument "${arg}" for triage` }
        } else {
            problemParts.push(arg)
        }
    }

    if (print && (agent !== undefined || model !== undefined))
        return { ok: false, message: "The --print option cannot be combined with --agent or --model" }

    const joinedProblem = problemParts.join(" ").trim()
    const problem = joinedProblem.length > 0 ? joinedProblem : undefined
    return { ok: true, options: { agent, model, dir, log, run, problem, print } }
}

/** Replace the user's home directory prefix with `~` so triage context never leaks usernames */
export function redactHomePath(target: string, home: string): string {
    if (!home) return target
    const normalizedHome = home.endsWith("/") || home.endsWith("\\") ? home.slice(0, -1) : home
    if (!normalizedHome) return target
    if (target === normalizedHome) return "~"
    const sep = target[normalizedHome.length]
    if (target.startsWith(normalizedHome) && (sep === "/" || sep === "\\"))
        return `~${target.slice(normalizedHome.length)}`
    return target
}

function readBundledPlaybook(packageRoot: string): string {
    const playbookPath = join(packageRoot, "agents", "TRIAGE.md")
    if (existsSync(playbookPath)) return readFileSync(playbookPath, "utf8").trimEnd()
    return [
        "# Fluxerly triage playbook",
        "",
        "Investigate the reported Fluxerly problem using triage-context.md and the installed SDK source.",
        "Separate bot configuration, Fluxer behavior and SDK bugs, prefer createTestBot reproductions, redact all secrets and ask before modifying files or posting issues",
    ].join("\n")
}

const maxLogExcerptChars = 16_000
const maxTraceCaptureChars = 256_000
const defaultTraceTimeoutMs = 30_000
const sensitiveLogFilePattern =
    /^(?:\.env(?:\..+)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|credentials(?:\..+)?|secrets?(?:\..+)?)$/i

function isSensitiveLogFile(filePath: string): boolean {
    const name = basename(filePath)
    return sensitiveLogFilePattern.test(name)
}

function redactInlineText(text: string, home: string): string {
    const masked = maskText(text)
    if (!home) return masked
    const normalizedHome = home.endsWith("/") || home.endsWith("\\") ? home.slice(0, -1) : home
    if (!normalizedHome) return masked
    return masked.replaceAll(normalizedHome, "~")
}

function readRedactedLogTail(
    filePath: string,
    home: string,
):
    | { readonly ok: true; readonly excerpt: string; readonly truncated: boolean }
    | { readonly ok: false; readonly message: string } {
    if (isSensitiveLogFile(filePath))
        return {
            ok: false,
            message: `Refusing to read "${basename(filePath)}" with --log because it looks like a credential or secret file`,
        }
    if (!existsSync(filePath)) return { ok: false, message: `Log file "${filePath}" was not found` }
    let raw: string
    try {
        raw = readFileSync(filePath, "utf8")
    } catch (error) {
        const message = maskedMessage(error)
        const detail = message ? ` (${message})` : ""
        return { ok: false, message: `Could not read log file "${filePath}"${detail}` }
    }
    const truncated = raw.length > maxLogExcerptChars
    const slice = truncated ? raw.slice(raw.length - maxLogExcerptChars) : raw
    return { ok: true, excerpt: redactInlineText(slice, home).trimEnd(), truncated }
}

function defaultRunTraceCommand(
    command: string,
    options: {
        readonly cwd: string
        readonly env: Readonly<Record<string, string | undefined>>
        readonly timeoutMs: number
    },
): Promise<TriageTraceResult> {
    return new Promise((resolveTrace) => {
        const debugValue = options.env.FLUXERLY_DEBUG?.trim() || "rest,gateway"
        const child = spawn(command, {
            cwd: options.cwd,
            env: { ...options.env, FLUXERLY_DEBUG: debugValue },
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
        })
        let buffer = ""
        let truncated = false
        let timedOut = false
        let settled = false
        const append = (chunk: Buffer) => {
            buffer += chunk.toString("utf8")
            if (buffer.length > maxTraceCaptureChars) {
                buffer = buffer.slice(buffer.length - maxTraceCaptureChars)
                truncated = true
            }
        }
        child.stdout?.on("data", append)
        child.stderr?.on("data", append)
        const timer = setTimeout(() => {
            timedOut = true
            child.kill("SIGTERM")
            const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000)
            killTimer.unref()
        }, options.timeoutMs)
        timer.unref()
        const finish = (
            exitCode: number | null,
            signal: NodeJS.Signals | null,
            errorMessage?: string,
        ) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolveTrace({
                command,
                exitCode,
                signal,
                timedOut,
                output: buffer,
                truncated,
                errorMessage,
            })
        }
        child.once("error", (error) => finish(null, null, maskedMessage(error) || "Failed to execute command"))
        child.once("close", (code, signal) => finish(code, signal))
    })
}

/** Render redacted machine, SDK and static doctor facts as Markdown for `triage-context.md` */
function formatTriageContext(
    facts: ProjectFacts,
    options: {
        readonly project: string
        readonly nodeVersion: string
        readonly platform: NodeJS.Platform
        readonly osRelease: string
        readonly osArch: string
        readonly homedir: string
        readonly generatedAt: string
        readonly problem?: string | undefined
        readonly logExcerpt?:
            | { readonly path: string; readonly excerpt: string; readonly truncated: boolean }
            | undefined
        readonly trace?:
            | {
                  readonly result: TriageTraceResult
                  readonly redactedOutput: string
                  readonly traceFilePath?: string | undefined
              }
            | undefined
    },
): string {
    const redact = (value: string) => redactHomePath(value, options.homedir)
    const statusLabels: Record<DoctorStatus, string> = { pass: "OK", warn: "WARN", fail: "FAIL" }
    const installedPin = facts.installedSdkFluxerCommit
        ? `${facts.installedSdkFluxerCommit} (${facts.installedSdkFluxerCommit.slice(0, 7)})`
        : "unknown (older SDK release or not installed)"
    const cliPin = `${facts.cliFluxerCommit} (${facts.cliFluxerCommit.slice(0, 7)})`
    const lines = [
        "# Fluxerly triage context",
        "",
        "Redacted environment and static project facts collected offline by `fluxerly triage`. No `.env` values or secrets were read",
        "",
        "## Environment",
        "",
        `- Generated: ${options.generatedAt}`,
        `- Operating system: ${options.platform} ${options.osRelease} (${options.osArch})`,
        `- Node.js: ${options.nodeVersion}`,
        `- Package manager: ${facts.packageManager}`,
        `- Project folder: ${redact(options.project)}`,
        `- Triage CLI version: ${facts.cliVersion ?? "unknown"}`,
        `- Target Fluxer server commit (triage CLI): ${cliPin}`,
        `- Installed @neontechspace/fluxerly version: ${facts.installedSdkVersion ?? "not installed in node_modules"}`,
        `- Target Fluxer server commit (installed SDK): ${installedPin}`,
        `- Installed effect version: ${facts.installedEffectVersion ?? "not installed in node_modules"}`,
        `- Installed typescript version: ${facts.installedTypeScriptVersion ?? "not installed in node_modules"}`,
        `- Installed @types/node version: ${facts.installedTypesNodeVersion ?? "not installed in node_modules"}`,
        `- tsconfig.json present: ${facts.hasTsConfig ? "yes" : "no"}`,
        "",
        "## Local SDK paths",
        "",
        `- Installed package folder: ${facts.installedSdkPath ? redact(facts.installedSdkPath) : "not found in node_modules"}`,
        `- SDK TypeScript source: ${facts.installedSdkSourcePath ? redact(facts.installedSdkSourcePath) : "unavailable"}`,
        `- SDK agent guide: ${facts.installedAgentsGuidePath ? redact(facts.installedAgentsGuidePath) : "unavailable"}`,
        "- Secrets note: Never read `.env` or credential files in this project",
        "",
        "## Static doctor checks",
        "",
        `Overall: ${facts.doctor.ok ? "ok (no failures)" : "failures found"}`,
        "",
    ]
    for (const check of facts.doctor.checks) {
        lines.push(`- [${statusLabels[check.status]}] (${check.id}) ${check.message}`)
        if (check.fix) lines.push(`  Fix: ${check.fix}`)
    }
    if (options.problem) {
        lines.push("", "## Reported symptom", "", redactInlineText(options.problem, options.homedir))
    }
    if (options.logExcerpt) {
        const heading = options.logExcerpt.truncated
            ? `Redacted tail of ${redact(options.logExcerpt.path)} (last ${maxLogExcerptChars} characters):`
            : `Redacted contents of ${redact(options.logExcerpt.path)}:`
        lines.push("", "## Redacted log excerpt", "", heading, "", "```text", options.logExcerpt.excerpt, "```")
    }
    if (options.trace) {
        const { result, redactedOutput, traceFilePath } = options.trace
        const excerptTruncated = redactedOutput.length > maxLogExcerptChars || result.truncated
        const excerpt =
            redactedOutput.length > maxLogExcerptChars
                ? redactedOutput.slice(redactedOutput.length - maxLogExcerptChars)
                : redactedOutput
        const statusSummary = result.errorMessage
            ? `failed to start (${redactInlineText(result.errorMessage, options.homedir)})`
            : result.timedOut
              ? `timed out (exit ${result.exitCode ?? "null"}, signal ${result.signal ?? "none"})`
              : `exit ${result.exitCode ?? "null"}${result.signal ? ` (signal ${result.signal})` : ""}`
        lines.push(
            "",
            "## Redacted debug trace (--run)",
            "",
            `- Command: \`${redactInlineText(result.command, options.homedir)}\``,
            `- Outcome: ${statusSummary}`,
        )
        if (traceFilePath) lines.push(`- Full redacted trace file: ${redact(traceFilePath)}`)
        if (excerpt.trim().length > 0) {
            lines.push(
                "",
                excerptTruncated
                    ? `Redacted trace tail (last ${maxLogExcerptChars} characters):`
                    : "Redacted trace output:",
                "",
                "```text",
                excerpt.trimEnd(),
                "```",
            )
        } else {
            lines.push("", "Command produced no stdout or stderr output")
        }
    }
    return `${lines.join("\n")}\n`
}

/** Build the single-line launch prompt passed to an agent CLI (Windows `.cmd` safe) */
export function buildTriageLaunchPrompt(promptFilePath: string, hasProblem = false): string {
    return hasProblem
        ? `Read and follow ${promptFilePath}, then read the sibling triage-context.md file (including the reported symptom) and begin investigating`
        : `Read and follow ${promptFilePath}, then read the sibling triage-context.md file and ask what went wrong`
}

/** Write `triage-context.md`, `triage-prompt.md` and optional `triage-trace.log` into a fresh temporary session folder */
function writeTriageSession(options: {
    readonly packageRoot: string
    readonly project: string
    readonly facts: ProjectFacts
    readonly nodeVersion: string
    readonly platform: NodeJS.Platform
    readonly osRelease: string
    readonly osArch: string
    readonly homedir: string
    readonly sessionRoot?: string | undefined
    readonly problem?: string | undefined
    readonly logExcerpt?: { readonly path: string; readonly excerpt: string; readonly truncated: boolean } | undefined
    readonly trace?: { readonly result: TriageTraceResult; readonly redactedOutput: string } | undefined
}): TriageSessionFiles {
    const root = options.sessionRoot ?? tmpdir()
    mkdirSync(root, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const sessionDir = mkdtempSync(join(root, `fluxerly-triage-${stamp}-`))

    const contextFilePath = join(sessionDir, "triage-context.md")
    const promptFilePath = join(sessionDir, "triage-prompt.md")
    let traceFilePath: string | undefined
    if (options.trace) {
        traceFilePath = join(sessionDir, "triage-trace.log")
        writeFileSync(traceFilePath, `${options.trace.redactedOutput.trimEnd()}\n`, { encoding: "utf8", mode: 0o600 })
    }
    const context = formatTriageContext(options.facts, {
        project: options.project,
        nodeVersion: options.nodeVersion,
        platform: options.platform,
        osRelease: options.osRelease,
        osArch: options.osArch,
        homedir: options.homedir,
        generatedAt: new Date().toISOString(),
        problem: options.problem,
        logExcerpt: options.logExcerpt,
        trace: options.trace ? { ...options.trace, traceFilePath } : undefined,
    })
    const playbook = readBundledPlaybook(options.packageRoot)
    const prompt = [playbook, "", "---", "", `Session context file: ${contextFilePath}`, ""].join("\n")

    writeFileSync(contextFilePath, context, { encoding: "utf8", mode: 0o600 })
    writeFileSync(promptFilePath, prompt, { encoding: "utf8", mode: 0o600 })
    return { sessionDir, promptFilePath, contextFilePath, traceFilePath }
}

/** Resolve an executable on PATH across Unix and Windows (including Windows executable shims) */
export function findCommandOnPath(
    command: string,
    env: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform,
): string | undefined {
    const rawPath = env.PATH ?? env.Path ?? ""
    if (!rawPath) return undefined
    const extensions =
        platform === "win32"
            ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
                  .split(";")
                  .map((ext) => ext.trim())
                  .filter(Boolean)
            : [""]
    for (const dir of rawPath.split(delimiter)) {
        if (!dir) continue
        for (const ext of extensions) {
            const candidate = join(
                dir,
                ext && !command.toLowerCase().endsWith(ext.toLowerCase()) ? `${command}${ext}` : command,
            )
            if (!existsSync(candidate)) continue
            if (platform === "win32") return candidate
            try {
                accessSync(candidate, fsConstants.X_OK)
                return candidate
            } catch {
                // allow-silent: Skip non-executable PATH matches
            }
        }
    }
    return undefined
}

/** Match a user's numbered or named answer in the agent picker */
export function matchTriageAgentAnswer(
    agents: readonly TriageAgentSpec[],
    answer: string,
): TriageAgentSpec | undefined {
    const trimmed = answer.trim()
    if (!trimmed) return undefined
    return (
        agents.find((_, index) => String(index + 1) === trimmed) ??
        agents.find((agent) => agent.id === trimmed.toLowerCase() || agent.command === trimmed.toLowerCase())
    )
}

async function pickTriageAgent(
    agents: readonly TriageAgentSpec[],
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream & CliStreamLike,
    env: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform,
): Promise<TriageAgentSpec | undefined> {
    const theme = createCliTheme(output, { env, platform })
    const rl = createInterface({ input, output })
    try {
        const menu = agents
            .map(
                (agent, index) =>
                    `  ${theme.cyan(`[${index + 1}]`)} ${theme.bold(agent.label)} ${theme.faint(`(${agent.command})`)}`,
            )
            .join("\n")
        for (;;) {
            const answer = await rl.question(
                `${theme.bold("Run triage with:")}\n${menu}\n${theme.cyan(theme.symbols.pointer)} `,
            )
            const picked = matchTriageAgentAnswer(agents, answer)
            if (picked !== undefined) return picked
            output.write(`${theme.gold(`Enter a number from 1 to ${agents.length}, or an agent name`)}\n`)
        }
    } catch (error) {
        if (error instanceof Error && (error.name === "AbortError" || error.message.includes("readline was closed")))
            return undefined
        throw error
    } finally {
        rl.close()
    }
}

function defaultSpawnSession(request: TriageSpawnRequest): Promise<number> {
    return new Promise((resolveExit, rejectExit) => {
        const child = spawn(request.command, [...request.args], {
            cwd: request.cwd,
            stdio: "inherit",
            shell: request.shell,
        })
        child.once("error", rejectExit)
        child.once("exit", (code, signal) => resolveExit(code ?? (signal === null ? 0 : 1)))
    })
}

function resolveAgentStateDir(
    agent: TriageAgentSpec,
    env: Readonly<Record<string, string | undefined>>,
    home: string,
): string {
    return env[agent.stateDirEnv]?.trim() || join(home, agent.defaultStateDir)
}

/** Run `fluxerly triage` and return exit code 0, 1 or "usage" */
export async function runTriage(args: readonly string[], environment: TriageEnvironment): Promise<0 | 1 | "usage"> {
    const env = environment.env ?? process.env
    const platform = environment.platform ?? osPlatform()
    const nodeVersion = environment.nodeVersion ?? process.versions.node
    const currentOsRelease = environment.osRelease ?? osRelease()
    const currentOsArch = environment.osArch ?? arch()
    const home = environment.homedir ?? homedir()
    const errTheme = createCliTheme(environment.errorOutput, { env, platform })
    const writeError = (message: string) =>
        environment.errorOutput.write(
            errTheme.capabilities.color === "none"
                ? `${message}\n`
                : `${errTheme.error(`${errTheme.symbols.fail} ${message}`)}\n`,
        )

    const parsed = parseTriageArguments(args)
    if (!parsed.ok) {
        writeError(parsed.message)
        return "usage"
    }

    const { options } = parsed
    const targetProject = options.dir
        ? isAbsolute(options.dir)
            ? options.dir
            : resolve(environment.project, options.dir)
        : environment.project
    if (!existsSync(targetProject)) {
        writeError(`Project folder "${targetProject}" was not found`)
        return 1
    }

    let logExcerpt: { readonly path: string; readonly excerpt: string; readonly truncated: boolean } | undefined
    if (options.log !== undefined) {
        const resolvedLog = isAbsolute(options.log) ? options.log : resolve(targetProject, options.log)
        const loaded = readRedactedLogTail(resolvedLog, home)
        if (!loaded.ok) {
            writeError(loaded.message)
            return 1
        }
        logExcerpt = { path: resolvedLog, excerpt: loaded.excerpt, truncated: loaded.truncated }
    }

    const facts = collectProjectFacts(targetProject, environment.packageRoot, nodeVersion)
    const theme = createCliTheme(environment.output, { env, platform })

    let trace: { readonly result: TriageTraceResult; readonly redactedOutput: string } | undefined
    if (options.run !== undefined) {
        if (!options.print) {
            const notice = `Running trace command with FLUXERLY_DEBUG=${env.FLUXERLY_DEBUG?.trim() || "rest,gateway"}`
            environment.output.write(
                theme.capabilities.color === "none" ? `${notice}\n` : `${theme.cyan(theme.symbols.pointer)} ${theme.muted(notice)}\n`,
            )
        }
        const traceRunner = environment.runTraceCommand ?? defaultRunTraceCommand
        const result = await traceRunner(options.run, {
            cwd: targetProject,
            env,
            timeoutMs: environment.traceTimeoutMs ?? defaultTraceTimeoutMs,
        })
        trace = { result, redactedOutput: redactInlineText(result.output, home) }
    }

    if (options.print) {
        const context = formatTriageContext(facts, {
            project: targetProject,
            nodeVersion,
            platform,
            osRelease: currentOsRelease,
            osArch: currentOsArch,
            homedir: home,
            generatedAt: new Date().toISOString(),
            problem: options.problem,
            logExcerpt,
            trace,
        })
        const playbook = readBundledPlaybook(environment.packageRoot)
        environment.output.write(`${playbook}\n\n---\n\n${context}`)
        return 0
    }

    if (theme.capabilities.color !== "none") {
        const banner = theme.renderBanner({
            version: facts.cliVersion,
            subtitle: "Agent-powered SDK and bot triage",
            detail: redactHomePath(targetProject, home),
            hint: "Offline facts only. Never reads .env secrets or edits without asking",
        })
        if (banner) environment.output.write(`${banner}\n`)
    }

    const session = writeTriageSession({
        packageRoot: environment.packageRoot,
        project: targetProject,
        facts,
        nodeVersion,
        platform,
        osRelease: currentOsRelease,
        osArch: currentOsArch,
        homedir: home,
        sessionRoot: environment.sessionRoot,
        problem: options.problem,
        logExcerpt,
        trace,
    })

    const detect = environment.detectCommand ?? ((command: string) => findCommandOnPath(command, env, platform))
    const installed: { readonly agent: TriageAgentSpec; readonly resolved: string }[] = []
    for (const agent of triageAgents) {
        const resolved = detect(agent.command)
        if (resolved) installed.push({ agent, resolved })
    }

    let selected: { readonly agent: TriageAgentSpec; readonly resolved: string } | undefined
    if (options.agent !== undefined) {
        selected = installed.find((entry) => entry.agent.id === options.agent)
        if (!selected) {
            const spec = triageAgents.find((item) => item.id === options.agent)!
            writeError(`The "${spec.command}" CLI (${spec.label}) was not found on PATH`)
            environment.output.write(
                [
                    "",
                    "The triage prompt and context were written to:",
                    `  ${session.promptFilePath}`,
                    `  ${session.contextFilePath}`,
                    "",
                    "Run `fluxerly triage --print` to copy the triage brief into any coding agent",
                    "",
                ].join("\n"),
            )
            return 1
        }
    } else if (installed.length === 1) {
        selected = installed[0]
    } else if (installed.length > 1) {
        if (environment.input.isTTY !== true || environment.output.isTTY !== true) {
            writeError(
                "Multiple supported agent CLIs are installed and there is no terminal to pick one. Re-run with --agent claude, --agent codex, --agent antigravity or --print",
            )
            return 1
        }
        const picked = await pickTriageAgent(
            installed.map((entry) => entry.agent),
            environment.input,
            environment.output,
            env,
            platform,
        )
        if (!picked) {
            environment.output.write("\nNo agent started\n")
            return 0
        }
        selected = installed.find((entry) => entry.agent.id === picked.id)
    }

    const launchPrompt = buildTriageLaunchPrompt(
        session.promptFilePath,
        options.problem !== undefined || logExcerpt !== undefined || trace !== undefined,
    )
    if (!selected) {
        environment.output.write(
            [
                "No supported terminal coding agent CLI (claude, codex or agy) was found on PATH",
                "",
                "The triage playbook and redacted project context were written to:",
                `  ${session.promptFilePath}`,
                `  ${session.contextFilePath}`,
                "",
                "Paste this prompt into any coding agent, or run `fluxerly triage --print`:",
                `  ${launchPrompt}`,
                "",
            ].join("\n"),
        )
        return 0
    }

    const { agent, resolved } = selected
    const isWindowsCmd = platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)
    const command = platform === "win32" ? agent.command : resolve(resolved)
    const spawnArgs = [
        ...(options.model === undefined ? [] : ["--model", options.model]),
        ...(agent.promptArgs ?? []),
        launchPrompt,
    ]
    environment.output.write(
        theme.capabilities.color === "none"
            ? `Starting ${agent.label}. It will read the redacted context and ask what went wrong\n\n`
            : `${theme.cyan(theme.symbols.pointer)} Starting ${theme.bold(agent.label)}. ${theme.muted("It will read the redacted context and ask what went wrong")}\n\n`,
    )

    const spawnFn = environment.spawnSession ?? defaultSpawnSession
    let exitCode: number
    try {
        exitCode = await spawnFn({
            command,
            args: spawnArgs,
            cwd: targetProject,
            shell: isWindowsCmd,
        })
    } catch (error) {
        const message = maskedMessage(error)
        const detail = message ? ` (${message})` : ""
        writeError(`Could not start "${agent.command}"${detail}`)
        return 1
    }

    if (exitCode !== 0) {
        const stateDir = resolveAgentStateDir(agent, env, home)
        environment.output.write(
            [
                "",
                `${agent.label} exited with code ${exitCode}`,
                "",
                `${agent.label} stores its state in ${redactHomePath(stateDir, home)} (override with ${agent.stateDirEnv})`,
                "",
                "The triage playbook and redacted project context remain at:",
                `  ${session.promptFilePath}`,
                `  ${session.contextFilePath}`,
                "",
                `To retry, start \`${agent.command}\` manually or use any coding agent with:`,
                `  ${launchPrompt}`,
                "",
            ].join("\n"),
        )
        return 1
    }

    return 0
}
