import assert from "node:assert/strict"
import test from "node:test"
import { contentFingerprint, exactFiles, readNpmTarball } from "../content.js"
import {
    assertNightlyDate,
    assertPublishBaseline,
    assertStablePromotion,
    channelTagState,
    channels,
    compareVersions,
    nightlyDateOf,
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
    assert.equal(plan("1000.0.0-nightly.4", "nightly", ["patch"]), "1000.0.0-nightly.5")
    assert.equal(plan("1000.0.0-nightly.4", "nightly", ["major", "patch"]), "1000.0.0-nightly.5")
    assert.equal(plan("1000.0.0-nightly.2", "stable"), "1000.0.0")
    assert.equal(plan("1000.0.0", "stable", ["patch"]), "1000.0.1")
    assert.equal(plan("1000.0.0-nightly.2", "stable", ["patch"]), "1000.0.0")
    assert.equal(plan("1000.0.0", "nightly", ["minor"]), "1000.1.0-nightly.0")
    assert.equal(plan("1000.0.0", "nightly", ["major"]), "1001.0.0-nightly.0")
    assert.equal(plan("1001.4.2", "nightly", ["major"], { epoch: 2000 }), "2000.0.0-nightly.0")
    assert.throws(() => plan("1999.1.0", "nightly", ["major"]), /explicit epoch/)
    assert.throws(() => plan("1000.0.0-nightly.4", "nightly"), /No pending/)
    assert.throws(() => plan("0.0.0", "nightly", ["major"]), /Epoch Semantic Versioning/)
    assert.throws(() => plan("0.1.0", "nightly", ["patch"]), /Epoch Semantic Versioning/)
    assert.throws(() => plan("0.0.0-nightly.1", "nightly", ["patch"]), /Epoch Semantic Versioning/)
    assert.throws(() => plan("1000.0.0", "nightly", ["minor"], { epoch: 2000 }), /major Changesets/)
    assert.throws(() => plan("1000.0.0", "nightly", ["major"], { epoch: 1001 }), /higher multiple/)
})

test("Later prereleases use the stable base rather than repeatedly bumping the preview", () => {
    const plan = (currentVersion, channel, pendingTypes, extra = {}) => planVersion({
        currentVersion, channel, pendingTypes, releaseBase: "1000.2.3", ...extra,
    }).version
    assert.equal(plan("1000.2.4-nightly.0", "nightly", ["patch"]), "1000.2.4-nightly.1")
    assert.equal(plan("1000.2.4-nightly.1", "nightly", ["minor"]), "1000.3.0-nightly.0")
    assert.equal(plan("1000.3.0-nightly.0", "nightly", ["minor"]), "1000.3.0-nightly.1")
    assert.equal(plan("1000.3.0-nightly.1", "nightly", ["major"]), "1001.0.0-nightly.0")
    assert.equal(plan("1001.0.0-nightly.0", "nightly", ["major"]), "1001.0.0-nightly.1")
    assert.equal(plan("1001.0.0-nightly.1", "stable", []), "1001.0.0")
    // An explicit epoch selected earlier in the cycle survives later notes
    assert.equal(plan("2000.0.0-nightly.0", "nightly", ["major"]), "2000.0.0-nightly.1")
    assert.equal(plan("1000.3.0-nightly.0", "stable", ["major"]), "1001.0.0")
    assert.equal(plan("1000.3.0-nightly.0", "stable", [], { releaseTypes: ["major"], allowNoChanges: true }), "1001.0.0")
    for (const releaseBase of [undefined, null, "1000.3.0", "1001.0.0", "1000.2.3-nightly.0", "0.0.0"])
        assert.throws(() => plan("1000.3.0-nightly.0", "nightly", [], { releaseBase }), /releaseBase/)
})

