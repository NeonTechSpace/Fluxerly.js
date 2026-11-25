/**
 * Runs `fluxerly triage [--agent antigravity|claude|codex|opencode|t3code|other] [--model <id>] [--dir <folder>] [--print]`.
 * Collects redacted project and SDK facts alongside Fluxerly's triage playbook and either prints a harness-agnostic
 * prompt and session files for any coding agent or starts a detected CLI (Antigravity, Claude Code, Codex, OpenCode
 * or T3 Code) inside the bot project to diagnose whether an issue belongs to project code, Fluxer or `@neontechspace/fluxerly`
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
import { StringDecoder } from "node:string_decoder"
import { createCliTheme, type CliStreamLike } from "./cli-theme.js"
import { collectProjectFacts, type DoctorStatus, type ProjectFacts } from "./doctor-command.js"
import { maskText, maskedMessage } from "./masking.js"

export type TriageAgentId = "antigravity" | "claude" | "codex" | "opencode" | "t3code"
export type TriageAgentOption = TriageAgentId | "other"

export interface TriageAgentArgsContext {
    readonly launchPrompt: string
    readonly model?: string | undefined
    readonly targetProject: string
}

export interface TriageAgentSpec {
    readonly id: TriageAgentId
    readonly command: string
    readonly label: string
    readonly stateDirEnv: string
    readonly defaultStateDir: string
    readonly aliases?: readonly string[]
    readonly promptArgs?: readonly string[]
    readonly buildArgs?: (context: TriageAgentArgsContext) => readonly string[]
}

export const triageAgents: readonly TriageAgentSpec[] = Object.freeze([
    {
        id: "antigravity",
        command: "agy",
        label: "Antigravity",
        stateDirEnv: "GEMINI_HOME",
        defaultStateDir: ".gemini",
        promptArgs: ["--prompt-interactive"],
    },
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
        id: "opencode",
        command: "opencode",
        label: "OpenCode",
        stateDirEnv: "OPENCODE_CONFIG_DIR",
        defaultStateDir: ".config/opencode",
        promptArgs: ["--prompt"],
    },
    {
        id: "t3code",
        command: "t3",
        label: "T3 Code",
        stateDirEnv: "T3CODE_HOME",
        defaultStateDir: ".t3",
        aliases: ["t3"],
        buildArgs: ({ launchPrompt, model, targetProject }) => [
            "thread",
            "start",
            "--title",
            "Fluxerly triage",
            ...(model === undefined ? [] : ["--model", model]),
            targetProject,
            launchPrompt,
        ],
    },
])

export interface TriageOptions {
    readonly agent?: TriageAgentOption | undefined
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
    readonly copyToClipboard?: (text: string) => Promise<boolean>
    readonly runTraceCommand?: (
        command: string,
        options: {
            readonly cwd: string
            readonly env: Readonly<Record<string, string | undefined>>
            readonly timeoutMs: number
        },
    ) => Promise<TriageTraceResult>
}

const agentAliases = new Map<string, TriageAgentOption>([
    ...triageAgents.flatMap((agent): [string, TriageAgentOption][] => [
        [agent.id, agent.id],
        ...(agent.aliases ?? []).map((alias): [string, TriageAgentOption] => [alias, agent.id]),
    ]),
    ["other", "other"],
    ["any", "other"],
])

/** Parse `fluxerly triage` CLI arguments and return either validated options or a specific 1-line error */
export function parseTriageArguments(
    args: readonly string[],
): { readonly ok: true; readonly options: TriageOptions } | { readonly ok: false; readonly message: string } {
    let agent: TriageAgentOption | undefined
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
                return {
                    ok: false,
                    message: "The --agent option requires antigravity, claude, codex, opencode, t3code or other",
                }
            const resolved = agentAliases.get(value.toLowerCase())
            if (resolved === undefined)
                return {
                    ok: false,
                    message: `Unsupported --agent value "${value}". Supported agents are antigravity, claude, codex, opencode, t3code and other`,
                }
            agent = resolved
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
            const trimmed = value?.trim() ?? ""
            if (!trimmed || trimmed.startsWith("-"))
                return { ok: false, message: "The --run option requires a command string to execute" }
            run = trimmed
        } else if (arg.startsWith("-")) {
            return { ok: false, message: `Unknown argument "${arg}" for triage` }
        } else {
            problemParts.push(arg)
        }
    }

    if (print && (agent !== undefined || model !== undefined))
        return { ok: false, message: "The --print option cannot be combined with --agent or --model" }
    if (agent === "other" && model !== undefined)
        return { ok: false, message: "The --model option cannot be combined with --agent other" }

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

