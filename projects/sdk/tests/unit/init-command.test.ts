import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import {
    detectPackageManager,
    parseInitArguments,
    runCommand,
    runInit,
    selectStarterTemplate,
    templateQuestion,
    type PackageManager,
} from "../../src/internal/init-command.js"

/** Standard streams that report themselves as terminals or not, with everything init prints */
function streams(terminal: boolean) {
    const input = Object.assign(new PassThrough(), { isTTY: terminal })
    const output = Object.assign(new PassThrough(), { isTTY: terminal })
    let printed = ""
    output.on("data", (chunk: Buffer) => (printed += chunk.toString()))
    return { input, output, printed: () => printed }
}

/** Resolve once the prompt has asked its question this many times, so an answer is never typed before the question */
function asked(printed: () => string, times: number, output: PassThrough) {
    return new Promise<void>((resolve) => {
        const check = () => {
            if (printed().split(templateQuestion).length - 1 < times) return
            output.off("data", check)
            resolve()
        }
        output.on("data", check)
        check()
    })
}

test.each(["js", "ts", "effect"] as const)("--template %s selects that starter without asking", async (template) => {
    const terminal = streams(true)
    await expect(selectStarterTemplate(template, terminal)).resolves.toBe(template)
    expect(terminal.printed()).toBe("")
})

test("without a terminal and without --template, init writes the JavaScript starter without asking", async () => {
    const piped = streams(false)
    await expect(selectStarterTemplate(undefined, piped)).resolves.toBe("js")
    expect(piped.printed()).toBe("")
})

test.each([
    [[], { template: undefined, install: true }],
    [["--template", "ts"], { template: "ts", install: true }],
    [["--no-install"], { template: undefined, install: false }],
    [["--no-install", "--template", "effect"], { template: "effect", install: false }],
    [["--template", "js", "--no-install"], { template: "js", install: false }],
])("init accepts the arguments %j", (args, expected) => {
    expect(parseInitArguments(args)).toEqual(expected)
})

test.each([
    ["an unknown template", ["--template", "rust"]],
    ["a missing template", ["--template"]],
    ["a template without the option", ["ts"]],
    ["an extra argument", ["--template", "ts", "extra"]],
    ["a repeated option", ["--no-install", "--no-install"]],
    ["a second template", ["--template", "ts", "--template", "js"]],
])("%s is invalid", (_, args) => {
    expect(parseInitArguments(args)).toBe("invalid")
})

test.each([
    ["Enter", "", "js"],
    ["1", "1", "js"],
    ["2", "2", "ts"],
    ["3", " 3 ", "effect"],
])("without raw mode, answering %s at the numbered prompt selects that starter", async (_, answer, template) => {
    const terminal = streams(true)
    const selected = selectStarterTemplate(undefined, terminal)
    await asked(terminal.printed, 1, terminal.output)
    terminal.input.write(`${answer}\n`)
    await expect(selected).resolves.toBe(template)
    expect(terminal.printed()).toContain("3. Effect (TypeScript with the native Effect API)")
})

test("an answer outside the numbered prompt asks again", async () => {
    const terminal = streams(true)
    const selected = selectStarterTemplate(undefined, terminal)
    await asked(terminal.printed, 1, terminal.output)
    terminal.input.write("typescript\n")
    await asked(terminal.printed, 2, terminal.output)
    terminal.input.write("2\n")
    await expect(selected).resolves.toBe("ts")
})

test("input that ends before an answer at the numbered prompt cancels init", async () => {
    const terminal = streams(true)
    const selected = selectStarterTemplate(undefined, terminal)
    await asked(terminal.printed, 1, terminal.output)
    terminal.input.end()
    await expect(selected).resolves.toBe("cancelled")
})

test("Ctrl+C at the numbered prompt cancels init", async () => {
    const terminal = streams(true)
    const selected = selectStarterTemplate(undefined, terminal)
    await asked(terminal.printed, 1, terminal.output)
    terminal.input.write("\x03")
    await expect(selected).resolves.toBe("cancelled")
})

const showCursor = "\x1b[?25h"

/** A terminal whose input supports raw mode, recording each raw mode change, so init shows the arrow-key menu */
function menuTerminal({ colors = false } = {}) {
    const terminal = streams(true)
    const rawModes: boolean[] = []
    const input = Object.assign(terminal.input, {
        isRaw: false,
        setRawMode(mode: boolean) {
            rawModes.push(mode)
            input.isRaw = mode
        },
    })
    if (colors) Object.assign(terminal.output, { hasColors: () => true })
    return { ...terminal, input, rawModes }
}

