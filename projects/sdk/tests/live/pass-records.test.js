import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { liveChecks } from "./run-all.js"
import { categories, categoriesForChanges } from "./support/categories.js"
import {
    categoryInputs,
    inputHash,
    loadPasses,
    passMaxAgeMs,
    reuseDecisions,
    savePasses,
    updatePasses,
} from "./support/pass-records.js"

const checks = liveChecks()
const names = Object.keys(categories)
const day = 24 * 60 * 60 * 1_000
const now = Date.parse("2026-11-03T12:00:00.000Z")
const paths = [
    "docs/RELEASING.md",
    "projects/web/src/pages/index.astro",
    "projects/sdk/README.md",
    "projects/sdk/src/internal/reactions.ts",
    "projects/sdk/src/internal/expressions.ts",
    "projects/sdk/src/internal/binding/operations.ts",
    "projects/sdk/tests/live/messages.js",
    "projects/sdk/tests/live/expressions.js",
    "projects/sdk/tests/live/expressions.test.js",
    "projects/sdk/tests/live/channel-fixture.mjs",
    "projects/sdk/tests/live/support/live-pacing.js",
    "projects/sdk/tests/live/run-all.js",
    "projects/sdk/package.json",
    "projects/sdk/tsconfig.json",
    "projects/pnpm-lock.yaml",
    "projects/release/upstream/manifest.json",
]

test("a category's inputs are all SDK source, compiler settings, its harnesses and the Fluxer pin, never docs", () => {
    const inputs = categoryInputs(paths, checks)
    expect(inputs.reactions).toEqual(
        [
            "projects/pnpm-lock.yaml",
            "projects/release/upstream/manifest.json",
            "projects/sdk/package.json",
            "projects/sdk/src/internal/binding/operations.ts",
            "projects/sdk/src/internal/expressions.ts",
            "projects/sdk/src/internal/reactions.ts",
            // The reactions harness imports the shared channel fixture
            "projects/sdk/tests/live/channel-fixture.mjs",
            "projects/sdk/tests/live/messages.js",
            "projects/sdk/tests/live/run-all.js",
            "projects/sdk/tests/live/support/live-pacing.js",
            "projects/sdk/tsconfig.json",
        ].sort(),
    )
    expect(inputs.expressions).toContain("projects/sdk/tests/live/expressions.js")
    expect(inputs.reactions).not.toContain("projects/sdk/tests/live/expressions.js")
    // The changed-file mapping picks likely categories, not every category whose checks run a file, so any SDK source
    // change must invalidate every category's pass
    for (const category of names) {
        for (const path of [
            "projects/sdk/src/internal/reactions.ts",
            "projects/sdk/src/internal/expressions.ts",
            "projects/sdk/tsconfig.json",
            "projects/release/upstream/manifest.json",
        ])
            expect(inputs[category], category).toContain(path)
        for (const path of ["docs/RELEASING.md", "projects/web/src/pages/index.astro", "projects/sdk/README.md"])
            expect(inputs[category], category).not.toContain(path)
        expect(inputs[category]).not.toContain("projects/sdk/tests/live/expressions.test.js")
    }
})

test("a shared live fixture counts for the categories whose harnesses import it, and only those", () => {
    const inputs = categoryInputs(paths, checks)
    expect(inputs.threads).toContain("projects/sdk/tests/live/channel-fixture.mjs")
    expect(inputs["typed-raw"]).toContain("projects/sdk/tests/live/channel-fixture.mjs")
    expect(inputs.members).not.toContain("projects/sdk/tests/live/channel-fixture.mjs")
    const selected = categoriesForChanges(["projects/sdk/tests/live/channel-fixture.mjs"], checks).categories
    expect(selected).toContain("threads")
    expect(selected).toContain("typed-raw")
    expect(selected).not.toContain("members")
})

test("the input hash changes with any input's content, a deleted input or another path list", () => {
    const files = { a: "one", b: "two" }
    const read = (path) => {
        if (!(path in files)) throw new Error("missing")
        return Buffer.from(files[path])
    }
    const first = inputHash(["a", "b"], read)
    expect(inputHash(["a", "b"], read)).toBe(first)
    files.b = "changed"
    expect(inputHash(["a", "b"], read)).not.toBe(first)
    files.b = "two"
    delete files.b
    expect(inputHash(["a", "b"], read)).not.toBe(first)
    expect(inputHash(["a"], read)).not.toBe(first)
})

