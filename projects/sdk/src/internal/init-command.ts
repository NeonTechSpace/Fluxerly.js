/**
 * Runs `fluxerly init`: It chooses the starter, writes it, installs its dependencies with the package manager that
 * launched init, and prints the next steps.
 * The starter is the one the --template option names, a choice from a prompt when both standard streams are terminals,
 * or JavaScript otherwise, so scripts and CI never wait for input. The prompt is an arrow-key menu when the input
 * terminal supports raw mode, and a numbered question otherwise
 */

import { spawn } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { emitKeypressEvents, type Key } from "node:readline"
import { createInterface } from "node:readline/promises"
import { createCliTheme, truncateVisible, type CliStreamLike, type CliTheme } from "./cli-theme.js"
import {
    StarterConflictError,
    starterTemplates,
    writeStarterProject,
    type StarterResult,
    type StarterTemplate,
} from "./starter-project.js"

/** The streams init talks through. Their isTTY flags decide whether it asks, and raw mode decides how */
interface InitStreams {
    readonly input: NodeJS.ReadableStream & {
        readonly isTTY?: boolean
        readonly isRaw?: boolean
        setRawMode?(mode: boolean): unknown
    }
    // A terminal's hasColors and getColorDepth respect NO_COLOR and FORCE_COLOR
    readonly output: NodeJS.WritableStream &
        CliStreamLike & {
            on?(event: "resize", listener: () => void): unknown
            off?(event: "resize", listener: () => void): unknown
        }
    readonly env?: Readonly<Record<string, string | undefined>> | undefined
    readonly platform?: NodeJS.Platform | undefined
}
type MenuInput = InitStreams["input"] & { setRawMode(mode: boolean): unknown }

const question = "Which starter should fluxerly init write?"
const choices: readonly {
    readonly template: StarterTemplate
    readonly name: string
    readonly description: string
    readonly label: string
}[] = [
    { template: "js", name: "JavaScript", description: "Zero-build ESM starter", label: "JavaScript" },
    { template: "ts", name: "TypeScript", description: "Native .ts with TypeScript 7 check", label: "TypeScript" },
    {
        template: "effect",
        name: "Effect",
        description: "TypeScript with the native Effect API",
        label: "Effect (TypeScript with the native Effect API)",
    },
]
const templateMenu = [question, ...choices.map(({ label }, index) => `  ${index + 1}. ${label}`)].join("\n")
export const templateQuestion = "Enter 1, 2 or 3, or press Enter for JavaScript: "

// A Map has no inherited keys, so an answer such as "constructor" matches nothing
const answers = new Map<string, StarterTemplate>([
    ["", "js"],
    ["1", "js"],
    ["2", "ts"],
    ["3", "effect"],
])

const isTemplate = (value: string | undefined): value is StarterTemplate =>
    starterTemplates.some((template) => template === value)
const isManager = (value: string | undefined): value is PackageManager =>
    value === "npm" || value === "pnpm" || value === "bun"

export interface ParsedInitArguments {
    readonly template: StarterTemplate | undefined
    readonly install: boolean
    readonly dir?: string
    readonly manager?: PackageManager
}

function parseInitArgumentsDetailed(args: readonly string[]): ParsedInitArguments | { readonly error: string } {
    let template: StarterTemplate | undefined
    let install = true
    let dir: string | undefined
    let manager: PackageManager | undefined
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        const next = args[index + 1]
        if (arg === "--no-install") {
            if (!install) return { error: "The --no-install option was passed more than once" }
            install = false
        } else if (arg === "--template") {
            if (template !== undefined) return { error: "The --template option was passed more than once" }
            if (next === undefined)
                return { error: "Missing value for --template. Supported templates are js, ts and effect" }
            if (!isTemplate(next))
                return { error: `Unsupported --template value "${next}". Supported templates are js, ts and effect` }
            template = next
            index++
        } else if (arg === "--dir") {
            if (dir !== undefined) return { error: "The --dir option was passed more than once" }
            if (next === undefined || next.trim() === "" || next.startsWith("-"))
                return { error: "Missing folder path for --dir" }
            dir = next
            index++
        } else if (arg === "--pm") {
            if (manager !== undefined) return { error: "The --pm option was passed more than once" }
            if (next === undefined)
                return { error: "Missing value for --pm. Supported package managers are npm, pnpm and bun" }
            if (!isManager(next))
                return { error: `Unsupported --pm value "${next}". Supported package managers are npm, pnpm and bun` }
            manager = next
            index++
        } else return { error: `Unknown argument "${arg ?? ""}" for init` }
    }
    return {
        template,
        install,
        ...(dir !== undefined ? { dir } : {}),
        ...(manager !== undefined ? { manager } : {}),
    }
}

