import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

// Catches: A misspelled group in --only ran nothing and still reported a clean sweep with exit 0
test("the screen check rejects an unknown --only group before it starts a server or browser", () => {
    const script = fileURLToPath(new URL("../scripts/checks/sweep.mjs", import.meta.url))
    const result = spawnSync(process.execPath, [script, "--only=menu"], { encoding: "utf8", timeout: 60_000 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Unknown screen check "menu"/)
    assert.doesNotMatch(result.stdout, /starting at/)
})
