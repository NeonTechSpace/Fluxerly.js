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
])("without raw mode, answering %s at the numbered prompt selects that starter", async (_, answer, template) => {
    const terminal = streams(true)
    const selected = selectStarterTemplate([], terminal)
    await asked(terminal.printed, 1, terminal.output)
    terminal.input.write(`${answer}\n`)
    await expect(selected).resolves.toBe(template)
    expect(terminal.printed()).toContain("3. Effect (TypeScript with the native Effect API)")
})

test("an answer outside the numbered prompt asks again", async () => {
    const terminal = streams(true)
    const selected = selectStarterTemplate([], terminal)
    await asked(terminal.printed, 1, terminal.output)
    terminal.input.write("typescript\n")
    await asked(terminal.printed, 2, terminal.output)
    terminal.input.write("2\n")
    await expect(selected).resolves.toBe("ts")
})

test("input that ends before an answer at the numbered prompt cancels init", async () => {
    const terminal = streams(true)
    const selected = selectStarterTemplate([], terminal)
    await asked(terminal.printed, 1, terminal.output)
    terminal.input.end()
    await expect(selected).resolves.toBe("cancelled")
})

test("Ctrl+C at the numbered prompt cancels init", async () => {
    const terminal = streams(true)
    const selected = selectStarterTemplate([], terminal)
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
    const selected = selectStarterTemplate([], terminal)
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
    const selected = selectStarterTemplate([], terminal)
    terminal.input.write(`\x1b[B${key}`)
    await expect(selected).resolves.toBe("cancelled")
    expect(terminal.rawModes).toEqual([true, false])
    expect(terminal.input.isPaused()).toBe(true)
    expect(terminal.printed().endsWith(showCursor)).toBe(true)
})

test("input that ends in the menu cancels init and restores the terminal", async () => {
    const terminal = menuTerminal()
    const selected = selectStarterTemplate([], terminal)
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
    const selected = selectStarterTemplate([], terminal)
    terminal.input.write("\x1b[B")
    await expect(selected).rejects.toThrow("The terminal went away")
    expect(terminal.rawModes).toEqual([true, false])
    expect(terminal.printed().endsWith(showCursor)).toBe(true)
})

test("the menu highlights in color only when the terminal supports color", async () => {
    const colored = menuTerminal({ colors: true })
    const coloredPick = selectStarterTemplate([], colored)
    colored.input.write("\r")
    await coloredPick
    expect(colored.printed()).toContain("\x1b[36m> JavaScript\x1b[39m")

    const plain = menuTerminal()
    const plainPick = selectStarterTemplate([], plain)
    plain.input.write("\r")
    await plainPick
    expect(plain.printed()).toContain("> JavaScript")
    expect(plain.printed()).not.toContain("\x1b[36m")
})
