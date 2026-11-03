import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test, vi } from "vitest"
import { newAgentsFile, writeAgentsSection } from "../../src/internal/agents-section.js"
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

const starters = [
    { template: "js", bot: "bot.js", test: "bot.test.js", testing: "testing" },
    { template: "ts", bot: "bot.ts", test: "bot.test.ts", testing: "testing" },
    { template: "effect", bot: "bot.ts", test: "bot.test.ts", testing: "effect/testing" },
] as const

test.each(starters)(
    "the $template starter is a runnable project with a token template and its .env copy, ignores, a test and agent rules",
    ({ template, bot, test: botTest, testing }) => {
        const project = temporary()
        const typeScript = template === "js" ? [] : ["tsconfig.json"]
        const files = ["package.json", ...typeScript, bot, botTest, ".env.example", ".env", ".gitignore", "AGENTS.md"]
        expect(writeStarterProject(project, sdk, template)).toEqual({ written: files, ignored: [] })
        expect(readdirSync(project).toSorted()).toEqual(files.toSorted())

        const manifest = JSON.parse(read(project, "package.json"))
        expect(manifest.type).toBe("module")
        // Node.js runs the bot file itself, so neither script needs a build step
        expect(manifest.scripts.start.split(" ")).toEqual(["node", expect.stringMatching(/^--env-file/), bot])
        // The dev script restarts the same bot file with the same .env after each saved change
        expect(manifest.scripts.dev).toBe(`node --watch --env-file-if-exists=.env ${bot}`)
        // Node.js has no default test timeout, and without forcing the exit a timed-out test keeps the process running
        expect(manifest.scripts.test).toBe("node --test --test-timeout=30000 --test-force-exit")
        // Node.js removes types without checking them, so only a TypeScript starter has a script that runs the compiler
        expect(manifest.scripts.check).toBe(template === "js" ? undefined : "tsc")
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

test.skipIf(process.platform === "win32")(
    "the written .env is readable only by its owner, because it holds the token",
    () => {
        const project = temporary()
        writeStarterProject(project, sdk)
        expect(statSync(join(project, ".env")).mode & 0o777).toBe(0o600)
    },
)

test("existing files stop init before it writes anything and are listed as conflicts", () => {
    const project = temporary()
    writeFileSync(join(project, "bot.js"), "own bot\n")
    writeFileSync(join(project, "package.json"), "own manifest\n")
    writeFileSync(join(project, ".gitignore"), "own ignores\n")

    let failure: unknown
    try {
        writeStarterProject(project, sdk)
    } catch (error) {
        failure = error
    }
    expect(failure).toBeInstanceOf(StarterConflictError)
    expect((failure as StarterConflictError).conflicts).toEqual(["package.json", "bot.js"])
    expect(readdirSync(project).toSorted()).toEqual([".gitignore", "bot.js", "package.json"])
    expect(read(project, "bot.js")).toBe("own bot\n")
    // A conflict writes nothing, not even the lines the starter would add to the .gitignore
    expect(read(project, ".gitignore")).toBe("own ignores\n")
})

test("an existing .env is kept and is no conflict, so init writes every other file", () => {
    const project = temporary()
    writeFileSync(join(project, ".env"), "FLUXER_BOT_TOKEN=own-token\n")
    expect(writeStarterProject(project, sdk).written).not.toContain(".env")
    expect(read(project, ".env")).toBe("FLUXER_BOT_TOKEN=own-token\n")
    expect(readdirSync(project)).toContain("bot.js")
})

// The quick start's manual setup has the reader write a .gitignore with .env, and init may run in that folder later
test.each([
    ["lacks both lines", "dist\n", "dist\nnode_modules\n.env\n", ["node_modules", ".env"]],
    ["has .env, as the quick start's manual setup writes it", ".env\n", ".env\nnode_modules\n", ["node_modules"]],
    ["has node_modules", "node_modules\n", "node_modules\n.env\n", [".env"]],
    ["ends without a line break", ".env", ".env\nnode_modules\n", ["node_modules"]],
    ["is empty", "", "node_modules\n.env\n", ["node_modules", ".env"]],
    ["uses Windows line endings", "dist\r\n.env\r\n", "dist\r\n.env\r\nnode_modules\r\n", ["node_modules"]],
    ["has both lines already", "# Ignored\n.env\nnode_modules\n", "# Ignored\n.env\nnode_modules\n", []],
    // A commented or differently scoped entry does not ignore .env, so the line is still added
    ["has only look-alike lines", "# .env\n.env/\n", "# .env\n.env/\nnode_modules\n.env\n", ["node_modules", ".env"]],
])("an existing .gitignore that %s is kept and gains only the lines it lacks", (_, before, after, added) => {
    const project = temporary()
    writeFileSync(join(project, ".gitignore"), before)
    const result = writeStarterProject(project, sdk)
    expect(result.written).not.toContain(".gitignore")
    expect(result.ignored).toEqual(added)
    expect(read(project, ".gitignore")).toBe(after)
    expect(readdirSync(project)).toContain("bot.js")
})

/** Ask Git itself, ignoring this machine's settings, whether a project's rules ignore a path */
function gitIgnores(project: string, path: string) {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")))
    const git = (...args: string[]) =>
        spawnSync("git", ["-c", `core.excludesFile=${join(project, "no-global-ignores")}`, ...args], {
            cwd: project,
            env: { ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(project, "no-global-config") },
            encoding: "utf8",
        })
    expect(git("init", "--quiet", "--template=").status).toBe(0)
    return git("check-ignore", "--no-index", path).status === 0
}

test.each([
    ["negates the rule", ".env\nnode_modules\n!.env\n"],
    ["negates the rule with a leading slash", ".env\nnode_modules\n!/.env\n"],
    ["negates with a wildcard for .env files", ".env\nnode_modules\n!.env*\n"],
    ["negates with a wildcard for everything", "node_modules\n.env\n!*\n"],
    ["writes the rule with a leading space, which is another pattern for Git", " .env\nnode_modules\n"],
    ["uses Windows line endings", "node_modules\r\n.env\r\n!.env\r\n"],
    ["negates the rule with a backslash escape", ".env\nnode_modules\n!\\.env\n"],
])("init ends with .env ignored when an existing .gitignore %s", (_, before) => {
    const project = temporary()
    writeFileSync(join(project, ".gitignore"), before)
    const { ignored } = writeStarterProject(project, sdk)
    expect(ignored).toContain(".env")
    expect(read(project, ".gitignore").startsWith(before)).toBe(true)
    expect(gitIgnores(project, ".env")).toBe(true)
})

test.each([
    ["as a folder", ".env\nnode_modules\n!node_modules/\n"],
    ["with a backslash escape", ".env\nnode_modules\n!node\\_modules\n"],
])("init ends with node_modules ignored when an existing .gitignore negates it %s", (_, before) => {
    const project = temporary()
    writeFileSync(join(project, ".gitignore"), before)
    expect(writeStarterProject(project, sdk).ignored).toEqual(["node_modules"])
    expect(gitIgnores(project, "node_modules/x")).toBe(true)
})

test.each([
    ["negates another path, as many projects do for the template", ".env\nnode_modules\n!.env.example\n"],
    ["repeats the rule after its negation", "node_modules\n!.env\n.env\n"],
    ["has trailing spaces, which Git ignores", ".env  \nnode_modules\t\n"],
])("an existing .gitignore that %s already ignores .env and stays unchanged", (_, before) => {
    const project = temporary()
    writeFileSync(join(project, ".gitignore"), before)
    expect(writeStarterProject(project, sdk).ignored).toEqual([])
    expect(read(project, ".gitignore")).toBe(before)
    expect(gitIgnores(project, ".env")).toBe(true)
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
    expect(writeStarterProject(project, sdk).written).toContain(".env.example")
})

test("a write that fails on the last new file leaves an existing .gitignore as it was", () => {
    const project = temporary()
    writeFileSync(join(project, ".gitignore"), "dist\n")
    // AGENTS.md is the last file of the starter, so every other file was written before it failed
    injected.text = newAgentsFile(project, sdk)

    expect(() => writeStarterProject(project, sdk)).toThrow("No space left on device")
    expect(readdirSync(project)).toEqual([".gitignore"])
    expect(read(project, ".gitignore")).toBe("dist\n")
})
