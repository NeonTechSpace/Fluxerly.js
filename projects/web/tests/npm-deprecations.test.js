import assert from "node:assert/strict"
import { test } from "node:test"
import { npmDeprecations } from "../scripts/versions.js"

// The version menu marks what npm deprecates, from npm's registry document. A version npm doesn't list can't be told apart from one that
// isn't deprecated, so it stops the build instead of going unmarked

test("each served version npm deprecates keeps npm's message, and the others are left out", () => {
    const packument = { versions: { "1000.0.0": { deprecated: "Upgrade to 1001.0.0 or newer" }, "1001.0.0": {}, "1001.0.0-nightly.20261104.56": { deprecated: "" } } }
    assert.deepEqual(npmDeprecations(packument, ["1000.0.0", "1001.0.0", "1001.0.0-nightly.20261104.56"]), { "1000.0.0": "Upgrade to 1001.0.0 or newer" })
})

test("a served version npm doesn't list, or a document without versions, stops the build", () => {
    assert.throws(() => npmDeprecations({ versions: { "1001.0.0": {} } }, ["1000.0.0"]), /doesn't list 1000\.0\.0/)
    assert.throws(() => npmDeprecations({ error: "Not found" }, ["1000.0.0"]), /lists no versions/)
    assert.throws(() => npmDeprecations(undefined, ["1000.0.0"]), /lists no versions/)
})
