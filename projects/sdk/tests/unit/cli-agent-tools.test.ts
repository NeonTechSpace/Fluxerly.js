import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { checkAgentsSection, runAgentsCommand } from "../../src/internal/agents-section.js"
import { inspectProject, runDoctor } from "../../src/internal/doctor-command.js"
import { parseInitArguments, runInit } from "../../src/internal/init-command.js"
import { runInvite } from "../../src/internal/invite-command.js"
import { writeStarterProject } from "../../src/internal/starter-project.js"

const sdk = fileURLToPath(new URL("../../", import.meta.url))
const directories: string[] = []

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporary() {
    const directory = mkdtempSync(join(tmpdir(), "fluxerly-cli-tools-"))
    directories.push(directory)
    return directory
}

function capture() {
    const out = new PassThrough()
    const err = new PassThrough()
    let stdout = ""
    let stderr = ""
    out.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    err.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    return { output: out, errorOutput: err, stdout: () => stdout, stderr: () => stderr }
}

test("fluxerly init supports --dir, --pm and merging into an existing AGENTS.md", async () => {
    expect(parseInitArguments(["--template", "ts", "--dir", "my-bot", "--pm", "pnpm", "--no-install"])).toEqual({
        template: "ts",
        install: false,
        dir: "my-bot",
        manager: "pnpm",
    })
    expect(parseInitArguments(["--dir"])).toBe("invalid")
    expect(parseInitArguments(["--pm", "yarn"])).toBe("invalid")

    const root = temporary()
    const existingDir = join(root, "existing-bot")
    mkdirSync(existingDir)
    writeFileSync(join(existingDir, "AGENTS.md"), "# Team rules\n\nKeep code small\n")

    const streams = capture()
    const outcome = await runInit(["--template", "ts", "--dir", "existing-bot", "--pm", "pnpm", "--no-install"], {
        input: Object.assign(new PassThrough(), { isTTY: false }),
        output: streams.output,
        errorOutput: streams.errorOutput,
        project: root,
        packageRoot: sdk,
        userAgent: undefined,
    })
    expect(outcome).toBe(0)
    expect(existsSync(join(existingDir, "bot.ts"))).toBe(true)
    const agents = readFileSync(join(existingDir, "AGENTS.md"), "utf8")
    expect(agents).toContain("# Team rules")
    expect(agents).toContain("<!-- fluxerly:start -->")
    expect(agents).toContain("pnpm exec fluxerly agents")
})

test("fluxerly agents supports --check, --print and tool targets", () => {
    const project = temporary()
    expect(checkAgentsSection(project, sdk)).toBe("missing")

    const missingCheck = capture()
    expect(runAgentsCommand(["--check"], { project, packageRoot: sdk, ...missingCheck })).toBe(1)

    const printed = capture()
    expect(runAgentsCommand(["--print"], { project, packageRoot: sdk, ...printed })).toBe(0)
    expect(printed.stdout()).toContain("<!-- fluxerly:start -->")
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false)

    const all = capture()
    expect(runAgentsCommand(["--target", "all"], { project, packageRoot: sdk, ...all })).toBe(0)
    expect(existsSync(join(project, "AGENTS.md"))).toBe(true)
    expect(existsSync(join(project, ".agents/skills/fluxerly/SKILL.md"))).toBe(true)
    expect(checkAgentsSection(project, sdk)).toBe("current")

    const passCheck = capture()
    expect(runAgentsCommand(["--check"], { project, packageRoot: sdk, ...passCheck })).toBe(0)

    const cursor = capture()
    expect(runAgentsCommand(["--target", "cursor"], { project, packageRoot: sdk, ...cursor })).toBe(0)
    expect(readFileSync(join(project, ".cursor/rules/fluxerly.mdc"), "utf8")).toContain("alwaysApply: true")

    const claude = capture()
    expect(runAgentsCommand(["--target", "claude"], { project, packageRoot: sdk, ...claude })).toBe(0)
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md")

    const gemini = capture()
    expect(runAgentsCommand(["--target", "gemini"], { project, packageRoot: sdk, ...gemini })).toBe(0)
    expect(readFileSync(join(project, "GEMINI.md"), "utf8")).toContain("AGENTS.md")
})

test("fluxerly doctor validates a healthy starter project and flags broken settings without leaking secrets", () => {
    const project = temporary()
    writeStarterProject(project, sdk, "ts", "pnpm")
    writeFileSync(
        join(project, "package.json"),
        JSON.stringify({
            type: "module",
            dependencies: { "@neontechspace/fluxerly": "1002.0.0" },
            devDependencies: { typescript: "7.0.2", "@types/node": "24.19.2" },
        }),
    )
    const secret = "fluxer-secret-never-print-me"
    writeFileSync(join(project, ".env"), `FLUXER_BOT_TOKEN=${secret}\n`)

    const healthy = capture()
    expect(runDoctor(["--json"], { project, packageRoot: sdk, nodeVersion: "26.13.1", ...healthy })).toBe(0)
    expect(healthy.stdout()).not.toContain(secret)
    const parsed = JSON.parse(healthy.stdout()) as { ok: boolean; checks: { id: string; status: string }[] }
    expect(parsed.ok).toBe(true)
    expect(parsed.checks.find((check) => check.id === "agents")?.status).toBe("pass")
    expect(parsed.checks.find((check) => check.id === "env-token")?.status).toBe("pass")

    const broken = inspectProject(project, sdk, "22.12.0")
    expect(broken.ok).toBe(false)
    expect(broken.checks.find((check) => check.id === "node")?.status).toBe("fail")
})

test("fluxerly invite builds installation URLs from permission names or decimal bits", () => {
    const plain = capture()
    expect(runInvite(["123456789012345678"], plain)).toBe(0)
    expect(plain.stdout().trim()).toBe("https://fluxer.com/oauth2/authorize?client_id=123456789012345678&scope=bot")

    const named = capture()
    expect(runInvite(["123456789012345678", "--permissions", "ViewChannel,SendMessages"], named)).toBe(0)
    expect(named.stdout().trim()).toBe(
        "https://fluxer.com/oauth2/authorize?client_id=123456789012345678&scope=bot&permissions=3072",
    )

    const bad = capture()
    expect(runInvite(["123456789012345678", "--permissions", "NotARealPermission"], bad)).toBe(1)
    expect(bad.stderr()).toContain("Unknown permission names")
})
