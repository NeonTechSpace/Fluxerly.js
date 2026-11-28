import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { goMaxProcsFor, parallelLanes, runBounded } from "../../scripts/concurrency.mjs"

const sdk = fileURLToPath(new URL("../", import.meta.url))
const require = createRequire(import.meta.url)
const effectPackage = require("@effect/tsgo/package.json")
const binEntry = typeof effectPackage.bin === "string" ? effectPackage.bin : effectPackage.bin["effect-tsgo"]
const effectTsgo = join(dirname(require.resolve("@effect/tsgo/package.json")), binEntry)

const projects = ["tsconfig.test.json", "tsconfig.examples.json"]
const lanes = parallelLanes({ envVar: "FLUXERLY_EFFECT_LINT_CONCURRENCY", perLaneCores: 4, max: projects.length })
const env =
    lanes > 1 && !process.env.GOMAXPROCS ? { ...process.env, GOMAXPROCS: String(goMaxProcsFor(lanes)) } : process.env

function runProject(project) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                effectTsgo,
                "diagnostics",
                "--project",
                project,
                "--strict",
                "--severity",
                "error,warning",
                "--format",
                "text",
            ],
            { cwd: sdk, env, windowsHide: true },
        )
        const output = []
        child.stdout.on("data", (chunk) => output.push(chunk))
        child.stderr.on("data", (chunk) => output.push(chunk))
        child.on("error", reject)
        child.on("close", (code) => resolve({ project, code: code ?? 1, output: Buffer.concat(output).toString() }))
    })
}

const results = await runBounded(projects, lanes, runProject)
let failed = false
for (const result of results) {
    if (result.output.trim()) process.stdout.write(result.output)
    if (result.code !== 0) failed = true
}
if (failed) process.exitCode = 1
