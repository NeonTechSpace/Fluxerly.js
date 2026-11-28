// Generates what the docs read from the SDK into a content folder: the reference, the endpoint map, the example bots and the changelog.
// Build the SDK first. Usage: node scripts/docs/generate.mjs [--out FOLDER] [--with-pending]
// --with-pending adds the pending Changesets notes to the changelog, as a nightly's snapshot does
import { spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { unreleasedNotes } from "../../../release/source.js"
import { parallelLanes } from "../../../scripts/concurrency.mjs"

const site = fileURLToPath(new URL("../../", import.meta.url))
const sdk = resolve(site, "../sdk")

// The changelog page: the title, then what a nightly adds, then the published Stable releases
export function changelogPage(changelog, pending) {
    const title = /^# .*\n\n?/.exec(changelog)?.[0] ?? ""
    const unreleased = pending ? `## Unreleased\n\nThese changes are in this nightly and not yet in a Stable release\n\n${pending.trim()}\n\n` : ""
    return `${title}${unreleased}${changelog.slice(title.length) || (pending ? "" : "No package releases have been recorded yet\n")}`
}

function runNode(args, env) {
    return new Promise((done, fail) => {
        const child = spawn(process.execPath, args, { cwd: site, env, stdio: "inherit", windowsHide: true })
        child.on("error", fail)
        child.on("close", (code) => {
            if (code === 0) done()
            else fail(new Error(`Command failed (exit ${code}): ${args.join(" ")}`))
        })
    })
}

export async function generate(out, { withPending = false } = {}) {
    const env = { ...process.env, DOCS_CONTENT: out }
    await mkdir(out, { recursive: true })
    // Overlap TypeDoc extraction and SDK static route analysis on multi-core hosts, keeping 2 to 4 core local runs serial
    const lanes = parallelLanes({ envVar: "FLUXERLY_GENERATE_CONCURRENCY", perLaneCores: 2, max: 2 })
    if (lanes >= 2) {
        const tempDir = await mkdtemp(join(tmpdir(), "fluxerly-sdk-routes-"))
        const routesFile = join(tempDir, "routes.json")
        try {
            await Promise.all([
                runNode([join(site, "scripts/docs/extract.mjs")], env),
                runNode([join(site, "scripts/docs/sdk-routes.mjs"), "--sdk", sdk, "--write", routesFile], env),
            ])
            await runNode([join(site, "scripts/docs/endpoints.mjs")], { ...env, DOCS_SDK_ROUTES: routesFile })
        } finally {
            await rm(tempDir, { recursive: true, force: true })
        }
    } else {
        // endpoints.mjs reads model.json produced by extract.mjs, so extract must finish first
        for (const script of ["extract.mjs", "endpoints.mjs"]) await runNode([join(site, "scripts/docs", script)], env)
    }
    await rm(join(out, "examples"), { recursive: true, force: true })
    await cp(join(sdk, "examples"), join(out, "examples"), { recursive: true, filter: (path) => !/[\\/](node_modules|dist)$/.test(path) })
    const changelog = await readFile(join(sdk, "CHANGELOG.md"), "utf8").catch(() => "")
    const pending = withPending ? await unreleasedNotes(resolve(site, "..")) : ""
    await writeFile(join(out, "changelog.md"), changelogPage(changelog, pending))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2)
    const out = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : join(site, "content")
    await generate(out, { withPending: args.includes("--with-pending") })
}
