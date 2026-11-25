import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, test } from "vitest"
import { fileURLToPath } from "node:url"
import {
    buildTriageLaunchPrompt,
    findCommandOnPath,
    matchTriageAgentAnswer,
    matchTriagePickerAnswer,
    parseTriageArguments,
    redactHomePath,
    runTriage,
    triageAgents,
    type TriageSpawnRequest,
} from "../../src/internal/triage-command.js"
import { pinnedFluxerCommit, pinnedFluxerRepository } from "../../src/internal/fluxer-pin.js"

const sdkRoot = fileURLToPath(new URL("../../", import.meta.url))
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url))
const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
}

function captureStream(overrides: { isTTY?: boolean; columns?: number; rows?: number; depth?: number } = {}) {
    let text = ""
    const stream = new PassThrough() as PassThrough & {
        isTTY?: boolean
        columns?: number
        rows?: number
        hasColors?(): boolean
        getColorDepth?(): number
    }
    stream.isTTY = overrides.isTTY ?? false
    if (overrides.columns !== undefined) stream.columns = overrides.columns
    if (overrides.rows !== undefined) stream.rows = overrides.rows
    stream.hasColors = () => (overrides.depth ?? 0) >= 4
    stream.getColorDepth = () => overrides.depth ?? 1
    stream.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8")
    })
    return { stream, read: () => text }
}

function makeBotProject(options: { envSecret?: string } = {}): string {
    const project = makeTempDir("fluxerly-triage-project-")
    writeFileSync(
        join(project, "package.json"),
        JSON.stringify({
            private: true,
            type: "module",
            dependencies: { "@neontechspace/fluxerly": "^1003.0.0", effect: "^4.1.5" },
            devDependencies: { typescript: "7.0.2", "@types/node": "26.6.7" },
        }),
    )
    writeFileSync(join(project, ".gitignore"), "node_modules\n.env\n")
    if (options.envSecret !== undefined) writeFileSync(join(project, ".env"), `FLUXER_BOT_TOKEN=${options.envSecret}\n`)
    mkdirSync(join(project, "node_modules/@neontechspace/fluxerly/src/internal"), { recursive: true })
    mkdirSync(join(project, "node_modules/@neontechspace/fluxerly/agents"), { recursive: true })
    writeFileSync(
        join(project, "node_modules/@neontechspace/fluxerly/package.json"),
        JSON.stringify({ name: "@neontechspace/fluxerly", version: "1003.0.0" }),
    )
    writeFileSync(
        join(project, "node_modules/@neontechspace/fluxerly/src/internal/fluxer-pin.ts"),
        `export const pinnedFluxerCommit = "${pinnedFluxerCommit}" as const\n`,
    )
    writeFileSync(join(project, "node_modules/@neontechspace/fluxerly/agents/AGENTS.md"), "# Fluxerly\n")
    mkdirSync(join(project, "node_modules/effect"), { recursive: true })
    writeFileSync(
        join(project, "node_modules/effect/package.json"),
        JSON.stringify({ name: "effect", version: "4.1.5" }),
    )
    return project
}

