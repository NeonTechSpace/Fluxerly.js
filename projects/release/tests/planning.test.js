import assert from "node:assert/strict"
import test from "node:test"
import { contentFingerprint, exactFiles, readNpmTarball } from "../content.js"
import {
    assertPublishBaseline,
    assertStablePromotion,
    channelTagState,
    channels,
    compareVersions,
    npmChannelTag,
    parseVersion,
    planNightly,
    planVersion,
    selectBaseline,
} from "../planning.js"
import { packages, tarball } from "./helpers.js"

test("Epoch versions separate compatibility changes from readiness", () => {
    const plan = (currentVersion, channel, pendingTypes = [], extra = {}) =>
        planVersion({ currentVersion, channel, pendingTypes, releaseBase: null, ...extra }).version
    assert.equal(plan("1000.0.0-rc.4", "rc", ["patch"]), "1000.0.0-rc.5")
    assert.equal(plan("1000.0.0-rc.4", "rc", ["major", "patch"]), "1000.0.0-rc.5")
    assert.equal(plan("1000.0.0-rc.2", "stable"), "1000.0.0")
    assert.equal(plan("1000.0.0", "stable", ["patch"]), "1000.0.1")
    assert.throws(() => plan("1000.0.0-rc.2", "stable", ["patch"]), /pending changes as a release candidate/)
    assert.equal(plan("1000.0.0", "rc", ["minor"]), "1000.1.0-rc.0")
    assert.equal(plan("1000.0.0", "rc", ["major"]), "1001.0.0-rc.0")
    assert.equal(plan("1001.4.2", "rc", ["major"], { epoch: 2000 }), "2000.0.0-rc.0")
    assert.throws(() => plan("1999.1.0", "rc", ["major"]), /explicit epoch/)
    assert.throws(() => plan("1000.0.0-rc.4", "rc"), /No pending/)
    assert.throws(() => plan("0.0.0", "rc", ["major"]), /Epoch Semantic Versioning/)
    assert.throws(() => plan("0.1.0", "rc", ["patch"]), /Epoch Semantic Versioning/)
    assert.throws(() => plan("0.0.0-rc.1", "rc", ["patch"]), /Epoch Semantic Versioning/)
    assert.throws(() => plan("1000.0.0", "rc", ["minor"], { epoch: 2000 }), /major Changesets/)
    assert.throws(() => plan("1000.0.0", "rc", ["major"], { epoch: 1001 }), /higher multiple/)
})

test("Later prereleases use the stable base rather than repeatedly bumping the preview", () => {
    const plan = (currentVersion, channel, pendingTypes, extra = {}) => planVersion({
        currentVersion, channel, pendingTypes, releaseBase: "1000.2.3", ...extra,
    }).version
    assert.equal(plan("1000.2.4-rc.0", "rc", ["patch"]), "1000.2.4-rc.1")
    assert.equal(plan("1000.2.4-rc.1", "rc", ["minor"]), "1000.3.0-rc.0")
    assert.equal(plan("1000.3.0-rc.0", "rc", ["minor"]), "1000.3.0-rc.1")
    assert.equal(plan("1000.3.0-rc.1", "rc", ["major"]), "1001.0.0-rc.0")
    assert.equal(plan("1001.0.0-rc.0", "rc", ["major"]), "1001.0.0-rc.1")
    assert.equal(plan("1001.0.0-rc.1", "stable", []), "1001.0.0")
    // An explicit epoch selected earlier in the cycle survives later notes
    assert.equal(plan("2000.0.0-rc.0", "rc", ["major"]), "2000.0.0-rc.1")
    assert.throws(() => plan("1000.3.0-rc.0", "stable", ["major"]), /pending changes as a release candidate/)
    assert.throws(() => plan("1000.3.0-rc.0", "stable", [], { releaseTypes: ["major"], allowNoChanges: true }), /changed release target/)
    for (const releaseBase of [undefined, null, "1000.3.0", "1001.0.0", "1000.2.3-rc.0", "0.0.0"])
        assert.throws(() => plan("1000.3.0-rc.0", "rc", [], { releaseBase }), /releaseBase/)
})

