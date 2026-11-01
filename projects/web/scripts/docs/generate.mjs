// Generates what the docs read from the SDK into a content folder: the reference, the endpoint map, the example bots and the changelog.
// Build the SDK first. Usage: node scripts/docs/generate.mjs [--out FOLDER] [--with-pending]
// --with-pending adds the pending Changesets notes to the changelog, as a nightly's snapshot does
import { execFileSync } from "node:child_process"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { unreleasedNotes } from "../../../release/source.js"

const site = fileURLToPath(new URL("../../", import.meta.url))
const sdk = resolve(site, "../sdk")

// The changelog page: the title, then what a nightly adds, then the published Stable releases
export function changelogPage(changelog, pending) {
    const title = /^# .*\n\n?/.exec(changelog)?.[0] ?? ""
    const unreleased = pending ? `## Unreleased\n\nThese changes are in this nightly and not yet in a Stable release\n\n${pending.trim()}\n\n` : ""
    return `${title}${unreleased}${changelog.slice(title.length) || (pending ? "" : "No package releases have been recorded yet\n")}`
}

export async function generate(out, { withPending = false } = {}) {
    const env = { ...process.env, DOCS_CONTENT: out }
    await mkdir(out, { recursive: true })
    for (const script of ["extract.mjs", "endpoints.mjs"]) execFileSync(process.execPath, [join(site, "scripts/docs", script)], { cwd: site, env, stdio: "inherit" })
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
