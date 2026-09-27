/**
 * The Node.js version check each public entry point runs when it loads.
 * Invariant: Each entry point imports this module first, so an older Node.js stops with this error before other SDK code
 * runs. A runtime that reports no Node.js version is not checked
 */

/** Oldest supported Node.js release, matching the package's engines field */
const minimum = { major: 24, minor: 11 } as const

/** Throw when the reported Node.js version is older than the supported minimum */
export function checkNodeVersion(versions: { readonly node?: string | undefined } | undefined): void {
    const found = versions?.node
    if (typeof found !== "string") return
    const [major = Number.NaN, minor = Number.NaN] = found.split(".").map(Number)
    if (!Number.isInteger(major) || !Number.isInteger(minor)) return
    if (major > minimum.major || (major === minimum.major && minor >= minimum.minor)) return
    throw new Error(
        `Fluxerly needs Node.js ${minimum.major}.${minimum.minor} or newer, but this is Node.js ${found}. Install a current Node.js release from https://nodejs.org, then run the bot again`,
    )
}

checkNodeVersion(globalThis.process?.versions)