test.each([
    ["Enter", "\r", "js", "JavaScript"],
    ["↓ and Enter", "\x1b[B\r", "ts", "TypeScript"],
    ["↑ from the first option and Enter", "\x1b[A\r", "effect", "Effect (TypeScript with the native Effect API)"],
    ["j, j, k and Enter", "jjk\r", "ts", "TypeScript"],
])("in the menu, %s selects that starter and collapses the menu to the choice", async (_, keys, template, label) => {
    const terminal = menuTerminal()
    const selected = selectStarterTemplate(undefined, terminal)
    terminal.input.write(keys)
    await expect(selected).resolves.toBe(template)
    expect(terminal.printed()).toContain("> JavaScript\n")
    // The collapse clears the menu and writes the question with the choice in its place
    expect(terminal.printed()).toContain(`\x1b[0JWhich starter should fluxerly init write? ${label}\n`)
    expect(terminal.rawModes).toEqual([true, false])
    expect(terminal.printed().endsWith(showCursor)).toBe(true)
})

test.each([
    ["Escape", "\x1b"],
    ["Ctrl+C", "\x03"],
])("%s in the menu cancels init and restores the terminal", async (_, key) => {
    const terminal = menuTerminal()
    const selected = selectStarterTemplate(undefined, terminal)
    terminal.input.write(`\x1b[B${key}`)
    await expect(selected).resolves.toBe("cancelled")
    expect(terminal.rawModes).toEqual([true, false])
    expect(terminal.input.isPaused()).toBe(true)
    expect(terminal.printed().endsWith(showCursor)).toBe(true)
})

test("input that ends in the menu cancels init and restores the terminal", async () => {
    const terminal = menuTerminal()
    const selected = selectStarterTemplate(undefined, terminal)
    terminal.input.end()
    await expect(selected).resolves.toBe("cancelled")
    expect(terminal.rawModes).toEqual([true, false])
    expect(terminal.printed().endsWith(showCursor)).toBe(true)
})

test("a failure while redrawing the menu still restores the terminal", async () => {
    const terminal = menuTerminal()
    const write = terminal.output.write.bind(terminal.output)
    let writes = 0
    // The first write draws the menu, and the second, the redraw after ↓, fails
    terminal.output.write = ((chunk: string) => {
        if (++writes === 2) throw new Error("The terminal went away")
        return write(chunk)
    }) as typeof terminal.output.write
    const selected = selectStarterTemplate(undefined, terminal)
    terminal.input.write("\x1b[B")
    await expect(selected).rejects.toThrow("The terminal went away")
    expect(terminal.rawModes).toEqual([true, false])
    expect(terminal.printed().endsWith(showCursor)).toBe(true)
})

test("the menu highlights in color only when the terminal supports color", async () => {
    const colored = menuTerminal({ colors: true })
    const coloredPick = selectStarterTemplate(undefined, colored)
    colored.input.write("\r")
    await coloredPick
    expect(colored.printed()).toContain("\x1b[36m> JavaScript\x1b[39m")

    const plain = menuTerminal()
    const plainPick = selectStarterTemplate(undefined, plain)
    plain.input.write("\r")
    await plainPick
    expect(plain.printed()).toContain("> JavaScript")
    expect(plain.printed()).not.toContain("\x1b[36m")
})

const sdk = fileURLToPath(new URL("../../", import.meta.url))
const release = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")) as {
    version: string
    peerDependencies: { effect: string }
}
const directories: string[] = []

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * Run init without a terminal in a new folder. The runner records each command instead of installing, and fails the
 * command at index failAt
 */
async function init(
    args: readonly string[],
    userAgent?: string,
    { failAt = -1, existing = {} as Record<string, string> } = {},
) {
    const project = mkdtempSync(join(tmpdir(), "fluxerly-init-"))
    directories.push(project)
    for (const [name, text] of Object.entries(existing)) writeFileSync(join(project, name), text)
    const { input, output, printed } = streams(false)
    const errors = streams(false)
    const commands: { command: string; args: readonly string[]; cwd: string }[] = []
    const outcome = await runInit(args, {
        input,
        output,
        errorOutput: errors.output,
        project,
        packageRoot: sdk,
        userAgent,
        run: async (command, commandArgs, cwd) => {
            commands.push({ command, args: commandArgs, cwd })
            return commands.length - 1 !== failAt
        },
    })
    return { outcome, project, commands, printed: printed(), errors: errors.printed() }
}

test.each([
    ["pnpm/10.18.0 npm/? node/v24.9.0 win32 x64", "pnpm"],
    ["bun/1.2.23 npm/? node/v24.3.0 linux x64", "bun"],
    ["npm/11.6.0 node/v24.9.0 darwin arm64 workspaces/false", "npm"],
    ["yarn/1.22.22 npm/? node/v24.9.0 linux x64", "npm"],
    [undefined, "npm"],
])("the user agent %s selects %s", (userAgent, manager) => {
    expect(detectPackageManager(userAgent)).toBe(manager)
})

