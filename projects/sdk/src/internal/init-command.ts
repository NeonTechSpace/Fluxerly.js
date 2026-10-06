/**
 * Runs `fluxerly init`: It chooses the starter, writes it, installs its dependencies with the package manager that
 * launched init, and prints the next steps.
 * The starter is the one the --template option names, a choice from a prompt when both standard streams are terminals,
 * or JavaScript otherwise, so scripts and CI never wait for input. The prompt is an arrow-key menu when the input
 * terminal supports raw mode, and a numbered question otherwise
 */

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { emitKeypressEvents, type Key } from "node:readline"
import { createInterface } from "node:readline/promises"
import { StarterConflictError, starterTemplates, writeStarterProject, type StarterTemplate } from "./starter-project.js"

/** The streams init talks through. Their isTTY flags decide whether it asks, and raw mode decides how */
interface InitStreams {
    readonly input: NodeJS.ReadableStream & {
        readonly isTTY?: boolean
        readonly isRaw?: boolean
        setRawMode?(mode: boolean): unknown
    }
    // A terminal's hasColors respects NO_COLOR and FORCE_COLOR
    readonly output: NodeJS.WritableStream & { readonly isTTY?: boolean; hasColors?(): boolean }
}
type MenuInput = InitStreams["input"] & { setRawMode(mode: boolean): unknown }

const question = "Which starter should fluxerly init write?"
const choices: readonly { readonly template: StarterTemplate; readonly label: string }[] = [
    { template: "js", label: "JavaScript" },
    { template: "ts", label: "TypeScript" },
    { template: "effect", label: "Effect (TypeScript with the native Effect API)" },
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

/** What the arguments after `init` ask for, or "invalid" for arguments init does not accept */
export function parseInitArguments(
    args: readonly string[],
): { readonly template: StarterTemplate | undefined; readonly install: boolean } | "invalid" {
    let template: StarterTemplate | undefined
    let install = true
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        const next = args[index + 1]
        if (arg === "--no-install" && install) install = false
        else if (arg === "--template" && template === undefined && isTemplate(next)) {
            template = next
            index++
        } else return "invalid"
    }
    return { template, install }
}

/**
 * Select the starter: The named template, or a choice from the prompt. Returns "cancelled" when the prompt ends
 * without an answer, such as after Ctrl+C or Escape
 */
export async function selectStarterTemplate(
    template: StarterTemplate | undefined,
    { input, output }: InitStreams,
): Promise<StarterTemplate | "cancelled"> {
    if (template !== undefined) return template
    if (!input.isTTY || !output.isTTY) return "js"
    if (typeof input.setRawMode === "function") return pickFromMenu(input as MenuInput, output)

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
 * with the choice. Raw mode and the cursor are restored however the menu ends
 */
async function pickFromMenu(input: MenuInput, output: InitStreams["output"]): Promise<StarterTemplate | "cancelled"> {
    const color = output.hasColors?.() === true
    const highlight = (text: string) => (color ? `\x1b[36m${text}\x1b[39m` : text)
    let selected = 0
    // Each line clears what an earlier draw left on it
    const draw = () =>
        choices
            .map(({ label }, index) => `\x1b[2K${index === selected ? highlight(`> ${label}`) : `  ${label}`}\n`)
            .join("")

    const wasRaw = input.isRaw === true
    let onKeypress: ((text: string | undefined, key: Key | undefined) => void) | undefined
    let onEnd: (() => void) | undefined
    emitKeypressEvents(input)
    input.setRawMode(true)
    try {
        output.write(`\x1b[?25l${question}\n${draw()}`)
        const picked = await new Promise<number | null>((resolve, reject) => {
            onEnd = () => resolve(null)
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
                    output.write(`\x1b[${choices.length}A${draw()}`)
                } catch (error) {
                    reject(error)
                }
            }
            input.on("keypress", onKeypress)
            input.once("end", onEnd)
        })
        const answer = picked === null ? "" : ` ${highlight(choices[picked]!.label)}`
        output.write(`\x1b[${choices.length + 1}A\x1b[0J${question}${answer}\n`)
        return picked === null ? "cancelled" : choices[picked]!.template
    } finally {
        if (onKeypress) input.off("keypress", onKeypress)
        if (onEnd) input.off("end", onEnd)
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

const managers = {
    npm: { add: "install", exact: "--save-exact", dev: "--save-dev", run: "npm" },
    pnpm: { add: "add", exact: "--save-exact", dev: "--save-dev", run: "pnpm" },
    // bun test is Bun's own test runner, so the package's scripts run through bun run
    bun: { add: "add", exact: "--exact", dev: "--dev", run: "bun run" },
}
const installed = {
    js: "the SDK",
    ts: "the SDK and the Node.js types",
    effect: "the SDK, Effect and the Node.js types",
}

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
    // The editor and TypeScript read the SDK's types, which use the Node.js types
    const nodeTypes = [manager, add, dev, "@types/node"]
    if (template === "js") return [sdk]
    return template === "ts" ? [sdk, nodeTypes] : [sdk, effect, nodeTypes]
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
    readonly errorOutput: NodeJS.WritableStream
    /** The folder the starter is written into */
    readonly project: string
    /** The installed SDK package, whose package.json names the version to install */
    readonly packageRoot: string
    readonly userAgent: string | undefined
    readonly run?: CommandRunner
}

