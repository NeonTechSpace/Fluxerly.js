// @ts-check

export const channels = ["canary", "rc", "stable"]

export function parseVersion(version) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(canary|rc)\.(0|[1-9]\d*))?$/.exec(version)
    if (!match) throw new Error("Release version must use numeric SemVer with a canary or rc suffix")
    const [major, minor, patch] = match.slice(1, 4).map(Number)
    const number = match[5] === undefined ? undefined : Number(match[5])
    if (![major, minor, patch, number ?? 0].every(Number.isSafeInteger))
        throw new Error("Release version exceeds safe integer bounds")
    return {
        major,
        minor,
        patch,
        channel: match[4] ?? "stable",
        number,
        core: `${major}.${minor}.${patch}`,
        line: `${major}.${minor}`,
    }
}

export function compareVersions(a, b) {
    a = parseVersion(a)
    b = parseVersion(b)
    for (const key of ["major", "minor", "patch"]) if (a[key] !== b[key]) return a[key] - b[key]
    const rank = { canary: 0, rc: 1, stable: 2 }
    return rank[a.channel] - rank[b.channel] || (a.number ?? 0) - (b.number ?? 0)
}

export function highestBump(types) {
    if (types.some((type) => !["patch", "minor", "major"].includes(type)))
        throw new Error("Unknown Changesets release type")
    return ["major", "minor", "patch"].find((type) => types.includes(type))
}

export function releaseBaseFor(current, releaseBase) {
    if (current.channel === "stable") return current.core
    if (releaseBase === null && current.core === "1000.0.0") return null
    if (typeof releaseBase !== "string")
        throw new Error("Prerelease cycle requires its stable releaseBase, or null for the initial 1000.0.0 cycle")
    const base = parseVersion(releaseBase)
    if (base.channel !== "stable" || base.major < 1000 || compareVersions(releaseBase, current.core) >= 0)
        throw new Error("Prerelease releaseBase must be a stable version below the target")
    return releaseBase
}

/**
 * @param {{ currentVersion: string, channel: string, pendingTypes?: string[], releaseTypes?: string[], releaseBase?: string | null, epoch?: number, allowNoChanges?: boolean }} options
 */
export function planVersion({
    currentVersion,
    channel,
    pendingTypes = [],
    releaseTypes = pendingTypes,
    releaseBase,
    epoch,
    allowNoChanges = false,
}) {
    if (!channels.includes(channel)) throw new Error("Channel must be canary, rc or stable")
    const current = parseVersion(currentVersion)
    const bump = highestBump(pendingTypes)
    const cycleBump = highestBump(releaseTypes)
    if (current.major < 1000) throw new Error("Public releases must use Epoch Semantic Versioning")
    // An RC source promotes to Stable unchanged. Its content check against the published RC runs in candidate.js
    if (channel === "stable" && current.channel === "rc" && bump)
        throw new Error("Publish pending changes as a release candidate before stable")
    const baseVersion = releaseBaseFor(current, releaseBase)
    const base = baseVersion === null ? null : parseVersion(baseVersion)
    let core
    if (epoch !== undefined) {
        if (base === null) throw new Error("The initial release cycle targets Epoch 1 at 1000.0.0")
        if (!Number.isSafeInteger(epoch) || epoch < 1000 || epoch % 1000 !== 0 || epoch <= current.major)
            throw new Error("An explicit epoch must be a higher multiple of 1000")
        if (bump !== "major")
            throw new Error("An epoch transition requires a major Changesets fragment")
        core = `${epoch}.0.0`
    } else if (base === null) {
        core = "1000.0.0"
    } else {
        if (current.channel === "stable" && !bump && !allowNoChanges)
            throw new Error("A stable source version needs a Changesets fragment before another release")
        core =
            cycleBump === "major"
                ? `${base.major + 1}.0.0`
                : cycleBump === "minor"
                  ? `${base.major}.${base.minor + 1}.0`
                  : `${base.major}.${base.minor}.${base.patch + 1}`
        // Preserve an already selected target, including an explicit epoch, if notes are later reduced
        if (current.channel !== "stable" && compareVersions(core, current.core) < 0) core = current.core
    }
    const targetCore = parseVersion(core)
    if (
        Math.floor(targetCore.major / 1000) > Math.floor(current.major / 1000) &&
        current.major >= 1000 &&
        epoch === undefined
    )
        throw new Error("The compatibility-major range is exhausted, select an explicit epoch")
    const promotion = current.major >= 1000 && current.core === core && current.channel !== channel
    if (!allowNoChanges && !bump && !promotion)
        throw new Error("No pending Changesets fragments or readiness promotion")
    if (!allowNoChanges && !bump && current.channel === channel)
        throw new Error("No pending Changesets fragments or readiness promotion")
    if (promotion && compareVersions(`${core}${channel === "stable" ? "" : `-${channel}.0`}`, currentVersion) <= 0)
        throw new Error("Readiness promotion must advance SemVer ordering")
    if (channel === "stable" && current.channel === "rc" && current.core !== core)
        throw new Error("A changed release target must pass through a release candidate before stable")
    // Patch and minor releases may go straight to Stable. A new major version or epoch needs an RC first
    if (channel === "stable" && isBigRelease(core) && !(current.channel === "rc" && current.core === core))
        throw new Error(
            `${core} is a new major version or epoch, publish it as a release candidate first and then promote that RC to Stable`,
        )
    const number = current.channel === channel && current.core === core ? (current.number ?? -1) + 1 : 0
    const version = `${core}${channel === "stable" ? "" : `-${channel}.${number}`}`
    return {
        currentVersion,
        version,
        channel,
        line: targetCore.line,
        bump: bump ?? "patch",
        promotion,
        epoch: epoch ?? null,
        releaseBase: baseVersion,
    }
}

