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
 * Uploads a missing candidate unless a nightly published meanwhile supersedes it. A candidate version that appeared
 * meanwhile is confirmed by the caller instead of uploaded or superseded
 * @returns {Promise<{ superseded: string } | { submitted: boolean, providerFailed: boolean }>}
 */
async function uploadMissing(candidate, { publisher, assertBaseline }) {
    const { inventory, superseded } = await assertBaseline()
    const appeared = inventory.npmVersions.includes(candidate.version)
    if (superseded && !appeared) return { superseded }
    if (appeared) return { submitted: false, providerFailed: false }
    const channel = npmChannelTag(candidate, inventory.npmTags ?? {})
    const tag = channel.advance ? channel.tag : stagingTag(candidate)
    try {
        await publisher(tag)
        return { submitted: true, providerFailed: false }
    } catch {
        return { submitted: true, providerFailed: true }
    }
}

/** Reads the status, treating a transient metadata failure after an accepted upload as no observation */
async function observePublished(candidate, registries) {
    try {
        return await inspectPublished(candidate, registries)
    } catch {
        // Metadata can fail temporarily after an accepted upload. Keep polling without resubmitting it
        return undefined
    }
}

/**
 * Re-reads a confirmed publication once more. Returns the status that ends the confirmation, or undefined to keep polling
 * @returns {Promise<PublishedStatus | undefined>}
 */
async function readbackPublished(candidate, registries) {
    let final
    try {
        final = await inspectPublished(candidate, registries)
    } catch {
        // A transient final read does not undo the earlier observation
    }
    if (!final) return undefined
    if (!final.complete) throw new Error("Publication changed during final npm registry readback")
    return final.channelTag.confirmed ? final : undefined
}

/** Polls npm until the reviewed bytes and the channel tag are confirmed, or the deadline passes */
async function confirmPublication(
    candidate,
    registries,
    { submitted, providerFailed, wait, now, timeout, delay, progress },
) {
    const started = now()
    let nextProgress = started
    /** @type {PublishedStatus | undefined} */
    let status
    for (;;) {
        status = await observePublished(candidate, registries)
        if (status?.npm === "different") throw differentBytes(candidate)
        if (status?.complete && status.channelTag.confirmed) {
            const final = await readbackPublished(candidate, registries)
            if (final) return { ...final, tag: final.channelTag.tag, published: submitted ? "now" : "already" }
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

/**
 * Publishes a reviewed candidate at most once per run and is safe to rerun. An existing version with the reviewed bytes
 * is accepted, a missing version is submitted and polled, and an existing version with other bytes fails. A nightly
 * whose content matches a nightly published after its preparation is superseded and uploads nothing, unless its own
 * version appeared meanwhile. `assertBaseline` returns the fresh registry inventory and any superseding version
 * @returns {Promise<
 *     | (PublishedStatus & { tag: string, published: string, outcome?: undefined, supersededBy?: undefined })
 *     | { outcome: "superseded", supersededBy: string }
 * >}
 */
export async function publishCandidate(
    candidate,
    {
        registries,
        publisher,
        assertBaseline = async () => ({ inventory: await registries.inventory(candidate.name, { allowMissing: true }) }),
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
    let upload = { submitted: false, providerFailed: false }
    if (initial.npm === "missing") {
        const result = await uploadMissing(candidate, { publisher, assertBaseline })
        if ("superseded" in result) return { outcome: "superseded", supersededBy: result.superseded }
        upload = result
    } else progress(`${candidate.version} is already published with the reviewed bytes, confirming its npm tag`)
    return confirmPublication(candidate, registries, { ...upload, wait, now, timeout, delay, progress })
}
