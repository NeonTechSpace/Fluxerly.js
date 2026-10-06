import { PassThrough } from "node:stream"
import { expect, test } from "vitest"
import { selectStarterTemplate, templateQuestion } from "../../src/internal/init-command.js"

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
    await expect(selectStarterTemplate(["--template", template], terminal)).resolves.toBe(template)
    expect(terminal.printed()).toBe("")
})

test("without a terminal and without --template, init writes the JavaScript starter without asking", async () => {
    const piped = streams(false)
    await expect(selectStarterTemplate([], piped)).resolves.toBe("js")
    expect(piped.printed()).toBe("")
})

test.each([
    ["an unknown template", ["--template", "rust"]],
    ["a missing template", ["--template"]],
    ["a template without the option", ["ts"]],
    ["an extra argument", ["--template", "ts", "extra"]],
])("%s is invalid, so init writes nothing", async (_, args) => {
    const terminal = streams(true)
    await expect(selectStarterTemplate(args, terminal)).resolves.toBe("invalid")
    expect(terminal.printed()).toBe("")
})

test.each([
    ["Enter", "", "js"],
    ["1", "1", "js"],
    ["2", "2", "ts"],
    ["3", " 3 ", "effect"],
])("in a terminal, answering %s selects that starter", async (_, answer, template) => {
    const terminal = streams(true)
    const selected = selectStarterTemplate([], terminal)
    await asked(terminal.printed, 1, terminal.output)
    terminal.input.write(`${answer}\n`)
    await expect(selected).resolves.toBe(template)
    expect(terminal.printed()).toContain("3. Effect (TypeScript with the native Effect API)")
})

test("an answer outside the menu asks again", async () => {
    const terminal = streams(true)
    const selected = selectStarterTemplate([], terminal)
    await asked(terminal.printed, 1, terminal.output)
    terminal.input.write("typescript\n")
    await asked(terminal.printed, 2, terminal.output)
    terminal.input.write("2\n")
    await expect(selected).resolves.toBe("ts")
})

test("input that ends before an answer cancels init", async () => {
    const terminal = streams(true)
    const selected = selectStarterTemplate([], terminal)
    await asked(terminal.printed, 1, terminal.output)
    terminal.input.end()
    await expect(selected).resolves.toBe("cancelled")
})

test("Ctrl+C at the prompt cancels init", async () => {
    const terminal = streams(true)
    const selected = selectStarterTemplate([], terminal)
    await asked(terminal.printed, 1, terminal.output)
    terminal.input.write("\x03")
    await expect(selected).resolves.toBe("cancelled")
})