/** What the arguments after `init` ask for, or "invalid" for arguments init does not accept */
export function parseInitArguments(args: readonly string[]): ParsedInitArguments | "invalid" {
    const parsed = parseInitArgumentsDetailed(args)
    return "error" in parsed ? "invalid" : parsed
}

/**
 * Select the starter: The named template, or a choice from the prompt. Returns "cancelled" when the prompt ends
 * without an answer, such as after Ctrl+C or Escape
 */
export async function selectStarterTemplate(
    template: StarterTemplate | undefined,
    { input, output, env, platform }: InitStreams,
): Promise<StarterTemplate | "cancelled"> {
    if (template !== undefined) return template
    if (!input.isTTY || !output.isTTY) return "js"
    if (typeof input.setRawMode === "function") return pickFromMenu(input as MenuInput, output, { env, platform })

    const prompt = createInterface({ input, output })
    // Ctrl+C and the end of input close the prompt, which cancels the question
    const closed = new Promise<"cancelled">((resolve) => prompt.once("close", () => resolve("cancelled")))
    try {
        output.write(`${templateMenu}\n`)
        for (;;) {
            const answer = await Promise.race([
                prompt.question(templateQuestion).then(
                    (text) => answers.get(text.trim()) ?? null,
                    // allow-silent: A question pending when the prompt closes rejects, and init reports the cancellation
                    () => "cancelled" as const,
                ),
                closed,
            ])
            if (answer !== null) return answer
            output.write("Enter 1, 2 or 3\n")
        }
    } finally {
        prompt.close()
    }
}

/**
 * Show the starters as a menu that ↑ and ↓ (or k and j) move through and Enter picks, then collapse it to one line
 * with the choice. Every line is truncated to the terminal width so soft wrapping never breaks cursor redraws, and
 * raw mode, resize listeners and the cursor are restored however the menu ends
 */
async function pickFromMenu(
    input: MenuInput,
    output: InitStreams["output"],
    options: Pick<InitStreams, "env" | "platform">,
): Promise<StarterTemplate | "cancelled"> {
    const theme = createCliTheme(output, options)
    const maxWidth = () => Math.max(20, (output.columns ?? 80) - 1)
    const fit = (line: string) => truncateVisible(line, maxWidth(), theme.symbols.ellipsis)
    const keyHint = theme.capabilities.unicode
        ? "↑/↓ or j/k to move  Enter to select  Esc to cancel"
        : "Up/Down or j/k to move  Enter to select  Esc to cancel"
    let selected = 0
    // Each line clears what an earlier draw left on it and stays within one row so cursor-up redraws stay aligned
    const drawQuestion = () => `\x1b[2K${fit(theme.bold(question))}\n`
    const drawBody = () =>
        [
            ...choices.map(({ name, description }, index) => {
                const active = index === selected
                const lead = active ? theme.cyan(`${theme.symbols.pointer} ${name}`) : `  ${name}`
                const detail = description ? `  ${theme.muted(description)}` : ""
                return `\x1b[2K${fit(`${lead}${detail}`)}\n`
            }),
            `\x1b[2K${fit(theme.faint(keyHint))}\n`,
        ].join("")
    const bodyLines = choices.length + 1
    const totalLines = bodyLines + 1

    const wasRaw = input.isRaw === true
    let onKeypress: ((text: string | undefined, key: Key | undefined) => void) | undefined
    let onEnd: (() => void) | undefined
    let onResize: (() => void) | undefined
    emitKeypressEvents(input)
    input.setRawMode(true)
    try {
        output.write(`\x1b[?25l${drawQuestion()}${drawBody()}`)
        const picked = await new Promise<number | null>((resolve, reject) => {
            onEnd = () => resolve(null)
            onResize = () => {
                try {
                    output.write(`\x1b[${totalLines}A${drawQuestion()}${drawBody()}`)
                } catch (error) {
                    reject(error)
                }
            }
            onKeypress = (_, key) => {
                try {
                    if (key === undefined) return
                    if ((key.ctrl === true && key.name === "c") || key.name === "escape") return resolve(null)
                    if (key.name === "return" || key.name === "enter") return resolve(selected)
                    const step =
                        key.name === "up" || key.name === "k" ? -1 : key.name === "down" || key.name === "j" ? 1 : 0
                    if (step === 0) return
                    // Moving past either end wraps around to the other
                    selected = (selected + step + choices.length) % choices.length
                    output.write(`\x1b[${bodyLines}A${drawBody()}`)
                } catch (error) {
                    reject(error)
                }
            }
            input.on("keypress", onKeypress)
            input.once("end", onEnd)
            output.on?.("resize", onResize)
        })
        const answer = picked === null ? "" : ` ${theme.cyan(choices[picked]!.label)}`
        output.write(`\x1b[${totalLines}A\x1b[0J${question}${answer}\n`)
        return picked === null ? "cancelled" : choices[picked]!.template
    } finally {
        if (onKeypress) input.off("keypress", onKeypress)
        if (onEnd) input.off("end", onEnd)
        if (onResize) output.off?.("resize", onResize)
        input.setRawMode(wasRaw)
        // Reading stops so the process can exit once init is done
        input.pause()
        output.write("\x1b[?25h")
    }
}

