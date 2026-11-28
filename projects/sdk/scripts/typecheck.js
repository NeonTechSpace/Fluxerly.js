import { spawn } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { goMaxProcsFor, parallelLanes, runBounded } from "../../scripts/concurrency.mjs"

const sdk = fileURLToPath(new URL("../", import.meta.url))
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc")
const cacheDir = join(sdk, "node_modules/.cache/tsc")
const clean = process.env.FLUXERLY_CLEAN_BUILD === "1" || process.argv.includes("--clean")

const projects = [
    { name: "tsconfig.test.json", buildInfo: join(cacheDir, "test.tsbuildinfo") },
    { name: "tests/types/tsconfig.starter.json", buildInfo: join(cacheDir, "starter.tsbuildinfo") },
]

if (clean) for (const { buildInfo } of projects) rmSync(buildInfo, { force: true })
mkdirSync(cacheDir, { recursive: true })

const lanes = parallelLanes({ envVar: "FLUXERLY_TYPECHECK_CONCURRENCY", perLaneCores: 4, max: projects.length })
const env =
    lanes > 1 && !process.env.GOMAXPROCS ? { ...process.env, GOMAXPROCS: String(goMaxProcsFor(lanes)) } : process.env

function runProject({ name, buildInfo }) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [compiler, "-p", name, "--incremental", "--tsBuildInfoFile", buildInfo], {
            cwd: sdk,
            env,
            windowsHide: true,
        })
        const output = []
        child.stdout.on("data", (chunk) => output.push(chunk))
        child.stderr.on("data", (chunk) => output.push(chunk))
        child.on("error", reject)
        child.on("close", (code) => resolve({ name, code: code ?? 1, output: Buffer.concat(output).toString() }))
    })
}

const results = await runBounded(projects, lanes, runProject)
let failed = false
for (const result of results) {
    if (result.output.trim()) process.stdout.write(result.output)
    if (result.code !== 0) failed = true
}
if (failed) process.exitCode = 1