test("Only RC and Stable are selectable channels, and nightly versions are never committed to source", () => {
    assert.deepEqual(channels, ["rc", "stable"])
    for (const channel of ["alpha", "beta"]) {
        const version = `1000.0.0-${channel}.1`
        assert.throws(() => parseVersion(version), /numeric SemVer/)
        assert.throws(() => planVersion({ currentVersion: "1000.0.0", channel }), /Channel must be rc or stable/)
        assert.throws(() => contentFingerprint(packages(version)), /Invalid staged package version/)
        assert.throws(() => npmChannelTag({ version, channel }, {}), /numeric SemVer/)
    }
    // Nightly builds are planned at preparation and Canary is retired, so neither is a version pull request target
    for (const channel of ["canary", "nightly"])
        assert.throws(
            () => planVersion({ currentVersion: "1000.0.0", channel, pendingTypes: ["patch"] }),
            /Channel must be rc or stable/,
            channel,
        )
    for (const channel of ["rc", "stable"])
        assert.throws(
            () => planVersion({ currentVersion: "1000.1.0-nightly.0", channel, pendingTypes: ["patch"], releaseBase: "1000.0.0" }),
            /Nightly versions are never committed/,
            channel,
        )
    assert.throws(() => npmChannelTag({ version: "1000.0.0-nightly.1", channel: "beta" }, {}), /does not match/)
})

test("Versions order nightly, rc and stable within a core, and numerically within a channel", () => {
    const versions = [
        "1000.0.1-nightly.0",
        "1000.0.0",
        "1000.0.0-rc.0",
        "1000.0.0-nightly.10",
        "1000.0.0-nightly.2",
        "1000.0.0-rc.10",
    ]
    assert.deepEqual([...versions].sort(compareVersions), [
        "1000.0.0-nightly.2",
        "1000.0.0-nightly.10",
        "1000.0.0-rc.0",
        "1000.0.0-rc.10",
        "1000.0.0",
        "1000.0.1-nightly.0",
    ])
    assert.equal(compareVersions("1000.0.0-nightly.3", "1000.0.0-nightly.3"), 0)
})

test("A published legacy Canary still parses and sorts below nightly and RC builds of its version", () => {
    assert.deepEqual(parseVersion("1000.1.0-canary.7"), {
        major: 1000,
        minor: 1,
        patch: 0,
        channel: "canary",
        number: 7,
        core: "1000.1.0",
        line: "1000.1",
    })
    assert.ok(compareVersions("1000.1.0-canary.7", "1000.1.0-nightly.0") < 0)
    assert.ok(compareVersions("1000.1.0-canary.7", "1000.1.0-rc.0") < 0)
    // Legacy Canary inventory entries never become a nightly or RC baseline and never block one
    const npmVersions = ["1000.0.0", "1000.1.0-canary.7", "1000.1.0-canary.8"]
    assert.equal(selectBaseline({ npmVersions, version: "1000.1.0-nightly.0", channel: "nightly" }), null)
    assert.equal(selectBaseline({ npmVersions, version: "1000.1.0-rc.0", channel: "rc" }), null)
    // A source still at a legacy Canary version promotes through its RC, never straight to Stable
    const plan = (channel, pendingTypes = []) =>
        planVersion({ currentVersion: "1000.0.0-canary.4", channel, pendingTypes, releaseBase: null }).version
    assert.equal(plan("rc", ["minor"]), "1000.0.0-rc.0")
    assert.equal(plan("rc"), "1000.0.0-rc.0")
    assert.throws(() => plan("stable"), /1000.0.0 is a new major version or epoch/)
})

test("Preview baselines are isolated by major.minor line and channel, and a first preview has none", () => {
    const versions = ["1000.0.0", "1000.0.1", "1000.1.0-nightly.0", "1000.1.0-nightly.1"]
    const select = (version, channel) => selectBaseline({ npmVersions: versions, version, channel })
    assert.equal(select("1000.1.0-nightly.2", "nightly"), "1000.1.0-nightly.1")
    assert.equal(select("1000.1.0-rc.0", "rc"), null)
    assert.equal(select("1000.2.0-nightly.0", "nightly"), null)
    assert.throws(() => select("1000.1.0-nightly.0", "nightly"), /newer version/)
    assert.throws(() => selectBaseline({ npmVersions: null, version: "1000.1.0-rc.0", channel: "rc" }), /unavailable/)
})

