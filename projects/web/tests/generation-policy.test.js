import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { generate, webRoot } from "../scripts/generate.js"

test("Public generation without a published snapshot fails before replacing existing output", async () => {
    const released = await mkdtemp(join(tmpdir(), "fluxerly-empty-releases-"))
    if (dirname(resolve(released)) !== resolve(tmpdir())) throw new Error("Unexpected release fixture directory")
    const versionsPath = join(webRoot, "content/versions.json")
    const before = await readFile(versionsPath)
    const docsMetaPath = join(webRoot, "content/docs/meta.json")
    const docsBefore = await readFile(docsMetaPath)
    try {
        await assert.rejects(generate({ releasesDirectory: released, publicBuild: true }), /requires an imported published snapshot/)
        assert.deepEqual(await readFile(versionsPath), before)
        assert.deepEqual(await readFile(docsMetaPath), docsBefore)
    } finally {
        await rm(released, { recursive: true, force: true })
    }
})
