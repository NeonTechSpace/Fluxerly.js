import assert from "node:assert/strict"
import test from "node:test"
import { contentFingerprint, exactFiles, readNpmTarball } from "../content.js"
import { channels, compareVersions, npmChannelTag, parseVersion, planVersion, selectBaseline } from "../planning.js"
import { packages, tarball } from "./helpers.js"

test("Epoch versions separate compatibility changes from readiness", () => {
    const plan = (currentVersion, channel, pendingTypes = [], extra = {}) =>
        planVersion({ currentVersion, channel, pendingTypes, ...extra }).version
    assert.equal(plan("0.0.0", "canary"), "1000.0.0-canary.0")
    assert.equal(plan("1000.0.0-canary.4", "canary", ["patch"]), "1000.0.0-canary.5")
    assert.equal(plan("1000.0.0-canary.4", "rc", ["minor"]), "1000.1.0-rc.0")
    assert.equal(plan("1000.0.0-canary.4", "rc", ["major", "patch"]), "1001.0.0-rc.0")
    assert.equal(plan("1000.0.0-canary.4", "rc"), "1000.0.0-rc.0")
    assert.equal(plan("1000.0.0-rc.2", "stable"), "1000.0.0")
    assert.equal(plan("1000.0.0", "stable", ["patch"]), "1000.0.1")
    assert.equal(plan("1000.0.0", "canary", ["minor"]), "1000.1.0-canary.0")
    assert.equal(plan("1000.0.0", "canary", ["major"]), "1001.0.0-canary.0")
    assert.equal(plan("1001.4.2", "canary", ["major"], { epoch: 2000 }), "2000.0.0-canary.0")
    assert.throws(() => plan("1999.1.0", "canary", ["major"]), /explicit epoch/)
    assert.throws(() => plan("1000.0.0-canary.4", "canary"), /No pending/)
    assert.throws(() => plan("1000.0.0-canary.4", "stable"), /release candidate/)
    assert.throws(() => plan("1000.0.0-rc.4", "canary"), /advance SemVer/)
    assert.throws(() => plan("0.0.0", "rc"), /first public canary/)
    assert.throws(() => plan("0.0.0", "stable", ["major"]), /first public canary/)
    assert.throws(() => plan("0.1.0", "canary", ["patch"]), /Epoch Semantic Versioning/)
    assert.throws(() => plan("0.0.0-canary.1", "canary", ["patch"]), /Epoch Semantic Versioning/)
    assert.throws(() => plan("1000.0.0", "canary", ["minor"], { epoch: 2000 }), /major Changesets/)
    assert.throws(() => plan("1000.0.0", "canary", ["major"], { epoch: 1001 }), /higher multiple/)
    assert.equal(compareVersions("1000.0.0-canary.10", "1000.0.0-rc.0") < 0, true)
    assert.equal(compareVersions("1000.0.0-rc.10", "1000.0.0") < 0, true)
})

test("Only Canary, RC and Stable are accepted release channels", () => {
    assert.deepEqual(channels, ["canary", "rc", "stable"])
    for (const channel of ["alpha", "beta"]) {
        const version = `1000.0.0-${channel}.1`
        assert.throws(() => parseVersion(version), /canary or rc suffix/)
        assert.throws(() => planVersion({ currentVersion: "0.0.0", channel }), /Channel must/)
        assert.throws(() => contentFingerprint(packages(version)), /Invalid staged package version/)
        assert.throws(() => npmChannelTag({ version, channel }, {}), /canary or rc suffix/)
    }
    assert.throws(() => npmChannelTag({ version: "1000.0.0-canary.1", channel: "beta" }, {}), /does not match/)
})

test("Published baselines are isolated by major.minor line and readiness channel", () => {
    const versions = ["1000.0.0", "1000.0.1", "1000.1.0-canary.0", "1000.1.0-canary.1"]
    const select = (version, channel, bootstrap = false) =>
        selectBaseline({ npmVersions: versions, version, channel, bootstrap })
    assert.equal(select("1000.0.2", "stable"), "1000.0.1")
    assert.equal(select("1000.1.0-canary.2", "canary"), "1000.1.0-canary.1")
    assert.equal(select("1000.1.0-rc.0", "rc", true), null)
    assert.throws(() => select("1000.1.0-rc.0", "rc"), /bootstrap/)
    assert.throws(() => select("1000.1.0-canary.2", "canary", true), /forbidden/)
    assert.throws(() => select("1000.0.0", "stable"), /newer version/)
    assert.throws(
        () =>
            selectBaseline({
                npmVersions: null,
                version: "1000.0.0",
                channel: "stable",
                bootstrap: true,
            }),
        /unavailable/,
    )
})

test("Publication baseline checks reject versions ahead of the reviewed candidate", () => {
    const values = { version: "1000.0.0-canary.2", channel: "canary", npmVersions: ["1000.0.0-canary.1"] }
    assert.equal(selectBaseline(values), "1000.0.0-canary.1")
    assert.throws(() => selectBaseline({ ...values, npmVersions: ["1000.0.0-canary.3"] }), /newer/)
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
    assert.throws(() => readNpmTarball(corrupt))
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