test("A nightly targets the core the next RC would and follows the newest published nightly of that core", () => {
    const nightly = (currentVersion, extra = {}) => planNightly({ currentVersion, npmVersions: [], number: 0, ...extra })
    // A stable source with no pending notes still builds toward the next patch, never the published Stable
    assert.deepEqual(nightly("1000.2.3"), {
        currentVersion: "1000.2.3",
        version: "1000.2.4-nightly.0",
        channel: "nightly",
        line: "1000.2",
    })
    assert.equal(nightly("1000.2.3", { pendingTypes: ["patch", "minor"] }).version, "1000.3.0-nightly.0")
    assert.equal(nightly("1000.2.3", { pendingTypes: ["major"] }).version, "1001.0.0-nightly.0")
    // An RC cycle keeps its target, and a later major note escalates it as the next RC would
    const cycle = { releaseBase: "1000.2.3", pendingTypes: [], releaseTypes: ["minor"] }
    assert.equal(nightly("1000.3.0-rc.1", cycle).version, "1000.3.0-nightly.0")
    assert.equal(
        nightly("1000.3.0-rc.1", { ...cycle, pendingTypes: ["major"], releaseTypes: ["minor", "major"] }).version,
        "1001.0.0-nightly.0",
    )
    assert.equal(nightly("1000.0.0-rc.7", { releaseBase: null }).version, "1000.0.0-nightly.0")
    // The build number is the nightly number. It must be above published nightlies of the same core, numerically
    const npmVersions = [
        "1000.2.3",
        "1000.3.0-nightly.0",
        "1000.3.0-nightly.10",
        "1000.3.0-nightly.2",
        "1000.2.4-nightly.30",
        "1000.4.0-nightly.40",
        "1000.3.0-rc.50",
        "1000.3.0-canary.60",
    ]
    assert.equal(nightly("1000.3.0-rc.1", { ...cycle, npmVersions, number: 11 }).version, "1000.3.0-nightly.11")
    assert.equal(nightly("1000.3.0-rc.1", { ...cycle, npmVersions, number: 57 }).version, "1000.3.0-nightly.57")
    for (const number of [10, 2])
        assert.throws(
            () => nightly("1000.3.0-rc.1", { ...cycle, npmVersions, number }),
            new RegExp(`number ${number} must be above the published 1000.3.0-nightly.10`),
        )
    for (const number of [undefined, -1, 1.5, "3"])
        assert.throws(() => nightly("1000.2.3", { number }), /whole build number/)
    for (const npmVersions of [undefined, null, { versions: [] }])
        assert.throws(() => nightly("1000.2.3", { npmVersions }), /Registry version inventory is unavailable/)
    assert.throws(() => nightly("1000.3.0-nightly.0", { releaseBase: "1000.2.3" }), /never committed/)
})

test("A stable baseline is the newest published RC of the same version, never an earlier stable", () => {
    const versions = ["1000.0.0", "1000.0.1-rc.0", "1000.0.1-rc.1", "1000.1.0-rc.0"]
    const select = (version) => selectBaseline({ npmVersions: versions, version, channel: "stable" })
    assert.equal(select("1000.0.1"), "1000.0.1-rc.1")
    assert.equal(select("1000.1.0"), "1000.1.0-rc.0")
    assert.throws(
        () => selectBaseline({ npmVersions: ["1000.0.0", "1000.0.1"], version: "1000.0.0", channel: "stable" }),
        /newer version/,
    )
    assert.doesNotThrow(() => assertStablePromotion("stable", "1000.0.1-rc.1", "same", "same"))
    assert.throws(() => assertStablePromotion("stable", "1000.0.1-rc.1", "changed", "same"), /differs from 1000.0.1-rc.1/)
    assert.doesNotThrow(() => assertStablePromotion("rc", "1000.0.1-rc.0", "changed", "same"))
})

test("Patch and minor releases may go straight to Stable, while a new major or epoch needs an RC", () => {
    const plan = (currentVersion, pendingTypes, extra = {}) =>
        planVersion({ currentVersion, channel: "stable", pendingTypes, releaseBase: "1000.2.3", ...extra }).version
    assert.equal(plan("1000.2.3", ["patch"]), "1000.2.4")
    assert.equal(plan("1000.2.3", ["minor", "patch"]), "1000.3.0")
    assert.equal(plan("1000.3.0-rc.0", []), "1000.3.0")
    assert.throws(() => plan("1000.2.3", ["major"]), /1001.0.0 is a new major version or epoch, publish it as a release candidate/)
    assert.throws(() => plan("1001.4.2", ["major"], { epoch: 2000 }), /new major version or epoch/)
    assert.equal(plan("1001.0.0-rc.1", []), "1001.0.0")
})