/**
 * Reports whether a version core starts a new major version or epoch. Patch and minor releases always raise the minor
 * or patch number, so only a new major version or epoch ends in `.0.0`
 * @param {string} core
 */
export function isBigRelease(core) {
    const { minor, patch } = parseVersion(core)
    return minor === 0 && patch === 0
}

/**
 * Selects the published version a candidate is compared with. A canary or RC compares with the previous version on
 * its channel and `major.minor` line, or with nothing when the registry inventory lists none. Canaries are experimental
 * and ignore pending RCs.
 *
 * A stable version compares with the newest published RC of the same version, which it must match byte for byte. The
 * pending RC is the newest RC above the newest stable version. While one exists, no other Stable at or above its
 * version can be published, and versions below it stay free. A new major version or epoch needs a published RC. A
 * patch or minor release without an RC of its version compares with nothing
 * @param {{ npmVersions: string[], version: string, channel: string }} options
 * @returns {string | null}
 */
export function selectBaseline({ npmVersions, version, channel }) {
    const target = parseVersion(version)
    if (target.channel !== channel) throw new Error("Candidate version does not match its channel")
    if (!Array.isArray(npmVersions)) throw new Error("Registry version inventory is unavailable")
    const published = npmVersions.map((value) => ({ value, item: parseVersion(value) }))
    if (
        published.some(
            ({ value, item }) =>
                item.line === target.line && item.channel === channel && compareVersions(value, version) > 0,
        )
    )
        throw new Error("A newer version is already published on the selected channel and line")
    const newest = (matches) =>
        published
            .filter(({ value, item }) => matches(item) && compareVersions(value, version) < 0)
            .map(({ value }) => value)
            .sort(compareVersions)
            .at(-1) ?? null
    if (channel !== "stable") return newest((item) => item.line === target.line && item.channel === channel)
    const highest = (values) => values.sort(compareVersions).at(-1) ?? null
    const latestStable = highest(published.filter(({ item }) => item.channel === "stable").map(({ value }) => value))
    const pending = highest(
        published
            .filter(
                ({ item }) =>
                    item.channel === "rc" && (latestStable === null || compareVersions(item.core, latestStable) > 0),
            )
            .map(({ value }) => value),
    )
    if (pending !== null && compareVersions(target.core, parseVersion(pending).core) > 0)
        throw new Error(
            `Release candidate ${pending} is pending, publish ${parseVersion(pending).core} as Stable first or publish a Stable below it`,
        )
    const candidate = newest((item) => item.core === target.core && item.channel === "rc")
    if (candidate === null && isBigRelease(target.core))
        throw new Error(
            `${target.core} is a new major version or epoch, publish ${target.core}-rc.N first and then promote it to Stable`,
        )
    return candidate
}

/**
 * Fails unless a stable candidate carries exactly the publishable content of the release candidate it promotes. A
 * stable candidate without an RC baseline is a direct patch or minor release with nothing to match
 * @param {string} channel
 * @param {string | null} baseline
 * @param {string} fingerprint
 * @param {string | undefined} baselineFingerprint
 */
export function assertStablePromotion(channel, baseline, fingerprint, baselineFingerprint) {
    if (channel === "stable" && baseline !== null && fingerprint !== baselineFingerprint)
        throw new Error(
            `Stable content differs from ${baseline}, publish the changed content as a release candidate first`,
        )
}

export function npmChannelTag(candidate, tags) {
    if (parseVersion(candidate.version).channel !== candidate.channel)
        throw new Error("Candidate version does not match its channel")
    const tag = candidate.channel === "stable" ? "latest" : candidate.channel
    const previous = tags[tag]
    const advance = !previous || compareVersions(candidate.version, previous) > 0
    return { tag, advance, expectedVersion: advance ? candidate.version : previous }
}

// Older maintenance lines publish under a line-specific staging tag instead of moving the channel tag backwards
export function stagingTag(candidate) {
    return `${candidate.channel}-${candidate.line.replaceAll(".", "-")}`
}

/**
 * Reports whether npm distribution tags expose the candidate through its channel tag, or through its line-specific
 * staging tag when the channel tag already points to a newer version
 * @param {{ version: string, channel: string, line: string }} candidate
 * @param {Record<string, string>} tags
 */
export function channelTagState(candidate, tags) {
    const { tag, advance } = npmChannelTag(candidate, tags)
    if (tags[tag] === candidate.version) return { tag, confirmed: true }
    if (advance) return { tag, confirmed: false }
    const staging = stagingTag(candidate)
    return { tag: staging, confirmed: tags[staging] === candidate.version }
}
