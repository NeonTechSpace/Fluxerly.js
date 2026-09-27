import assert from "node:assert/strict"
import test from "node:test"
import { contentFingerprint, exactFiles, readNpmTarball } from "../content.js"
import {
    assertStablePromotion,
    channelTagState,
    channels,
    compareVersions,
    npmChannelTag,
    parseVersion,
    planVersion,
    selectBaseline,
} from "../planning.js"
import { packages, tarball } from "./helpers.js"

test("Epoch versions separate compatibility changes from readiness", () => {
    const plan = (currentVersion, channel, pendingTypes = [], extra = {}) =>
        planVersion({ currentVersion, channel, pendingTypes, releaseBase: null, ...extra }).version
    assert.equal(plan("1000.0.0-canary.4", "canary", ["patch"]), "1000.0.0-canary.5")
    assert.equal(plan("1000.0.0-canary.4", "rc", ["minor"]), "1000.0.0-rc.0")
    assert.equal(plan("1000.0.0-canary.4", "rc", ["major", "patch"]), "1000.0.0-rc.0")
    assert.equal(plan("1000.0.0-canary.4", "rc"), "1000.0.0-rc.0")
    assert.equal(plan("1000.0.0-rc.2", "stable"), "1000.0.0")
    assert.equal(plan("1000.0.0", "stable", ["patch"]), "1000.0.1")
    assert.throws(() => plan("1000.0.0-rc.2", "stable", ["patch"]), /pending changes as a release candidate/)
    assert.equal(plan("1000.0.0", "canary", ["minor"]), "1000.1.0-canary.0")
    assert.equal(plan("1000.0.0", "canary", ["major"]), "1001.0.0-canary.0")
    assert.equal(plan("1001.4.2", "canary", ["major"], { epoch: 2000 }), "2000.0.0-canary.0")
    assert.throws(() => plan("1999.1.0", "canary", ["major"]), /explicit epoch/)
    assert.throws(() => plan("1000.0.0-canary.4", "canary"), /No pending/)
    assert.throws(() => plan("1000.0.0-canary.4", "stable"), /1000.0.0 is a new major version or epoch/)
    assert.throws(() => plan("1000.0.0-rc.4", "canary"), /advance SemVer/)
    assert.throws(() => plan("0.0.0", "canary", ["major"]), /Epoch Semantic Versioning/)
    assert.throws(() => plan("0.1.0", "canary", ["patch"]), /Epoch Semantic Versioning/)
    assert.throws(() => plan("0.0.0-canary.1", "canary", ["patch"]), /Epoch Semantic Versioning/)
    assert.throws(() => plan("1000.0.0", "canary", ["minor"], { epoch: 2000 }), /major Changesets/)
    assert.throws(() => plan("1000.0.0", "canary", ["major"], { epoch: 1001 }), /higher multiple/)
    assert.equal(compareVersions("1000.0.0-canary.10", "1000.0.0-rc.0") < 0, true)
    assert.equal(compareVersions("1000.0.0-rc.10", "1000.0.0") < 0, true)
})

test("Later prereleases use the stable base rather than repeatedly bumping the preview", () => {
    const plan = (currentVersion, channel, pendingTypes, extra = {}) => planVersion({
        currentVersion, channel, pendingTypes, releaseBase: "1000.2.3", ...extra,
    }).version
    assert.equal(plan("1000.2.4-canary.0", "canary", ["patch"]), "1000.2.4-canary.1")
    assert.equal(plan("1000.2.4-canary.1", "canary", ["minor"]), "1000.3.0-canary.0")
    assert.equal(plan("1000.3.0-canary.0", "rc", ["minor"]), "1000.3.0-rc.0")
    assert.equal(plan("1000.3.0-rc.0", "rc", ["major"]), "1001.0.0-rc.0")
    assert.equal(plan("1001.0.0-rc.0", "rc", ["major"]), "1001.0.0-rc.1")
    assert.equal(plan("1001.0.0-rc.1", "stable", []), "1001.0.0")
    assert.equal(plan("2000.0.0-canary.0", "rc", ["major"]), "2000.0.0-rc.0")
    assert.throws(() => plan("1000.3.0-rc.0", "stable", ["major"]), /pending changes as a release candidate/)
    assert.throws(() => plan("1000.3.0-rc.0", "stable", [], { releaseTypes: ["major"], allowNoChanges: true }), /changed release target/)
    assert.throws(() => plan("1000.3.0-canary.0", "stable", ["major"]), /release candidate/)
    for (const releaseBase of [undefined, null, "1000.3.0", "1001.0.0", "1000.2.3-rc.0", "0.0.0"])
        assert.throws(() => plan("1000.3.0-canary.0", "rc", [], { releaseBase }), /releaseBase/)
})

test("Only Canary, RC and Stable are accepted release channels", () => {
    assert.deepEqual(channels, ["canary", "rc", "stable"])
    for (const channel of ["alpha", "beta"]) {
        const version = `1000.0.0-${channel}.1`
        assert.throws(() => parseVersion(version), /canary or rc suffix/)
        assert.throws(() => planVersion({ currentVersion: "1000.0.0", channel }), /Channel must/)
        assert.throws(() => contentFingerprint(packages(version)), /Invalid staged package version/)
        assert.throws(() => npmChannelTag({ version, channel }, {}), /canary or rc suffix/)
    }
    assert.throws(() => npmChannelTag({ version: "1000.0.0-canary.1", channel: "beta" }, {}), /does not match/)
})

