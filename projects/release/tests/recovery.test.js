import assert from "node:assert/strict"
import test from "node:test"
import { sha256 } from "../content.js"
import { announceRelease } from "../github.js"
import { stagingTag } from "../planning.js"
import { inspectPublished, publishCandidate } from "../recovery.js"

const reviewed = Buffer.from("Reviewed npm tarball")

function setup({ version = "1000.0.0-canary.0", channel = "canary", line = "1000.0", tags = {} } = {}) {
    const candidate = {
        name: "@neontechspace/fluxerly",
        version,
        channel,
        line,
        artifacts: { "sdk.tgz": { sha256: sha256(reviewed), size: reviewed.length } },
    }
    const state = {
        candidate,
        published: false,
        served: reviewed,
        tags: { ...tags },
        publishedTags: [],
        calls: 0,
        reads: 0,
        baselineChecks: 0,
        elapsed: 0,
        timeout: 5000,
        delay: 5000,
    }
    state.registries = {
        inventory: async (_name, options) => {
            assert.deepEqual(options, { allowMissing: true })
            state.reads++
            return {
                npmVersions: state.published ? [candidate.version] : [],
                npmTags: { ...state.tags },
                npmDist: state.published ? { [candidate.version]: { tarball: "served", integrity: "checked" } } : {},
            }
        },
        npmTarball: async (dist) => {
            assert.deepEqual(dist, { tarball: "served", integrity: "checked" })
            return state.served
        },
    }
    state.assertBaseline = async () => {
        state.baselineChecks++
        return state.registries.inventory(candidate.name, { allowMissing: true })
    }
    state.publisher = async (tag) => {
        state.calls++
        state.publishedTags.push(tag)
        state.published = true
        state.tags[tag] = candidate.version
    }
    state.now = () => state.elapsed
    state.wait = async (milliseconds) => {
        state.elapsed += milliseconds
    }
    state.progress = () => {}
    return state
}

test("A rerun accepts an existing version with the reviewed bytes without publishing again", async () => {
    const state = setup()
    state.published = true
    state.tags.canary = state.candidate.version
    const result = await publishCandidate(state.candidate, state)
    assert.equal(result.published, "already")
    assert.equal(result.npm, "published")
    assert.equal(state.calls, 0)
    assert.equal(state.baselineChecks, 0)
})

test("An existing version with different bytes fails without publishing", async () => {
    const state = setup()
    state.published = true
    state.served = Buffer.from("Unreviewed bytes")
    await assert.rejects(publishCandidate(state.candidate, state), /different bytes/)
    assert.equal(state.calls, 0)
    const status = await inspectPublished(state.candidate, state.registries)
    assert.deepEqual([status.npm, status.complete], ["different", false])
})

test("An uncertain submission is confirmed from npm without publishing twice, and a rerun publishes nothing", async () => {
    const state = setup()
    const publisher = state.publisher
    state.publisher = async (tag) => {
        await publisher(tag)
        throw new Error("Response lost")
    }
    const result = await publishCandidate(state.candidate, state)
    assert.deepEqual([result.npm, result.complete, result.tag, result.published], ["published", true, "canary", "now"])
    assert.equal((await publishCandidate(state.candidate, state)).published, "already")
    assert.equal(state.calls, 1)
    assert.equal(state.baselineChecks, 1)
})

test("An accepted upload remains read-only while npm takes seven minutes to expose it", async () => {
    const state = setup()
    const messages = []
    state.timeout = 20 * 60_000
    state.progress = (message) => messages.push(message)
    state.publisher = async (tag) => {
        state.calls++
        state.tags[tag] = state.candidate.version
    }
    const inventory = state.registries.inventory
    state.registries.inventory = async (...args) => {
        state.published = state.calls > 0 && state.elapsed >= 7 * 60_000
        return inventory(...args)
    }
    assert.equal((await publishCandidate(state.candidate, state)).complete, true)
    assert.equal(state.calls, 1)
    assert.ok(state.elapsed >= 7 * 60_000 && state.elapsed < state.timeout, `Waited ${state.elapsed} ms`)
    assert.ok(messages.length > 0, "Waiting reports progress")
})

test("Distribution tags are polled with the version and a lagging tag is awaited without republishing", async () => {
    const state = setup()
    state.timeout = 60_000
    let lagging = 2
    state.publisher = async () => {
        state.calls++
        state.published = true
    }
    const inventory = state.registries.inventory
    state.registries.inventory = async (...args) => {
        if (state.calls && lagging-- <= 0) state.tags.canary = state.candidate.version
        return inventory(...args)
    }
    const result = await publishCandidate(state.candidate, state)
    assert.equal(result.tag, "canary")
    assert.equal(state.calls, 1)
    assert.ok(state.elapsed >= 5000)
})

test("A version whose channel tag never moves fails at the deadline without republishing", async () => {
    const state = setup({ tags: { canary: "1000.0.0-canary.0" } })
    Object.assign(state.candidate, { version: "1000.0.0-canary.1" })
    state.publisher = async () => {
        state.calls++
        state.published = true
    }
    await assert.rejects(publishCandidate(state.candidate, state), /canary tag does not point to it/)
    assert.equal(state.calls, 1)
    assert.equal(state.elapsed, state.timeout)
})

test("A superseded release on the same line recovers without republishing or restoring the channel tag", async () => {
    for (const [version, channel, newer] of [
        ["1000.0.0-rc.1", "rc", "1000.0.0-rc.2"],
        ["1000.0.1-canary.0", "canary", "1000.0.2-canary.0"],
        ["1000.0.1", "stable", "1000.0.2"],
    ]) {
        const tag = channel === "stable" ? "latest" : channel
        const state = setup({ version, channel, tags: { [tag]: newer } })
        state.published = true
        const result = await publishCandidate(state.candidate, state)
        assert.deepEqual([result.npm, result.published, result.tag], ["published", "already", tag])
        assert.equal(state.tags[tag], newer)
        assert.equal(state.calls, 0)
        assert.equal(state.baselineChecks, 0)
    }
})

