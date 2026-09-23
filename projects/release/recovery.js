import { parseVersion } from "./planning.js"

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
        now = () => performance.now(),
        timeout = 20 * 60_000,
        delay = 5000,
        progress = (message) => console.error(message),
    },
) {
    validateVersion(candidate)
    if (!Number.isFinite(timeout) || timeout < 0 || !Number.isFinite(delay) || delay <= 0)
        throw new Error("Invalid npm publication confirmation deadline or delay")
    const initial = await inspectPublished(candidate, registries)
    if (initial.complete)
        throw new Error(`${candidate.version} is already published, recover from the original immutable candidate`)
    let providerFailed = false
    try {
        await publisher(candidate)
    } catch {
        providerFailed = true
    }
    const started = now()
    let nextProgress = started
    for (;;) {
        let status
        try {
            status = await inspectPublished(candidate, registries)
        } catch {
            // Metadata can fail temporarily after an accepted upload. Keep polling without resubmitting it
        }
        if (status?.complete) {
            let final
            try {
                final = await inspectPublished(candidate, registries)
            } catch {
                // A transient final read does not undo the earlier version observation
            }
            if (final) {
                if (!final.complete) throw new Error("Publication changed during final npm registry readback")
                return final
            }
        }
        const remaining = timeout - (now() - started)
        if (remaining <= 0) break
        if (now() >= nextProgress) {
            progress(
                `Waiting for npm to confirm ${candidate.version} (${Math.ceil(remaining / 60_000)} minutes remaining)`,
            )
            nextProgress = now() + 60_000
        }
        await wait(Math.min(delay, remaining))
    }
    throw new Error(
        `npm publication is unconfirmed${providerFailed ? " after provider failure" : ""}, check version availability before retrying the same candidate`,
    )
}
