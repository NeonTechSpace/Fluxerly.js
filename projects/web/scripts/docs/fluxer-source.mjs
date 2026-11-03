// Reads the Fluxer files the endpoint map needs at the commit projects/release/upstream/manifest.json pins: the OpenAPI
// document, and the docs site's config and HTTP API pages that the manifest lists as endpointDocs. Every file is checked
// against the hash the manifest pins, whether it was downloaded or cached, so a cache can't change what a build reads.
// Files come from raw.githubusercontent.com at the pinned commit, never from a Fluxer host and with no GitHub API call or
// token. A copy is kept in .cache/fluxer/<commit> (gitignored), so a build with an unchanged pin downloads nothing, a new
// pin downloads each file once, and a cached file that no longer matches its hash is downloaded again
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { endpointDocsConfig, endpointDocsDirectory, validateManifest } from "../../../release/upstream.js"

const docsContentPath = dirname(endpointDocsDirectory)
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

// A dropped connection, a server error or a rate limit is tried again, so a blip can't fail a check or a release. A real answer such as 404 isn't
export async function download(url, { attempt = 1, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
    let wait = attempt * 2000
    try {
        const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) })
        if (response.ok) return Buffer.from(await response.arrayBuffer())
        await response.body?.cancel()
        if (response.status !== 429 && response.status < 500) throw Object.assign(new Error(`${url} answered HTTP ${response.status}`), { final: true })
        const asked = Number(response.headers.get("retry-after"))
        if (asked > 0) wait = Math.min(asked, 120) * 1000
        throw new Error(`${url} answered HTTP ${response.status}`)
    } catch (error) {
        if (error.final || attempt >= 6) throw error
        console.warn(`Retrying ${url} in ${Math.round(wait / 1000)} s: ${error.message}`)
        await sleep(wait)
        return download(url, { attempt: attempt + 1, sleep })
    }
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/")

/** One file of a GitHub repository at an exact commit */
export const githubFile = (repository, commit, path) => download(`https://raw.githubusercontent.com/${repository}/${commit}/${encodePath(path)}`)

/**
 * The pinned OpenAPI document, the docs site's config and the HTTP API pages, each from the cache when its copy matches the
 * pin and downloaded into the cache otherwise
 * @returns {Promise<{ openapi: Buffer, config: string, documents: { path: string, text: string }[], downloaded: string[] }>}
 */
export async function fluxerSource(manifest, { cacheDir, fetchFile = githubFile, log = console.log }) {
    validateManifest(manifest)
    if (!manifest.endpointDocs) throw new Error("The upstream manifest pins no endpointDocs. Move the pin with node release/upstream.js --update <commit>")
    const folder = join(cacheDir, manifest.commit)
    const pinned = [manifest.files.openapi, ...manifest.endpointDocs]
    const files = new Map()
    const downloaded = []
    for (const { path, sha256: expected } of pinned) {
        const cached = join(folder, path)
        let bytes = await readFile(cached).catch(() => undefined)
        if (bytes && sha256(bytes) !== expected) {
            log(`The cached ${path} does not match its pinned hash, downloading it again`)
            bytes = undefined
        }
        if (!bytes) {
            if (!downloaded.length) log(`Downloading Fluxer's pinned files at ${manifest.commit.slice(0, 12)} into ${folder}`)
            bytes = await fetchFile(manifest.repository, manifest.commit, path)
            const actual = sha256(bytes)
            if (actual !== expected) throw new Error(`${path} at ${manifest.commit} hashes to ${actual}, not the pinned ${expected}`)
            // Written beside its place and renamed, so an interrupted build leaves no partial file under the pinned name
            await mkdir(dirname(cached), { recursive: true })
            const partial = `${cached}.${process.pid}.partial`
            await writeFile(partial, bytes)
            await rename(partial, cached)
            downloaded.push(path)
        }
        files.set(path, bytes)
    }
    // Only the current pin is kept
    for (const name of await readdir(cacheDir)) if (name !== manifest.commit) await rm(join(cacheDir, name), { recursive: true, force: true })
    return {
        openapi: files.get(manifest.files.openapi.path),
        config: files.get(endpointDocsConfig).toString("utf8"),
        documents: manifest.endpointDocs
            .filter(({ path }) => path !== endpointDocsConfig)
            .map(({ path }) => ({ path: path.slice(docsContentPath.length + 1), text: files.get(path).toString("utf8") })),
        downloaded,
    }
}
