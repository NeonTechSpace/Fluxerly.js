import assert from "node:assert/strict"
import test from "node:test"
import { announceRelease } from "../github.mjs"
import { inspectPublished, publishCandidate } from "../recovery.mjs"

function setup() {
    const candidate = { name: "@neontechspace/fluxerly", version: "1000.0.0-canary.0", channel: "canary", line: "1000.0" }
    let published = false
    let calls = 0
    let reads = 0
    const registries = {
        inventory: async (_name, options) => {
            assert.deepEqual(options, { bootstrap: true })
            reads++
            return { npmVersions: published ? [candidate.version] : [] }
        },
        npmFiles: () => assert.fail("Publication must not download package files"),
    }
    const publisher = async () => {
        calls++
        published = true
    }
    return {
        candidate,
        registries,
        publisher,
        attempts: 2,
        wait: async () => {},
        get calls() { return calls },
        get reads() { return reads },
        set published(value) { published = value },
        get published() { return published },
    }
}

test("Existing npm versions are rejected without invoking the publisher", async () => {
    const state = setup()
    state.published = true
    await assert.rejects(publishCandidate(state.candidate, state), /already published/)
    assert.equal(state.calls, 0)
    assert.equal(state.reads, 1)
})

test("An uncertain submission is confirmed from npm metadata without publishing twice", async () => {
    const state = setup()
    const publisher = state.publisher
    state.publisher = async () => {
        await publisher()
        throw new Error("Response lost")
    }
    assert.deepEqual(await publishCandidate(state.candidate, state), { npm: "published", complete: true })
    await assert.rejects(publishCandidate(state.candidate, state), /already published/)
    assert.equal(state.calls, 1)
})

test("A provider failure remains recoverable but is unconfirmed without npm metadata", async () => {
    const state = setup()
    state.publisher = async () => {
        state.published = false
        throw new Error("Provider failed")
    }
    await assert.rejects(publishCandidate(state.candidate, state), /npm publication is unconfirmed after provider failure/)
    assert.equal(state.calls, 0)
})

test("Unsupported versions and inconsistent channels fail before npm effects", async () => {
    for (const change of [
        { version: "1000.0.0-beta.0" }, { version: "0.0.0" }, { channel: "rc" }, { line: "1000.1" },
    ]) {
        const state = setup()
        await assert.rejects(publishCandidate({ ...state.candidate, ...change }, state))
        assert.equal(state.reads, 0)
        assert.equal(state.calls, 0)
    }
    for (const [version, channel] of [["1000.0.0-rc.0", "rc"], ["1000.0.0", "stable"]]) {
        const state = setup()
        Object.assign(state.candidate, { version, channel })
        assert.equal((await publishCandidate(state.candidate, state)).complete, true)
    }
})

test("Final npm version readback must still confirm publication", async () => {
    const state = setup()
    const inventory = state.registries.inventory
    state.registries.inventory = async (...args) => {
        if (state.reads >= 2) state.published = false
        return inventory(...args)
    }
    await assert.rejects(publishCandidate(state.candidate, state), /final npm registry readback/)
})

test("Missing or unavailable npm publication prevents GitHub release effects", async () => {
    const state = setup()
    const github = new Proxy({}, { get: () => assert.fail("GitHub must not be called") })
    await assert.rejects(announceRelease(state.candidate, "unused", github, state.registries), /npm version must be published/)
    state.registries.inventory = async () => { throw new Error("Registry unavailable") }
    await assert.rejects(announceRelease(state.candidate, "unused", github, state.registries), /unavailable/)
})
