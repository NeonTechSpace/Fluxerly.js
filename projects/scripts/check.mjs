// @ts-check
// Runs the workspace checks side by side: node scripts/check.mjs [--changed] [sdk|web|release|contributions ...]
// Each step starts as soon as the steps it reads from have passed, so independent checks share the machine instead of
// waiting in line. Without a name it runs every group except public, which checks the deployed site instead of the local
// one. A named group skips steps of other groups, so the web and public groups expect a built SDK, as their package
// checks always have. With --changed, only the fast affected checks for uncommitted and branch changes run. With
// CHECK_RESULTS_FILE set, the run also writes each check's result, time and first error line as JSON for the job summary
// action
import { execFileSync, spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cpuBudget } from "./concurrency.mjs"

const workspace = fileURLToPath(new URL("../", import.meta.url))
const repoRoot = fileURLToPath(new URL("../../", import.meta.url))

/** @typedef {{ name: string, group: string, folder: string, script: string, after?: string[], alone?: boolean, weight?: number, priority?: number }} Step */

/** @type {Step[]} */
const steps = [
    // Start sdk build first on the critical path so downstream SDK and website steps never stall behind long suites
    { name: "sdk build", group: "sdk", folder: "sdk", script: "build", weight: 3, priority: 100 },
    { name: "web build", group: "web", folder: "web", script: "build", after: ["sdk build"], weight: 3, priority: 95 },
    { name: "web types", group: "web", folder: "web", script: "check:types", after: ["web build"], weight: 2, priority: 85 },
    { name: "sdk package", group: "sdk", folder: "sdk", script: "test:package", after: ["sdk build"], weight: 3, priority: 90 },
    // Unit tests use fixtures, not the build. Process tests run the built SDK. On small and CI machines each runs alone
    // so timing-bounded tests never contend for CPU. On high-core local machines (CPU budget >= 10, capped at 65% of
    // physical cores) each takes a large weighted share so the two Vitest suites still never overlap each other while
    // critical-path build and package steps overlap within the machine's 65% CPU ceiling
    { name: "sdk unit tests", group: "sdk", folder: "sdk", script: "test:unit", alone: true, priority: 88 },
    { name: "sdk process tests", group: "sdk", folder: "sdk", script: "test:processes", after: ["sdk build"], alone: true, priority: 80 },

    { name: "contributions", group: "contributions", folder: ".", script: "check:contributions", weight: 1, priority: 30 },
    // The workspace scripts, this runner among them, which no other group lints
    { name: "scripts lint", group: "contributions", folder: ".", script: "lint:scripts", weight: 1, priority: 30 },
    { name: "docs links", group: "contributions", folder: ".", script: "lint:docs-links", weight: 1, priority: 30 },
    { name: "release", group: "release", folder: "release", script: "test", weight: 2, priority: 40 },

    { name: "sdk format", group: "sdk", folder: "sdk", script: "format:check", weight: 1, priority: 50 },
    ...["effect", "code", "spelling", "test-invariants", "unused", "mapping", "discards", "dashes"].map((lint) => ({
        name: `sdk lint ${lint}`,
        group: "sdk",
        folder: "sdk",
        script: `lint:${lint}`,
        weight: lint === "effect" || lint === "code" ? 3 : 1,
        priority: lint === "effect" || lint === "code" ? 60 : 35,
    })),
    { name: "sdk examples", group: "sdk", folder: "sdk", script: "test:examples", after: ["sdk build"], weight: 1, priority: 45 },
    { name: "sdk public contract", group: "sdk", folder: "sdk", script: "test:public-contract", after: ["sdk build"], weight: 2, priority: 55 },
    { name: "sdk types", group: "sdk", folder: "sdk", script: "test:types", after: ["sdk build"], weight: 3, priority: 65 },
    { name: "sdk packaging", group: "sdk", folder: "sdk", script: "test:packaging", after: ["sdk build"], weight: 1, priority: 45 },

    // The site lint and build read the SDK's built declarations and examples, and its tests and search check read the built site
    { name: "web lint", group: "web", folder: "web", script: "lint", after: ["sdk build"], weight: 2, priority: 50 },
    { name: "web tests", group: "web", folder: "web", script: "test", after: ["web build"], weight: 2, priority: 75 },
    { name: "web search", group: "web", folder: "web", script: "test:search", after: ["web build"], weight: 3, priority: 78 },

    // The deployed site, built from the published versions' snapshots. It also expects a built SDK
    { name: "public lint", group: "public", folder: "web", script: "lint", weight: 2, priority: 50 },
    { name: "public generate", group: "public", folder: "web", script: "generate", weight: 2, priority: 90 },
    { name: "public build", group: "public", folder: "web", script: "build:public", after: ["public generate"], weight: 3, priority: 95 },
    { name: "public types", group: "public", folder: "web", script: "check:types", after: ["public build"], weight: 2, priority: 85 },
    { name: "public tests", group: "public", folder: "web", script: "test", after: ["public build"], weight: 2, priority: 75 },
]

