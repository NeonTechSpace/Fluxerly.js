import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { filesIn, generateVersion, webRoot } from "./generate.js"
import { unreleasedNotes } from "../../release/source.js"
import { parseVersion, validateSnapshot } from "./versions.js"
import { currentSnapshotSchema } from "./transform-schemas.js"

const args = process.argv.slice(2)
if (!((args.length === 2 || (args.length === 4 && args[2] === "--nightly")) && args[0] === "--out"))
    throw new Error("Use snapshot.js --out NEW_FILE [--nightly VERSION]")
const output = resolve(args[1])
process.chdir(webRoot)
// A nightly version exists only in its candidate, so release preparation supplies it
const nightly = args[3]
if (nightly !== undefined && parseVersion(nightly).channel !== "nightly") throw new Error("Expected a nightly version")
const version = nightly ?? JSON.parse(await readFile(join(webRoot, "../sdk/package.json"), "utf8")).version
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim()
if (
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        encoding: "utf8",
        windowsHide: true,
    }).trim()
)
    throw new Error("Release docs require a clean reviewed source checkout")
const temporary = await mkdtemp(join(tmpdir(), "fluxerly-docs-snapshot-"))
if (dirname(temporary) !== resolve(tmpdir())) throw new Error("Unexpected temporary docs directory")
try {
    const unreleased = nightly === undefined ? undefined : await unreleasedNotes(resolve(webRoot, ".."))
    await generateVersion(version, temporary, { unreleased })
    const snapshot = validateSnapshot({ schemaVersion: currentSnapshotSchema, version, sourceCommit, files: await filesIn(temporary) })
    await writeFile(output, JSON.stringify(snapshot), { flag: "wx" })
    console.log(JSON.stringify({ output, version, sourceCommit, files: snapshot.files.length }))
} finally {
    await rm(temporary, { recursive: true, force: true })
}
