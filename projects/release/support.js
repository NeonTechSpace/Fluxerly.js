// @ts-check

import { readFileSync } from "node:fs"
import { compareVersions, parseVersion } from "./planning.js"

const releaseCommands = new Set(["check-support", "version", "prepare", "verify", "publish", "status"])

// Development can use a newer stable Effect release without raising the consumer minimum
export function validateReleaseSupport(sdk) {
    const effect = sdk.peerDependencies?.effect
    const lowest = typeof effect === "string" ? /^\^(\d+\.\d+\.\d+)$/.exec(effect)?.[1] : undefined
    const tested = sdk.devDependencies?.effect
    if (
        !lowest ||
        typeof tested !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(tested) ||
        parseVersion(tested).major !== parseVersion(lowest).major ||
        compareVersions(tested, lowest) < 0 ||
        sdk.peerDependenciesMeta?.effect?.optional === true
    )
        throw new Error("Release requires a required stable Effect peer range and an exact Effect development version within it")
}

export function assertReleaseSupport(action) {
    if (!releaseCommands.has(action)) return
    const sdk = JSON.parse(readFileSync(new URL("../sdk/package.json", import.meta.url), "utf8"))
    validateReleaseSupport(sdk)
}
