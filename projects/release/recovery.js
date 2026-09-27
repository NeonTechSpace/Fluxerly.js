// @ts-check

import { sha256 } from "./content.js"
import { channelTagState, npmChannelTag, parseVersion, stagingTag } from "./planning.js"

/**
 * @typedef {object} PublishedStatus
 * @property {"published" | "missing" | "different"} npm Whether npm serves the reviewed tarball bytes for the version
 * @property {boolean} complete True only when npm serves exactly the reviewed tarball
 * @property {Record<string, string>} distTags Current npm distribution tags
 * @property {{ tag: string, confirmed: boolean }} channelTag Tag expected to expose this candidate
 */

function validateVersion(candidate) {
    const version = parseVersion(candidate.version)
    if (version.major < 1000 || version.channel !== candidate.channel || version.line !== candidate.line)
        throw new Error("Candidate version must match its public release channel and line")
}

function reviewedTarballChecksum(candidate) {
    const checksum = candidate.artifacts?.["sdk.tgz"]?.sha256
    if (typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum))
        throw new Error("Candidate does not bind a reviewed npm tarball checksum")
    return checksum
}

/**
 * Reads npm metadata and, when the version exists, downloads the served tarball to compare it with the reviewed bytes
 * @returns {Promise<PublishedStatus>}
 */
export async function inspectPublished(candidate, registries) {
    validateVersion(candidate)
    const expected = reviewedTarballChecksum(candidate)
    const inventory = await registries.inventory(candidate.name, { allowMissing: true })
    const distTags = inventory.npmTags ?? {}
    const channelTag = channelTagState(candidate, distTags)
    if (!inventory.npmVersions.includes(candidate.version))
        return { npm: "missing", complete: false, distTags, channelTag }
    const served = await registries.npmTarball(inventory.npmDist?.[candidate.version])
    const npm = sha256(served) === expected ? "published" : "different"
    return { npm, complete: npm === "published", distTags, channelTag }
}

function differentBytes(candidate) {
    return new Error(
        `npm serves different bytes for ${candidate.version} than the reviewed candidate. Do not republish, inspect the registry version`,
    )
}

/**
 * Publishes a reviewed candidate at most once per run and is safe to rerun. An existing version with the reviewed bytes
 * is accepted, a missing version is submitted and polled, and an existing version with other bytes fails
 */
export async function publishCandidate(
    candidate,
    {
        registries,
        publisher,
        assertBaseline = async () => registries.inventory(candidate.name, { allowMissing: true }),
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
    if (initial.npm === "different") throw differentBytes(candidate)
    let submitted = false
    let providerFailed = false
    if (initial.npm === "missing") {
        const inventory = await assertBaseline()
        const channel = npmChannelTag(candidate, inventory.npmTags ?? {})
        const tag = channel.advance ? channel.tag : stagingTag(candidate)
        submitted = true
        try {
            await publisher(tag)
        } catch {
            providerFailed = true
        }
    } else progress(`${candidate.version} is already published with the reviewed bytes, confirming its npm tag`)
    const started = now()
    let nextProgress = started
    /** @type {PublishedStatus | undefined} */
    let status
    for (;;) {
        try {
            status = await inspectPublished(candidate, registries)
        } catch {
            // Metadata can fail temporarily after an accepted upload. Keep polling without resubmitting it
            status = undefined
        }
        if (status?.npm === "different") throw differentBytes(candidate)
        if (status?.complete && status.channelTag.confirmed) {
            let final
            try {
                final = await inspectPublished(candidate, registries)
            } catch {
                // A transient final read does not undo the earlier observation
            }
            if (final) {
                if (!final.complete) throw new Error("Publication changed during final npm registry readback")
                if (final.channelTag.confirmed)
                    return { ...final, tag: final.channelTag.tag, published: submitted ? "now" : "already" }
            }
        }
        const remaining = timeout - (now() - started)
        if (remaining <= 0) break
        if (now() >= nextProgress) {
            progress(
                `Waiting for npm to confirm ${candidate.version} and its tag (${Math.ceil(remaining / 60_000)} minutes remaining)`,
            )
            nextProgress = now() + 60_000
        }
        await wait(Math.min(delay, remaining))
    }
    if (status?.complete)
        throw new Error(
            `npm serves ${candidate.version}, but the ${status.channelTag.tag} tag does not point to it. Inspect the tags with the dist-tag runbook, never republish`,
        )
    throw new Error(
        `npm publication is unconfirmed${providerFailed ? " after provider failure" : ""}. Rerun Release publish with the same candidate, it reads npm before any upload`,
    )
}
