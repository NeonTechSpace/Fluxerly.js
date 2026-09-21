import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, writeFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { validateSnapshot } from "./versions.js"

const repository = "NeonTechSpace/Fluxerly.js"
const webRoot = fileURLToPath(new URL("../", import.meta.url))
function authenticatedRead(args) {
    try {
        return execFileSync("gh", args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 64 * 1024 * 1024,
            timeout: 60_000,
        })
    } catch {
        throw new Error("Authenticated GitHub release read failed; no automatic retry was attempted")
    }
}
function parseJson(bytes) {
    try {
        return JSON.parse(bytes.toString("utf8"))
    } catch {
        throw new Error("GitHub release read returned invalid JSON")
    }
}

export async function fetchReleases({ root = webRoot, gh = authenticatedRead } = {}) {
    const read = async (args) => {
        try {
            return await gh([args[0], "--hostname", "github.com", ...args.slice(1)])
        } catch {
            throw new Error("Authenticated GitHub release read failed; no automatic retry was attempted")
        }
    }
    // The CLI destination is fixed generated output, never an authored directory
    const directory = resolve(root, "released")
    await mkdir(directory, { recursive: true })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Release archive must be a real generated directory")
    if ((await readdir(directory)).length)
        throw new Error("Release import requires an empty generated archive directory; existing files are preserved")
    const pages = parseJson(await read(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]))
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
        throw new Error("Invalid paginated GitHub release inventory")
    const archives = new Map()
    for (const release of pages.flat()) {
        if (release?.draft === true) continue
        if (release?.draft !== false || typeof release.tag_name !== "string" || !Array.isArray(release.assets))
            throw new Error("Invalid published GitHub release metadata")
        const docs = release.assets.filter((asset) => asset?.name === "docs.json")
        if (docs.length !== 1) throw new Error("Published release has no unique docs snapshot")
        const asset = docs[0]
        if (
            !Number.isSafeInteger(asset.id) ||
            asset.id <= 0 ||
            !Number.isSafeInteger(asset.size) ||
            asset.size <= 0 ||
            asset.size > 64 * 1024 * 1024 ||
            asset.state !== "uploaded" ||
            !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")
        )
            throw new Error("Invalid docs asset metadata")
        const bytes = await read([
            "api",
            `repos/${repository}/releases/assets/${asset.id}`,
            "-H",
            "Accept: application/octet-stream",
        ])
        if (
            !Buffer.isBuffer(bytes) ||
            `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.digest ||
            bytes.length !== asset.size
        )
            throw new Error("Docs asset checksum mismatch")
        let snapshot
        try {
            snapshot = validateSnapshot(parseJson(bytes))
        } catch {
            throw new Error("Invalid docs snapshot")
        }
        if (release.tag_name !== `v${snapshot.version}` || archives.has(snapshot.version))
            throw new Error("Release tag does not identify a unique docs version")
        const commit = parseJson(
            await read(["api", `repos/${repository}/commits/${encodeURIComponent(release.tag_name)}`]),
        ).sha
        if (snapshot.sourceCommit !== commit) throw new Error("Docs snapshot does not match release source")
        archives.set(snapshot.version, bytes)
    }
    // Validate remote inputs before writing, but do not claim multi-file atomicity
    // A local write failure preserves the partial archive for explicit reconciliation
    if ((await readdir(directory)).length)
        throw new Error("Release archive changed during import; existing files are preserved")
    for (const [version, bytes] of archives) {
        const target = join(directory, `${version}.json`)
        try {
            const info = await lstat(directory)
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Release archive destination changed")
            await writeFile(target, bytes, { flag: "wx" })
            if (!(await readFile(target)).equals(bytes)) throw new Error("Release archive readback mismatch")
        } catch {
            throw new Error(
                "Release archive write or readback failed; existing and partial files are preserved for reconciliation",
            )
        }
    }
    return { imported: [...archives.keys()] }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.log(JSON.stringify(await fetchReleases()))
    } catch (error) {
        console.error(error.message)
        process.exitCode = 1
    }
}
