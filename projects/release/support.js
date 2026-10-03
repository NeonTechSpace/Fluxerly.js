// @ts-check

import { readFileSync } from "node:fs"

const releaseCommands = new Set(["check-support", "version", "prepare", "verify", "publish", "status"])

// The Effect peer accepts later releases of one stable major. Its lowest version is the one the SDK is tested against,
// so the development dependency must be exactly that version
export function validateReleaseSupport(sdk) {
    const effect = sdk.peerDependencies?.effect
    const lowest = typeof effect === "string" ? /^\^(\d+\.\d+\.\d+)$/.exec(effect)?.[1] : undefined
    if (!lowest || sdk.devDependencies?.effect !== lowest || sdk.peerDependenciesMeta?.effect?.optional === true)
        throw new Error("Release requires a required Effect peer range whose lowest version is the exact Effect development version")
}

export function assertReleaseSupport(action) {
    if (!releaseCommands.has(action)) return
    const sdk = JSON.parse(readFileSync(new URL("../sdk/package.json", import.meta.url), "utf8"))
    validateReleaseSupport(sdk)
}