test("Preview baselines are isolated by major.minor line and channel, and a first preview has none", () => {
    const versions = ["1000.0.0", "1000.0.1", "1000.1.0-canary.0", "1000.1.0-canary.1"]
    const select = (version, channel) => selectBaseline({ npmVersions: versions, version, channel })
    assert.equal(select("1000.1.0-canary.2", "canary"), "1000.1.0-canary.1")
    assert.equal(select("1000.1.0-rc.0", "rc"), null)
    assert.equal(select("1000.2.0-canary.0", "canary"), null)
    assert.throws(() => select("1000.1.0-canary.0", "canary"), /newer version/)
    assert.throws(() => selectBaseline({ npmVersions: null, version: "1000.1.0-rc.0", channel: "rc" }), /unavailable/)
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
    assert.equal(plan("1000.2.4-canary.1", ["patch"]), "1000.2.4")
    assert.equal(plan("1000.3.0-canary.0", []), "1000.3.0")
    assert.throws(() => plan("1000.2.3", ["major"]), /1001.0.0 is a new major version or epoch, publish it as a release candidate/)
    assert.throws(() => plan("1001.0.0-canary.0", []), /1001.0.0 is a new major version or epoch/)
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

test("Canaries are experimental and publish while an RC is pending", () => {
    const npmVersions = ["1000.0.0", "1001.0.0-rc.0", "1001.1.0-canary.0"]
    const candidate = { version: "1001.1.0-canary.1", channel: "canary", line: "1001.1" }
    assert.equal(selectBaseline({ npmVersions, ...candidate }), "1001.1.0-canary.0")
    assert.equal(selectBaseline({ npmVersions, version: "1002.0.0-canary.0", channel: "canary" }), null)
    const tags = { latest: "1000.0.0", rc: "1001.0.0-rc.0", canary: "1001.1.0-canary.0" }
    assert.deepEqual(npmChannelTag(candidate, tags), { tag: "canary", advance: true, expectedVersion: "1001.1.0-canary.1" })
    assert.throws(() => selectBaseline({ npmVersions: [...npmVersions, "1001.1.0-canary.3"], ...candidate }), /newer version/)
})

test("Only release version and changelog bookkeeping are normalized", () => {
    const original = packages("1000.0.0-canary.0")
    const promoted = packages("1000.0.0-rc.0")
    assert.equal(contentFingerprint(original), contentFingerprint(promoted))
    assert.notDeepEqual(exactFiles(original), exactFiles(promoted))
    assert.notEqual(
        contentFingerprint(original),
        contentFingerprint(packages("1000.0.0-canary.1", "export const value = 2\n")),
    )
    assert.notEqual(
        contentFingerprint(original),
        contentFingerprint(packages("1000.0.0-canary.1", undefined, "Changed metadata")),
    )
    const comments = packages("1000.0.0-canary.1", "/** Changed caller documentation */\nexport const value = 1\n")
    assert.notEqual(contentFingerprint(original), contentFingerprint(comments))
    const guide = packages("1000.0.0-canary.1")
    guide.set("README.md", Buffer.from("Changed package guide\n"))
    assert.notEqual(contentFingerprint(original), contentFingerprint(guide))
    const reordered = new Map([...original].reverse())
    assert.equal(contentFingerprint(original), contentFingerprint(reordered))
})

test("npm archives establish actual file bytes and reject unsafe inventories", () => {
    const files = packages("1000.0.0-canary.0")
    assert.deepEqual(exactFiles(readNpmTarball(tarball(files))), exactFiles(files))
    assert.throws(() => readNpmTarball(tarball(new Map([["../escape", Buffer.from("bad")]]))), /Unsafe/)
    const corrupt = Buffer.from(tarball(files))
    corrupt[corrupt.length - 4] ^= 1
    assert.throws(() => readNpmTarball(corrupt), { code: "Z_DATA_ERROR" })
})

test("npm uses canary, rc and latest tags without moving older release lines backwards", () => {
    assert.deepEqual(npmChannelTag({ version: "1000.0.1", channel: "stable" }, { latest: "1000.1.0" }), {
        tag: "latest",
        advance: false,
        expectedVersion: "1000.1.0",
    })
    assert.deepEqual(npmChannelTag({ version: "1000.1.0-canary.0", channel: "canary" }, { latest: "1000.0.0" }), {
        tag: "canary",
        advance: true,
        expectedVersion: "1000.1.0-canary.0",
    })
    assert.deepEqual(npmChannelTag({ version: "1000.1.0-rc.0", channel: "rc" }, { canary: "1000.1.0-canary.2" }), {
        tag: "rc",
        advance: true,
        expectedVersion: "1000.1.0-rc.0",
    })
    for (const channel of ["canary", "rc"]) {
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
    const older = { version: "1000.0.2-canary.0", channel: "canary", line: "1000.0" }
    assert.deepEqual(channelTagState(older, { canary: "1000.0.2-canary.0" }), { tag: "canary", confirmed: true })
    assert.deepEqual(channelTagState(older, { canary: "1000.1.0-canary.3" }), { tag: "canary-1000-0", confirmed: false })
    assert.deepEqual(channelTagState(older, { canary: "1000.1.0-canary.3", "canary-1000-0": "1000.0.2-canary.0" }), {
        tag: "canary-1000-0",
        confirmed: true,
    })
    const stable = { version: "1000.0.0", channel: "stable", line: "1000.0" }
    // latest follows the newest preview until the first stable release moves it
    assert.deepEqual(channelTagState(stable, { latest: "1000.0.0-rc.0" }), { tag: "latest", confirmed: false })
    assert.deepEqual(channelTagState(stable, { latest: "1000.0.0" }), { tag: "latest", confirmed: true })
})
