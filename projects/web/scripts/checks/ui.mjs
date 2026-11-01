import { execSync } from "node:child_process"
import { rmSync } from "node:fs"

// Everything a UI change must pass, in one command: pnpm check:ui. Astro keeps rendered Markdown in a cache that a change
// to a Markdown plugin doesn't clear, so the check always starts from a clean one. --quick is a shorter run
const quick = process.argv.includes("--quick")
const run = (command) => {
    const started = Date.now()
    execSync(command, { stdio: "inherit" })
    console.log(`${command}: ${Math.round((Date.now() - started) / 1000)} s`)
}

rmSync(".astro/data-store.json", { force: true })
rmSync("node_modules/.astro/data-store.json", { force: true })
run("pnpm exec astro check")
run("pnpm build")
run("node --test tests/*.test.ts")
run(`node scripts/checks/sweep.mjs${quick ? " --quick" : ""}`)
console.log("UI checks passed")
