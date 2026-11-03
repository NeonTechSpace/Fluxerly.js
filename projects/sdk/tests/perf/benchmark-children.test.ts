// Runs one smoke sample of each local benchmark child against the built SDK, as the benchmark parents start them, to check
// the facts they report rather than their timings
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { modes } from "../support/both-apis.js"

const sdk = fileURLToPath(new URL("../..", import.meta.url))
const guard = fileURLToPath(new URL("../../../scripts/no-fluxer-network.mjs", import.meta.url))

function child(script: string, args: readonly string[], env: Record<string, string> = {}) {
    const result = spawnSync(
        process.execPath,
        [
            "--import",
            guard,
            "--expose-gc",
            "--max-old-space-size=512",
            `tests/perf/${script}`,
            "--child",
            ...args,
            "--smoke",
        ],
        { cwd: sdk, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000, windowsHide: true },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout) as Record<string, unknown>
}

// The configured-disabled variant asserts that no record reaches its sink, which a shell's debugging variables would break
test.each(modes)("the %s logging benchmark child ignores the shell's FLUXERLY logging variables", (mode) => {
    const row = child(
        "performance-logging.js",
        [mode === "native" ? "effect" : "default", "configured-disabled", "1"],
        {
            FLUXERLY_DEBUG: "rest",
            FLUXERLY_LOG_FORMAT: "unknown-format",
            FLUXERLY_LOG_COLOR: "unknown-color",
        },
    )
    expect(row).toMatchObject({ variant: "configured-disabled" })
})

// Shutdown time and the wait until the cached message is collected are separate figures
test.each(modes)("the %s workload benchmark reports shutdown time apart from the collection wait", (mode) => {
    const row = child("performance-local.js", ["workload", mode === "native" ? "effect" : "default", "1"])
    expect(row).not.toHaveProperty("cleanupMs")
    expect(row.shutdownMs).toEqual(expect.any(Number))
    expect(row.collectionWaitMs).toEqual(expect.any(Number))
    expect(row.weakReferenceReleased).toBe(true)
})