function envSecrets(env: Readonly<Record<string, string | undefined>>): readonly string[] {
    const keys = ["FLUXER_BOT_TOKEN", "FLUXER_TOKEN", "BOT_TOKEN"]
    const values: string[] = []
    for (const key of keys) {
        const value = env[key]?.trim()
        if (value && value.length >= 6) values.push(value)
    }
    return values
}

function redactInlineText(text: string, home: string, secrets: readonly string[] = []): string {
    const masked = maskText(text, secrets)
    if (!home) return masked
    const normalizedHome = home.endsWith("/") || home.endsWith("\\") ? home.slice(0, -1) : home
    if (!normalizedHome) return masked
    return masked.replaceAll(normalizedHome, "~")
}

const maxTraceRawLineChars = 262_144
const maxTraceRawBufferChars = 1_048_576

function sliceRedactedTail(masked: string, maxChars: number): string {
    if (masked.length <= maxChars) return masked
    let start = masked.length - maxChars
    for (const marker of ["[redacted]", "[REDACTED]"]) {
        const markerStart = masked.lastIndexOf(marker, start)
        if (markerStart !== -1 && markerStart < start && markerStart + marker.length > start) {
            start = markerStart + marker.length
        }
    }
    return masked.slice(start)
}

function redactAndTail(
    raw: string,
    maxChars: number,
    home: string,
    secrets: readonly string[] = [],
): { readonly text: string; readonly truncated: boolean } {
    const masked = redactInlineText(raw, home, secrets)
    return {
        text: sliceRedactedTail(masked, maxChars),
        truncated: raw.length > maxChars || masked.length > maxChars,
    }
}

function markdownCodeFence(body: string): string {
    let longest = 2
    for (const match of body.matchAll(/`+/g)) {
        if (match[0].length > longest) longest = match[0].length
    }
    return "`".repeat(longest + 1)
}

function readRedactedLogTail(
    filePath: string,
    home: string,
    secrets: readonly string[] = [],
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
    const tailed = redactAndTail(raw, maxLogExcerptChars, home, secrets)
    return { ok: true, excerpt: tailed.text.trimEnd(), truncated: tailed.truncated }
}

function terminateTraceProcessTree(child: ReturnType<typeof spawn>, signal: "SIGTERM" | "SIGKILL"): void {
    const pid = child.pid
    if (process.platform === "win32") {
        if (pid !== undefined) {
            try {
                const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
                    stdio: "ignore",
                    windowsHide: true,
                })
                killer.once("error", () => {
                    // allow-silent: Ignore missing Windows kill helper when falling back
                })
                killer.unref()
                return
            } catch {
                // allow-silent: Fall back to direct child.kill when process tree termination is unavailable
            }
        }
        try {
            child.kill(signal)
        } catch {
            // allow-silent: Process already exited
        }
        return
    }
    if (pid !== undefined) {
        try {
            process.kill(-pid, signal)
            return
        } catch {
            // allow-silent: Process group may already have exited; fall back to direct child.kill
        }
    }
    try {
        child.kill(signal)
    } catch {
        // allow-silent: Process already exited
    }
}