afterEach(() => {
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe("fluxerly triage playbook, argument parsing and helpers", () => {
    test("bundled agents/TRIAGE.md stays byte-for-byte identical to .github/triage/PLAYBOOK.md and fluxer-pin matches manifest", () => {
        const bundled = readFileSync(join(sdkRoot, "agents/TRIAGE.md"), "utf8")
        const repoCopy = readFileSync(join(repoRoot, ".github/triage/PLAYBOOK.md"), "utf8")
        expect(bundled).toBe(repoCopy)
        expect(bundled).toContain("via-triage.yml")
        expect(bundled).toContain("createTestBot")
        expect(bundled).toContain("--run")
        const manifest = JSON.parse(
            readFileSync(join(repoRoot, "projects/release/upstream/manifest.json"), "utf8"),
        ) as { repository: string; commit: string }
        expect(pinnedFluxerRepository).toBe(manifest.repository)
        expect(pinnedFluxerCommit).toBe(manifest.commit)
    })

    test("parses triage options, redacts home paths, resolves agent answers and handles empty PATH", () => {
        expect(
            parseTriageArguments([
                "--agent",
                "antigravity",
                "--model",
                "gemini-4",
                "--dir",
                "bot",
                "--log",
                "bot.log",
                "--run",
                "node bot.js",
                "bot hangs on shutdown",
            ]),
        ).toEqual({
            ok: true,
            options: {
                agent: "antigravity",
                model: "gemini-4",
                dir: "bot",
                log: "bot.log",
                run: "node bot.js",
                problem: "bot hangs on shutdown",
                print: false,
            },
        })
        expect(parseTriageArguments(["--print", "--dir", "bot"])).toEqual({
            ok: true,
            options: {
                agent: undefined,
                model: undefined,
                dir: "bot",
                log: undefined,
                run: undefined,
                problem: undefined,
                print: true,
            },
        })
        expect(parseTriageArguments(["--agent", "opencode", "--model", "openai/gpt-5"])).toEqual({
            ok: true,
            options: {
                agent: "opencode",
                model: "openai/gpt-5",
                dir: undefined,
                log: undefined,
                run: undefined,
                problem: undefined,
                print: false,
            },
        })
        expect(parseTriageArguments(["--agent", "t3"])).toEqual({
            ok: true,
            options: {
                agent: "t3code",
                model: undefined,
                dir: undefined,
                log: undefined,
                run: undefined,
                problem: undefined,
                print: false,
            },
        })
        expect(parseTriageArguments(["--agent", "other"])).toEqual({
            ok: true,
            options: {
                agent: "other",
                model: undefined,
                dir: undefined,
                log: undefined,
                run: undefined,
                problem: undefined,
                print: false,
            },
        })
        for (const bad of [
            ["--agent", "unknown"],
            ["--print", "--agent", "codex"],
            ["--agent", "other", "--model", "x"],
            ["--model"],
            ["--log"],
            ["--run"],
            ["--run", "   "],
            ["--run", "--print"],
            ["--run", "a", "--run", "b"],
            ["--bogus"],
        ]) {
            expect(parseTriageArguments(bad).ok).toBe(false)
        }
        expect(redactHomePath("/home/alice/bots/my-bot", "/home/alice")).toBe("~/bots/my-bot")
        expect(redactHomePath("/home/alice2/bots", "/home/alice")).toBe("/home/alice2/bots")
        expect(redactHomePath("C:\\Users\\Alice\\bot", "C:\\Users\\Alice")).toBe("~\\bot")
        expect(matchTriageAgentAnswer(triageAgents, "1")?.id).toBe("claude")
        expect(matchTriageAgentAnswer(triageAgents, "codex")?.id).toBe("codex")
        expect(matchTriageAgentAnswer(triageAgents, "agy")?.id).toBe("antigravity")
        expect(matchTriageAgentAnswer(triageAgents, "opencode")?.id).toBe("opencode")
        expect(matchTriageAgentAnswer(triageAgents, "t3")?.id).toBe("t3code")
        expect(matchTriageAgentAnswer(triageAgents, "9")).toBeUndefined()
        expect(matchTriagePickerAnswer(triageAgents, String(triageAgents.length + 1))).toBe("other")
        expect(matchTriagePickerAnswer(triageAgents, "other")).toBe("other")
        expect(matchTriagePickerAnswer(triageAgents, "0")).toBe("other")
        expect(findCommandOnPath("codex", { PATH: "" }, "linux")).toBeUndefined()
    })
})

describe("fluxerly triage execution modes", () => {
    test("--print emits pure ANSI-free brief with symptom and redacted --log while refusing secret files", async () => {
        const secret = "SUPER_SECRET_BOT_TOKEN_987654321"
        const project = makeBotProject({ envSecret: secret })
        writeFileSync(
            join(project, "bot.log"),
            `Authorization: Bot log-secret-value-12345\nPath: /home/alice/my-bot/bot.ts\n[lifecycle.connectionEnded] close 4004\n`,
        )
        const out = captureStream({ isTTY: true, columns: 80, rows: 24, depth: 24 })
        const err = captureStream()
        const code = await runTriage(["--print", "--log", "bot.log", "gateway closes with 4004"], {
            project,
            packageRoot: sdkRoot,
            input: new PassThrough(),
            output: out.stream,
            errorOutput: err.stream,
            env: { COLORTERM: "truecolor" },
            platform: "linux",
            nodeVersion: "26.13.1",
            homedir: "/home/alice",
        })
        expect(code).toBe(0)
        expect(err.read()).toBe("")
        const printed = out.read()
        // oxlint-disable-next-line no-control-regex -- Verifies --print contains zero ANSI escapes
        expect(printed).not.toMatch(/\x1b\[/)
        expect(printed).toContain("Installed @neontechspace/fluxerly version: 1003.0.0")
        expect(printed).toContain(`Target Fluxer server commit (installed SDK): ${pinnedFluxerCommit}`)
        expect(printed).toContain("gateway closes with 4004")
        expect(printed).toContain("~/my-bot/bot.ts")
        expect(printed).not.toContain(secret)
        expect(printed).not.toContain("log-secret-value-12345")

        // Refuses .env passed to --log
        const refusedErr = captureStream()
        const refusedOut = captureStream()
        expect(
            await runTriage(["--print", "--log", ".env"], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: refusedOut.stream,
                errorOutput: refusedErr.stream,
                env: {},
                platform: "linux",
            }),
        ).toBe(1)
        expect(refusedErr.read()).toContain(".env")
        expect(refusedOut.read()).not.toContain(secret)
    })

    test("auto-starts the sole installed agent with a single-line prompt and antigravity interactive flag", async () => {
        const project = makeBotProject()
        const sessions = makeTempDir("fluxerly-triage-sessions-")
        const calls: TriageSpawnRequest[] = []
        const code = await runTriage(["--model", "gemini-4"], {
            project,
            packageRoot: sdkRoot,
            input: new PassThrough(),
            output: captureStream().stream,
            errorOutput: captureStream().stream,
            env: {},
            platform: "linux",
            nodeVersion: "26.13.1",
            sessionRoot: sessions,
            detectCommand: (command) => (command === "agy" ? "/usr/local/bin/agy" : undefined),
            spawnSession: async (request) => {
                calls.push(request)
                return 0
            },
        })
        expect(code).toBe(0)
        expect(calls).toHaveLength(1)
        const [call] = calls
        expect(call!.command).toBe("/usr/local/bin/agy")
        expect(call!.cwd).toBe(project)
        expect(call!.shell).toBe(false)
        expect(call!.args.slice(0, 3)).toEqual(["--model", "gemini-4", "--prompt-interactive"])
        expect(call!.args[3]).not.toContain("\n")
        const promptPath = call!.args[3]!.match(/(\S+triage-prompt\.md)/)?.[1]
        expect(promptPath && existsSync(promptPath)).toBe(true)
        expect(readFileSync(promptPath!, "utf8")).toContain("triage-context.md")
        expect(buildTriageLaunchPrompt(promptPath!)).toBe(call!.args[3])
    })

    test("handles Windows .cmd shims, multi-agent TTY picker, non-TTY error, zero-agent fallback and non-zero exit recovery", async () => {
        const project = makeBotProject()
        const sessions = makeTempDir("fluxerly-triage-sessions-")

        // Multiple agents without TTY fails cleanly
        const nonTtyErr = captureStream()
        expect(
            await runTriage([], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: captureStream().stream,
                errorOutput: nonTtyErr.stream,
                env: {},
                platform: "linux",
                sessionRoot: sessions,
                detectCommand: (cmd) => (cmd === "claude" || cmd === "codex" ? `/bin/${cmd}` : undefined),
            }),
        ).toBe(1)
        expect(nonTtyErr.read()).toContain("--agent")

        // Multiple agents with TTY picker chooses selected agent and uses shell for Windows .cmd shim
        const ttyInput = new PassThrough() as PassThrough & { isTTY?: boolean }
        ttyInput.isTTY = true
        ttyInput.end("2\n")
        const spawned: TriageSpawnRequest[] = []
        expect(
            await runTriage([], {
                project,
                packageRoot: sdkRoot,
                input: ttyInput,
                output: captureStream({ isTTY: true, columns: 80, rows: 24, depth: 4 }).stream,
                errorOutput: captureStream().stream,
                env: {},
                platform: "win32",
                sessionRoot: sessions,
                detectCommand: (cmd) => (cmd === "claude" || cmd === "codex" ? `C:\\tools\\${cmd}.cmd` : undefined),
                spawnSession: async (request) => {
                    spawned.push(request)
                    return 0
                },
            }),
        ).toBe(0)
        expect(spawned).toEqual([expect.objectContaining({ command: "codex", shell: true })])

        // Zero agents installed prints session paths and exits 0
        const zeroOut = captureStream()
        expect(
            await runTriage([], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: zeroOut.stream,
                errorOutput: captureStream().stream,
                env: {},
                platform: "linux",
                sessionRoot: sessions,
                detectCommand: () => undefined,
            }),
        ).toBe(0)
        expect(zeroOut.read()).toContain("triage-prompt.md")

        // Non-zero agent exit reports redacted state dir and recovery instructions
        const failOut = captureStream()
        expect(
            await runTriage(["--agent", "codex"], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: failOut.stream,
                errorOutput: captureStream().stream,
                env: { CODEX_HOME: "/home/alice/.custom-codex" },
                platform: "linux",
                homedir: "/home/alice",
                sessionRoot: sessions,
                detectCommand: (cmd) => (cmd === "codex" ? "/usr/bin/codex" : undefined),
                spawnSession: async () => 2,
            }),
        ).toBe(1)
        expect(failOut.read()).toContain("~/.custom-codex")
        expect(failOut.read()).toContain("CODEX_HOME")
    })

    test("supports OpenCode, T3 Code, --agent other and choosing Other in an interactive TTY picker", async () => {
        const project = makeBotProject()
        const sessions = makeTempDir("fluxerly-triage-harnesses-")

        // OpenCode launches interactive TUI with --prompt and optional --model
        const opencodeCalls: TriageSpawnRequest[] = []
        expect(
            await runTriage(["--agent", "opencode", "--model", "anthropic/claude-sonnet"], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: captureStream().stream,
                errorOutput: captureStream().stream,
                env: {},
                platform: "linux",
                sessionRoot: sessions,
                detectCommand: (cmd) => (cmd === "opencode" ? "/usr/local/bin/opencode" : undefined),
                spawnSession: async (request) => {
                    opencodeCalls.push(request)
                    return 0
                },
            }),
        ).toBe(0)
        expect(opencodeCalls).toHaveLength(1)
        expect(opencodeCalls[0]!.command).toBe("/usr/local/bin/opencode")
        expect(opencodeCalls[0]!.args.slice(0, 3)).toEqual(["--model", "anthropic/claude-sonnet", "--prompt"])

        // T3 Code launches `t3 thread start --title "Fluxerly triage" [--model ...] <project> <prompt>`
        const t3Calls: TriageSpawnRequest[] = []
        expect(
            await runTriage(["--agent", "t3", "--model", "gpt-6.2-sol", "403 on reply"], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: captureStream().stream,
                errorOutput: captureStream().stream,
                env: {},
                platform: "linux",
                sessionRoot: sessions,
                detectCommand: (cmd) => (cmd === "t3" ? "/usr/local/bin/t3" : undefined),
                spawnSession: async (request) => {
                    t3Calls.push(request)
                    return 0
                },
            }),
        ).toBe(0)
        expect(t3Calls).toHaveLength(1)
        expect(t3Calls[0]!.command).toBe("/usr/local/bin/t3")
        expect(t3Calls[0]!.args.slice(0, 7)).toEqual([
            "thread",
            "start",
            "--title",
            "Fluxerly triage",
            "--model",
            "gpt-6.2-sol",
            project,
        ])
        expect(t3Calls[0]!.args[7]).toContain("triage-prompt.md")

        // --agent other skips spawning detected CLIs and prints harness-agnostic prompt and session files
        const otherOut = captureStream()
        const skippedCalls: TriageSpawnRequest[] = []
        expect(
            await runTriage(["--agent", "other"], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: otherOut.stream,
                errorOutput: captureStream().stream,
                env: {},
                platform: "linux",
                sessionRoot: sessions,
                detectCommand: (cmd) => (cmd === "claude" ? "/bin/claude" : undefined),
                spawnSession: async (request) => {
                    skippedCalls.push(request)
                    return 0
                },
            }),
        ).toBe(0)
        expect(skippedCalls).toHaveLength(0)
        expect(otherOut.read()).toContain("Use any coding agent")
        expect(otherOut.read()).toContain("triage-prompt.md")

        // Interactive TTY picker offers Other even when only one CLI is installed
        const singleTtyIn = new PassThrough() as PassThrough & { isTTY?: boolean }
        singleTtyIn.isTTY = true
        singleTtyIn.end("2\n")
        const singleTtyOut = captureStream({ isTTY: true, columns: 80, rows: 24, depth: 4 })
        expect(
            await runTriage([], {
                project,
                packageRoot: sdkRoot,
                input: singleTtyIn,
                output: singleTtyOut.stream,
                errorOutput: captureStream().stream,
                env: {},
                platform: "linux",
                sessionRoot: sessions,
                detectCommand: (cmd) => (cmd === "codex" ? "/bin/codex" : undefined),
                spawnSession: async (request) => {
                    skippedCalls.push(request)
                    return 0
                },
            }),
        ).toBe(0)
        expect(skippedCalls).toHaveLength(0)
        expect(singleTtyOut.read()).toContain("Other coding agent")
        expect(singleTtyOut.read()).toContain("triage-prompt.md")
    })

    test("--run executes the command with FLUXERLY_DEBUG, masks secrets, writes triage-trace.log and survives non-zero exit", async () => {
        const project = makeBotProject()
        const sessions = makeTempDir("fluxerly-triage-run-")
        const out = captureStream()
        const err = captureStream()
        const traceOut = captureStream()

        // --print --run with real node child process verifying FLUXERLY_DEBUG, non-zero exit and secret redaction in both output and command string
        const envToken = "UNLABELED_ENV_SECRET_TOKEN_777"
        const scriptCmd = `${JSON.stringify(process.execPath)} -e "console.log('DEBUG=' + process.env.FLUXERLY_DEBUG); console.log('RAW=' + process.env.FLUXER_BOT_TOKEN); console.error('Authorization: Bot trace-secret-99999'); console.error('Path: /home/alice/bot/index.js'); process.exit(2)" -- ${envToken}`
        expect(
            await runTriage(["--print", "--run", scriptCmd], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: out.stream,
                errorOutput: err.stream,
                env: { FLUXER_BOT_TOKEN: envToken },
                platform: "linux",
                homedir: "/home/alice",
                traceTimeoutMs: 10_000,
            }),
        ).toBe(0)
        expect(err.read()).toBe("")
        const printed = out.read()
        expect(printed).toContain("## Captured debug trace (--run)")
        expect(printed).toContain("Review captured command output before sharing it publicly")
        expect(printed).toContain("Outcome: exit 2")
        expect(printed).toContain("DEBUG=rest,gateway")
        expect(printed).toContain("~/bot/index.js")
        expect(printed).not.toContain("trace-secret-99999")
        expect(printed).not.toContain(envToken)

        // --run timeout terminates the spawned process tree promptly without hanging on shell grandchildren
        const timeoutOut = captureStream()
        const hangCmd = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"`
        const timeoutStart = Date.now()
        expect(
            await runTriage(["--print", "--run", hangCmd], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: timeoutOut.stream,
                errorOutput: captureStream().stream,
                env: {},
                platform: process.platform,
                traceTimeoutMs: 120,
            }),
        ).toBe(0)
        const elapsedMs = Date.now() - timeoutStart
        expect(elapsedMs).toBeLessThan(3_000)
        expect(timeoutOut.read()).toContain("Outcome: timed out")

        // Interactive session writes scrubbed triage-trace.log alongside triage-context.md
        const calls: TriageSpawnRequest[] = []
        expect(
            await runTriage(["--run", "node bot.js"], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: traceOut.stream,
                errorOutput: captureStream().stream,
                env: {},
                platform: "linux",
                homedir: "/home/alice",
                sessionRoot: sessions,
                detectCommand: (cmd) => (cmd === "codex" ? "/usr/bin/codex" : undefined),
                spawnSession: async (request) => {
                    calls.push(request)
                    return 0
                },
                runTraceCommand: async (command) => ({
                    command,
                    exitCode: 1,
                    signal: null,
                    timedOut: false,
                    output: "Authorization: Bearer secret-oauth-xyz\n/home/alice/project/bot.ts:12\n",
                    truncated: false,
                }),
            }),
        ).toBe(0)
        expect(calls).toHaveLength(1)
        const promptPath = calls[0]!.args[0]!.match(/(\S+triage-prompt\.md)/)?.[1] ?? ""
        expect(promptPath).not.toBe("")
        const contextPath = promptPath.replace("triage-prompt.md", "triage-context.md")
        const tracePath = promptPath.replace("triage-prompt.md", "triage-trace.log")
        expect(existsSync(tracePath)).toBe(true)
        const traceFile = readFileSync(tracePath, "utf8")
        expect(traceFile).not.toContain("secret-oauth-xyz")
        expect(traceFile).toContain("~/project/bot.ts:12")
        const contextFile = readFileSync(contextPath, "utf8")
        expect(contextFile).toContain("triage-trace.log")
        expect(contextFile).toContain("Outcome: exit 1")
        expect(contextFile).not.toContain("secret-oauth-xyz")
    })

    test("triage never reads .env, redacts credentials before truncating logs/trace and kills non-timeout background descendants", async () => {
        const project = makeBotProject()
        // Write a .env with a Bot-prefixed token that doctor would flag if read, proving triage does not read .env
        writeFileSync(join(project, ".env"), "FLUXER_BOT_TOKEN=Bot DO_NOT_READ_ENV_SECRET_42\n")
        const boundarySecret = "BOUNDARY_TOKEN_SECRET_XYZ_987654321"
        const logPath = join(project, "boundary.log")
        // Place the secret right across the 16,000-character tail cut boundary plus embedded triple backticks
        const suffix = "\n```\ntail-line\n"
        const logBody = `${boundarySecret}${"x".repeat(16_000 - boundarySecret.length + 1 - suffix.length)}${suffix}`
        writeFileSync(logPath, logBody)

        const out = captureStream()
        const err = captureStream()
        expect(
            await runTriage(["--print", "--log", logPath], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: out.stream,
                errorOutput: err.stream,
                env: { FLUXER_BOT_TOKEN: boundarySecret },
                platform: "linux",
                homedir: "/home/alice",
            }),
        ).toBe(0)
        expect(err.read()).toBe("")
        const printedLog = out.read()
        expect(printedLog).toContain(".env file is present (contents not read by triage)")
        expect(printedLog).not.toContain("starts with a")
        expect(printedLog).not.toContain("DO_NOT_READ_ENV_SECRET_42")
        expect(printedLog).not.toContain(boundarySecret)
        expect(printedLog).not.toContain(boundarySecret.slice(1))
        expect(printedLog).toContain("````text")

        // Trace buffer truncation redacts secrets spanning both 24,000-char buffer and 16,000-char excerpt boundaries
        const traceSecret = "TRACE_BOUNDARY_SECRET_TOKEN_55555"
        const traceOut = captureStream()
        const bigCmd = `${JSON.stringify(process.execPath)} -e "process.stdout.write('a'.repeat(5000) + process.env.FLUXER_BOT_TOKEN + 'b'.repeat(7990) + process.env.FLUXER_BOT_TOKEN + 'c'.repeat(15990))"`
        expect(
            await runTriage(["--print", "--run", bigCmd], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: traceOut.stream,
                errorOutput: captureStream().stream,
                env: { FLUXER_BOT_TOKEN: traceSecret },
                platform: process.platform,
                traceTimeoutMs: 10_000,
            }),
        ).toBe(0)
        const printedTrace = traceOut.read()
        expect(printedTrace).not.toContain(traceSecret)
        expect(printedTrace).not.toContain(traceSecret.slice(4))

        // Oversized single lines (>256 KiB) are omitted completely rather than sliced mid-line
        const hugeOut = captureStream()
        const hugeCmd = `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(262140) + 'OVERSIZED_LINE_SECRET_9999' + '\\nafter-huge\\n')"`
        expect(
            await runTriage(["--print", "--run", hugeCmd], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: hugeOut.stream,
                errorOutput: captureStream().stream,
                env: { FLUXER_BOT_TOKEN: "OVERSIZED_LINE_SECRET_9999" },
                platform: process.platform,
                traceTimeoutMs: 10_000,
            }),
        ).toBe(0)
        const printedHuge = hugeOut.read()
        expect(printedHuge).toContain("[omitted oversized line]")
        expect(printedHuge).toContain("after-huge")
        expect(printedHuge).not.toContain("OVERSIZED_LINE_SECRET_9999")
        expect(printedHuge).not.toContain("OVERSIZED")

        // Full-file redaction prevents severed credentials when later redactions shrink the log, and [redacted] is never sliced mid-marker
        const shrinkLog = join(project, "shrink.log")
        const shrinkBody = `${"p".repeat(100)}Authorization: shortsecret999\npassword=${"s".repeat(6000)}\n${"q".repeat(15_995)}\n`
        writeFileSync(shrinkLog, shrinkBody)
        const shrinkOut = captureStream()
        expect(
            await runTriage(["--print", "--log", shrinkLog], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: shrinkOut.stream,
                errorOutput: captureStream().stream,
                env: {},
                platform: "linux",
                homedir: "/home/alice",
            }),
        ).toBe(0)
        const printedShrink = shrinkOut.read()
        expect(printedShrink).not.toContain("shortsecret999")
        expect(printedShrink).not.toContain("ssssss")

        // Tail slice landing inside lowercase [redacted] steps cleanly past the marker instead of emitting "cted]"
        const markerLog = join(project, "marker.log")
        const markerBody = `Authorization: splitmarker12345${"B".repeat(15_995)}`
        writeFileSync(markerLog, markerBody)
        const markerOut = captureStream()
        expect(
            await runTriage(["--print", "--log", markerLog], {
                project,
                packageRoot: sdkRoot,
                input: new PassThrough(),
                output: markerOut.stream,
                errorOutput: captureStream().stream,
                env: {},
                platform: "linux",
                homedir: "/home/alice",
            }),
        ).toBe(0)
        const printedMarker = markerOut.read()
        expect(printedMarker).not.toContain("splitmarker12345")
        expect(printedMarker).not.toContain("cted]BBBBB")

        // On POSIX, background children (both redirected AND inheriting stdout/stderr) are cleaned up cleanly without false timeout
        if (process.platform !== "win32") {
            const bgOut = captureStream()
            const bgCmd = "sleep 30 >/dev/null 2>&1 & echo BG_PID=$!"
            expect(
                await runTriage(["--print", "--run", bgCmd], {
                    project,
                    packageRoot: sdkRoot,
                    input: new PassThrough(),
                    output: bgOut.stream,
                    errorOutput: captureStream().stream,
                    env: {},
                    platform: process.platform,
                    traceTimeoutMs: 10_000,
                }),
            ).toBe(0)
            const match = /BG_PID=(\d+)/.exec(bgOut.read())
            expect(match).not.toBeNull()
            const bgPid = Number(match![1])
            let alive = true
            for (let attempt = 0; attempt < 20; attempt++) {
                try {
                    process.kill(bgPid, 0)
                    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
                } catch {
                    alive = false
                    break
                }
            }
            expect(alive).toBe(false)

            // Inherited stdout/stderr background child finishes with exit 0 (NOT timed out) and is cleaned up
            const inheritedOut = captureStream()
            const inheritedStart = Date.now()
            expect(
                await runTriage(["--print", "--run", "sleep 30 & echo INHERITED_OK=$!"], {
                    project,
                    packageRoot: sdkRoot,
                    input: new PassThrough(),
                    output: inheritedOut.stream,
                    errorOutput: captureStream().stream,
                    env: {},
                    platform: process.platform,
                    traceTimeoutMs: 500,
                }),
            ).toBe(0)
            const inheritedElapsed = Date.now() - inheritedStart
            const inheritedPrinted = inheritedOut.read()
            expect(inheritedElapsed).toBeLessThan(1_000)
            expect(inheritedPrinted).toContain("Outcome: exit 0")
            expect(inheritedPrinted).not.toContain("timed out")
            expect(inheritedPrinted).toContain("INHERITED_OK=")
            const inheritedMatch = /INHERITED_OK=(\d+)/.exec(inheritedPrinted)
            expect(inheritedMatch).not.toBeNull()
            const inheritedPid = Number(inheritedMatch![1])
            let inheritedAlive = true
            for (let attempt = 0; attempt < 20; attempt++) {
                try {
                    process.kill(inheritedPid, 0)
                    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
                } catch {
                    inheritedAlive = false
                    break
                }
            }
            expect(inheritedAlive).toBe(false)
        }
    })
})
