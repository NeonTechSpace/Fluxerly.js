import assert from "node:assert/strict"

globalThis.fetch = () => {
    throw new Error("Creation must not make HTTP requests")
}
globalThis.WebSocket = class {
    constructor() {
        throw new Error("Creation must not open a WebSocket")
    }
}

const { createClient, ConfigurationError } = await import("@neontechspace/fluxerly")
const result = createClient({ token: "fixture-only-not-a-credential" })
assert.equal(result.isOk(), true)
assert.equal(result.value.state, "Disconnected")
assert.equal(Reflect.set(result.value, "state", "Connected"), false)

const invalid = createClient({ token: "" })
assert.equal(invalid.isErr(), true)
assert.ok(invalid.error instanceof ConfigurationError)
assert.equal(invalid.error._tag, "ConfigurationError")
assert.equal((await result.value.shutdown()).isOk(), true)
assert.equal(result.value.state, "Closed")
assert.equal((await result.value.waitForClose()).isOk(), true)
assert.equal((await result.value.connect()).error._tag, "ClientClosedError")

for (const path of ["dist/internal/client.js", "src/internal/configuration.ts"]) {
    await assert.rejects(import(`@neontechspace/fluxerly/${path}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
}
console.log("Default JavaScript packed consumer passed")
