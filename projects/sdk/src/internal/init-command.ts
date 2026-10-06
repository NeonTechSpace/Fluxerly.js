/**
 * Chooses the starter that `fluxerly init` writes: The one its --template option names, the answer to a prompt when
 * both standard streams are terminals, or JavaScript otherwise, so scripts and CI never wait for input
 */

import { createInterface } from "node:readline/promises"
import { starterTemplates, type StarterTemplate } from "./starter-project.js"

/** The streams init talks through, whose isTTY flags decide whether it asks */
interface InitStreams {
    readonly input: NodeJS.ReadableStream & { readonly isTTY?: boolean }
    readonly output: NodeJS.WritableStream & { readonly isTTY?: boolean }
}

const templateMenu = [
    "Which starter should fluxerly init write?",
    "  1. JavaScript",
    "  2. TypeScript",
    "  3. Effect (TypeScript with the native Effect API)",
].join("\n")
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
 * "cancelled" when the prompt ends without an answer, such as after Ctrl+C
 */
export async function selectStarterTemplate(
    args: readonly string[],
    { input, output }: InitStreams,
): Promise<StarterTemplate | "invalid" | "cancelled"> {
    if (args.length > 0)
        return args.length === 2 && args[0] === "--template" && isTemplate(args[1]) ? args[1] : "invalid"
    if (!input.isTTY || !output.isTTY) return "js"

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
