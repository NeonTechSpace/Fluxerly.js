import { parseVersion } from "./planning.mjs"

function validateVersion(candidate) {
    const version = parseVersion(candidate.version)
    if (version.major < 1000 || version.channel !== candidate.channel || version.line !== candidate.line)
        throw new Error("Candidate version must match its public release channel and line")
}

export async function inspectPublished(candidate, registries) {
    validateVersion(candidate)
    const inventory = await registries.inventory(candidate.name, { bootstrap: true })
    const npm = inventory.npmVersions.includes(candidate.version) ? "published" : "missing"
    return { npm, complete: npm === "published" }
}

// Registry metadata confirms version availability, not the published file contents
export async function publishCandidate(
    candidate,
    {
        registries,
        publisher,
        wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        attempts = 6,
        delay = 5000,
    },
) {
    validateVersion(candidate)
    const initial = await inspectPublished(candidate, registries)
    if (initial.complete)
        throw new Error(`${candidate.version} is already published, recover from the original immutable candidate`)
    let providerFailed = false
    try {
        await publisher(candidate)
    } catch {
        providerFailed = true
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
        const status = await inspectPublished(candidate, registries)
        if (status.complete) {
            const final = await inspectPublished(candidate, registries)
            if (!final.complete) throw new Error("Publication changed during final npm registry readback")
            return final
        }
        if (attempt + 1 < attempts) await wait(delay)
    }
    throw new Error(
        `npm publication is unconfirmed${providerFailed ? " after provider failure" : ""}, check version availability before retrying the same candidate`,
    )
}
