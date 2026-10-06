import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test, vi } from "vitest"
import { writeAgentsSection } from "../../src/internal/agents-section.js"
import { StarterConflictError, writeStarterProject } from "../../src/internal/starter-project.js"

/** When set, the next write of exactly this text fails after its file was created, as a full disk would */
const injected = vi.hoisted(() => ({ text: undefined as string | undefined }))
vi.mock("node:fs", async (original) => {
    const fs = await original<typeof import("node:fs")>()
    return {
        ...fs,
        writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
            if (injected.text !== undefined && args[1] === injected.text) {
                injected.text = undefined
                fs.writeFileSync(args[0], "", args[2])
                throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" })
            }
            return fs.writeFileSync(...args)
        },
    }
})

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

const starters = [
    { template: "js", bot: "bot.js", test: "bot.test.js", testing: "testing", example: "bot.js" },
    { template: "ts", bot: "bot.ts", test: "bot.test.ts", testing: "testing", example: "bot.ts" },
    { template: "effect", bot: "bot.ts", test: "bot.test.ts", testing: "effect/testing", example: "bot-effect.ts" },
] as const

test.each(starters)(
    "the $template starter is a runnable project with a token template and its .env copy, ignores, a test and agent rules",
    ({ template, bot, test: botTest, testing }) => {
        const project = temporary()
        const typeScript = template === "js" ? [] : ["tsconfig.json"]
        const files = ["package.json", ...typeScript, bot, botTest, ".env.example", ".env", ".gitignore", "AGENTS.md"]
        expect(writeStarterProject(project, sdk, template)).toEqual(files)
        expect(readdirSync(project).toSorted()).toEqual(files.toSorted())

        const manifest = JSON.parse(read(project, "package.json"))
        expect(manifest.type).toBe("module")
        // Node.js runs the bot file itself, so neither script needs a build step
        expect(manifest.scripts.start.split(" ")).toEqual(["node", expect.stringMatching(/^--env-file/), bot])
        expect(manifest.scripts.test).toBe("node --test")
        expect(manifest).not.toHaveProperty("dependencies")
        expect(read(project, ".env.example")).toBe("FLUXER_BOT_TOKEN=\n")
        expect(read(project, ".env")).toBe(read(project, ".env.example"))
        expect(read(project, ".gitignore").split("\n")).toEqual(expect.arrayContaining(["node_modules", ".env"]))
        expect(read(project, botTest)).toContain(`from "@neontechspace/fluxerly/${testing}"`)
        expect(read(project, botTest)).toContain(`from "./${bot}"`)
        expect(read(project, botTest)).toContain(".say(")

        // AGENTS.md is the file that fluxerly agents creates in the same folder
        const agentsProject = temporary()
        writeAgentsSection(agentsProject, sdk)
        expect(read(project, "AGENTS.md")).toBe(read(agentsProject, "AGENTS.md"))
    },
)

test.each(starters.filter(({ template }) => template !== "js"))(
    "the $template starter's tsconfig.json checks strictly for editors and leaves running to Node.js",
    ({ template }) => {
        const project = temporary()
        writeStarterProject(project, sdk, template)
        expect(JSON.parse(read(project, "tsconfig.json")).compilerOptions).toMatchObject({
            module: "NodeNext",
            types: ["node"],
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
        })
    },
)

test.each(starters)(
    "the generated $template bot keeps the shipped $example starter's handlers",
    ({ template, bot, example }) => {
        const project = temporary()
        writeStarterProject(project, sdk, template)
        const starter = eventsBlock(readFileSync(join(sdk, "examples/starter", example), "utf8"))
        expect(starter).toBeDefined()
        expect(eventsBlock(read(project, bot))).toBe(starter)
        expect(read(project, bot)).toContain("token: process.env.FLUXER_BOT_TOKEN")
        expect(read(project, bot)).toContain("if (import.meta.main)")
    },
)

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

test("an existing .env is kept and is no conflict, so init writes every other file", () => {
    const project = temporary()
    writeFileSync(join(project, ".env"), "FLUXER_BOT_TOKEN=own-token\n")
    expect(writeStarterProject(project, sdk)).not.toContain(".env")
    expect(read(project, ".env")).toBe("FLUXER_BOT_TOKEN=own-token\n")
    expect(readdirSync(project)).toContain("bot.js")
})

test("an existing .env is not listed when other files conflict", () => {
    const project = temporary()
    writeFileSync(join(project, ".env"), "FLUXER_BOT_TOKEN=own-token\n")
    writeFileSync(join(project, "bot.js"), "own bot\n")
    expect(() => writeStarterProject(project, sdk)).toThrow(expect.objectContaining({ conflicts: ["bot.js"] }))
    expect(readdirSync(project).toSorted()).toEqual([".env", "bot.js"])
})

test("a write that fails after creating its file removes every file this run created, so init can run again", () => {
    const project = temporary()
    writeFileSync(join(project, "notes.txt"), "own notes\n")
    injected.text = "FLUXER_BOT_TOKEN=\n"

    expect(() => writeStarterProject(project, sdk)).toThrow("No space left on device")
    expect(readdirSync(project)).toEqual(["notes.txt"])
    expect(writeStarterProject(project, sdk)).toContain(".env.example")
})
