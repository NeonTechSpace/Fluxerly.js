import { createHash } from "node:crypto"
import { contentFingerprint, exactFiles, readNpmTarball } from "./content.js"

const npmRegistry = "https://registry.npmjs.org"
const maximumBytes = 128 * 1024 * 1024

export function packageName(name) {
    if (!/^@[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._-]*$/.test(name))
        throw new Error("Release package must use a valid scoped name")
    return name
}

export function createRegistries({ fetchImpl = fetch, timeout = 30_000 } = {}) {
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
        return Object.keys(value.versions)
    }

    async function inventory(name, { bootstrap = false } = {}) {
        packageName(name)
        const npm = await json(`${npmRegistry}/${encodeURIComponent(name)}`, bootstrap)
        if (npm && npm.name !== name) throw new Error("npm inventory package identity does not match")
        return {
            npmVersions: npm ? versionMap(npm) : [],
            npmTags: npm?.["dist-tags"] ?? {},
            absent: { npm: npm === null },
        }
    }

    async function npmFiles(name, version, { allowMissing = false } = {}) {
        packageName(name)
        const metadata = await json(`${npmRegistry}/${encodeURIComponent(name)}/${version}`, allowMissing)
        if (metadata === null) return null
        if (metadata.name !== name || metadata.version !== version || !metadata.dist?.tarball)
            throw new Error("npm version metadata does not match its requested identity")
        const compressed = await request(metadata.dist.tarball)
        if (metadata.dist.integrity) {
            const integrity = metadata.dist.integrity
            if (
                typeof integrity !== "string" ||
                !/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity) ||
                `sha512-${createHash("sha512").update(compressed).digest("base64")}` !== integrity
            )
                throw new Error("npm tarball integrity does not match its registry metadata")
        }
        return readNpmTarball(compressed)
    }

    return {
        inventory,
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
