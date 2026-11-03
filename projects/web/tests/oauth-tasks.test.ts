// Checks the OAuth guide's task table against the reference model: every method of the OAuth client and of the oauth
// namespace has a row that links its reference entry, so a new method cannot be left out of the table
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import type { Declaration, Entry } from "../src/lib/reference.ts"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const model = JSON.parse(read("content/reference/model.json")) as { entries: Entry[] }
const guide = read("content/guides/webhooks-and-oauth.md")

/** The rows of the table under the guide's "Pick an OAuth method" heading */
function taskRows(): string[] {
    const section = /^## Pick an OAuth method\n([\s\S]*?)^## /m.exec(guide)?.[1]
    assert.ok(section, "The guide has no Pick an OAuth method section before the next heading")
    return section.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| ---")).slice(1)
}

test("the OAuth task table links every OAuth method's reference entry", () => {
    const entry = model.entries.find((candidate) => candidate.key === "js-ts")!
    const declarations = entry.categories.flatMap((category) => category.items) as Declaration[]
    const members = ["oauth", "OAuthClient"].flatMap((name) => {
        const declaration = declarations.find((item) => item.name === name)
        assert.ok(declaration?.members?.length, `The reference has no members for ${name}`)
        // await using is how the table names disposal, beside shutdown
        return declaration.members.filter((member) => !member.name.startsWith("["))
    })
    const table = taskRows().join("\n")
    for (const member of members) assert.ok(table.includes(`(/docs/api/js-ts/oauth/#${member.anchor})`), `No row links ${member.name}`)
    // Every reference link in the table names an anchor the reference has
    const anchors = new Set(members.map((member) => member.anchor))
    for (const [, anchor] of table.matchAll(/\(\/docs\/api\/js-ts\/oauth\/#([\w-]+)\)/g)) assert.ok(anchors.has(anchor), `Unknown anchor ${anchor}`)
})
