import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const sdk = fileURLToPath(new URL("../", import.meta.url))

export function build() {
    const require = createRequire(import.meta.url)
    const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc")
    const output = resolve(sdk, "dist")
    assert.equal(dirname(output), resolve(sdk))
    // dist is generated and ignored; a clean output prevents deleted source modules from surviving a release
    rmSync(output, { recursive: true, force: true })
    execFileSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
        cwd: sdk,
        stdio: "inherit",
        timeout: 120_000,
        windowsHide: true,
    })
    // Every public entry point, including the testing entry points, must exist in the fresh output it maps to
    const manifest = JSON.parse(readFileSync(resolve(sdk, "package.json"), "utf8"))
    for (const [entry, conditions] of Object.entries(manifest.exports))
        for (const target of Object.values(conditions))
            assert.ok(
                existsSync(resolve(sdk, target)),
                `Package export ${entry} maps to missing ${target} after the build`,
            )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build()
