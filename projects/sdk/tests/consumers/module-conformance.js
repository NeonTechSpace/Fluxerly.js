import assert from "node:assert/strict"
import { existsSync } from "node:fs"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const adjacentRegistry = new URL("./module-conformance-registry.js", import.meta.url)
const { validateModuleConformance } = await import(
    existsSync(adjacentRegistry) ? adjacentRegistry : new URL("../module-conformance-registry.js", import.meta.url)
)
const moduleObject = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
const result = validateModuleConformance(mode, moduleObject)
assert.ok(result.names.length > 0)
console.log(`Packed ${mode} runtime module conformance passed with ${result.names.length} exact value exports`)