test("A pending RC blocks every other Stable at or above its version and leaves lower versions free", () => {
    const select = (npmVersions, version) => selectBaseline({ npmVersions, version, channel: "stable" })
    const pending = ["1000.0.0", "1000.1.0-rc.0", "1001.0.0-rc.0", "1001.0.0-rc.1"]
    assert.throws(() => select(pending, "1001.0.1"), /Release candidate 1001.0.0-rc.1 is pending, publish 1001.0.0 as Stable first/)
    assert.throws(() => select(pending, "1001.1.0"), /1001.0.0-rc.1 is pending/)
    assert.throws(() => select(pending, "1002.0.0"), /1001.0.0-rc.1 is pending/)
    // The matching Stable compares with the newest RC of its version and must match its bytes
    assert.equal(select(pending, "1001.0.0"), "1001.0.0-rc.1")
    // A hotfix below the pending RC needs no RC. A superseded RC of the same version still sets its content
    assert.equal(select(pending, "1000.0.1"), null)
    assert.equal(select(pending, "1000.1.0"), "1000.1.0-rc.0")
    // RCs at or below the newest Stable are no longer pending
    assert.equal(select([...pending, "1001.0.0"], "1001.0.1"), null)
    assert.equal(select(["1000.0.0", "1000.0.1-rc.0", "1000.1.0"], "1000.1.1"), null)
    // Without a pending RC, patch and minor releases are free and a new major or epoch still needs its RC
    assert.equal(select(["1000.0.0"], "1000.0.1"), null)
    assert.equal(select(["1000.0.0"], "1000.1.0"), null)
    assert.equal(select([], "1000.0.1"), null)
    assert.throws(() => select(["1000.0.0"], "1001.0.0"), /1001.0.0 is a new major version or epoch, publish 1001.0.0-rc.N first/)
    assert.throws(() => select(["1001.4.2"], "2000.0.0"), /2000.0.0 is a new major version or epoch/)
})

test("Nightly builds are experimental, ignore a pending RC and publish under the nightly tag", () => {
    const npmVersions = ["1000.0.0", "1001.0.0-rc.0", "1001.1.0-nightly.0"]
    const candidate = { version: "1001.1.0-nightly.1", channel: "nightly", line: "1001.1" }
    assert.equal(selectBaseline({ npmVersions, ...candidate }), "1001.1.0-nightly.0")
    assert.equal(selectBaseline({ npmVersions, version: "1002.0.0-nightly.0", channel: "nightly" }), null)
    // A nightly of the pending RC's own version neither compares with that RC nor waits for its Stable
    assert.equal(selectBaseline({ npmVersions, version: "1001.0.0-nightly.0", channel: "nightly" }), null)
    const tags = { latest: "1000.0.0", rc: "1001.0.0-rc.0", nightly: "1001.1.0-nightly.0" }
    assert.deepEqual(npmChannelTag(candidate, tags), { tag: "nightly", advance: true, expectedVersion: "1001.1.0-nightly.1" })
    assert.throws(() => selectBaseline({ npmVersions: [...npmVersions, "1001.1.0-nightly.3"], ...candidate }), /newer version/)
})

test("Only release version and changelog bookkeeping are normalized", () => {
    const original = packages("1000.0.0-nightly.0")
    const promoted = packages("1000.0.0-rc.0")
    assert.equal(contentFingerprint(original), contentFingerprint(promoted))
    assert.notDeepEqual(exactFiles(original), exactFiles(promoted))
    assert.notEqual(
        contentFingerprint(original),
        contentFingerprint(packages("1000.0.0-nightly.1", "export const value = 2\n")),
    )
    assert.notEqual(
        contentFingerprint(original),
        contentFingerprint(packages("1000.0.0-nightly.1", undefined, "Changed metadata")),
    )
    const comments = packages("1000.0.0-nightly.1", "/** Changed caller documentation */\nexport const value = 1\n")
    assert.notEqual(contentFingerprint(original), contentFingerprint(comments))
    const guide = packages("1000.0.0-nightly.1")
    guide.set("README.md", Buffer.from("Changed package guide\n"))
    assert.notEqual(contentFingerprint(original), contentFingerprint(guide))
    const reordered = new Map([...original].reverse())
    assert.equal(contentFingerprint(original), contentFingerprint(reordered))
})

test("npm archives establish actual file bytes and reject unsafe inventories", () => {
    const files = packages("1000.0.0-nightly.0")
    assert.deepEqual(exactFiles(readNpmTarball(tarball(files))), exactFiles(files))
    assert.throws(() => readNpmTarball(tarball(new Map([["../escape", Buffer.from("bad")]]))), /Unsafe/)
    const corrupt = Buffer.from(tarball(files))
    corrupt[corrupt.length - 4] ^= 1
    assert.throws(() => readNpmTarball(corrupt), { code: "Z_DATA_ERROR" })
})

