import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { AgentsSectionError, writeAgentsSection } from "../../src/internal/agents-section.js"

const sdk = fileURLToPath(new URL("../../", import.meta.url))
const directories: string[] = []

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporary() {
    const directory = mkdtempSync(join(tmpdir(), "fluxerly-agents-"))
    directories.push(directory)
    return directory
}

/** An installed package with the shipped agent guide and the given version */
function installedPackage(version: string) {
    const root = temporary()
    mkdirSync(join(root, "agents"))
    copyFileSync(join(sdk, "agents/AGENTS.md"), join(root, "agents/AGENTS.md"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ version }))
    return root
}

const read = (project: string) => readFileSync(join(project, "AGENTS.md"), "utf8")

test("a project without AGENTS.md gets one with the rules, the installed version and the guide path", () => {
    const project = temporary()
    expect(writeAgentsSection(project, installedPackage("1000.0.0-rc.9")).status).toBe("created")
    const text = read(project)
    expect(text).toContain("@neontechspace/fluxerly 1000.0.0-rc.9")
    expect(text).toContain("node_modules/@neontechspace/fluxerly/agents/AGENTS.md")
    expect(text).toContain("Check `result.isErr()` before reading `result.value`")
    expect(text).toContain("run `npx --no fluxerly agents` to refresh")
})

test("the section is added after existing instructions, which stay unchanged", () => {
    const project = temporary()
    const own = "# Project rules\n\nUse tabs\n"
    writeFileSync(join(project, "AGENTS.md"), own)
    expect(writeAgentsSection(project, installedPackage("1000.0.0-rc.9")).status).toBe("added")
    expect(read(project).startsWith(`${own}\n<!-- fluxerly:start -->`)).toBe(true)
})

test("running again changes nothing until the SDK version changes, then replaces only the section", () => {
    const project = temporary()
    writeFileSync(join(project, "AGENTS.md"), "Before\r\n")
    writeAgentsSection(project, installedPackage("1000.0.0-rc.9"))
    writeFileSync(join(project, "AGENTS.md"), `${read(project)}After\r\n`)
    const first = read(project)
    expect(writeAgentsSection(project, installedPackage("1000.0.0-rc.9")).status).toBe("current")
    expect(read(project)).toBe(first)

    expect(writeAgentsSection(project, installedPackage("1000.0.0-rc.10")).status).toBe("updated")
    const second = read(project)
    expect(second).toBe(first.replace("rc.9", "rc.10"))
    // A Windows file keeps its line endings
    expect(second.replaceAll("\r\n", "")).not.toContain("\n")
})

test("the refresh command matches the project's package manager", () => {
    for (const [lockfile, command] of [
        ["pnpm-lock.yaml", "pnpm exec fluxerly agents"],
        ["bun.lock", "bunx --no-install fluxerly agents"],
        ["package-lock.json", "npx --no fluxerly agents"],
    ]) {
        const project = temporary()
        writeFileSync(join(project, lockfile!), "")
        writeAgentsSection(project, installedPackage("1000.0.0-rc.9"))
        expect(read(project)).toContain(`run \`${command}\` to refresh`)
    }
})

test("a broken marker stops the update without changing AGENTS.md", () => {
    const project = temporary()
    const broken = "Mine\n<!-- fluxerly:start -->\nhalf a section\n"
    writeFileSync(join(project, "AGENTS.md"), broken)
    expect(() => writeAgentsSection(project, installedPackage("1000.0.0-rc.9"))).toThrow(AgentsSectionError)
    expect(read(project)).toBe(broken)
})

test("a CLAUDE.md that does not mention AGENTS.md is reported but not changed", () => {
    const project = temporary()
    writeFileSync(join(project, "CLAUDE.md"), "Be brief\n")
    writeFileSync(join(project, "GEMINI.md"), "See @AGENTS.md\n")
    const { notes } = writeAgentsSection(project, installedPackage("1000.0.0-rc.9"))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("CLAUDE.md does not mention AGENTS.md")
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("Be brief\n")
})
