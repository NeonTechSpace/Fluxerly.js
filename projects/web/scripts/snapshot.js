// Writes one version's docs to a new file, for release preparation to bind to the package candidate: the guides, the reference, the
// example bots and the changelog. Usage: node web/scripts/snapshot.js --out NEW_FILE [--nightly VERSION]
import { execFileSync } from "node:child_process"
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { generate } from "./docs/generate.mjs"
import { parseVersion, snapshotSchema, validateSnapshot } from "./versions.js"

const webRoot = fileURLToPath(new URL("../", import.meta.url))
const args = process.argv.slice(2)
if (!((args.length === 2 || (args.length === 4 && args[2] === "--nightly")) && args[0] === "--out")) throw new Error("Use snapshot.js --out NEW_FILE [--nightly VERSION]")
const output = resolve(args[1])
// A nightly version exists only in its candidate, so release preparation supplies it
const nightly = args[3]
if (nightly !== undefined && parseVersion(nightly).channel !== "nightly") throw new Error("Expected a nightly version")
const version = nightly ?? JSON.parse(await readFile(join(webRoot, "../sdk/package.json"), "utf8")).version
const git = (...command) => execFileSync("git", command, { cwd: webRoot, encoding: "utf8", windowsHide: true }).trim()
const sourceCommit = git("rev-parse", "HEAD")
if (git("status", "--porcelain", "--untracked-files=no")) throw new Error("Release docs require a clean reviewed source checkout")

const temporary = await mkdtemp(join(tmpdir(), "fluxerly-docs-snapshot-"))
if (dirname(temporary) !== resolve(tmpdir())) throw new Error("Unexpected temporary docs directory")
try {
    await generate(temporary, { withPending: nightly !== undefined })
    await cp(join(webRoot, "content/guides"), join(temporary, "guides"), { recursive: true })
    const names = await readdir(temporary, { recursive: true, withFileTypes: true })
    const files = await Promise.all(
        names
            .filter((entry) => entry.isFile())
            .map(async (entry) => {
                const path = join(entry.parentPath, entry.name)
                return { path: relative(temporary, path).replaceAll("\\", "/"), content: await readFile(path, "utf8") }
            }),
    )
    const snapshot = validateSnapshot({ schemaVersion: snapshotSchema, version, sourceCommit, files })
    await writeFile(output, JSON.stringify(snapshot), { flag: "wx" })
    console.log(JSON.stringify({ output, version, sourceCommit, files: files.length }))
} finally {
    await rm(temporary, { recursive: true, force: true })
}
