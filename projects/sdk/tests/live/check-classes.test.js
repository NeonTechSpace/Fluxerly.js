import { spawn } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { afterEach, expect, test } from "vitest"
import { liveChecks } from "./run-all.js"
import { checkClasses, declaredCheck } from "./support/check-classes.js"

const live = new URL("./", import.meta.url)
const harnessUrl = new URL("./support/harness.js", import.meta.url).href
const parent = realpathSync(tmpdir())
const roots = []
const childTimeoutMs = 60_000

afterEach(() => {
    for (const root of roots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(parent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

test("every harness that takes the sandbox lock declares its lock class", () => {
    const harnesses = readdirSync(live).filter(
        (file) => /^[a-z-]+\.m?js$/.test(file) && readFileSync(new URL(file, live), "utf8").includes("acquireLock()"),
    )
    expect(harnesses.length).toBeGreaterThan(20)
    // A declaration without a harness would hide a renamed file
    expect(Object.keys(checkClasses).sort()).toEqual(harnesses.sort())
})

test("every live package script and direct runner check resolves to declared scenarios", () => {
    const checks = liveChecks()
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
    const scripts = Object.keys(packageJson.scripts).filter(
        (script) => (script === "test:live" || script.startsWith("test:live:")) && script !== "test:live:all",
    )
    expect(checks.size).toBe(scripts.length + 3)
    for (const check of checks.values())
        for (const { harness, args } of check.commands) expect(declaredCheck(harness, args)).toBeDefined()
})

test("the runner treats only checks whose every command is SDK work as runnable", () => {
    const checks = liveChecks()
    expect(checks.get("moderation:default")?.sdkWork).toBe(false)
    expect(checks.get("presence")?.sdkWork).toBe(false)
    expect(checks.get("pins")).toMatchObject({ sdkWork: true, lockClass: "test-owned" })
    expect(checks.get("administration")).toMatchObject({ sdkWork: true, lockClass: "shared-state" })
})

test("scenario keys follow the arguments after the mode in any order", () => {
    expect(declaredCheck("messages.js", ["effect", "--pins"])).toMatchObject({ key: "messages-pins" })
    expect(declaredCheck("messages.mjs", ["default"])).toMatchObject({ key: "messages" })
    expect(declaredCheck("guild-lifecycle.js", ["default", "--lose-response", "--leave"])).toMatchObject({
        key: "guild-lifecycle-leave-lose-response",
        level: "manual",
    })
    expect(declaredCheck("messages.js", ["default", "--unknown"])).toBeUndefined()
})

// Each child loads the harness and reports ready, attempts one lock once the parent says go, and reports whether it
// acquired it. A holder keeps its lock until the parent closes its stdin, which happens only after every child has
// reported, so every attempt happens while every acquired lock is still held, however slowly the processes start
function contend(root, checks) {
    const script = join(root, "contender.mjs")
    writeFileSync(
        script,
        `import { acquireLock } from ${JSON.stringify(harnessUrl)}
        const [path, lockClass, key] = process.argv.slice(2)
        const go = new Promise((done) => process.stdin.once("data", done))
        const closed = new Promise((done) => process.stdin.on("end", done))
        process.stdin.resume()
        console.log("ready")
        await go
        let lock
        try {
            lock = acquireLock({ path, check: { lockClass, key } })
        } catch {
            // A refused child also waits, so the parent's stdin writes never reach an exited process
        }
        console.log(JSON.stringify({ lockClass, key, acquired: lock !== undefined }))
        await closed
        if (lock) console.log(JSON.stringify({ released: lock.release() }))`,
    )
    const path = join(root, ".env.test.local.lock")
    const children = checks.map(([lockClass, key]) => {
        const child = spawn(process.execPath, [script, path, lockClass, key], { timeout: childTimeoutMs })
        const lines = []
        const waiters = []
        createInterface({ input: child.stdout }).on("line", (line) => {
            lines.push(line)
            for (const waiter of waiters.splice(0)) waiter()
        })
        const line = async (index) => {
            while (lines.length <= index)
                await Promise.race([
                    new Promise((done) => waiters.push(done)),
                    closed.then(() => {
                        throw new Error("Lock contender exited before reporting its result")
                    }),
                ])
            return lines[index]
        }
        const closed = new Promise((done, fail) => {
            child.on("error", fail)
            child.on("close", done)
        })
        return { child, line, lines, closed }
    })
    return (async () => {
        try {
            await Promise.all(children.map(({ line }) => line(0)))
            for (const { child } of children) child.stdin.write("go\n")
            const results = await Promise.all(children.map(async ({ line }) => JSON.parse(await line(1))))
            // Every child has attempted its lock, so the holders may release
            for (const { child } of children) child.stdin.end()
            await Promise.all(children.map(({ closed }) => closed))
            return results.map((result, index) =>
                result.acquired ? { ...result, ...JSON.parse(children[index].lines[2]) } : result,
            )
        } finally {
            for (const { child } of children) child.stdin.end()
            await Promise.all(children.map(({ closed }) => closed))
        }
    })()
}

test(
    "processes holding shared locks for different checks run together",
    async () => {
        const root = mkdtempSync(join(parent, "fluxerly-live-lock-"))
        roots.push(root)
        const results = await contend(root, [
            ["read-only", "sdk"],
            ["test-owned", "messages-pins"],
            ["test-owned", "webhooks"],
        ])
        // Each child acquired its lock while the others still held theirs
        expect(results.every((result) => result.acquired && result.released)).toBe(true)
        expect(readdirSync(root).filter((name) => name.startsWith(".env.test.local.lock"))).toEqual([])
    },
    (3 + 1) * childTimeoutMs,
)

test(
    "an exclusive holder never overlaps another holder when processes race for the lock",
    async () => {
        const root = mkdtempSync(join(parent, "fluxerly-live-lock-"))
        roots.push(root)
        // No holder is a valid outcome when racing acquisitions both back out. Check each fixed round's safety invariants
        // without requiring the scheduler to produce a winning interleaving
        for (let round = 0; round < 3; round++) {
            const results = await contend(root, [
                ["shared-state", "administration"],
                ["test-owned", "messages-pins"],
                ["shared-state", "guild-feature-toggles"],
                ["test-owned", "webhooks"],
                ["read-only", "sdk"],
                ["test-owned", "messages-pins"],
            ])
            const held = results.filter((result) => result.acquired)
            expect(held.every((result) => result.released)).toBe(true)
            // Every holder kept its lock until all children had attempted, so an exclusive holder must be the only one
            if (held.some((result) => result.lockClass === "shared-state")) expect(held).toHaveLength(1)
            // The same check key never has two holders at once
            expect(held.filter((result) => result.key === "messages-pins").length).toBeLessThanOrEqual(1)
            expect(readdirSync(root).filter((name) => name.startsWith(".env.test.local.lock"))).toEqual([])
        }
    },
    (3 * 6 + 1) * childTimeoutMs,
)
