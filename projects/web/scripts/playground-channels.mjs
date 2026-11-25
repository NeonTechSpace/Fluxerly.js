// Resolves and caches the published npm @nightly SDK tarball for the Playground channel switcher
// strictly when Nightly is newer than Stable, verifying SHA-512 integrity before unpacking
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { compareVersions, parseVersion } from "./versions.js"

const execFileAsync = promisify(execFile)
const webRoot = fileURLToPath(new URL("../", import.meta.url))
const defaultCacheRoot = join(webRoot, ".cache/playground-sdk")

/**
 * Selects the published npm nightly version only when it is strictly newer than the served Stable version.
 * Returns null when Stable already includes the latest changes or when metadata is incomplete
 * @param {unknown} packument
 * @param {string} stableVersion
 */
export function selectPlaygroundNightly(packument, stableVersion) {
    if (!packument || typeof packument !== "object" || !stableVersion) return null
    const doc = /** @type {{ "dist-tags"?: Record<string, unknown>; versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown } }> }} */ (packument)
    const nightly = doc["dist-tags"]?.nightly
    if (typeof nightly !== "string" || !nightly.trim()) return null
    try {
        if (parseVersion(nightly).channel !== "nightly") return null
        if (compareVersions(nightly, stableVersion) <= 0) return null
    } catch {
        return null
    }
    const dist = doc.versions?.[nightly]?.dist
    const tarball = typeof dist?.tarball === "string" ? dist.tarball : ""
    const integrity = typeof dist?.integrity === "string" ? dist.integrity : ""
    if (!tarball.startsWith("https://registry.npmjs.org/") || !integrity.startsWith("sha512-")) {
        return null
    }
    return { version: nightly, tarball, integrity }
}

async function exists(path) {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

/**
 * Downloads (once per version), verifies SHA-512 integrity, and unpacks the npm tarball into a cached directory.
 * Repeat builds for the same version reuse the verified unpacked copy without contacting npm
 * @param {{ version: string; tarball: string; integrity: string; cacheRoot?: string }} target
 */
export async function prepareNightlySdkDir({ version, tarball, integrity, cacheRoot = defaultCacheRoot }) {
    const targetDir = join(cacheRoot, version)
    const markerPath = join(targetDir, ".ready.json")
    if (await exists(markerPath)) {
        try {
            const marker = JSON.parse(await readFile(markerPath, "utf8"))
            if (
                marker.version === version &&
                marker.integrity === integrity &&
                (await exists(join(targetDir, "dist/index.js"))) &&
                (await exists(join(targetDir, "dist/index.d.ts")))
            ) {
                return targetDir
            }
        } catch {
            // Re-download below if cache metadata is corrupt
        }
    }

    await mkdir(cacheRoot, { recursive: true })
    const response = await fetch(tarball, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) {
        throw new Error(`Could not download nightly SDK tarball ${tarball} (HTTP ${response.status})`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    const expectedHash = integrity.slice("sha512-".length)
    const actualHash = createHash("sha512").update(bytes).digest("base64")
    if (actualHash !== expectedHash) {
        throw new Error(`Nightly SDK tarball integrity mismatch for ${version}`)
    }

    const stageRoot = await mkdtemp(join(cacheRoot, ".stage-"))
    const archivePath = join(stageRoot, "package.tgz")
    const unpackedDir = join(stageRoot, "unpacked")
    try {
        await mkdir(unpackedDir, { recursive: true })
        await writeFile(archivePath, bytes)
        await execFileAsync("tar", ["-xzf", archivePath, "--strip-components=1", "-C", unpackedDir])
        if (!(await exists(join(unpackedDir, "dist/index.js"))) || !(await exists(join(unpackedDir, "dist/index.d.ts")))) {
            throw new Error(`Nightly SDK tarball for ${version} is missing built dist files`)
        }
        await writeFile(join(unpackedDir, ".ready.json"), JSON.stringify({ version, integrity }))
        await rm(targetDir, { recursive: true, force: true })
        await rename(unpackedDir, targetDir)
    } finally {
        await rm(stageRoot, { recursive: true, force: true })
    }
    return targetDir
}
