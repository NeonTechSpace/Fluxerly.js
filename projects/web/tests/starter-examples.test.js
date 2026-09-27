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
    for (const [marker, reason] of [
        ["{{starter:../package.json}}", /Unknown starter example/],
        ["{{starter:missing.js}}", /Unknown starter example/],
        ["{{starter:lifetime.js}}", /Unknown starter example/],
        ["{{starter:lifetime-effect.ts}}", /Unknown starter example/],
        ["{{starter:bot.js}", /Incomplete starter example marker/],
    ]) await assert.rejects(expandStarterExamples(marker), reason, marker)
})

test("Example includes embed a named example file and reject unsafe paths", async () => {
    const source = await readFile(new URL("../../sdk/examples/small-bot/bot.ts", import.meta.url), "utf8")
    assert.equal(await expandStarterExamples("{{example:small-bot/bot.ts}}"), source.trimEnd())
    for (const [marker, reason] of [
        ["{{example:../package.json}}", /Unknown example file/],
        ["{{example:small-bot/../../package.json}}", /Unknown example file/],
        ["{{example:starter/bot.js}}", /Unknown example file/],
        ["{{example:small-bot/missing.ts}}", { code: "ENOENT" }],
        ["{{example:small-bot/bot.ts}", /Incomplete example marker/],
    ]) await assert.rejects(expandStarterExamples(marker), reason, marker)
})