function nextSteps(manager: PackageManager, template: StarterTemplate, install?: readonly (readonly string[])[]) {
    const { run } = managers[manager]
    const steps = [
        ...(install
            ? [[`Install ${installed[template]}:`, ...install.map((args) => `   ${args.join(" ")}`)].join("\n")]
            : []),
        "Set FLUXER_BOT_TOKEN in .env to the bot's token",
        `Check the bot without a token: ${run} test`,
        `Start the bot: ${run} start`,
    ]
    return ["", "Next steps:", ...steps.map((step, index) => `${index + 1}. ${step}`)].join("\n")
}

/**
 * Run `fluxerly init` with the arguments after `init` and resolve its exit code, or "usage" for arguments it does not
 * accept. A failed install keeps the written files and prints the install commands instead
 */
export async function runInit(args: readonly string[], environment: InitEnvironment): Promise<0 | 1 | "usage"> {
    const { output, errorOutput, project, packageRoot } = environment
    const print = (text: string) => output.write(`${text}\n`)
    const parsed = parseInitArguments(args)
    if (parsed === "invalid") return "usage"
    const template = await selectStarterTemplate(parsed.template, environment)
    if (template === "cancelled") {
        errorOutput.write("fluxerly init was cancelled and wrote nothing\n")
        return 1
    }

    let written: readonly string[]
    try {
        written = writeStarterProject(project, packageRoot, template)
    } catch (error) {
        if (!(error instanceof StarterConflictError)) throw error
        errorOutput.write(
            `${error.message}, so fluxerly init wrote nothing. Run it in an empty folder, or move these files away first\n`,
        )
        return 1
    }
    print(`Created ${written.join(", ")}`)
    if (!written.includes(".env")) print("Kept the existing .env")

    const manager = detectPackageManager(environment.userAgent)
    const release = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as SdkRelease
    const commands = installCommands(manager, template, release)
    if (!parsed.install) {
        print(nextSteps(manager, template, commands))
        return 0
    }
    print(`Installing ${installed[template]} with ${manager}`)
    const run = environment.run ?? runCommand
    for (const [command, ...commandArgs] of commands) {
        if (await run(command!, commandArgs, project)) continue
        errorOutput.write(
            `Installing with ${manager} failed or ${manager} could not start. The written files are kept, and the next steps include the install\n`,
        )
        print(nextSteps(manager, template, commands))
        return 1
    }
    print(nextSteps(manager, template))
    return 0
}