/**
 * @param {string} script
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [extraEnv]
 */
function run(script, cwd, extraEnv = {}) {
    // Inside pnpm, npm_execpath is pnpm's own entry, which starts without a shell on every platform
    const pnpm = process.env.npm_execpath
    const [command, args] = pnpm?.endsWith(".js") || pnpm?.endsWith(".cjs") ? [process.execPath, [pnpm]] : ["pnpm", []]
    return new Promise((done) => {
        const child = spawn(command, [...args, "run", script], {
            cwd,
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
        child.on("error", (error) => done({ code: 1, output: `${error.message}\n` }))
        child.on("close", (code) => done({ code: code ?? 1, output: Buffer.concat(output).toString() }))
    })
}

/** @param {number} ms */
const seconds = (ms) => `${Math.round(ms / 1000)}s`

/** The command that runs one step again, from the workspace folder @param {Step} step */
const commandOf = (step) => `pnpm ${step.folder === "." ? "" : `--dir ${step.folder} `}run ${step.script}`

// Lines that only report that a script exited or that something passed, so they never say what went wrong
const exitNoise = /^(>|ELIFECYCLE|WARN|Command failed|.*exit code \d+|[✓✔√])|^\s*$/
const errorLine = /\b(FAIL|not ok|error|Error|ERR_[A-Z_]+|failed)\b|^\s*[✖×✗x]\s/

/**
 * The first line of a failed step's output that says what went wrong, such as a failing test, a type error or a lint rule
 * @param {string} output
 */
export function failureLine(output) {
    // oxlint-disable-next-line no-control-regex -- Colors from the tools are removed so the line reads as plain text
    const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/).map((line) => line.trim())
    const useful = lines.filter((line) => line && !exitNoise.test(line))
    return (useful.find((line) => errorLine.test(line)) ?? useful.at(-1) ?? "No output").slice(0, 300)
}

/**
 * Computes the slot demand and child concurrency limits for one check step
 * @param {Step} step
 * @param {number} total
 * @returns {{ need: number, exclusive: boolean, env: NodeJS.ProcessEnv }}
 */
function stepResources(step, total) {
    if (step.alone) {
        if (total < 10) return { need: total, exclusive: true, env: {} }
        // High-core local machine: Allocate over half of the 65% CPU budget so unit and process suites never overlap
        // each other, while critical-path build and package work shares the remaining slots within the host ceiling
        const need = Math.max(6, Math.min(total - 6, Math.ceil(total * 0.55)))
        const env = process.env.VITEST_MAX_WORKERS ? {} : { VITEST_MAX_WORKERS: String(need) }
        return { need, exclusive: false, env }
    }
    const need = Math.max(1, Math.min(total, step.weight ?? 1))
    /** @type {NodeJS.ProcessEnv} */
    const env = {}
    if (step.script === "test:package" && !process.env.FLUXERLY_PACKAGE_CONCURRENCY && total >= 4) {
        env.FLUXERLY_PACKAGE_CONCURRENCY = String(Math.max(1, Math.min(4, need)))
    }
    if (step.script === "test:search" && !process.env.FLUXERLY_SEARCH_WORKERS && total >= 4) {
        env.FLUXERLY_SEARCH_WORKERS = String(Math.max(1, Math.min(6, need + 1)))
    }
    if ((step.script === "lint:effect" || step.script === "lint:code" || step.script === "test:types") && !process.env.GOMAXPROCS && total >= 4) {
        env.GOMAXPROCS = String(Math.max(2, Math.min(total, need * 2)))
    }
    if (step.script === "lint:code" && !process.env.RAYON_NUM_THREADS && total >= 4) {
        env.RAYON_NUM_THREADS = String(Math.max(2, Math.min(total, need * 2)))
    }
    return { need, exclusive: false, env }
}

/** @param {string[]} groups */
async function check(groups) {
    const unknown = groups.filter((group) => !steps.some((step) => step.group === group))
    if (unknown.length > 0) throw new Error(`Unknown check group ${unknown.join(", ")}. Groups: contributions, release, sdk, web, public`)
    const selected = steps.filter((step) => (groups.length === 0 ? step.group !== "public" : groups.includes(step.group)))
    const names = new Set(selected.map((step) => step.name))
    const started = Date.now()
    // Every step's result exists before any step starts, so a step waits for the steps it needs wherever they are listed
    const results = new Map(selected.map((step) => [step.name, Promise.withResolvers()]))
    /** @type {{ name: string, output: string }[]} */
    const failed = []
    /** @type {string[]} */
    const skipped = []
    /** @type {Map<string, { name: string, result: string, ms: number, command: string, error?: string, blockedBy?: string }>} */
    const report = new Map()
    // Slot budget scales from availableParallelism(): Gentle on 2 to 4 cores, capped near 65% on multi-core local hosts,
    // and full-runner on CI. Non-exclusive steps fill free slots ahead of waiting exclusive steps so builds and lints
    // never stall behind an exclusive test suite, while exclusive steps still run in FIFO order once all slots are free
    const total = cpuBudget({ envVar: "FLUXERLY_CHECK_SLOTS" })
    let free = total
    /** @type {{ need: number, exclusive: boolean, priority: number, go: () => void }[]} */
    const queue = []
    const pump = () => {
        while (queue.length > 0) {
            let best = -1
            for (let index = 0; index < queue.length; index++) {
                const item = queue[index]
                if (item.need > free || (item.exclusive && free !== total)) continue
                if (best === -1 || item.priority > queue[best].priority) best = index
            }
            if (best === -1) break
            const [next] = queue.splice(best, 1)
            free -= next.need
            next.go()
        }
    }
    /** @param {number} need @param {boolean} exclusive @param {number} priority */
    const slot = (need, exclusive, priority) =>
        new Promise((go) => (queue.push({ need, exclusive, priority, go: () => go(undefined) }), pump()))
    /** @param {number} need */
    const release = (need) => ((free += need), pump())

    /** @param {Step} step @returns {Promise<boolean>} */
    const start = async (step) => {
        const before = (step.after ?? []).filter((name) => names.has(name))
        const passed = await Promise.all(before.map((name) => results.get(name)?.promise))
        if (passed.includes(false)) {
            skipped.push(step.name)
            report.set(step.name, { name: step.name, result: "skipped", ms: 0, command: commandOf(step), blockedBy: before[passed.indexOf(false)] })
            return false
        }
        const { need, exclusive, env } = stepResources(step, total)
        await slot(need, exclusive, step.priority ?? 0)
        const from = Date.now()
        const { code, output } = await run(step.script, resolve(workspace, step.folder), env).finally(() => release(need))
        const ms = Date.now() - from
        console.log(`${code === 0 ? "passed" : "FAILED"}  ${step.name}  ${seconds(ms)}`)
        report.set(step.name, {
            name: step.name,
            result: code === 0 ? "passed" : "failed",
            ms,
            command: commandOf(step),
            ...(code === 0 ? {} : { error: failureLine(output) }),
        })
        if (code !== 0) failed.push({ name: step.name, output })
        return code === 0
    }
    await Promise.all(selected.map((step) => start(step).then((passed) => results.get(step.name)?.resolve(passed))))

    for (const { name, output } of failed) console.log(`\n--- ${name} ---\n${output.trimEnd()}`)
    const summary = [`${selected.length - failed.length - skipped.length} of ${selected.length} checks passed in ${seconds(Date.now() - started)}`]
    if (failed.length > 0) summary.push(`Failed: ${failed.map(({ name }) => name).join(", ")}`)
    if (skipped.length > 0) summary.push(`Not run because a step they need failed: ${skipped.join(", ")}`)
    console.log(`\n${summary.join("\n")}`)
    if (process.env.CHECK_RESULTS_FILE)
        writeFileSync(
            process.env.CHECK_RESULTS_FILE,
            JSON.stringify({ total: Date.now() - started, checks: selected.flatMap((step) => report.get(step.name) ?? []) }) + "\n",
        )
    return failed.length === 0 && skipped.length === 0
}

/** Lists changed repository paths relative to HEAD and untracked files */
function changedFiles() {
    const read = (/** @type {string[]} */ args) =>
        execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
            .split("\0")
            .filter(Boolean)
    const names = new Set([
        ...read(["diff", "--name-only", "-z", "HEAD"]),
        ...read(["ls-files", "--others", "--exclude-standard", "-z"]),
    ])
    return [...names]
}

/** Picks the check groups affected by changed files for fast local iteration */
function changedGroups() {
    const files = changedFiles()
    if (files.length === 0) return []
    const groups = new Set()
    for (const file of files) {
        if (file.startsWith(".github/") || file.startsWith("docs/") || file.startsWith("projects/scripts/") || /^(?:AGENTS|REVIEW)\.md$/.test(file))
            groups.add("contributions")
        if (file.startsWith("projects/release/")) groups.add("release")
        if (file.startsWith("projects/sdk/") || /^projects\/(?:\.oxlintrc\.json|cspell|knip\.jsonc|package\.json|pnpm-)/.test(file))
            groups.add("sdk")
        if (file.startsWith("projects/web/")) groups.add("web")
    }
    if (groups.size === 0) groups.add("contributions")
    return [...groups]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2)
    const changed = args.includes("--changed")
    const requested = args.filter((arg) => arg !== "--changed")
    if (changed && requested.length > 0)
        throw new Error("Use --changed without explicit group names")
    const groups = changed ? changedGroups() : requested
    if (changed && groups.length === 0) {
        console.log("No changed files to check")
        process.exitCode = 0
    } else {
        if (changed) console.log(`Changed groups: ${groups.join(", ")}`)
        process.exitCode = (await check(groups)) ? 0 : 1
    }
}
