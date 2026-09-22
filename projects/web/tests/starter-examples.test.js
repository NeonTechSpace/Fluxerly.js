import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { expandStarterExamples } from "../scripts/starter-examples.js"

test("Starter documentation embeds the exact application file without rewriting it", async () => {
    const source = await readFile(new URL("../../sdk/examples/starter/bot.js", import.meta.url), "utf8")
    const marker = "{{starter:bot.js}}"
    assert.equal(await expandStarterExamples(`${marker}\n${marker}`), `${source.trimEnd()}\n${source.trimEnd()}`)
    assert.equal(await expandStarterExamples("No example marker"), "No example marker")
})

test("Starter includes reject unknown files, traversal and incomplete markers", async () => {
    for (const marker of ["{{starter:../package.json}}", "{{starter:missing.js}}", "{{starter:bot.js}"]) {
        await assert.rejects(expandStarterExamples(marker))
    }
})
