// @ts-check
// Runs workspace or SDK lint checks in bounded parallel lanes scaled from availableParallelism()
// Usage: node scripts/lint.mjs [sdk]
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cpuBudget, goMaxProcsFor, parallelLanes } from "./concurrency.mjs"

const workspace = fileURLToPath(new URL("../", import.meta.url))

/** @typedef {{ name: string, folder: string, script: string, heavy?: boolean }} LintStep */

/** @type {LintStep[]} */
const sdkSteps = [
    { name: "sdk lint effect", folder: "sdk", script: "lint:effect", heavy: true },
    { name: "sdk lint code", folder: "sdk", script: "lint:code", heavy: true },
    { name: "sdk lint spelling", folder: "sdk", script: "lint:spelling" },
    { name: "sdk lint test-invariants", folder: "sdk", script: "lint:test-invariants" },
    { name: "sdk lint unused", folder: "sdk", script: "lint:unused" },
    { name: "sdk lint mapping", folder: "sdk", script: "lint:mapping" },
    { name: "sdk lint discards", folder: "sdk", script: "lint:discards" },
    { name: "sdk lint dashes", folder: "sdk", script: "lint:dashes" },
]

/** @type {LintStep[]} */
const allSteps = [
    ...sdkSteps,
    { name: "web lint", folder: "web", script: "lint", heavy: true },
    { name: "release lint", folder: "release", script: "lint" },
    { name: "scripts lint", folder: ".", script: "lint:scripts" },
    { name: "docs links", folder: ".", script: "lint:docs-links" },
]

/**
 * Runs one pnpm script and captures its combined output
 * @param {LintStep} step
 * @param {NodeJS.ProcessEnv} extraEnv
 * @returns {Promise<{ code: number, output: string, ms: number }>}
 */
function runStep(step, extraEnv) {
    const pnpm = process.env.npm_execpath
    const [command, args] = pnpm?.endsWith(".js") || pnpm?.endsWith(".cjs") ? [process.execPath, [pnpm]] : ["pnpm", []]
    const started = Date.now()
    return new Promise((done) => {
        const child = spawn(command, [...args, "run", step.script], {
            cwd: resolve(workspace, step.folder),
            env: {
                ...process.env,
                ...extraEnv,
                FORCE_COLOR: process.env.FORCE_COLOR ?? (process.stdout.isTTY ? "1" : "0"),
            },
            shell: command === "pnpm" && process.platform === "win32",
            windowsHide: true,
        })
        /** @type {Buffer[]} */
        const output = []
        child.stdout.on("data", (chunk) => output.push(chunk))
        child.stderr.on("data", (chunk) => output.push(chunk))
        child.on("error", (error) => done({ code: 1, output: `${error.message}\n`, ms: Date.now() - started }))
        child.on("close", (code) => done({ code: code ?? 1, output: Buffer.concat(output).toString(), ms: Date.now() - started }))
    })
}

const mode = process.argv[2]
if (mode !== undefined && mode !== "sdk") throw new Error(`Unknown lint scope ${mode}. Use no arguments or "sdk"`)
const selected = mode === "sdk" ? sdkSteps : allSteps

// Low-core hosts stay at 1 lane, while multi-core hosts overlap independent lints within the CPU budget
const budget = cpuBudget({ envVar: "FLUXERLY_LINT_CONCURRENCY" })
const totalLanes = parallelLanes({ envVar: "FLUXERLY_LINT_CONCURRENCY", perLaneCores: 2, max: 6 })
const heavyWeight = totalLanes <= 1 ? 1 : Math.min(totalLanes, 2)
let free = totalLanes
/** @type {{ need: number, go: () => void }[]} */
const queue = []
const pump = () => {
    while (queue.length > 0) {
        const index = queue.findIndex((item) => item.need <= free)
        if (index === -1) break
        const [next] = queue.splice(index, 1)
        free -= next.need
        next.go()
    }
}
/** @param {number} need */
const acquire = (need) => new Promise((go) => (queue.push({ need, go: () => go(undefined) }), pump()))
/** @param {number} need */
const release = (need) => ((free += need), pump())

const heavyLanes = Math.max(1, Math.floor(totalLanes / heavyWeight))
const extraEnv =
    totalLanes > 1 && !process.env.GOMAXPROCS
        ? { GOMAXPROCS: String(Math.max(2, Math.min(budget, goMaxProcsFor(heavyLanes)))) }
        : {}

const started = Date.now()
/** @type {{ name: string, output: string }[]} */
const failed = []
await Promise.all(
    selected.map(async (step) => {
        const need = step.heavy ? heavyWeight : 1
        await acquire(need)
        const result = await runStep(step, step.heavy ? extraEnv : {}).finally(() => release(need))
        console.log(`${result.code === 0 ? "passed" : "FAILED"}  ${step.name}  ${Math.round(result.ms / 1000)}s`)
        if (result.code !== 0) failed.push({ name: step.name, output: result.output })
    }),
)
for (const { name, output } of failed) console.log(`\n--- ${name} ---\n${output.trimEnd()}`)
console.log(`\n${selected.length - failed.length} of ${selected.length} lint checks passed in ${Math.round((Date.now() - started) / 1000)}s`)
process.exitCode = failed.length === 0 ? 0 : 1
