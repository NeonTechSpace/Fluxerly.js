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

export function planVersion({
    currentVersion,
    channel,
    pendingTypes = [],
    epoch,
    allowNoChanges = false,
}) {
    if (!channels.includes(channel)) throw new Error("Channel must be canary, rc or stable")
    const current = parseVersion(currentVersion)
    const bump = highestBump(pendingTypes)
    if (current.major < 1000 && currentVersion !== "0.0.0")
        throw new Error("Public releases must use Epoch Semantic Versioning")
    if (currentVersion === "0.0.0" && channel !== "canary")
        throw new Error("The local placeholder must enter the first public canary")
    let core
    if (epoch !== undefined) {
        if (!Number.isSafeInteger(epoch) || epoch < 1000 || epoch % 1000 !== 0 || epoch <= current.major)
            throw new Error("An explicit epoch must be a higher multiple of 1000")
        if (bump !== "major")
            throw new Error("An epoch transition requires a major Changesets fragment")
        core = `${epoch}.0.0`
    } else if (current.major === 0) {
        core = "1000.0.0"
    } else if (current.channel !== "stable") {
        core = current.core
        if (bump === "major") core = `${current.major + 1}.0.0`
        if (bump === "minor") core = `${current.major}.${current.minor + 1}.0`
    } else {
        if (!bump && !allowNoChanges)
            throw new Error("A stable source version needs a Changesets fragment before another release")
        core =
            bump === "major"
                ? `${current.major + 1}.0.0`
                : bump === "minor"
                  ? `${current.major}.${current.minor + 1}.0`
                  : `${current.major}.${current.minor}.${current.patch + 1}`
    }
    const targetCore = parseVersion(core)
    if (
        Math.floor(targetCore.major / 1000) > Math.floor(current.major / 1000) &&
        current.major >= 1000 &&
        epoch === undefined
    )
        throw new Error("The compatibility-major range is exhausted, select an explicit epoch")
    const promotion = current.major >= 1000 && current.core === core && current.channel !== channel
    if (!allowNoChanges && !bump && !promotion && currentVersion !== "0.0.0")
        throw new Error("No pending Changesets fragments or readiness promotion")
    if (!allowNoChanges && !bump && current.channel === channel && currentVersion !== "0.0.0")
        throw new Error("No pending Changesets fragments or readiness promotion")
    if (promotion && compareVersions(`${core}${channel === "stable" ? "" : `-${channel}.0`}`, currentVersion) <= 0)
        throw new Error("Readiness promotion must advance SemVer ordering")
    if (channel === "stable" && current.channel === "canary" && current.core === core)
        throw new Error("Promote the canary to a release candidate before stable")
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
    }
}

export function selectBaseline({ npmVersions, version, channel, bootstrap = false }) {
    const target = parseVersion(version)
    if (target.channel !== channel) throw new Error("Candidate version does not match its channel")
    function latest(versions) {
        if (!Array.isArray(versions)) throw new Error("Registry version inventory is unavailable")
        return (
            versions
                .filter((value) => {
                    const item = parseVersion(value)
                    if (item.line === target.line && item.channel === channel && compareVersions(value, version) > 0)
                        throw new Error("A newer version is already published on the selected channel and line")
                    return item.line === target.line && item.channel === channel && compareVersions(value, version) < 0
                })
                .sort(compareVersions)
                .at(-1) ?? null
        )
    }
    const baseline = latest(npmVersions)
    if (baseline === null && !bootstrap)
        throw new Error("No previous published channel baseline, explicit bootstrap is required")
    if (baseline !== null && bootstrap) throw new Error("Bootstrap is forbidden when a previous channel baseline exists")
    return baseline
}

export function npmChannelTag(candidate, tags) {
    if (parseVersion(candidate.version).channel !== candidate.channel)
        throw new Error("Candidate version does not match its channel")
    const tag = candidate.channel === "stable" ? "latest" : candidate.channel
    const previous = tags[tag]
    const advance = !previous || compareVersions(candidate.version, previous) > 0
    return { tag, advance, expectedVersion: advance ? candidate.version : previous }
}