export type PackageManager = "npm" | "pnpm" | "bun"

/** The package manager that launched init, read from the user agent it sets, such as "pnpm/10.0.0 npm/? node/v24" */
export function detectPackageManager(userAgent: string | undefined): PackageManager {
    const name = userAgent?.split("/", 1)[0]
    return name === "pnpm" || name === "bun" ? name : "npm"
}

// The test and start scripts have a short form in every manager, while any other script needs the run command
const managers = {
    npm: {
        add: "install",
        exact: "--save-exact",
        dev: "--save-dev",
        run: "npm",
        check: "npm run check",
        watch: "npm run dev",
    },
    pnpm: {
        add: "add",
        exact: "--save-exact",
        dev: "--save-dev",
        run: "pnpm",
        check: "pnpm run check",
        watch: "pnpm dev",
    },
    // bun test is Bun's own test runner, so the package's scripts run through bun run
    bun: { add: "add", exact: "--exact", dev: "--dev", run: "bun run", check: "bun run check", watch: "bun run dev" },
}
const installed = {
    js: "the SDK",
    ts: "the SDK, TypeScript and the Node.js types",
    effect: "the SDK, Effect, TypeScript and the Node.js types",
}

// Where the token and the invite are explained, under the address that the SDK's other documentation links use
const createBotGuide = "https://fluxerly.neontechspace.com/docs/create-a-bot/"

/** The SDK release that init installs, read from its own package.json */
interface SdkRelease {
    readonly version: string
    readonly peerDependencies: { readonly effect: string }
}

/** The install commands for a starter, each as the manager's name followed by its arguments */
function installCommands(
    manager: PackageManager,
    template: StarterTemplate,
    { version, peerDependencies }: SdkRelease,
): readonly (readonly string[])[] {
    const { add, exact, dev } = managers[manager]
    // Install the version that wrote the starter. A prerelease's API can change between versions, so it is pinned
    // exactly
    const sdk = [manager, add, ...(version.includes("-") ? [exact] : []), `@neontechspace/fluxerly@${version}`]
    // The lowest Effect release in the SDK's peer range, which the documentation recommends and the SDK is tested
    // against
    const effect = [manager, add, `effect@${peerDependencies.effect.replace(/^\^/, "")}`]
    // The check script runs TypeScript 7, the version that the SDK documents as required, and the SDK's types use the
    // Node.js types
    const typeTools = [manager, add, dev, "@types/node", "typescript@7"]
    if (template === "js") return [sdk]
    return template === "ts" ? [sdk, typeTools] : [sdk, effect, typeTools]
}

/** Runs a command in `cwd` with the terminal's standard streams, and resolves whether it ran and succeeded */
export type CommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<boolean>

export const runCommand: CommandRunner = (command, args, cwd) =>
    new Promise((resolve) => {
        // On Windows, npm and pnpm are .cmd shims, which only a shell starts. Init builds every argument itself, so the
        // joined command line carries no user input
        const child =
            process.platform === "win32"
                ? spawn([command, ...args].join(" "), { cwd, stdio: "inherit", shell: true })
                : spawn(command, args, { cwd, stdio: "inherit" })
        // A manager that is not installed fails to start, and init reports the failed install
        child.once("error", () => resolve(false))
        child.once("close", (code) => resolve(code === 0))
    })

/** The streams, folders and package manager that init works with */
export interface InitEnvironment extends InitStreams {
    readonly errorOutput: NodeJS.WritableStream & CliStreamLike
    /** The folder the starter is written into */
    readonly project: string
    /** The installed SDK package, whose package.json names the version to install */
    readonly packageRoot: string
    readonly userAgent: string | undefined
    readonly run?: CommandRunner
}