test("a release run reuses only a recent pass on the same inputs, and --fresh reuses nothing", () => {
    const hashes = { smoke: "h1", expressions: "h2", reactions: "h3", uploads: "h4", oauth: "h5" }
    const passes = {
        smoke: { hash: "h1", passedAt: new Date(now - day).toISOString() },
        expressions: { hash: "old", passedAt: new Date(now - day).toISOString() },
        reactions: { hash: "h3", passedAt: new Date(now - passMaxAgeMs - 1).toISOString() },
        oauth: { hash: "h5", passedAt: new Date(now + day).toISOString() },
    }
    expect(reuseDecisions(passes, hashes, { now })).toEqual([
        { category: "smoke", run: false, passedAt: passes.smoke.passedAt },
        { category: "expressions", run: true, reason: "inputs changed" },
        { category: "reactions", run: true, reason: "expired" },
        { category: "uploads", run: true, reason: "no pass" },
        { category: "oauth", run: true, reason: "expired" },
    ])
    // A pass exactly 14 days old still counts
    expect(
        reuseDecisions(
            { smoke: { hash: "h1", passedAt: new Date(now - passMaxAgeMs).toISOString() } },
            { smoke: "h1" },
            { now },
        ),
    ).toEqual([{ category: "smoke", run: false, passedAt: new Date(now - passMaxAgeMs).toISOString() }])
    expect(reuseDecisions(passes, hashes, { now, fresh: true }).every((decision) => decision.reason === "fresh")).toBe(
        true,
    )
})

const hashes = Object.fromEntries(names.map((name) => [name, `hash-${name}`]))
const passing = (...units) => units.map((name) => ({ name, status: "pass" }))

test("a category records a pass only when every member passed in a run that was not throttled", () => {
    const after = updatePasses({}, { hashes, results: passing("expressions", "reactions@default"), now })
    expect(after).toEqual({
        expressions: { hash: "hash-expressions", passedAt: new Date(now).toISOString() },
        reactions: { hash: "hash-reactions", passedAt: new Date(now).toISOString() },
    })
    // A whole check covers both of its mode halves
    expect(Object.keys(updatePasses({}, { hashes, results: passing("reactions"), now })).sort()).toEqual([
        "reactions",
        "reactions-effect",
    ])
    // Some members passed and the others did not run: Neither a pass nor a removal
    const kept = { messages: { hash: "hash-messages", passedAt: new Date(now - day).toISOString() } }
    expect(updatePasses(kept, { hashes, results: passing("nonce", "events"), now })).toEqual(kept)
})

// Catches: A release run that reused a category whose latest run failed, only recovered a journal or met a 429
test.each(["fail", "timeout", "recovered", "skipped"])("a %s member removes its category's pass", (status) => {
    const passes = {
        expressions: { hash: "hash-expressions", passedAt: new Date(now - day).toISOString() },
        uploads: { hash: "hash-uploads", passedAt: new Date(now - day).toISOString() },
    }
    const after = updatePasses(passes, {
        hashes,
        results: [{ name: "expressions", status }, ...passing("attachments")],
        now,
    })
    expect(after.expressions).toBeUndefined()
    // uploads had one member pass and one not run, so its earlier pass stays
    expect(after.uploads).toEqual(passes.uploads)
})

test("a throttled run records no pass and removes the pass of every category it touched", () => {
    const passes = {
        expressions: { hash: "hash-expressions", passedAt: new Date(now - day).toISOString() },
        oauth: { hash: "hash-oauth", passedAt: new Date(now - day).toISOString() },
    }
    expect(updatePasses(passes, { hashes, results: passing("expressions"), throttled: true, now })).toEqual({
        oauth: passes.oauth,
    })
})

test("the record survives a round trip, and a damaged record means every category runs", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fluxerly-live-passes-")))
    try {
        const path = join(root, ".env.test.passes.json")
        expect(loadPasses(path)).toEqual({})
        const passes = { smoke: { hash: "h", passedAt: new Date(now).toISOString() } }
        savePasses(passes, path)
        expect(loadPasses(path)).toEqual(passes)
        writeFileSync(path, "{not json")
        expect(loadPasses(path)).toEqual({})
    } finally {
        rmSync(root, { recursive: true })
    }
})
