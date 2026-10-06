import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { writeAgentsSection } from "../../src/internal/agents-section.js"
import { StarterConflictError, writeStarterProject } from "../../src/internal/starter-project.js"

const sdk = fileURLToPath(new URL("../../", import.meta.url))
const directories: string[] = []

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporary() {
    const directory = mkdtempSync(join(tmpdir(), "fluxerly-init-"))
    directories.push(directory)
    return directory
}

const read = (project: string, name: string) => readFileSync(join(project, name), "utf8")
/** The events object of a bot program, as written in its source */
const eventsBlock = (source: string) =>
    /^ {4}events: \{\n[\s\S]*?\n {4}\},\n/m.exec(source.replaceAll("\r\n", "\n"))?.[0]

test("an empty folder gets a runnable bot project with a token template, ignores, a test and agent rules", () => {
    const project = temporary()
    expect(writeStarterProject(project, sdk)).toEqual([
        "package.json",
        "bot.js",
        "bot.test.js",
        ".env.example",
        ".gitignore",
        "AGENTS.md",
    ])
    expect(readdirSync(project).toSorted()).toEqual(
        ["package.json", "bot.js", "bot.test.js", ".env.example", ".gitignore", "AGENTS.md"].toSorted(),
    )

    const manifest = JSON.parse(read(project, "package.json"))
    expect(manifest.type).toBe("module")
    expect(manifest.scripts.start).toMatch(/^node .*\bbot\.js$/)
    expect(manifest.scripts.test).toMatch(/^node --test\b/)
    expect(manifest).not.toHaveProperty("dependencies")
    expect(read(project, ".env.example")).toBe("FLUXER_BOT_TOKEN=\n")
    expect(read(project, ".gitignore").split("\n")).toEqual(expect.arrayContaining(["node_modules", ".env"]))
    expect(read(project, "bot.test.js")).toContain('from "@neontechspace/fluxerly/testing"')
    expect(read(project, "bot.test.js")).toContain('from "./bot.js"')

    // AGENTS.md is the file that fluxerly agents creates in the same folder
    const agentsProject = temporary()
    writeAgentsSection(agentsProject, sdk)
    expect(read(project, "AGENTS.md")).toBe(read(agentsProject, "AGENTS.md"))
})

test("the generated bot keeps the shipped starter's handlers", () => {
    const project = temporary()
    writeStarterProject(project, sdk)
    const starter = eventsBlock(readFileSync(join(sdk, "examples/starter/bot.js"), "utf8"))
    expect(starter).toBeDefined()
    expect(eventsBlock(read(project, "bot.js"))).toBe(starter)
    expect(read(project, "bot.js")).toContain("token: process.env.FLUXER_BOT_TOKEN, processSignals: true")
})

test("existing files stop init before it writes anything and are listed as conflicts", () => {
    const project = temporary()
    writeFileSync(join(project, "bot.js"), "own bot\n")
    writeFileSync(join(project, ".gitignore"), "own ignores\n")

    let failure: unknown
    try {
        writeStarterProject(project, sdk)
    } catch (error) {
        failure = error
    }
    expect(failure).toBeInstanceOf(StarterConflictError)
    expect((failure as StarterConflictError).conflicts).toEqual(["bot.js", ".gitignore"])
    expect(readdirSync(project).toSorted()).toEqual([".gitignore", "bot.js"])
    expect(read(project, "bot.js")).toBe("own bot\n")
    expect(read(project, ".gitignore")).toBe("own ignores\n")
})
