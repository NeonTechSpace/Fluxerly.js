// Tests the Fluxer commit the docs name: read from an endpoint map's source, nothing shown for a map without a valid one,
// and the generated map naming the commit the repository pins
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { fluxerPinOf } from "../src/lib/fluxer-pin.ts"

const commit = "f50792ae705cbba28fecace477253de534c627ef"

test("reads the pin from an endpoint map's source and links the commit on GitHub", () => {
    assert.deepEqual(fluxerPinOf({ fluxer: { repository: "fluxerapp/fluxer", commit } }), {
        commit,
        short: "f50792a",
        url: `https://github.com/fluxerapp/fluxer/commit/${commit}`,
    })
})

test("names no pin when the map has none or a malformed one", () => {
    for (const source of [undefined, null, {}, { fluxer: {} }, { fluxer: { repository: "fluxerapp/fluxer", commit: "f50792a" } }, { fluxer: { repository: "not a repository", commit } }])
        assert.equal(fluxerPinOf(source), null)
})

test("the generated endpoint map names the commit the repository pins", () => {
    // A build reads this map, so a pin moved without generating again would show the old commit
    const manifest = JSON.parse(readFileSync(new URL("../../release/upstream/manifest.json", import.meta.url), "utf8"))
    const generated = JSON.parse(readFileSync(new URL("../content/reference/endpoints.json", import.meta.url), "utf8"))
    assert.equal(fluxerPinOf(generated.source)?.url, `https://github.com/${manifest.repository}/commit/${manifest.commit}`)
})
