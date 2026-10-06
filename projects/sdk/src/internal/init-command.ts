/**
 * Chooses the starter that `fluxerly init` writes: The one its --template option names, a choice from a prompt when
 * both standard streams are terminals, or JavaScript otherwise, so scripts and CI never wait for input.
 * The prompt is an arrow-key menu when the input terminal supports raw mode, and a numbered question otherwise
 */

import { emitKeypressEvents, type Key } from "node:readline"
import { createInterface } from "node:readline/promises"
import { starterTemplates, type StarterTemplate } from "./starter-project.js"

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

/**
 * Select the starter for the arguments after `init`. Returns "invalid" for arguments init does not accept, and
 * "cancelled" when the prompt ends without an answer, such as after Ctrl+C or Escape
 */
export async function selectStarterTemplate(
    args: readonly string[],
    { input, output }: InitStreams,
): Promise<StarterTemplate | "invalid" | "cancelled"> {
    if (args.length > 0)
        return args.length === 2 && args[0] === "--template" && isTemplate(args[1]) ? args[1] : "invalid"
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
