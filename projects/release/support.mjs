import { readFileSync } from "node:fs"

const releaseCommands = new Set(["check-support", "version", "prepare", "verify", "publish", "status"])

export function validateReleaseSupport(sdk) {
    const effect = sdk.peerDependencies?.effect
    if (typeof effect !== "string" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(effect) ||
        sdk.devDependencies?.effect !== effect || sdk.peerDependenciesMeta?.effect?.optional === true)
        throw new Error("Release requires a matching exact Effect development version and required npm peer")
}

export function assertReleaseSupport(action) {
    if (!releaseCommands.has(action)) return
    const sdk = JSON.parse(readFileSync(new URL("../sdk/package.json", import.meta.url), "utf8"))
    validateReleaseSupport(sdk)
}
