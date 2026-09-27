// @ts-check

import { createHash } from "node:crypto"
import { contentFingerprint, exactFiles, readNpmTarball } from "./content.js"

const npmRegistry = "https://registry.npmjs.org"
const maximumBytes = 128 * 1024 * 1024

/** @typedef {{ tarball: string, integrity: string }} NpmDist */
/**
 * @typedef {object} NpmInventory
 * @property {string[]} npmVersions
 * @property {Record<string, string>} npmTags
 * @property {Record<string, NpmDist | undefined>} npmDist
 * @property {{ npm: boolean }} absent
 */

export function packageName(name) {
    if (!/^@[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._-]*$/.test(name))
        throw new Error("Release package must use a valid scoped name")
    return name
}

export function sha512Integrity(bytes) {
    return `sha512-${createHash("sha512").update(bytes).digest("base64")}`
}

/** @param {{ fetchImpl?: typeof fetch, timeout?: number }} [options] */
export function createRegistries({ fetchImpl = fetch, timeout = 30_000 } = {}) {
    /**
     * @param {string} url
     * @param {boolean} [allowMissing]
     * @returns {Promise<Buffer | null>}
     */
    async function request(url, allowMissing = false) {
        const target = new URL(url)
        if (target.origin !== npmRegistry || target.username || target.password)
            throw new Error("Registry content URL is outside the official npm registry")
        let response
        try {
            response = await fetchImpl(target, {
                headers: { accept: "application/json, application/octet-stream" },
                signal: AbortSignal.timeout(timeout),
                redirect: "error",
            })
        } catch {
            throw new Error("Registry request failed or exceeded its deadline")
        }
        if (response.status === 404 && allowMissing) {
            await response.body?.cancel()
            return null
        }
        if (!response.ok) {
            await response.body?.cancel()
            throw new Error(`Registry request returned HTTP ${response.status}`)
        }
        const reader = response.body?.getReader()
        if (!reader) throw new Error("Registry response has no body")
        let total = 0
        const chunks = []
        try {
            for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                total += value.length
                if (total > maximumBytes) throw new Error("Registry response exceeds the byte limit")
                chunks.push(value)
            }
        } finally {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
        }
        return Buffer.concat(chunks)
    }

    /** @param {string} url */
    async function required(url) {
        const bytes = await request(url)
        if (bytes === null) throw new Error("Registry response is missing")
        return bytes
    }

    async function json(url, allowMissing = false) {
        const bytes = await request(url, allowMissing)
        if (bytes === null) return null
        try {
            const value = JSON.parse(bytes.toString("utf8"))
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
            return value
        } catch {
            throw new Error("Registry metadata is not a valid JSON object")
        }
    }

    function versionMap(value) {
        if (!value.versions || typeof value.versions !== "object" || Array.isArray(value.versions))
            throw new Error("Registry metadata has no version inventory")
        return value.versions
    }

    /**
     * @param {string} name
     * @param {{ allowMissing?: boolean }} [options] Permits a missing package, which reads as an empty inventory
     * @returns {Promise<NpmInventory>}
     */
    async function inventory(name, { allowMissing = false } = {}) {
        packageName(name)
        const npm = await json(`${npmRegistry}/${encodeURIComponent(name)}`, allowMissing)
        if (npm && npm.name !== name) throw new Error("npm inventory package identity does not match")
        const versions = npm ? versionMap(npm) : {}
        /** @type {Record<string, NpmDist | undefined>} */
        const npmDist = {}
        for (const [version, metadata] of Object.entries(versions)) {
            const dist = metadata?.dist
            if (typeof dist?.tarball === "string" && typeof dist?.integrity === "string")
                npmDist[version] = { tarball: dist.tarball, integrity: dist.integrity }
        }
        return {
            npmVersions: Object.keys(versions),
            npmTags: npm?.["dist-tags"] ?? {},
            npmDist,
            absent: { npm: npm === null },
        }
    }

    /**
     * Downloads the tarball npm serves for a version and verifies it against the registry's SHA-512 integrity
     * @param {NpmDist | undefined} dist
     */
    async function npmTarball(dist) {
        if (
            typeof dist?.integrity !== "string" ||
            !/^sha512-[A-Za-z0-9+/]+=*$/.test(dist.integrity) ||
            typeof dist.tarball !== "string"
        )
            throw new Error("npm version metadata has no SHA-512 tarball integrity")
        const compressed = await required(dist.tarball)
        if (sha512Integrity(compressed) !== dist.integrity)
            throw new Error("npm tarball integrity does not match its registry metadata")
        return compressed
    }

    async function npmFiles(name, version) {
        packageName(name)
        const metadata = await json(`${npmRegistry}/${encodeURIComponent(name)}/${version}`)
        if (metadata.name !== name || metadata.version !== version || !metadata.dist?.tarball)
            throw new Error("npm version metadata does not match its requested identity")
        return readNpmTarball(await npmTarball(metadata.dist))
    }

    return {
        inventory,
        npmTarball,
        npmFiles,
        async baseline(name, version) {
            const npm = await npmFiles(name, version)
            return {
                version,
                contentFingerprint: contentFingerprint(npm),
                files: exactFiles(npm),
            }
        },
    }
}
