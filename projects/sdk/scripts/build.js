import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, globSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const sdk = fileURLToPath(new URL("../", import.meta.url))
const buildInfoPath = resolve(sdk, "node_modules/.cache/tsc/build.tsbuildinfo")

function expectedOutputs() {
    const source = globSync("src/**/*.ts", { cwd: sdk })
        .map((path) => path.replaceAll("\\", "/"))
        .toSorted()
    return new Set(
        source.flatMap((path) => {
            const stem = path.replace(/^src\//, "dist/").replace(/\.ts$/, "")
            return [".js", ".js.map", ".d.ts", ".d.ts.map"].map((extension) => stem + extension)
        }),
    )
}

function pruneEmptyDirs(directory) {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const full = join(directory, entry.name)
        pruneEmptyDirs(full)
        if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true })
    }
}

function syncIncrementalOutput(output) {
    const expected = expectedOutputs()
    if (!existsSync(output)) {
        rmSync(buildInfoPath, { force: true })
        return expected
    }
    const existing = globSync("dist/**/*", { cwd: sdk, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(sdk.length).replaceAll("\\", "/"))
    let removedStale = false
    for (const path of existing) {
        if (expected.has(path)) continue
        rmSync(resolve(sdk, path), { force: true })
        removedStale = true
    }
    if (removedStale) pruneEmptyDirs(output)
    const existingSet = new Set(existing)
    const missingAny = [...expected].some((path) => !existingSet.has(path))
    // Force a fresh emit whenever files were removed or dist is incomplete so deleted sources never survive
    if (removedStale || missingAny) rmSync(buildInfoPath, { force: true })
    return expected
}

export function build({ clean = Boolean(process.env.CI) || process.env.FLUXERLY_CLEAN_BUILD === "1" } = {}) {
    const require = createRequire(import.meta.url)
    const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc")
    const output = resolve(sdk, "dist")
    assert.equal(dirname(output), resolve(sdk))
    let expected
    const args = [compiler, "-p", "tsconfig.json"]
    if (clean) {
        // dist is generated and ignored: A clean output prevents deleted source modules from surviving a release
        rmSync(output, { recursive: true, force: true })
        rmSync(buildInfoPath, { force: true })
    } else {
        expected = syncIncrementalOutput(output)
        mkdirSync(dirname(buildInfoPath), { recursive: true })
        args.push("--incremental", "--tsBuildInfoFile", buildInfoPath)
    }
    execFileSync(process.execPath, args, {
        cwd: sdk,
        stdio: "inherit",
        timeout: 120_000,
        windowsHide: true,
    })
    if (expected) {
        for (const path of expected) assert.ok(existsSync(resolve(sdk, path)), `Incremental build is missing ${path}`)
    }
    // Every public entry point, including the testing entry points, must exist in the fresh output it maps to
    const manifest = JSON.parse(readFileSync(resolve(sdk, "package.json"), "utf8"))
    for (const [entry, conditions] of Object.entries(manifest.exports))
        for (const target of Object.values(conditions))
            assert.ok(
                existsSync(resolve(sdk, target)),
                `Package export ${entry} maps to missing ${target} after the build`,
            )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    build({
        clean: Boolean(process.env.CI) || process.env.FLUXERLY_CLEAN_BUILD === "1" || process.argv.includes("--clean"),
    })
}