test("Only Nightly and Stable are selectable, while retired channels remain readable", () => {
    assert.deepEqual(channels, ["nightly", "stable"])
    for (const channel of ["alpha", "beta", "rc", "canary"])
        assert.throws(() => planVersion({ currentVersion: "1000.0.0", channel, pendingTypes: ["patch"] }), /Channel must be nightly or stable/)
    for (const channel of ["alpha", "beta"]) {
        const version = `1000.0.0-${channel}.1`
        assert.throws(() => parseVersion(version), /numeric SemVer/)
        assert.throws(() => contentFingerprint(packages(version)), /Invalid staged package version/)
        assert.throws(() => npmChannelTag({ version, channel }, {}), /numeric SemVer/)
    }
    assert.equal(parseVersion("1000.0.0-rc.1").channel, "rc")
    assert.equal(parseVersion("1000.0.0-canary.1").channel, "canary")
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

test("Dated and older numbered nightlies share SemVer ordering with legacy versions", () => {
    const versions = [
        "1000.0.0-nightly.20261020.1",
        "1000.0.0-rc.0",
        "1000.0.0-nightly.15",
        "1000.0.0-nightly.20261019.16",
        "1000.0.0-nightly.20261019.9",
        "1000.0.0-nightly.13",
        "1000.0.0-nightly.20261019",
    ]
    // Numeric identifiers compare numerically, and more identifiers sort higher once all earlier ones are equal
    assert.deepEqual([...versions].sort(compareVersions), [
        "1000.0.0-nightly.13",
        "1000.0.0-nightly.15",
        "1000.0.0-nightly.20261019",
        "1000.0.0-nightly.20261019.9",
        "1000.0.0-nightly.20261019.16",
        "1000.0.0-nightly.20261020.1",
        "1000.0.0-rc.0",
    ])
    assert.ok(compareVersions("1000.0.0-nightly.20261019.16", "1000.0.0-nightly.15") > 0)
    assert.ok(compareVersions("1000.0.0-nightly.20261019.1", "1000.0.0-nightly.20261018.99") > 0)
    assert.ok(compareVersions("1000.0.0-nightly.20261231.99", "1000.0.0-rc.0") < 0)
    assert.ok(compareVersions("1000.0.0-nightly.20261019.1", "1000.0.0") < 0)
    assert.ok(compareVersions("1000.0.1-nightly.20260101.1", "1000.0.0-nightly.20261019.16") > 0)
    assert.equal(compareVersions("1000.0.0-nightly.20261019.16", "1000.0.0-nightly.20261019.16"), 0)
})

test("A dated nightly parses its date and run number, and only a real date can name one", () => {
    assert.deepEqual(parseVersion("1000.0.0-nightly.20261019.16"), {
        major: 1000,
        minor: 0,
        patch: 0,
        channel: "nightly",
        identifiers: [20261019, 16],
        number: 16,
        date: "20261019",
        core: "1000.0.0",
        line: "1000.0",
    })
    assert.deepEqual(
        [parseVersion("1000.0.0-nightly.15").number, parseVersion("1000.0.0-nightly.15").date],
        [15, undefined],
    )
    for (const version of [
        "1000.0.0-nightly.20261319.1",
        "1000.0.0-nightly.20260230.1",
        "1000.0.0-nightly.2026101.1",
        "1000.0.0-nightly.202610199.1",
        "1000.0.0-nightly.20261019.01",
        "1000.0.0-nightly.20261019.1.2",
        "1000.0.0-rc.20261019.1",
        "1000.0.0-canary.20261019.1",
    ])
        assert.throws(() => parseVersion(version), /numeric SemVer|calendar date|build date/, version)
    assert.equal(assertNightlyDate("20240229"), "20240229")
    for (const date of [undefined, 20261019, "2026-10-19", "20261019 ", "20250229", "20260001", "20260100", "00000101", "00010101", "09991231"])
        assert.throws(() => assertNightlyDate(date), /YYYYMMDD|calendar date/, String(date))
    assert.equal(nightlyDateOf("2026-10-19T23:59:59Z"), "20261019")
    assert.equal(nightlyDateOf("2026-10-20T01:30:00+02:00"), "20261019")
    assert.throws(() => nightlyDateOf("not a time"), /valid timestamp/)
})

test("A published legacy Canary still parses and sorts below nightly builds of its version", () => {
    assert.deepEqual(parseVersion("1000.1.0-canary.7"), {
        major: 1000,
        minor: 1,
        patch: 0,
        channel: "canary",
        identifiers: [7],
        number: 7,
        date: undefined,
        core: "1000.1.0",
        line: "1000.1",
    })
    assert.ok(compareVersions("1000.1.0-canary.7", "1000.1.0-nightly.0") < 0)
    assert.ok(compareVersions("1000.1.0-canary.7", "1000.1.0-rc.0") < 0)
    // Legacy Canary inventory entries never become a nightly baseline or block one
    const npmVersions = ["1000.0.0", "1000.1.0-canary.7", "1000.1.0-canary.8"]
    assert.equal(selectBaseline({ npmVersions, version: "1000.1.0-nightly.0", channel: "nightly" }), null)

})

test("Preview baselines are isolated by major.minor line and channel, and a first preview has none", () => {
    const versions = ["1000.0.0", "1000.0.1", "1000.1.0-nightly.0", "1000.1.0-nightly.1"]
    const select = (version, channel) => selectBaseline({ npmVersions: versions, version, channel })
    assert.equal(select("1000.1.0-nightly.2", "nightly"), "1000.1.0-nightly.1")
    assert.equal(select("1000.2.0-nightly.0", "nightly"), null)
    assert.throws(() => select("1000.1.0-nightly.0", "nightly"), /newer version/)
    assert.throws(() => selectBaseline({ npmVersions: null, version: "1000.1.0-nightly.0", channel: "nightly" }), /unavailable/)
})

test("A nightly targets the core the next Stable would and follows the newest published nightly of that core", () => {
    const date = "20261019"
    const nightly = (currentVersion, extra = {}) => planNightly({ currentVersion, npmVersions: [], date, number: 1, ...extra })
    // A stable source with no pending notes still builds toward the next patch, never the published Stable
    assert.deepEqual(nightly("1000.2.3"), {
        currentVersion: "1000.2.3",
        version: "1000.2.4-nightly.20261019.1",
        channel: "nightly",
        line: "1000.2",
    })
    assert.equal(nightly("1000.2.3", { pendingTypes: ["patch", "minor"] }).version, "1000.3.0-nightly.20261019.1")
    assert.equal(nightly("1000.2.3", { pendingTypes: ["major"] }).version, "1001.0.0-nightly.20261019.1")
    // A nightly target keeps its target, and a later major note escalates it as the next Stable would
    const cycle = { releaseBase: "1000.2.3", pendingTypes: [], releaseTypes: ["minor"] }
    assert.equal(nightly("1000.3.0-nightly.1", cycle).version, "1000.3.0-nightly.20261019.1")
    assert.equal(
        nightly("1000.3.0-nightly.1", { ...cycle, pendingTypes: ["major"], releaseTypes: ["minor", "major"] }).version,
        "1001.0.0-nightly.20261019.1",
    )
    assert.equal(nightly("1000.0.0-nightly.0", { releaseBase: null }).version, "1000.0.0-nightly.20261019.1")
    // The version must sort above every published nightly of the core, in either form
    const npmVersions = [
        "1000.2.3",
        "1000.3.0-nightly.0",
        "1000.3.0-nightly.10",
        "1000.3.0-nightly.2",
        "1000.3.0-nightly.20261018.7",
        "1000.2.4-nightly.30",
        "1000.4.0-nightly.40",
        "1000.3.0-rc.50",
        "1000.3.0-canary.60",
    ]
    const planned = (extra) => nightly("1000.3.0-nightly.1", { ...cycle, npmVersions, ...extra }).version
    assert.equal(planned({ number: 1 }), "1000.3.0-nightly.20261019.1")
    assert.equal(planned({ number: 57 }), "1000.3.0-nightly.20261019.57")
    assert.equal(planned({ date: "20261018", number: 8 }), "1000.3.0-nightly.20261018.8")
    // A later day wins over a lower run number, and the same day needs a higher run number
    assert.equal(planned({ date: "20261020", number: 1 }), "1000.3.0-nightly.20261020.1")
    for (const [extra, newest] of [
        [{ date: "20261018", number: 7 }, "1000.3.0-nightly.20261018.7"],
        [{ date: "20261018", number: 6 }, "1000.3.0-nightly.20261018.7"],
        [{ date: "20261017", number: 99 }, "1000.3.0-nightly.20261018.7"],
    ])
        assert.throws(
            () => planned(extra),
            new RegExp(`Nightly 1000.3.0-nightly.${extra.date}.${extra.number} must be above the published ${newest.replaceAll(".", "\\.")}`),
        )
    // Older numbered nightlies alone still guard the next one, so a dated nightly passes them whatever their number
    const legacy = ["1000.3.0-nightly.13", "1000.3.0-nightly.15"]
    assert.equal(planned({ npmVersions: legacy, number: 16 }), "1000.3.0-nightly.20261019.16")
    assert.equal(planned({ npmVersions: legacy, number: 1 }), "1000.3.0-nightly.20261019.1")
    assert.throws(() => planned({ npmVersions: ["1000.3.0-nightly.20270101.1"] }), /must be above the published 1000\.3\.0-nightly\.20270101\.1/)
    for (const number of [undefined, 0, -1, 1.5, "3"])
        assert.throws(() => nightly("1000.2.3", { number }), /positive whole run number/, String(number))
    for (const badDate of [undefined, 20261019, "2026-10-19", "202610", "20261319", "20260230"])
        assert.throws(() => nightly("1000.2.3", { date: badDate }), /YYYYMMDD|calendar date/, String(badDate))
    for (const npmVersions of [undefined, null, { versions: [] }])
        assert.throws(() => nightly("1000.2.3", { npmVersions }), /Registry version inventory is unavailable/)
    assert.equal(nightly("1000.3.0-nightly.0", { releaseBase: "1000.2.3" }).version, "1000.3.0-nightly.20261019.1")
})

test("A stable baseline is the newest published nightly of the same version, never an earlier stable", () => {
    const versions = ["1000.0.0", "1000.0.1-nightly.0", "1000.0.1-nightly.1", "1000.1.0-nightly.0"]
    const select = (version) => selectBaseline({ npmVersions: versions, version, channel: "stable" })
    assert.equal(select("1000.0.1"), "1000.0.1-nightly.1")
    assert.equal(select("1000.1.0"), "1000.1.0-nightly.0")
    assert.throws(
        () => selectBaseline({ npmVersions: ["1000.0.0", "1000.0.1"], version: "1000.0.0", channel: "stable" }),
        /newer version/,
    )
    assert.doesNotThrow(() => assertStablePromotion("stable", "1000.0.1-nightly.1", "same", "same"))
    assert.throws(() => assertStablePromotion("stable", "1000.0.1-nightly.1", "changed", "same"), /differs from 1000.0.1-nightly.1/)
    assert.doesNotThrow(() => assertStablePromotion("nightly", "1000.0.1-nightly.0", "changed", "same"))
})

test("Stable planning accepts every release size from Stable or a nightly target", () => {
    for (const [type, version] of [["patch", "1000.2.4"], ["minor", "1000.3.0"], ["major", "1001.0.0"]]) {
        assert.equal(planVersion({ currentVersion: "1000.2.3", channel: "stable", pendingTypes: [type] }).version, version)
        assert.equal(planVersion({ currentVersion: "1000.2.4-nightly.0", releaseBase: "1000.2.3", channel: "stable", pendingTypes: [type] }).version, version)
    }
    assert.equal(planVersion({ currentVersion: "1001.4.2", channel: "stable", pendingTypes: ["major"], epoch: 2000 }).version, "2000.0.0")
})


test("Stable requires a nightly of its exact core and ignores published rc versions", () => {
    for (const version of ["1000.0.1", "1000.1.0", "1001.0.0", "2000.0.0"])
        assert.throws(() => selectBaseline({ npmVersions: ["1000.0.0", `${version}-rc.9`, "1000.0.0-nightly.8"], version, channel: "stable" }), /No nightly/)
    assert.equal(selectBaseline({ npmVersions: ["1000.0.1-nightly.2", "1000.0.1-rc.9", "1001.0.0-rc.3"], version: "1000.0.1", channel: "stable" }), "1000.0.1-nightly.2")
})


test("Nightly builds ignore published rc versions and publish under the nightly tag", () => {
    const npmVersions = ["1000.0.0", "1001.0.0-rc.0", "1001.1.0-nightly.0"]
    const candidate = { version: "1001.1.0-nightly.1", channel: "nightly", line: "1001.1" }
    assert.equal(selectBaseline({ npmVersions, ...candidate }), "1001.1.0-nightly.0")
    assert.equal(selectBaseline({ npmVersions, version: "1002.0.0-nightly.0", channel: "nightly" }), null)
    // A nightly ignores an old rc of its own version
    assert.equal(selectBaseline({ npmVersions, version: "1001.0.0-nightly.0", channel: "nightly" }), null)
    const tags = { latest: "1000.0.0", rc: "1001.0.0-rc.0", nightly: "1001.1.0-nightly.0" }
    assert.deepEqual(npmChannelTag(candidate, tags), { tag: "nightly", advance: true, expectedVersion: "1001.1.0-nightly.1" })
    assert.throws(() => selectBaseline({ npmVersions: [...npmVersions, "1001.1.0-nightly.3"], ...candidate }), /newer version/)
})

test("Only release version and changelog bookkeeping are normalized", () => {
    const original = packages("1000.0.0-nightly.0")
    const promoted = packages("1000.0.0")
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

test("npm uses nightly and latest tags without moving older release lines backwards", () => {
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
    for (const channel of ["nightly"]) {
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

test("Dated nightlies move the nightly tag past older numbered ones and keep the staging tag for older lines", async () => {
    const dated = { version: "1000.0.0-nightly.20261019.16", channel: "nightly", line: "1000.0" }
    assert.deepEqual(npmChannelTag(dated, { nightly: "1000.0.0-nightly.15" }), {
        tag: "nightly",
        advance: true,
        expectedVersion: dated.version,
    })
    assert.equal(npmChannelTag(dated, { nightly: "1000.0.0-nightly.20261019.17" }).advance, false)
    const older = { version: "1000.0.2-nightly.20261019.16", channel: "nightly", line: "1000.0" }
    assert.deepEqual(channelTagState(older, { nightly: "1000.1.0-nightly.20261018.3" }), { tag: "nightly-1000-0", confirmed: false })
    assert.deepEqual(channelTagState(older, { nightly: "1000.1.0-nightly.3", "nightly-1000-0": older.version }), {
        tag: "nightly-1000-0",
        confirmed: true,
    })
    // A candidate prepared against the older numbered nightly 15 accepts the dated nightly that published meanwhile
    const baseline = (value) => ({ ...dated, contentFingerprint: "new", baseline: value && { version: value } })
    const fingerprints = { "1000.0.0-nightly.15": "old", "1000.0.0-nightly.20261019.15": "other" }
    const check = (candidate, npmVersions) =>
        assertPublishBaseline(candidate, npmVersions, async (version) => fingerprints[version])
    await check(baseline("1000.0.0-nightly.15"), ["1000.0.0-nightly.15", "1000.0.0-nightly.20261019.15"])
    assert.equal(
        selectBaseline({ npmVersions: ["1000.0.0-nightly.15", "1000.0.0-nightly.20261019.2"], ...dated }),
        "1000.0.0-nightly.20261019.2",
    )
    assert.throws(
        () => selectBaseline({ npmVersions: ["1000.0.0-nightly.15", "1000.0.0-nightly.20261020.1"], ...dated }),
        /newer version/,
    )
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
    assert.equal(await check(nightly("1000.1.0-nightly.56"), published), undefined)
    // Run 56 published while run 57 was being prepared against 55, or against no earlier nightly
    assert.equal(await check(nightly("1000.1.0-nightly.55"), published), undefined)
    assert.equal(await check(nightly(null), published), undefined)
    // Content identical to the nightly that published meanwhile is superseded, not an error, and is not published again
    fingerprints["1000.1.0-nightly.56"] = "new"
    assert.deepEqual(await check(nightly("1000.1.0-nightly.55"), published), { superseded: "1000.1.0-nightly.56" })
    // A baseline that disappeared or moved backwards is not an earlier nightly finishing
    await assert.rejects(check(nightly("1000.1.0-nightly.56"), ["1000.1.0-nightly.55"]), /baseline changed/)
    await assert.rejects(check(nightly("1000.1.0-nightly.55"), []), /baseline changed/)
    // A newer nightly on the line with other content already won, and one with the same content supersedes this run
    fingerprints["1000.1.0-nightly.56"] = "older"
    fingerprints["1000.1.0-nightly.58"] = "other"
    await assert.rejects(
        check(nightly("1000.1.0-nightly.55"), [...published, "1000.1.0-nightly.58"]),
        /newer version is already published/,
    )
    fingerprints["1000.1.0-nightly.58"] = "new"
    assert.deepEqual(await check(nightly("1000.1.0-nightly.55"), [...published, "1000.1.0-nightly.58"]), {
        superseded: "1000.1.0-nightly.58",
    })
    // A matching nightly that is not the newest still supersedes, and the newest matching one is reported
    fingerprints["1000.1.0-nightly.59"] = "other"
    assert.deepEqual(
        await check(nightly("1000.1.0-nightly.55"), [...published, "1000.1.0-nightly.58", "1000.1.0-nightly.59"]),
        { superseded: "1000.1.0-nightly.58" },
    )
    // Other lines and channels never supersede
    fingerprints["1000.2.0-nightly.1"] = "new"
    assert.equal(await check(nightly("1000.1.0-nightly.56"), [...published, "1000.2.0-nightly.1"]), undefined)
    // Stable review binds the exact newest nightly, even when newer nightly content matches
    const stable = { version: "1000.1.0", channel: "stable", contentFingerprint: "new", baseline: { version: "1000.1.0-nightly.55" } }
    await assert.rejects(check(stable, published), /baseline changed/)
    await check(stable, ["1000.1.0-nightly.55"])
    await assert.rejects(check(stable, [...published, "1000.1.1"]), /newer version/)

})

test("A nightly is superseded by any nightly of its line published after its preparation", async () => {
    const day = "1000.1.0-nightly.20261019"
    const candidate = (version, baseline = null) => ({
        version,
        channel: "nightly",
        contentFingerprint: "same",
        baseline: baseline && { version: baseline },
    })
    const reads = []
    const check = (target, npmVersions, fingerprints) =>
        assertPublishBaseline(target, npmVersions, async (version) => {
            reads.push(version)
            return fingerprints[version]
        })
    const published = [`${day}.1`, `${day}.4`, `${day}.5`]
    const other = Object.fromEntries(published.map((version) => [version, "other"]))
    // X and Y were prepared from one commit. Y published, then Z from newer content published. X still finds Y's content
    const x = candidate(`${day}.3`, `${day}.1`)
    assert.deepEqual(await check(x, published, { ...other, [`${day}.4`]: "same" }), { superseded: `${day}.4` })
    // Several nightlies in the window with none matching keep the earlier results for both sides
    await assert.rejects(check(x, published, other), /newer version is already published/)
    const lower = candidate(`${day}.9`, `${day}.1`)
    assert.equal(await check(lower, published, other), undefined)
    // The newest matching nightly is reported when several match, and reads stop there
    reads.length = 0
    assert.deepEqual(await check(x, published, { ...other, [`${day}.4`]: "same", [`${day}.5`]: "same" }), {
        superseded: `${day}.5`,
    })
    assert.deepEqual(reads, [`${day}.5`])
    // Without a higher nightly only the newest one published after preparation is read, and never the candidate's own
    reads.length = 0
    await check(lower, [...published, lower.version], { ...other, [lower.version]: "same" })
    assert.deepEqual(reads, [`${day}.5`])
    // Other lines and channels are ignored
    assert.equal(
        await check(lower, [...published, "1000.2.0-nightly.20261019.2", "1000.1.0-rc.1"], {
            ...other,
            "1000.2.0-nightly.20261019.2": "same",
            "1000.1.0-rc.1": "same",
        }),
        undefined,
    )
    // Without a reviewed baseline every nightly of the line counts as published after preparation
    const unreviewed = { ...other, [`${day}.1`]: "same" }
    assert.equal(await check(candidate(`${day}.9`), published, unreviewed), undefined)
    assert.deepEqual(await check(candidate(`${day}.3`), published, unreviewed), { superseded: `${day}.1` })
    // A candidate that reverts a change below it still publishes when only lower nightlies match: .2 holds the old
    // content, .4 the change, and this candidate (.5) the reverted content, so the nightly tag must move back to it
    const revert = candidate(`${day}.5`, `${day}.1`)
    const lowerOnly = [`${day}.1`, `${day}.2`, `${day}.4`]
    assert.equal(await check(revert, lowerOnly, { [`${day}.2`]: "same", [`${day}.4`]: "other" }), undefined)
    // Once a higher nightly exists the candidate cannot publish, so any matching lower nightly supersedes it
    assert.deepEqual(
        await check(revert, [...lowerOnly, `${day}.6`], {
            [`${day}.2`]: "same",
            [`${day}.4`]: "other",
            [`${day}.6`]: "other",
        }),
        { superseded: `${day}.2` },
    )
    // A long line cannot stall publication, the fingerprint reads share one deadline
    let clock = 0
    const slow = { now: () => clock, timeout: 1000 }
    await assert.rejects(
        assertPublishBaseline(x, [...published, `${day}.6`, `${day}.7`], async () => ((clock += 600), "other"), slow),
        /fingerprint reads.*1000\.1.*nightly\.20261019\.1/s,
    )
    // Stable comparison never performs nightly supersession reads
    const stable = { version: "1000.1.0", channel: "stable", contentFingerprint: "same", baseline: { version: `${day}.1` } }
    reads.length = 0
    await assert.rejects(check(stable, published, { [`${day}.4`]: "same" }), /baseline changed/)
    assert.deepEqual(reads, [])

})
