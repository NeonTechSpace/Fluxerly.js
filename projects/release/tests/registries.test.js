import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { exactFiles } from "../content.js"
import { createRegistries } from "../registries.js"
import { packages, tarball } from "./helpers.js"

const name = "@neontechspace/fluxerly"
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })

test("npm inventory requests only the official package metadata", async () => {
    const calls = []
    const registries = createRegistries({ fetchImpl: async url => {
        calls.push(String(url))
        assert.equal(url.origin, "https://registry.npmjs.org")
        assert.equal(url.pathname, "/%40neontechspace%2Ffluxerly")
        return json({ name, versions: { "1000.0.0": {} }, "dist-tags": { latest: "1000.0.0" } })
    } })
    assert.deepEqual(await registries.inventory(name), {
        npmVersions: ["1000.0.0"],
        npmTags: { latest: "1000.0.0" },
        absent: { npm: false },
    })
    assert.equal(calls.length, 1)
})

test("Official npm package 404 requires explicit bootstrap, other failures never establish absence", async () => {
    const registries = createRegistries({ fetchImpl: async () => json({ error: "Not found" }, 404) })
    await assert.rejects(registries.inventory(name), /HTTP 404/)
    assert.deepEqual(await registries.inventory(name, { bootstrap: true }), {
        npmVersions: [],
        npmTags: {},
        absent: { npm: true },
    })
    for (const status of [403, 429, 500])
        await assert.rejects(
            createRegistries({ fetchImpl: async () => json({ privateBody: "Do not expose" }, status) }).inventory(
                name,
                { bootstrap: true },
            ),
            new RegExp(`HTTP ${status}`),
        )
    await assert.rejects(
        createRegistries({
            fetchImpl: async () => {
                throw new Error("Network failed with private data")
            },
        }).inventory(name, { bootstrap: true }),
        /Registry request failed/,
    )
})

test("npm metadata and integrity lead to actual archive file verification", async () => {
    const files = packages("1000.0.0-canary.0")
    const compressed = tarball(files)
    const registries = createRegistries({
        fetchImpl: async (url) =>
            String(url).endsWith("sdk.tgz")
                ? new Response(compressed)
                : json({
                      name,
                      version: "1000.0.0-canary.0",
                      dist: {
                          tarball: "https://registry.npmjs.org/sdk.tgz",
                          integrity: `sha512-${createHash("sha512").update(compressed).digest("base64")}`,
                      },
                  }),
    })
    assert.deepEqual(exactFiles(await registries.npmFiles(name, "1000.0.0-canary.0")), exactFiles(files))
    const wrongOrigin = createRegistries({
        fetchImpl: async () =>
            json({ name, version: "1000.0.0-canary.0", dist: { tarball: "https://example.com/sdk.tgz" } }),
    })
    await assert.rejects(wrongOrigin.npmFiles(name, "1000.0.0-canary.0"), /official npm registry/)
})
