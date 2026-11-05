import { parseVersion, compareVersions } from "../../release/planning.js"
export { parseVersion, compareVersions }

// The snapshot format this site can build. Older release assets hold another site's pages, so they stay on GitHub and are not served
export const snapshotSchema = 3
const required = ["guides/index.md", "guides/quick-start.md", "guides/meta.json", "guides/glossary.md", "changelog.md", "reference/model.json", "reference/codes.json", "reference/links.json", "reference/endpoints.json"]

export function channelTargets(versions) {
    // Retired channels are never served
    const labels = { stable: "Stable", nightly: "Nightly" }
    const sorted = [...versions].sort(compareVersions).reverse()
    return Object.entries(labels).flatMap(([channel, label]) => {
        const version = sorted.find((v) => parseVersion(v).channel === channel)
        return version ? [{ version, label, path: channel === "stable" ? version : channel }] : []
    })
}

export function defaultVersion(versions) {
    return channelTargets(versions)[0]?.version ?? null
}

export function retainedVersions(versions) {
    const targets = new Set(channelTargets(versions).map((target) => target.version))
    return versions.filter((version) => parseVersion(version).channel === "stable" || targets.has(version))
}

export function validateSnapshot(snapshot) {
    if (snapshot?.schemaVersion !== snapshotSchema || !/^[a-f0-9]{40}$/.test(snapshot.sourceCommit)) throw new Error("Invalid docs provenance")
    parseVersion(snapshot.version)
    if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) throw new Error("Empty docs snapshot")
    const paths = new Set()
    for (const file of snapshot.files) {
        if (
            typeof file.path !== "string" ||
            !/^[\w.\- /]+$/.test(file.path) ||
            file.path.split("/").some((part) => !part || part === "." || part === "..") ||
            paths.has(file.path) ||
            typeof file.content !== "string"
        )
            throw new Error("Invalid docs snapshot file")
        paths.add(file.path)
    }
    if (required.some((path) => !paths.has(path))) throw new Error("Incomplete docs snapshot")
    return snapshot
}

/**
 * Which of the served versions npm marks as deprecated, with npm's own message, from the package's registry document. A served
 * version npm doesn't list throws, since whether it is deprecated is then unknown and the version menu must not leave it out
 * @param {unknown} packument @param {string[]} versions @returns {Record<string, string>}
 */
export function npmDeprecations(packument, versions) {
    const listed = /** @type {{ versions?: Record<string, { deprecated?: unknown }> }} */ (packument)?.versions
    if (!listed || typeof listed !== "object") throw new Error("npm's registry document lists no versions")
    /** @type {Record<string, string>} */
    const deprecated = {}
    for (const version of versions) {
        const entry = listed[version]
        if (!entry || typeof entry !== "object") throw new Error(`npm's registry document doesn't list ${version}, so whether it is deprecated is unknown. A version published a moment ago can take a minute to appear there`)
        if (typeof entry.deprecated === "string" && entry.deprecated.trim()) deprecated[version] = entry.deprecated.trim()
    }
    return deprecated
}
