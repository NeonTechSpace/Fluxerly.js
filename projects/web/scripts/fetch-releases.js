import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseVersion, retainedVersions, snapshotSchema, validateSnapshot } from "./versions.js"

const repository = "NeonTechSpace/Fluxerly.js"
const webRoot = fileURLToPath(new URL("../", import.meta.url))
/** @param {string[]} args */
function authenticatedRead(args) {
    try {
        return execFileSync("gh", args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 64 * 1024 * 1024,
            timeout: 60_000,
        })
    } catch {
        throw new Error("Authenticated GitHub release read failed. No automatic retry was attempted")
    }
}
function parseJson(bytes) {
    try {
        return JSON.parse(bytes.toString("utf8"))
    } catch {
        throw new Error("GitHub release read returned invalid JSON")
    }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

/**
 * Reads each retained release's docs.json into released/. A copy of every asset is kept in .cache/releases (gitignored),
 * named by its sha256, so an asset is downloaded only once. Each copy is used only when it matches the digest and size
 * that the fresh release metadata names, and a copy that doesn't is downloaded again. With write false, only the cache
 * is filled, which is how CI keeps the copies that the website workflow restores
 * @param {{ root?: string, cacheDir?: string, write?: boolean, gh?: (args: string[]) => Buffer | Promise<Buffer> }} [options]
 */
export async function fetchReleases({ root = webRoot, cacheDir = join(root, ".cache", "releases"), write = true, gh = authenticatedRead } = {}) {
    const read = async (args) => {
        try {
            return await gh([args[0], "--hostname", "github.com", ...args.slice(1)])
        } catch {
            throw new Error("Authenticated GitHub release read failed. No automatic retry was attempted")
        }
    }
    // The CLI destination is fixed generated output, never an authored directory
    const directory = resolve(root, "released")
    if (write) {
        await mkdir(directory, { recursive: true })
        const info = await lstat(directory)
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Release archive must be a real generated directory")
        if ((await readdir(directory)).length)
            throw new Error("Release import requires an empty generated archive directory. Existing files are preserved")
    }
    const pages = parseJson(await read(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]))
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
        throw new Error("Invalid paginated GitHub release inventory")
    const published = new Map()
    for (const release of pages.flat()) {
        if (release?.draft === true) continue
        if (release?.draft !== false || typeof release.tag_name !== "string" || !Array.isArray(release.assets))
            throw new Error("Invalid published GitHub release metadata")
        const version = release.tag_name.slice(1)
        try {
            if (!release.tag_name.startsWith("v") || published.has(version)) throw new Error()
            parseVersion(version)
        } catch {
            throw new Error("Release tag does not identify a unique docs version")
        }
        published.set(version, release)
    }
    const archives = new Map()
    const kept = new Set()
    // Older prerelease snapshots stay on GitHub, but do not add downloads or pages to each build
    for (const version of retainedVersions([...published.keys()])) {
        const release = published.get(version)
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
        const matches = (bytes) => Buffer.isBuffer(bytes) && `sha256:${sha256(bytes)}` === asset.digest && bytes.length === asset.size
        const cached = join(cacheDir, `${asset.digest.slice("sha256:".length)}.json`)
        kept.add(cached)
        let bytes = await readFile(cached).catch(() => undefined)
        if (!matches(bytes)) {
            bytes = await read([
                "api",
                `repos/${repository}/releases/assets/${asset.id}`,
                "-H",
                "Accept: application/octet-stream",
            ])
            if (!matches(bytes)) throw new Error("Docs asset checksum mismatch")
            // Written beside its place and renamed, so a stopped run leaves no partial copy under the digest's name
            await mkdir(cacheDir, { recursive: true })
            const partial = `${cached}.${process.pid}.partial`
            await writeFile(partial, bytes)
            await rename(partial, cached)
        }
        let snapshot
        try {
            const parsed = parseJson(bytes)
            // Written for an earlier site, so it stays on GitHub and this site doesn't serve that version
            if (Number.isSafeInteger(parsed?.schemaVersion) && parsed.schemaVersion < snapshotSchema) continue
            snapshot = validateSnapshot(parsed)
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
    // Only the retained releases' copies are kept
    for (const name of await readdir(cacheDir).catch(() => [])) {
        const path = join(cacheDir, name)
        if (/^[a-f0-9]{64}\.json$/.test(name) && !kept.has(path)) await rm(path, { force: true })
    }
    if (!write) return { imported: [...archives.keys()] }
    // Validate remote inputs before writing, but do not claim multi-file atomicity
    // A local write failure preserves the partial archive for explicit reconciliation
    if ((await readdir(directory)).length)
        throw new Error("Release archive changed during import. Existing files are preserved")
    for (const [version, bytes] of archives) {
        const target = join(directory, `${version}.json`)
        try {
            const info = await lstat(directory)
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Release archive destination changed")
            await writeFile(target, bytes, { flag: "wx" })
            if (!(await readFile(target)).equals(bytes)) throw new Error("Release archive readback mismatch")
        } catch {
            throw new Error(
                "Release archive write or readback failed. Existing and partial files are preserved for reconciliation",
            )
        }
    }
    return { imported: [...archives.keys()] }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const args = process.argv.slice(2)
        if (args.some((arg) => arg !== "--cache-only")) throw new Error("The only option is --cache-only, which fills the cache without writing released/")
        console.log(JSON.stringify(await fetchReleases({ write: !args.includes("--cache-only") })))
    } catch (error) {
        console.error(error.message)
        process.exitCode = 1
    }
}
