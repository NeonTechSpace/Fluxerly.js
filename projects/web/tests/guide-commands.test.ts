// Checks the commands the guides tell readers to run. Test helpers wait without a deadline by default, so a copied
// test command must bound each test and end the process, or a bot that never settles hangs the run or a CI job
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { test } from "node:test"

const folder = new URL("../content/guides/", import.meta.url)
const guides = readdirSync(folder)
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({ file, source: readFileSync(new URL(file, folder), "utf8") }))

/** Each `node --test` command in a guide's fenced blocks and inline code */
function testCommands(source: string): string[] {
    const fences = [...source.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)].map((fence) => fence[1]!)
    const prose = source.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "")
    const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map((span) => span[1]!)
    return [...fences.flatMap((code) => code.split("\n")), ...inline].flatMap((line) => line.match(/\bnode --test\b.*/g) ?? [])
}

test("every node --test command in the guides has a test timeout and forces the exit", () => {
    const commands = guides.flatMap(({ file, source }) => testCommands(source).map((command) => ({ file, command })))
    assert.ok(commands.length > 0, "No guide shows a node --test command")
    for (const { file, command } of commands) {
        assert.match(command, /--test-timeout=\d+/, `${file}: ${command}`)
        assert.match(command, /--test-force-exit\b/, `${file}: ${command}`)
    }
})
