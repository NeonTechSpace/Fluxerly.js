import assert from "node:assert/strict"
import test from "node:test"
import { readableType } from "../scripts/reference-theme.js"

test("Long generic types break at outer arguments without changing linked or nested types", () => {
    const args = [
        "[`Client`](/api/Client/)\\<`SelectedMessage`\\<`F`\\>\\>",
        "[`ConfigurationError`](/api/ConfigurationError/)",
        "`Scope` \\| `R`",
    ].map((text) => ({ text }))
    const type = { type: "reference", typeArguments: args, toString: () => "Effect<Client<SelectedMessage<F>>, ConfigurationError, Scope | R>" }
    type.text = `\`Effect\`\\<${args.map((arg) => arg.text).join(", ")}\\>`
    const formatted = readableType(type, (value) => value.text)
    assert.equal(formatted, `\`Effect\`\\<<br />&#160;&#160;${args.map((arg) => arg.text).join(",<br />&#160;&#160;")}<br />\\>`)
    assert.equal(formatted.replaceAll("<br />", "").replaceAll("&#160;", "").replaceAll(" ", ""), type.text.replaceAll(" ", ""))
})

test("Short, non-reference and differently rendered types are preserved", () => {
    for (const type of [
        { type: "reference", typeArguments: [{ text: "`void`" }], toString: () => "Effect<void>", text: "`Effect`\\<`void`\\>" },
        { type: "union", toString: () => "x".repeat(100), text: "`A` \\| `B`" },
        { type: "reference", typeArguments: [{ text: "`A`" }], toString: () => "x".repeat(100), text: "custom rendering" },
    ]) assert.equal(readableType(type, (value) => value.text), type.text)
})
