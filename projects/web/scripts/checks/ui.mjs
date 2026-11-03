import { execSync, spawn } from "node:child_process"
import { rmSync } from "node:fs"
import { areasForChanges, changedPaths, repositoryRoot } from "./changed.mjs"

// Everything a UI change must pass, in one command: pnpm check:ui. Astro keeps rendered Markdown in a cache that a change
// to a Markdown plugin doesn't clear, so the check always starts from a clean one. --quick is a shorter run
//
// --changed is the quick check during work. It stops at once when the changed files reach nothing on the website, and
// otherwise builds, then runs the type check, the tests and the screen check's --changed run side by side. They only read
// the build, and the type check and the build both write Astro's .astro folders, so the type check waits for the build
const quick = process.argv.includes("--quick")
const changed = process.argv.includes("--changed")
const run = (command) => {
    const started = Date.now()
    execSync(command, { stdio: "inherit" })
    console.log(`${command}: ${Math.round((Date.now() - started) / 1000)} s`)
}
// Each command's output is held back and shown whole when it ends, so side by side runs don't mix their lines
const runAlongside = (command) =>
    new Promise((done) => {
        const started = Date.now()
        const child = spawn(command, { shell: true, env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "0" } })
        const output = []
        child.stdout.on("data", (chunk) => output.push(chunk))
        child.stderr.on("data", (chunk) => output.push(chunk))
        child.on("close", (code) => {
            console.log(`\n--- ${command} ---\n${Buffer.concat(output).toString().trimEnd()}`)
            console.log(`${command}: ${code === 0 ? "passed" : "FAILED"} in ${Math.round((Date.now() - started) / 1000)} s`)
            done(code === 0)
        })
    })

if (changed) {
    const paths = changedPaths(repositoryRoot)
    const { areas, reasons } = areasForChanges(paths, repositoryRoot)
    const website = paths.some((path) => path.startsWith("projects/web/"))
    if (!website && areas !== "all" && areas.size === 0) {
        console.log("Nothing on the website changed, so there is nothing to check")
        process.exit(0)
    }
    for (const reason of reasons) console.log(reason)
}

rmSync(".astro/data-store.json", { force: true })
rmSync("node_modules/.astro/data-store.json", { force: true })
if (changed) {
    run("pnpm build")
    // The package test script, so the UI check runs every test file under the offline network guard
    const results = await Promise.all(["pnpm exec astro check", "pnpm test", `node scripts/checks/sweep.mjs --changed${quick ? " --quick" : ""}`].map(runAlongside))
    if (results.includes(false)) {
        console.log("UI checks failed")
        process.exit(1)
    }
} else {
    run("pnpm exec astro check")
    run("pnpm build")
    // The package test script, so the UI check runs every test file under the offline network guard
    run("pnpm test")
    run(`node scripts/checks/sweep.mjs${quick ? " --quick" : ""}`)
}
console.log("UI checks passed")
