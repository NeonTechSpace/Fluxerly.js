// @ts-check
// Runs the workspace checks side by side: node scripts/check.mjs [sdk|web|release|contributions ...]
// Each step starts as soon as the steps it reads from have passed, so independent checks share the machine instead of
// waiting in line. Without a name it runs every group except public, which checks the deployed site instead of the local
// one. A named group skips steps of other groups, so the web and public groups expect a built SDK, as their package
// checks always have
import { spawn } from "node:child_process"
import { availableParallelism } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const workspace = fileURLToPath(new URL("../", import.meta.url))

/** @typedef {{ name: string, group: string, folder: string, script: string, after?: string[], alone?: boolean }} Step */

/** @type {Step[]} */
const steps = [
    { name: "contributions", group: "contributions", folder: ".", script: "check:contributions" },
    { name: "release", group: "release", folder: "release", script: "test" },

    { name: "sdk format", group: "sdk", folder: "sdk", script: "format:check" },
    ...["code", "discards", "mapping", "dashes", "tests", "effect", "unused", "spelling"].map((lint) => ({
        name: `sdk lint ${lint}`,
        group: "sdk",
        folder: "sdk",
        script: `lint:${lint}`,
    })),
    // The unit tests use fixtures, not the build. The process tests run the built SDK. Both start a worker per thread and
    // hold timing-bounded tests, so each runs alone rather than beside other steps on a small machine such as CI's
    { name: "sdk unit tests", group: "sdk", folder: "sdk", script: "test:unit", alone: true },
    { name: "sdk process tests", group: "sdk", folder: "sdk", script: "test:processes", after: ["sdk build"], alone: true },
    { name: "sdk build", group: "sdk", folder: "sdk", script: "build" },
    { name: "sdk examples", group: "sdk", folder: "sdk", script: "test:examples", after: ["sdk build"] },
    { name: "sdk public contract", group: "sdk", folder: "sdk", script: "test:public-contract", after: ["sdk build"] },
    { name: "sdk types", group: "sdk", folder: "sdk", script: "test:types", after: ["sdk build"] },
    { name: "sdk packaging", group: "sdk", folder: "sdk", script: "test:packaging", after: ["sdk build"] },
    { name: "sdk package", group: "sdk", folder: "sdk", script: "test:package", after: ["sdk build"] },

    { name: "web lint", group: "web", folder: "web", script: "lint" },
    // The site reads the SDK's declarations and examples, and its tests and search check read the built site
    { name: "web build", group: "web", folder: "web", script: "build", after: ["sdk build"] },
    { name: "web types", group: "web", folder: "web", script: "check:types", after: ["web build"] },
    { name: "web tests", group: "web", folder: "web", script: "test", after: ["web build"] },
    { name: "web search", group: "web", folder: "web", script: "test:search", after: ["web build"] },

    // The deployed site, built from the published versions' snapshots. It also expects a built SDK
    { name: "public lint", group: "public", folder: "web", script: "lint" },
    { name: "public generate", group: "public", folder: "web", script: "generate" },
    { name: "public build", group: "public", folder: "web", script: "build:public", after: ["public generate"] },
    { name: "public types", group: "public", folder: "web", script: "check:types", after: ["public build"] },
    { name: "public tests", group: "public", folder: "web", script: "test", after: ["public build"] },
]

/** @param {string} script @param {string} cwd */
function run(script, cwd) {
    // Inside pnpm, npm_execpath is pnpm's own entry, which starts without a shell on every platform
    const pnpm = process.env.npm_execpath
    const [command, args] = pnpm?.endsWith(".js") || pnpm?.endsWith(".cjs") ? [process.execPath, [pnpm]] : ["pnpm", []]
    return new Promise((done) => {
        const child = spawn(command, [...args, "run", script], {
            cwd,
            env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? (process.stdout.isTTY ? "1" : "0") },
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
    // Heavy steps start their own workers, so more steps than threads would only slow each other down
    // A step that runs alone takes every slot. Waiting steps start in order, so one waiting to run alone is not starved
    const total = Math.max(2, availableParallelism())
    let free = total
    /** @type {{ need: number, go: () => void }[]} */
    const queue = []
    const pump = () => {
        while (queue.length > 0 && queue[0].need <= free) {
            const next = /** @type {{ need: number, go: () => void }} */ (queue.shift())
            free -= next.need
            next.go()
        }
    }
    /** @param {number} need */
    const slot = (need) => new Promise((go) => (queue.push({ need, go: () => go(undefined) }), pump()))
    /** @param {number} need */
    const release = (need) => ((free += need), pump())

    /** @param {Step} step @returns {Promise<boolean>} */
    const start = async (step) => {
        const before = (step.after ?? []).filter((name) => names.has(name))
        const passed = await Promise.all(before.map((name) => results.get(name)?.promise))
        if (passed.includes(false)) {
            skipped.push(step.name)
            return false
        }
        const need = step.alone ? total : 1
        await slot(need)
        const from = Date.now()
        const { code, output } = await run(step.script, resolve(workspace, step.folder)).finally(() => release(need))
        console.log(`${code === 0 ? "passed" : "FAILED"}  ${step.name}  ${seconds(Date.now() - from)}`)
        if (code !== 0) failed.push({ name: step.name, output })
        return code === 0
    }
    await Promise.all(selected.map((step) => start(step).then((passed) => results.get(step.name)?.resolve(passed))))

    for (const { name, output } of failed) console.log(`\n--- ${name} ---\n${output.trimEnd()}`)
    const summary = [`${selected.length - failed.length - skipped.length} of ${selected.length} checks passed in ${seconds(Date.now() - started)}`]
    if (failed.length > 0) summary.push(`Failed: ${failed.map(({ name }) => name).join(", ")}`)
    if (skipped.length > 0) summary.push(`Not run because a step they need failed: ${skipped.join(", ")}`)
    console.log(`\n${summary.join("\n")}`)
    return failed.length === 0 && skipped.length === 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = (await check(process.argv.slice(2))) ? 0 : 1
}