test("npm uses nightly, rc and latest tags without moving older release lines backwards", () => {
    assert.deepEqual(npmChannelTag({ version: "1000.0.1", channel: "stable" }, { latest: "1000.1.0" }), {
        tag: "latest",
        advance: false,
        expectedVersion: "1000.1.0",
    })
    assert.deepEqual(npmChannelTag({ version: "1000.1.0-nightly.0", channel: "nightly" }, { latest: "1000.0.0" }), {
        tag: "nightly",
        advance: true,
        expectedVersion: "1000.1.0-nightly.0",
    })
    assert.deepEqual(npmChannelTag({ version: "1000.1.0-rc.0", channel: "rc" }, { nightly: "1000.1.0-nightly.2" }), {
        tag: "rc",
        advance: true,
        expectedVersion: "1000.1.0-rc.0",
    })
    for (const channel of ["nightly", "rc"]) {
        const version = `1000.0.0-${channel}.2`
        const previous = `1000.1.0-${channel}.1`
        assert.deepEqual(npmChannelTag({ version, channel }, { [channel]: previous }), {
            tag: channel,
            advance: false,
            expectedVersion: previous,
        })
    }
    assert.deepEqual(npmChannelTag({ version: "1000.1.0", channel: "stable" }, { latest: "1000.1.0" }), {
        tag: "latest",
        advance: false,
        expectedVersion: "1000.1.0",
    })
})

test("npm tag confirmation accepts the channel tag or, behind a newer line, only the staging tag", () => {
    const older = { version: "1000.0.2-nightly.0", channel: "nightly", line: "1000.0" }
    assert.deepEqual(channelTagState(older, { nightly: "1000.0.2-nightly.0" }), { tag: "nightly", confirmed: true })
    assert.deepEqual(channelTagState(older, { nightly: "1000.1.0-nightly.3" }), { tag: "nightly-1000-0", confirmed: false })
    assert.deepEqual(channelTagState(older, { nightly: "1000.1.0-nightly.3", "nightly-1000-0": "1000.0.2-nightly.0" }), {
        tag: "nightly-1000-0",
        confirmed: true,
    })
    const stable = { version: "1000.0.0", channel: "stable", line: "1000.0" }
    // latest follows the newest preview until the first stable release moves it
    assert.deepEqual(channelTagState(stable, { latest: "1000.0.0-rc.0" }), { tag: "latest", confirmed: false })
    assert.deepEqual(channelTagState(stable, { latest: "1000.0.0" }), { tag: "latest", confirmed: true })
})

test("Publication accepts a nightly baseline that advanced since preparation, but never another changed baseline", async () => {
    const nightly = (baseline) => ({
        version: "1000.1.0-nightly.57",
        channel: "nightly",
        contentFingerprint: "new",
        baseline: baseline && { version: baseline },
    })
    const published = ["1000.1.0-nightly.55", "1000.1.0-nightly.56"]
    const fingerprints = { "1000.1.0-nightly.55": "old", "1000.1.0-nightly.56": "older" }
    const check = (candidate, npmVersions) =>
        assertPublishBaseline(candidate, npmVersions, async (version) => fingerprints[version])
    await check(nightly("1000.1.0-nightly.56"), published)
    // Run 56 published while run 57 was being prepared against 55, or against no earlier nightly
    await check(nightly("1000.1.0-nightly.55"), published)
    await check(nightly(null), published)
    // Content identical to the nightly that published meanwhile is not published again
    fingerprints["1000.1.0-nightly.56"] = "new"
    await assert.rejects(check(nightly("1000.1.0-nightly.55"), published), /matches 1000.1.0-nightly.56/)
    // A baseline that disappeared or moved backwards is not an earlier nightly finishing
    await assert.rejects(check(nightly("1000.1.0-nightly.56"), ["1000.1.0-nightly.55"]), /baseline changed/)
    await assert.rejects(check(nightly("1000.1.0-nightly.55"), []), /baseline changed/)
    // A newer nightly on the line already won
    await assert.rejects(
        check(nightly("1000.1.0-nightly.55"), [...published, "1000.1.0-nightly.58"]),
        /newer version is already published/,
    )
    // Reviewed channels keep the exact baseline they were reviewed against
    const rc = { version: "1000.1.0-rc.2", channel: "rc", contentFingerprint: "new", baseline: { version: "1000.1.0-rc.0" } }
    await assert.rejects(check(rc, ["1000.1.0-rc.0", "1000.1.0-rc.1"]), /baseline changed/)
    await check(rc, ["1000.1.0-rc.0"])
})
