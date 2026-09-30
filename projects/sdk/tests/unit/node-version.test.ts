import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { checkNodeVersion } from "../../src/internal/node-version.js"
// Load the graphs before timed cases. Each case still resets evaluation before reporting its own runtime version
import "../../src/index.js"
import "../../src/effect.js"
import "../../src/testing.js"
import "../../src/effect-testing.js"

const original = Object.getOwnPropertyDescriptor(process, "versions")!

beforeEach(() => {
    vi.resetModules()
})

afterEach(() => {
    Object.defineProperty(process, "versions", original)
})

/** Report a different Node.js version for the rest of the test */
function reportNode(node: string) {
    Object.defineProperty(process, "versions", { ...original, value: { ...process.versions, node } })
}

test.each(["22.12.0", "24.14.0", "20.0.0"])("Node.js %s is rejected with the minimum and the found version", (node) => {
    expect(() => checkNodeVersion({ node })).toThrow(
        `Fluxerly needs Node.js 24.15 or newer, but this is Node.js ${node}`,
    )
})

test.each(["24.15.0", "24.16.1", "25.0.0"])("Node.js %s is accepted", (node) => {
    expect(() => checkNodeVersion({ node })).not.toThrow()
})

test("a runtime without a Node.js version is not checked", () => {
    expect(() => checkNodeVersion(undefined)).not.toThrow()
    expect(() => checkNodeVersion({})).not.toThrow()
})

test.each(["../../src/index.js", "../../src/effect.js", "../../src/testing.js", "../../src/effect-testing.js"])(
    "loading %s on an older Node.js fails with the version message",
    async (entry) => {
        reportNode("22.12.0")
        await expect(import(entry)).rejects.toThrow("Fluxerly needs Node.js 24.15 or newer")
    },
)