test("A superseded channel tag never bypasses verification of the candidate's served bytes", async () => {
    const state = setup({ version: "1000.0.0-rc.1", channel: "rc", tags: { rc: "1000.0.0-rc.2" } })
    state.published = true
    state.served = Buffer.from("Unreviewed bytes")
    await assert.rejects(publishCandidate(state.candidate, state), /different bytes/)
    assert.equal(state.calls, 0)
})

test("An older published line still requires its staging tag for recovery", async () => {
    const state = setup({ version: "1000.0.0-rc.1", channel: "rc", tags: { rc: "1000.1.0-rc.2" } })
    state.published = true
    await assert.rejects(publishCandidate(state.candidate, state), /rc-1000-0 tag does not point to it/)
    assert.equal(state.calls, 0)
    state.tags[stagingTag(state.candidate)] = state.candidate.version
    assert.equal((await publishCandidate(state.candidate, state)).published, "already")
    assert.equal(state.tags.rc, "1000.1.0-rc.2")
    assert.equal(state.calls, 0)
})

test("An older release line publishes under its staging tag and leaves the newer channel tag in place", async () => {
    const state = setup({ version: "1000.0.2-canary.0", tags: { canary: "1000.1.0-canary.3" } })
    const result = await publishCandidate(state.candidate, state)
    assert.deepEqual(state.publishedTags, [stagingTag(state.candidate)])
    assert.equal(result.tag, "canary-1000-0")
    assert.equal(state.tags.canary, "1000.1.0-canary.3")
})

test("Unconfirmed npm publication stops at its deadline without a second upload", async () => {
    const state = setup()
    state.publisher = async () => {
        state.calls++
    }
    await assert.rejects(publishCandidate(state.candidate, state), /npm publication is unconfirmed\. Rerun/)
    assert.equal(state.calls, 1)
    assert.equal(state.elapsed, state.timeout)
})

test("Transient npm metadata failures after submission are retried without resubmission", async () => {
    const state = setup()
    const inventory = state.registries.inventory
    let afterSubmissionReads = 0
    state.registries.inventory = async (...args) => {
        if (state.calls && ++afterSubmissionReads === 1) throw new Error("Temporary registry failure")
        return inventory(...args)
    }
    assert.equal((await publishCandidate(state.candidate, state)).complete, true)
    assert.equal(state.calls, 1)
})

test("A transient final npm read retries within the deadline without resubmission", async () => {
    const state = setup()
    const inventory = state.registries.inventory
    let postSubmissionReads = 0
    let failedOnce = false
    state.registries.inventory = async (...args) => {
        // The first read after submission confirms publication, so the second is the final readback
        if (state.calls && ++postSubmissionReads === 2) {
            failedOnce = true
            throw new Error("Temporary final read failure")
        }
        return inventory(...args)
    }
    assert.equal((await publishCandidate(state.candidate, state)).complete, true)
    assert.equal(state.calls, 1)
    assert.equal(failedOnce, true)
})

test("A provider failure remains recoverable but is unconfirmed without npm metadata", async () => {
    const state = setup()
    state.publisher = async () => {
        state.calls++
        throw new Error("Provider failed")
    }
    await assert.rejects(publishCandidate(state.candidate, state), /unconfirmed after provider failure/)
    assert.equal(state.calls, 1)
})

test("Unsupported versions, inconsistent channels and unbound tarballs fail before npm effects", async () => {
    for (const [change, reason] of [
        [{ version: "1000.0.0-beta.0" }, /canary or rc suffix/],
        [{ version: "0.0.0", channel: "stable", line: "0.0" }, /public release channel and line/],
        [{ channel: "rc" }, /public release channel and line/],
        [{ line: "1000.1" }, /public release channel and line/],
        [{ artifacts: {} }, /does not bind a reviewed npm tarball/],
    ]) {
        const state = setup()
        await assert.rejects(publishCandidate({ ...state.candidate, ...change }, state), reason)
        assert.equal(state.reads, 0)
        assert.equal(state.calls, 0)
    }
    for (const [version, channel] of [["1000.0.0-rc.0", "rc"], ["1000.0.0", "stable"]]) {
        const state = setup({ version, channel })
        assert.equal((await publishCandidate(state.candidate, state)).complete, true)
    }
})

test("Final npm version readback must still confirm publication", async () => {
    const state = setup()
    const inventory = state.registries.inventory
    state.registries.inventory = async (...args) => {
        // Reads before this point are the initial status, the baseline check and the first confirmation
        if (state.reads >= 3) state.published = false
        return inventory(...args)
    }
    await assert.rejects(publishCandidate(state.candidate, state), /final npm registry readback/)
})

test("Missing, different or unavailable npm publication prevents GitHub release effects", async () => {
    const state = setup()
    const github = new Proxy({}, { get: () => assert.fail("GitHub must not be called") })
    await assert.rejects(announceRelease(state.candidate, "unused", github, state.registries), /npm version must be published/)
    state.published = true
    state.served = Buffer.from("Unreviewed bytes")
    await assert.rejects(announceRelease(state.candidate, "unused", github, state.registries), /different bytes/)
    state.registries.inventory = async () => {
        throw new Error("Registry unavailable")
    }
    await assert.rejects(announceRelease(state.candidate, "unused", github, state.registries), /unavailable/)
})
