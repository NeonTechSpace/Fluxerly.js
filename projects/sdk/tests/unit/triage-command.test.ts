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
    parseTriageArguments,
    redactHomePath,
    runTriage,
    triageAgents,
    type TriageSpawnRequest,
} from "../../src/internal/triage-command.js"

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
    mkdirSync(join(project, "node_modules/@neontechspace/fluxerly/src"), { recursive: true })
    mkdirSync(join(project, "node_modules/@neontechspace/fluxerly/agents"), { recursive: true })
    writeFileSync(
        join(project, "node_modules/@neontechspace/fluxerly/package.json"),
        JSON.stringify({ name: "@neontechspace/fluxerly", version: "1003.0.0" }),
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
    test("bundled agents/TRIAGE.md stays byte-for-byte identical to .github/triage/PLAYBOOK.md", () => {
        const bundled = readFileSync(join(sdkRoot, "agents/TRIAGE.md"), "utf8")
        const repoCopy = readFileSync(join(repoRoot, ".github/triage/PLAYBOOK.md"), "utf8")
        expect(bundled).toBe(repoCopy)
        expect(bundled).toContain("via-triage.yml")
        expect(bundled).toContain("createTestBot")
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
                "bot hangs on shutdown",
            ]),
        ).toEqual({
            ok: true,
            options: {
                agent: "antigravity",
                model: "gemini-4",
                dir: "bot",
                log: "bot.log",
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
                problem: undefined,
                print: true,
            },
        })
        for (const bad of [
            ["--agent", "unknown"],
            ["--print", "--agent", "codex"],
            ["--model"],
            ["--log"],
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
        expect(matchTriageAgentAnswer(triageAgents, "9")).toBeUndefined()
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
})
