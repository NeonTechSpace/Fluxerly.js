import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
    checkCodeCatalogue,
    generateCodeCatalogue,
    readCodeCatalogue,
    scanSdkCodes,
} from "../scripts/code-catalogue.js"

const sdkRoot = resolve(fileURLToPath(new URL("../../sdk", import.meta.url)))

async function sourceFixture(t, files) {
    const root = await mkdtemp(join(tmpdir(), "fluxerly-code-catalogue-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(root, "src", path, ".."), { recursive: true })
        await writeFile(join(root, "src", path), content)
    }
    return root
}

test("The SDK code catalogue covers every code the SDK creates, and the page lists every entry", async () => {
    const page = await generateCodeCatalogue(sdkRoot)
    const { errorCodes, logCodes } = await readCodeCatalogue(sdkRoot)
    for (const code of [...Object.keys(errorCodes), ...Object.keys(logCodes)]) assert.ok(page.includes(`| \`${code}\` |`), code)
})

test("The scan finds code literals, template families and operation prefixes, but not comments or messages", async (t) => {
    const root = await sourceFixture(t, {
        "errors.ts": [
            "/** code: \"comment.only\" */",
            "super(message, { code: \"auth.rejected\", hint })",
            "super(message, { code: `asset.${reason}` })",
            "log({ code: \"testing.unmatchedRequest\", message: `No route for ${method} ${path}` })",
            "operationErrorSettings(\"guild\", fields, cause)",
            "const known = \"lifecycle.ready\"",
        ].join("\n"),
    })
    const { created, literals } = await scanSdkCodes(root)
    assert.deepEqual([...created.keys()].sort(), ["asset.<reason>", "auth.rejected", "guild.<reason>", "testing.unmatchedRequest"])
    assert.ok(literals.has("lifecycle.ready"))
    assert.ok(!literals.has("comment.only"))
})

test("The check fails for a missing entry and for entries whose code is gone", () => {
    const entry = { error: "Example", meaning: "Example" }
    const scan = (codes, literals = []) => ({ created: new Map(codes.map((code) => [code, "src/x.ts:1"])), literals: new Set(literals) })
    const catalogue = { errorCodes: { "auth.rejected": entry }, logCodes: { "lifecycle.ready": { levels: ["info"], meaning: "Ready" } } }
    // A log code passed as an argument rather than a code: property still counts as emitted
    checkCodeCatalogue(catalogue, scan(["auth.rejected"], ["lifecycle.ready"]))
    assert.throws(() => checkCodeCatalogue(catalogue, scan(["auth.rejected", "client.busy"], ["lifecycle.ready"])), /client\.busy/)
    assert.throws(() => checkCodeCatalogue(catalogue, scan([], ["lifecycle.ready"])), /auth\.rejected/)
    assert.throws(() => checkCodeCatalogue(catalogue, scan(["auth.rejected"])), /lifecycle\.ready/)
})
