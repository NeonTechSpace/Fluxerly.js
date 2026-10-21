import assert from "node:assert/strict"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const { validateModuleConformance } = await import("./module-conformance-registry.js")
const moduleObject = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
const result = validateModuleConformance(mode, moduleObject)
assert.ok(result.names.length > 0)
console.log(`Packed ${mode} runtime module conformance passed with ${result.names.length} exact value exports`)