function processGroupAlive(pid: number): boolean {
    try {
        process.kill(-pid, 0)
        return true
    } catch {
        // allow-silent: Missing process group means no descendant remains
        return false
    }
}

function defaultRunTraceCommand(
    command: string,
    options: {
        readonly cwd: string
        readonly env: Readonly<Record<string, string | undefined>>
        readonly timeoutMs: number
        readonly homedir?: string | undefined
        readonly secrets?: readonly string[] | undefined
    },
): Promise<TriageTraceResult> {
    return new Promise((resolveTrace) => {
        const debugValue = options.env.FLUXERLY_DEBUG?.trim() || "rest,gateway"
        const home = options.homedir ?? homedir()
        const secrets = options.secrets ?? envSecrets(options.env)
        const child = spawn(command, {
            cwd: options.cwd,
            env: { ...options.env, FLUXERLY_DEBUG: debugValue },
            shell: true,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        })
        let completedMasked = ""
        let completedRaw = ""
        let truncated = false
        let timedOut = false
        let settled = false
        let killTimer: ReturnType<typeof setTimeout> | undefined
        let exitDrainTimer: ReturnType<typeof setTimeout> | undefined

        interface StreamBufferState {
            pendingLine: string
            droppingLongLine: boolean
            readonly decoder: StringDecoder
        }
        const createStreamState = (): StreamBufferState => ({
            pendingLine: "",
            droppingLongLine: false,
            decoder: new StringDecoder("utf8"),
        })
        const stdoutState = createStreamState()
        const stderrState = createStreamState()

        const flushCompletedRaw = () => {
            if (completedRaw.length === 0) return
            const maskedBatch = redactInlineText(completedRaw, home, secrets)
            completedRaw = ""
            const combined = completedMasked + maskedBatch
            if (combined.length > maxTraceCaptureChars) truncated = true
            completedMasked = sliceRedactedTail(combined, maxTraceCaptureChars)
        }

        const pushCompletedLine = (line: string) => {
            completedRaw += `${line}\n`
            if (completedRaw.length > maxTraceRawBufferChars) flushCompletedRaw()
        }

        const appendText = (state: StreamBufferState, text: string) => {
            let offset = 0
            while (offset < text.length) {
                const nlIndex = text.indexOf("\n", offset)
                if (state.droppingLongLine) {
                    if (nlIndex === -1) return
                    state.droppingLongLine = false
                    offset = nlIndex + 1
                    continue
                }
                if (nlIndex !== -1) {
                    const piece = text.slice(offset, nlIndex)
                    if (state.pendingLine.length + piece.length > maxTraceRawLineChars) {
                        state.pendingLine = ""
                        truncated = true
                        pushCompletedLine("[omitted oversized line]")
                    } else {
                        pushCompletedLine(state.pendingLine + piece)
                        state.pendingLine = ""
                    }
                    offset = nlIndex + 1
                } else {
                    const piece = text.slice(offset)
                    if (state.pendingLine.length + piece.length > maxTraceRawLineChars) {
                        state.pendingLine = ""
                        state.droppingLongLine = true
                        truncated = true
                        pushCompletedLine("[omitted oversized line]")
                    } else {
                        state.pendingLine += piece
                    }
                    return
                }
            }
        }

        child.stdout?.on("data", (chunk: Buffer) => appendText(stdoutState, stdoutState.decoder.write(chunk)))
        child.stderr?.on("data", (chunk: Buffer) => appendText(stderrState, stderrState.decoder.write(chunk)))
        const finish = (exitCode: number | null, signal: NodeJS.Signals | null, errorMessage?: string) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (killTimer !== undefined) clearTimeout(killTimer)
            if (exitDrainTimer !== undefined) clearTimeout(exitDrainTimer)
            if (process.platform !== "win32" && child.pid !== undefined && processGroupAlive(child.pid)) {
                terminateTraceProcessTree(child, "SIGKILL")
            }
            const stdoutRest = stdoutState.decoder.end()
            if (stdoutRest.length > 0) appendText(stdoutState, stdoutRest)
            const stderrRest = stderrState.decoder.end()
            if (stderrRest.length > 0) appendText(stderrState, stderrRest)
            if (stdoutState.pendingLine.length > 0) pushCompletedLine(stdoutState.pendingLine)
            if (stderrState.pendingLine.length > 0) pushCompletedLine(stderrState.pendingLine)
            const maskedTail = completedRaw.length > 0 ? redactInlineText(completedRaw, home, secrets) : ""
            const combined = completedMasked + maskedTail
            const output = sliceRedactedTail(combined, maxTraceCaptureChars)
            resolveTrace({
                command,
                exitCode,
                signal,
                timedOut,
                output,
                truncated: truncated || combined.length > maxTraceCaptureChars,
                errorMessage,
            })
        }
        const timer = setTimeout(() => {
            timedOut = true
            terminateTraceProcessTree(child, "SIGTERM")
            killTimer = setTimeout(() => {
                terminateTraceProcessTree(child, "SIGKILL")
                child.stdout?.destroy()
                child.stderr?.destroy()
                finish(null, "SIGKILL")
            }, 500)
            killTimer.unref()
        }, options.timeoutMs)
        timer.unref()
        child.once("error", (error) => finish(null, null, maskedMessage(error) || "Failed to execute command"))
        child.once("exit", (code, signal) => {
            if (settled || timedOut) return
            clearTimeout(timer)
            exitDrainTimer = setTimeout(() => {
                terminateTraceProcessTree(child, "SIGKILL")
                child.stdout?.destroy()
                child.stderr?.destroy()
                finish(code, signal)
            }, 50)
            exitDrainTimer.unref()
        })
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
        readonly secrets?: readonly string[] | undefined
        readonly generatedAt: string
        readonly problem?: string | undefined
        readonly logExcerpt?:
            { readonly path: string; readonly excerpt: string; readonly truncated: boolean } | undefined
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
    const intro = options.trace
        ? "Environment, static project facts and captured --run command output collected by `fluxerly triage`. Known token formats, headers, configured bot token env values and home paths were masked, but review captured output before sharing it publicly"
        : "Redacted environment and static project facts collected offline by `fluxerly triage`. No `.env` values or secrets were read"
    const lines = [
        "# Fluxerly triage context",
        "",
        intro,
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
        lines.push("", "## Reported symptom", "", redactInlineText(options.problem, options.homedir, options.secrets))
    }
    if (options.logExcerpt) {
        const heading = options.logExcerpt.truncated
            ? `Redacted tail of ${redact(options.logExcerpt.path)} (last ${maxLogExcerptChars} characters):`
            : `Redacted contents of ${redact(options.logExcerpt.path)}:`
        const fence = markdownCodeFence(options.logExcerpt.excerpt)
        lines.push("", "## Redacted log excerpt", "", heading, "", `${fence}text`, options.logExcerpt.excerpt, fence)
    }
    if (options.trace) {
        const { result, redactedOutput, traceFilePath } = options.trace
        const excerptTruncated = redactedOutput.length > maxLogExcerptChars || result.truncated
        const excerpt = sliceRedactedTail(redactedOutput, maxLogExcerptChars)
        const statusSummary = result.errorMessage
            ? `failed to start (${redactInlineText(result.errorMessage, options.homedir, options.secrets)})`
            : result.timedOut
              ? `timed out (exit ${result.exitCode ?? "null"}, signal ${result.signal ?? "none"})`
              : `exit ${result.exitCode ?? "null"}${result.signal ? ` (signal ${result.signal})` : ""}`
        lines.push(
            "",
            "## Captured debug trace (--run)",
            "",
            `- Command: \`${redactInlineText(result.command, options.homedir, options.secrets)}\``,
            `- Outcome: ${statusSummary}`,
            "- Redaction note: Known token formats, headers, configured bot token env values and home paths were masked. Review captured command output before sharing it publicly",
        )
        if (traceFilePath) lines.push(`- Captured trace file: ${redact(traceFilePath)}`)
        if (excerpt.trim().length > 0) {
            const body = excerpt.trimEnd()
            const fence = markdownCodeFence(body)
            lines.push(
                "",
                excerptTruncated
                    ? `Captured trace tail (last ${maxLogExcerptChars} characters):`
                    : "Captured trace output:",
                "",
                `${fence}text`,
                body,
                fence,
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
    readonly secrets?: readonly string[] | undefined
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
        secrets: options.secrets,
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
    const lowered = trimmed.toLowerCase()
    return (
        agents.find((_, index) => String(index + 1) === trimmed) ??
        agents.find(
            (agent) => agent.id === lowered || agent.command === lowered || (agent.aliases?.includes(lowered) ?? false),
        )
    )
}

/** Match either a detected agent CLI or the harness-agnostic "other" option in the interactive picker */
export function matchTriagePickerAnswer(
    agents: readonly TriageAgentSpec[],
    answer: string,
): TriageAgentSpec | "other" | undefined {
    const matched = matchTriageAgentAnswer(agents, answer)
    if (matched !== undefined) return matched
    const trimmed = answer.trim()
    if (!trimmed) return undefined
    const lowered = trimmed.toLowerCase()
    if (
        trimmed === String(agents.length + 1) ||
        trimmed === "0" ||
        lowered === "other" ||
        lowered === "any" ||
        lowered === "none" ||
        lowered === "print"
    )
        return "other"
    return undefined
}

async function pickTriageAgent(
    agents: readonly TriageAgentSpec[],
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream & CliStreamLike,
    env: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform,
): Promise<TriageAgentSpec | "other" | undefined> {
    const theme = createCliTheme(output, { env, platform })
    const rl = createInterface({ input, output })
    try {
        const sortedAgents = [...agents].sort((left, right) =>
            left.label.localeCompare(right.label, "en", { sensitivity: "base" }),
        )
        const otherIndex = sortedAgents.length + 1
        const menu = [
            ...sortedAgents.map(
                (agent, index) =>
                    `  ${theme.cyan(`[${index + 1}]`)} ${theme.bold(agent.label)} ${theme.faint(`(${agent.command})`)}`,
            ),
            `  ${theme.cyan(`[${otherIndex}]`)} ${theme.bold("Other coding agent")} ${theme.faint("(harness-agnostic prompt and files)")}`,
        ].join("\n")
        for (;;) {
            const answer = await rl.question(
                `${theme.bold("Run triage with:")}\n${menu}\n${theme.cyan(theme.symbols.pointer)} `,
            )
            const picked = matchTriagePickerAnswer(sortedAgents, answer)
            if (picked !== undefined) return picked
            output.write(`${theme.gold(`Enter a number from 1 to ${otherIndex}, an agent name or other`)}\n`)
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

export interface ClipboardCandidate {
    readonly command: string
    readonly args: readonly string[]
}

/** Resolve OS clipboard commands for the current platform and display environment */
export function resolveClipboardCandidates(
    platform: NodeJS.Platform,
    env: Readonly<Record<string, string | undefined>>,
    text: string,
): readonly ClipboardCandidate[] {
    if (platform === "darwin") return [{ command: "pbcopy", args: [] }]
    if (platform === "win32") {
        // Windows clip.exe reads the legacy OEM code page, so fall back to printing non-ASCII paths rather than mangling them
        if (/[^\x20-\x7e\r\n\t]/.test(text)) return []
        return [{ command: "clip", args: [] }]
    }
    const candidates: ClipboardCandidate[] = []
    if (env.WAYLAND_DISPLAY?.trim()) candidates.push({ command: "wl-copy", args: [] })
    if (env.DISPLAY?.trim()) {
        candidates.push({ command: "xclip", args: ["-selection", "clipboard"] })
        candidates.push({ command: "xsel", args: ["--clipboard", "--input"] })
    }
    if ((env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim()) && !/[^\x20-\x7e\r\n\t]/.test(text)) {
        candidates.push({ command: "clip.exe", args: [] })
    }
    return candidates
}

function tryClipboardCommand(candidate: ClipboardCandidate, text: string, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolveResult) => {
        let settled = false
        const finish = (ok: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolveResult(ok)
        }
        const child = spawn(candidate.command, [...candidate.args], {
            stdio: ["pipe", "ignore", "ignore"],
            windowsHide: true,
        })
        const timer = setTimeout(() => {
            child.kill()
            finish(false)
        }, timeoutMs)
        child.once("error", () => finish(false))
        child.once("exit", (code, signal) => finish(signal === null && code === 0))
        child.stdin?.once("error", () => finish(false))
        child.stdin?.end(text)
    })
}

async function defaultCopyToClipboard(
    text: string,
    platform: NodeJS.Platform,
    env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
    for (const candidate of resolveClipboardCandidates(platform, env, text)) {
        if (await tryClipboardCommand(candidate, text)) return true
    }
    return false
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

    const secrets = envSecrets(env)
    let logExcerpt: { readonly path: string; readonly excerpt: string; readonly truncated: boolean } | undefined
    if (options.log !== undefined) {
        const resolvedLog = isAbsolute(options.log) ? options.log : resolve(targetProject, options.log)
        const loaded = readRedactedLogTail(resolvedLog, home, secrets)
        if (!loaded.ok) {
            writeError(loaded.message)
            return 1
        }
        logExcerpt = { path: resolvedLog, excerpt: loaded.excerpt, truncated: loaded.truncated }
    }

    const facts = collectProjectFacts(targetProject, environment.packageRoot, nodeVersion, { readEnvFile: false })
    const theme = createCliTheme(environment.output, { env, platform })

    let trace: { readonly result: TriageTraceResult; readonly redactedOutput: string } | undefined
    if (options.run !== undefined) {
        if (!options.print) {
            const notice = `Running trace command with FLUXERLY_DEBUG=${env.FLUXERLY_DEBUG?.trim() || "rest,gateway"}`
            environment.output.write(
                theme.capabilities.color === "none"
                    ? `${notice}\n`
                    : `${theme.cyan(theme.symbols.pointer)} ${theme.muted(notice)}\n`,
            )
        }
        const traceRunner = environment.runTraceCommand ?? defaultRunTraceCommand
        const result = await traceRunner(options.run, {
            cwd: targetProject,
            env,
            timeoutMs: environment.traceTimeoutMs ?? defaultTraceTimeoutMs,
            ...(traceRunner === defaultRunTraceCommand ? { homedir: home, secrets } : {}),
        })
        trace = { result, redactedOutput: redactAndTail(result.output, maxTraceCaptureChars, home, secrets).text }
    }

    if (options.print) {
        const context = formatTriageContext(facts, {
            project: targetProject,
            nodeVersion,
            platform,
            osRelease: currentOsRelease,
            osArch: currentOsArch,
            homedir: home,
            secrets,
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
            hint:
                trace !== undefined
                    ? "Static facts plus --run trace. Never reads .env directly or edits without asking"
                    : "Offline facts only. Never reads .env secrets or edits without asking",
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
        secrets,
        sessionRoot: environment.sessionRoot,
        problem: options.problem,
        logExcerpt,
        trace,
    })

    const sessionFiles = [
        `  ${session.promptFilePath}`,
        `  ${session.contextFilePath}`,
        ...(session.traceFilePath ? [`  ${session.traceFilePath}`] : []),
    ]

    const detect = environment.detectCommand ?? ((command: string) => findCommandOnPath(command, env, platform))
    const installed: { readonly agent: TriageAgentSpec; readonly resolved: string }[] = []
    for (const agent of triageAgents) {
        const resolved = detect(agent.command)
        if (resolved) installed.push({ agent, resolved })
    }

    let selected: { readonly agent: TriageAgentSpec; readonly resolved: string } | undefined
    let useAgnosticHandoff = false
    const interactive = environment.input.isTTY === true && environment.output.isTTY === true
    if (options.agent === "other") {
        useAgnosticHandoff = true
    } else if (options.agent !== undefined) {
        selected = installed.find((entry) => entry.agent.id === options.agent)
        if (!selected) {
            const spec = triageAgents.find((item) => item.id === options.agent)!
            writeError(`The "${spec.command}" CLI (${spec.label}) was not found on PATH`)
            environment.output.write(
                [
                    "",
                    "The triage prompt and context were written to:",
                    ...sessionFiles,
                    "",
                    "Run `fluxerly triage --print` or `fluxerly triage --agent other` to use any coding agent",
                    "",
                ].join("\n"),
            )
            return 1
        }
    } else if (installed.length >= 1 && interactive) {
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
        if (picked === "other") useAgnosticHandoff = true
        else selected = installed.find((entry) => entry.agent.id === picked.id)
    } else if (installed.length === 1) {
        selected = installed[0]
    } else if (installed.length > 1) {
        writeError(
            "Multiple supported agent CLIs are installed and there is no terminal to pick one. Re-run with --agent antigravity, --agent claude, --agent codex, --agent opencode, --agent t3code, --agent other or --print",
        )
        return 1
    }

    const hasInput = options.problem !== undefined || logExcerpt !== undefined || trace !== undefined
    const launchPrompt = buildTriageLaunchPrompt(session.promptFilePath, hasInput)
    if (useAgnosticHandoff || !selected) {
        const copyFn = environment.copyToClipboard ?? ((text: string) => defaultCopyToClipboard(text, platform, env))
        let copied = false
        try {
            copied = await copyFn(launchPrompt)
        } catch {
            // allow-silent: Failed clipboard copies fall back to printing the prompt heading and text below
        }
        const intro = useAgnosticHandoff
            ? "Use any coding agent with this redacted triage session"
            : "No supported coding agent CLI (agy, claude, codex, opencode or t3) was found on PATH"
        const promptHeading = copied
            ? "Prompt copied to the clipboard. Paste it into any coding agent, or run `fluxerly triage --print`:"
            : "Paste this prompt into any coding agent, or run `fluxerly triage --print`:"
        environment.output.write(
            [
                intro,
                "",
                "The triage playbook and project context were written to:",
                ...sessionFiles,
                "",
                promptHeading,
                `  ${launchPrompt}`,
                "",
            ].join("\n"),
        )
        return 0
    }

    const { agent, resolved } = selected
    const isWindowsCmd = platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)
    const command = platform === "win32" ? agent.command : resolve(resolved)
    const spawnArgs = agent.buildArgs
        ? agent.buildArgs({ launchPrompt, model: options.model, targetProject })
        : [
              ...(options.model === undefined ? [] : ["--model", options.model]),
              ...(agent.promptArgs ?? []),
              launchPrompt,
          ]
    const startNote =
        agent.id === "t3code"
            ? hasInput
                ? "It will start a triage thread and begin investigating"
                : "It will start a triage thread and ask what went wrong"
            : hasInput
              ? "It will read the triage context and begin investigating"
              : "It will read the redacted context and ask what went wrong"
    environment.output.write(
        theme.capabilities.color === "none"
            ? `Starting ${agent.label}. ${startNote}\n\n`
            : `${theme.cyan(theme.symbols.pointer)} Starting ${theme.bold(agent.label)}. ${theme.muted(startNote)}\n\n`,
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
                "The triage playbook and project context remain at:",
                ...sessionFiles,
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