function nextSteps(
    manager: PackageManager,
    template: StarterTemplate,
    theme: CliTheme,
    install?: readonly (readonly string[])[],
) {
    const { run, check, watch } = managers[manager]
    const cmd = (text: string) => (theme.capabilities.color === "none" ? text : theme.cyanLight(text))
    const steps = [
        ...(install
            ? [[`Install ${installed[template]}:`, ...install.map((args) => `   ${cmd(args.join(" "))}`)].join("\n")]
            : []),
        `Set FLUXER_BOT_TOKEN in .env to the bot's token and invite the bot to a community. Both are explained at\n   ${theme.capabilities.color === "none" ? createBotGuide : theme.cyan(createBotGuide)}`,
        `Check the bot without a token: ${cmd(`${run} test`)}`,
        ...(template === "js" ? [] : [`Check the types: ${cmd(check)}`]),
        `Start the bot: ${cmd(`${run} start`)}\n   While changing the bot, ${cmd(watch)} restarts it after each saved change`,
    ]
    const heading = theme.capabilities.color === "none" ? "Next steps:" : theme.bold(theme.violet("Next steps:"))
    return [
        "",
        heading,
        ...steps.map(
            (step, index) =>
                `${theme.capabilities.color === "none" ? `${index + 1}.` : theme.gold(`${index + 1}.`)} ${step}`,
        ),
    ].join("\n")
}

/**
 * Run `fluxerly init` with the arguments after `init` and resolve its exit code, or "usage" for arguments it does not
 * accept. A failed install keeps the written files and prints the install commands instead
 */
export async function runInit(args: readonly string[], environment: InitEnvironment): Promise<0 | 1 | "usage"> {
    const { output, errorOutput, project, packageRoot, env, platform } = environment
    const theme = createCliTheme(output, { env, platform })
    const errTheme = createCliTheme(errorOutput, { env, platform })
    const print = (text: string) => output.write(`${text}\n`)
    const printOk = (text: string) =>
        print(theme.capabilities.color === "none" ? text : `${theme.success(theme.symbols.pass)} ${text}`)
    const printError = (text: string) =>
        errorOutput.write(
            errTheme.capabilities.color === "none"
                ? `${text}\n`
                : `${errTheme.error(`${errTheme.symbols.fail} ${text}`)}\n`,
        )

    const parsed = parseInitArgumentsDetailed(args)
    if ("error" in parsed) {
        printError(parsed.error)
        return "usage"
    }

    const release = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as SdkRelease
    if (theme.capabilities.color !== "none") {
        const banner = theme.renderBanner({
            version: release.version,
            subtitle: "Starter bot setup",
            detail: parsed.dir !== undefined ? resolve(project, parsed.dir) : project,
        })
        if (banner) output.write(`${banner}\n`)
    }

    const template = await selectStarterTemplate(parsed.template, environment)
    if (template === "cancelled") {
        printError("The init command was cancelled and wrote nothing")
        return 1
    }

    // The manager is known before any file is written, so the starter's AGENTS.md names its refresh command
    const manager = parsed.manager ?? detectPackageManager(environment.userAgent)
    const targetProject = parsed.dir !== undefined ? resolve(project, parsed.dir) : project
    if (parsed.dir !== undefined) mkdirSync(targetProject, { recursive: true })
    let result: StarterResult
    try {
        result = writeStarterProject(targetProject, packageRoot, template, manager)
    } catch (error) {
        if (!(error instanceof StarterConflictError)) throw error
        const conflictMessage = `${error.message}, so the init command wrote nothing. Run it in a new folder with --dir <folder>, or move these files away first`
        printError(conflictMessage)
        return 1
    }
    const { written, ignored } = result
    printOk(
        `Created ${theme.capabilities.color === "none" ? written.join(", ") : written.map((name) => theme.cyan(name)).join(", ")}`,
    )
    if (!written.includes("AGENTS.md")) printOk("Updated the existing AGENTS.md with the Fluxerly section")
    if (!written.includes(".env")) printOk("Kept the existing .env")
    if (!written.includes(".gitignore"))
        printOk(
            ignored.length > 0
                ? `Added ${ignored.join(" and ")} to the existing .gitignore`
                : "Kept the existing .gitignore, which already ignores node_modules and .env",
        )

    const commands = installCommands(manager, template, release)
    if (!parsed.install) {
        print(nextSteps(manager, template, theme, commands))
        return 0
    }
    print(
        theme.capabilities.color === "none"
            ? `Installing ${installed[template]} with ${manager}`
            : `${theme.cyan(theme.symbols.bullet)} Installing ${installed[template]} with ${theme.cyan(manager)}`,
    )
    const run = environment.run ?? runCommand
    for (const [command, ...commandArgs] of commands) {
        if (await run(command!, commandArgs, targetProject)) continue
        printError(
            `Installing with ${manager} failed or ${manager} could not start. The written files are kept, and the next steps include the install. Pass --pm npm|pnpm|bun to use another manager or --no-install to skip installing`,
        )
        print(nextSteps(manager, template, theme, commands))
        return 1
    }
    print(nextSteps(manager, template, theme))
    return 0
}