const userAgents = { npm: "npm/11.6.0 node/v24.9.0", pnpm: "pnpm/10.18.0 npm/? node/v24.9.0", bun: "bun/1.2.23" }
const flags = {
    npm: ["install", "--save-exact", "--save-dev"],
    pnpm: ["add", "--save-exact", "--save-dev"],
    bun: ["add", "--exact", "--dev"],
}
const scripts = { npm: "npm", pnpm: "pnpm", bun: "bun run" }

/** The install commands each starter needs, as the printed steps have always named them */
function expectedInstall(manager: PackageManager, template: "js" | "ts" | "effect") {
    const [add, exact, dev] = flags[manager]
    const sdkArgs = [
        add!,
        ...(release.version.includes("-") ? [exact!] : []),
        `@neontechspace/fluxerly@${release.version}`,
    ]
    const effectArgs = [add!, `effect@${release.peerDependencies.effect.replace(/^\^/, "")}`]
    const nodeTypesArgs = [add!, dev!, "@types/node"]
    const all =
        template === "js"
            ? [sdkArgs]
            : template === "ts"
              ? [sdkArgs, nodeTypesArgs]
              : [sdkArgs, effectArgs, nodeTypesArgs]
    return all.map((args) => ({ command: manager, args }))
}

test.each(
    (["npm", "pnpm", "bun"] as const).flatMap((manager) =>
        (["js", "ts", "effect"] as const).map((template) => [manager, template] as const),
    ),
)("%s installs the %s starter's dependencies in the project, then prints its next steps", async (manager, template) => {
    const result = await init(["--template", template], userAgents[manager])
    expect(result.outcome).toBe(0)
    expect(result.commands).toEqual(
        expectedInstall(manager, template).map((command) => ({ ...command, cwd: result.project })),
    )
    expect(result.printed).toContain(`Check the bot without a token: ${scripts[manager]} test`)
    expect(result.printed).toContain(`Start the bot: ${scripts[manager]} start`)
    // The install already ran, so the next steps do not repeat it
    expect(result.printed).not.toContain("@neontechspace/fluxerly@")
    expect(result.errors).toBe("")
})

test("init copies .env.example to .env, so the token goes straight into .env", async () => {
    const { project, printed } = await init(["--template", "ts"])
    expect(readFileSync(join(project, ".env"), "utf8")).toBe(readFileSync(join(project, ".env.example"), "utf8"))
    expect(printed).toContain("Set FLUXER_BOT_TOKEN in .env")
})

test("an existing .env does not stop init and keeps its token", async () => {
    const { outcome, project, commands, printed } = await init(["--template", "js"], undefined, {
        existing: { ".env": "FLUXER_BOT_TOKEN=own-token\n" },
    })
    expect(outcome).toBe(0)
    expect(readFileSync(join(project, ".env"), "utf8")).toBe("FLUXER_BOT_TOKEN=own-token\n")
    expect(printed).toContain("Kept the existing .env")
    expect(commands).toHaveLength(1)
})

test("a failed install keeps the written files, prints the install commands and exits with 1", async () => {
    const { outcome, project, commands, printed, errors } = await init(["--template", "effect"], userAgents.pnpm, {
        failAt: 1,
    })
    expect(outcome).toBe(1)
    // The install stops at the failed command
    expect(commands).toHaveLength(2)
    expect(readdirSync(project)).toEqual(expect.arrayContaining(["package.json", "bot.ts", ".env"]))
    expect(errors).toContain("pnpm")
    for (const { args } of expectedInstall("pnpm", "effect")) expect(printed).toContain(`   pnpm ${args.join(" ")}\n`)
})

test("--no-install writes the starter and .env without installing, and prints the install commands", async () => {
    const { outcome, project, commands, printed } = await init(["--template", "ts", "--no-install"], userAgents.bun)
    expect(outcome).toBe(0)
    expect(commands).toEqual([])
    expect(readdirSync(project)).toContain(".env")
    for (const { args } of expectedInstall("bun", "ts")) expect(printed).toContain(`   bun ${args.join(" ")}\n`)
    expect(printed).toContain("Start the bot: bun run start")
})

test("arguments init does not accept write nothing and run nothing", async () => {
    const { outcome, project, commands } = await init(["--template", "rust"])
    expect(outcome).toBe("usage")
    expect(readdirSync(project)).toEqual([])
    expect(commands).toEqual([])
})

test("existing starter files stop init before it writes or installs anything", async () => {
    const { outcome, project, commands, errors } = await init(["--template", "js"], undefined, {
        existing: { "bot.js": "own bot\n" },
    })
    expect(outcome).toBe(1)
    expect(readdirSync(project)).toEqual(["bot.js"])
    expect(commands).toEqual([])
    expect(errors).toContain("wrote nothing")
})

test.each([
    [0, true],
    [3, false],
])("the install runner reports a command that exits with %i as succeeded: %s", async (code, succeeded) => {
    // A bare command name, as the package managers are, resolves through the PATH on every platform
    await expect(runCommand("node", ["-e", `process.exit(${code})`], sdk)).resolves.toBe(succeeded)
})
