import assert from "node:assert/strict"
import { existsSync } from "node:fs"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const adjacentFixture = new URL("./gateway-conformance-fixture.js", import.meta.url)
const { runGatewayConformance } = await import(
    existsSync(adjacentFixture) ? adjacentFixture : new URL("../gateway-conformance-fixture.js", import.meta.url)
)
const result = await runGatewayConformance(mode)
assert.deepEqual(result, { mode, commands: 4, delivered: 1 })
console.log(`Packed ${mode} gateway conformance passed`)
