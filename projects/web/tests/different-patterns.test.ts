// The agent guide shipped in the SDK package lists the patterns that do not exist in Fluxerly, and the docs page explains the
// same patterns to people. Each code name the agent guide uses there must appear on the page, so the two lists cannot drift
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const compact = (text: string) => text.replace(/\s+/g, "")

test("the patterns page covers every code name in the agent guide's patterns section", () => {
    const guide = read("../../sdk/agents/AGENTS.md")
    const section = /^## Patterns that do not exist in Fluxerly\n([\s\S]*?)(?=^## )/m.exec(guide)?.[1]
    assert.ok(section, "The agent guide has no patterns section")
    const names = [...section.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!)
    assert.ok(names.length > 0, "The agent guide's patterns section names no code")
    const page = compact(read("../content/guides/different-patterns.md"))
    assert.deepEqual(names.filter((name) => !page.includes(compact(name))), [])
})
