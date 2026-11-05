// Tests that every SDK name the glossary writes as code still exists in the generated reference, and every log or error
// code in the code catalogue, so renaming one in the SDK fails here instead of leaving a stale definition
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const glossary = read("content/guides/glossary.md")
const model = JSON.parse(read("content/reference/model.json"))
const catalogue = JSON.parse(read("content/reference/codes.json")) as { logs: { code: string }[]; errors: { code: string }[] }

// Every name the reference model holds, at any depth: Declarations, members, options, parameters and event names
function namesIn(node: unknown, names = new Set<string>()) {
    if (Array.isArray(node)) for (const item of node) namesIn(item, names)
    else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            if (key === "name" && typeof value === "string") names.add(value)
            namesIn(value, names)
        }
    }
    return names
}
const names = namesIn(model)
const codes = new Set([...catalogue.logs, ...catalogue.errors].map((entry) => entry.code))

// Code as code names something: A dotted path, optionally called or given a value, such as client.on, guildOnly(),
// requirePermissions(names) or sharding: "auto". Numbers, command text, paths, quoted values and package names are not
// names. Neither are environment variables in capitals, such as FLUXER_BOT_TOKEN
const named = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\([\w, ]*\))?(?::\s*.+)?$/
const environment = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

// Code that is not an SDK name: The web platform's AbortSignal, Effect's Exit, the isErr method of neverthrow's Result,
// and Ms, the ending of duration option names
const outside = new Set(["AbortSignal", "exit.cause", "isErr()", "Ms"])

// The SDK names and codes a glossary writes that the reference does not have. Each part of a dotted name must be a name
// the reference holds somewhere, so a renamed function, option or member is found, while a member moved to another
// object whose name the reference also holds is not
function missingNames(markdown: string) {
    const spans = [...new Set([...markdown.matchAll(/`([^`]+)`/g)].map((match) => match[1]!))]
    const checked = spans.filter((span) => named.test(span) && !environment.test(span) && !outside.has(span))
    const missing = checked.filter((span) => !codes.has(span) && !named.exec(span)![1]!.split(".").every((part) => names.has(part)))
    return { checked, missing }
}

test("every SDK name and code the glossary writes still exists in the reference", () => {
    const { checked, missing } = missingNames(glossary)
    // The glossary names many, so a short list would mean the pattern broke
    assert.ok(checked.length > 30, `Only ${checked.length} names were checked: ${checked.join(", ")}`)
    assert.deepEqual(missing, [], `The glossary names what the reference no longer has: ${missing.join(", ")}`)
})

test("a name the SDK renamed is reported", () => {
    const glossaryText = "### Test client\n\nCreate one with `createFakeClient` or `createTestClient`, and read `lifecycle.connectionGone` or `lifecycle.connectionLost`"
    assert.deepEqual(missingNames(glossaryText).missing.sort(), ["createFakeClient", "lifecycle.connectionGone"])
})
