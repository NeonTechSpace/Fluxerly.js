import { parseVersion, compareVersions } from "../../release/planning.js"
export { parseVersion, compareVersions }
export function channelTargets(versions) {
    const labels = { stable: "Stable", rc: "RC", canary: "Canary" }
    const sorted = [...versions].sort(compareVersions).reverse()
    const targets = Object.entries(labels).flatMap(([channel, label]) => {
        const version = sorted.find((v) => parseVersion(v).channel === channel)
        return version ? [{ version, label }] : []
    })
    return targets
}
export function defaultVersion(versions) {
    return channelTargets(versions)[0]?.version ?? null
}
export function validateSnapshot(snapshot) {
    if (snapshot?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(snapshot.sourceCommit))
        throw new Error("Invalid docs provenance")
    parseVersion(snapshot.version)
    if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) throw new Error("Empty docs snapshot")
    const paths = new Set()
    for (const file of snapshot.files) {
        if (
            typeof file.path !== "string" ||
            !/^[\w.\- /]+\.(md|json)$/.test(file.path) ||
            file.path.split("/").some((p) => !p || p === "." || p === "..") ||
            paths.has(file.path) ||
            typeof file.content !== "string"
        )
            throw new Error("Invalid docs snapshot file")
        paths.add(file.path)
    }
    if (!paths.has("index.md") || !paths.has("quick-start.md") || !paths.has("changelog.md"))
        throw new Error("Incomplete docs snapshot")
    return snapshot
}
