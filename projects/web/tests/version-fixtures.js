import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { build } from "astro"
import { filesIn, generate, webRoot } from "../scripts/generate.js"
import { validateSnapshot } from "../scripts/versions.js"

const require = createRequire(import.meta.url)
// Astro moves prerendered assets, so isolated output must share the cache's filesystem
const temporaryParent = join(webRoot, ".astro")
await mkdir(temporaryParent, { recursive: true })
const root = await mkdtemp(join(temporaryParent, "versions-"))
const released = join(root, "released")
await mkdir(released)
const fixtures = [
    ["1000.0.0", "Promise<void>", "Stableonlymarker"],
    ["1000.0.1", "Promise<boolean>", "Lateststablemarker"],
    ["1000.1.0-rc.0", "Promise<number>", "Previousrcmarker"],
    ["1000.1.0-rc.1", "Promise<string>", "Rconlymarker"],
    ["1000.2.0-canary.0", "Promise<{ id: string }>", "Canaryonlymarker"],
    ["1000.2.0-canary.1", "Promise<{ id: string }>", "Latestcanarymarker"],
]
const markdown = (title, body) => `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body}\n`
const saved = new Map()
const deferred = new Set(["1000.1.0-rc.1", "1000.2.0-canary.1"])
try {
    for (const [version, signature, marker] of fixtures) {
        const files = [
            { path: "index.md", content: markdown("Documentation", `Immutable ${version} fixture`) },
            { path: "quick-start.md", content: markdown("Send your first message", `Guide for ${version}\n\n\`\`\`command\n${JSON.stringify({ kind: "install", package: "@neontechspace/fluxerly", version })}\n\`\`\``) },
            { path: "changelog.md", content: markdown("Changelog", `Changes for ${version}`) },
            {
                path: "api/index.md",
                content: markdown("API reference", `[Signature](/docs/${version}/api/signature/)`),
            },
            {
                path: "api/signature.md",
                content: markdown("Versioned signature", `## sendOnce\n\n\`sendOnce(): ${signature}\`\n\n${marker}`),
            },
            {
                path: "api/meta.json",
                content: JSON.stringify({ title: "API reference", pages: ["index", "signature", "..."] }),
            },
            {
                path: "meta.json",
                content: JSON.stringify({
                    title: version,
                    root: "version",
                    pages: ["index", "quick-start", "api", "changelog"],
                }),
            },
        ]
        if (version === "1000.0.0")
            files.push({
                path: "api/removed.md",
                content: markdown("Removed in RC", "This page exists only in the stable archive"),
            })
        const bytes = JSON.stringify(
            validateSnapshot({ schemaVersion: 1, version, sourceCommit: "1".repeat(40), files }),
        )
        saved.set(version, bytes)
        if (!deferred.has(version)) await writeFile(join(released, `${version}.json`), bytes, { flag: "wx" })
    }
    // Before Stable exists, latest must still render the exact selected prerelease under its own alias
    const prereleases = join(root, "prereleases")
    await mkdir(prereleases)
    for (const version of ["1000.2.0-canary.0", "1000.1.0-rc.0"]) {
        await writeFile(join(prereleases, `${version}.json`), saved.get(version))
        await generate({ releasesDirectory: prereleases, publicBuild: true })
        const metadata = JSON.parse(await readFile(join(webRoot, "content/versions.json"), "utf8"))
        assert.equal(metadata.defaultVersion, version)
        assert.match(await readFile(join(webRoot, "content/docs/latest/api/index.md"), "utf8"), /\/docs\/latest\/api\/signature/)
        assert.ok(!metadata.targets.some((target) => target.label === "Stable"))
    }
    await generate({ releasesDirectory: released, publicBuild: true })
    assert.equal(await readFile(join(webRoot, "content/versions.json"), "utf8").then((value) => JSON.parse(value).previewVersion), null)
    assert.ok(!(await filesIn(join(webRoot, "content/docs"))).some((file) => file.path.startsWith("preview/") || file.path.startsWith("dev/")))
    const before = new Map()
    for (const version of ["1000.0.0", "1000.0.1"]) before.set(version, await filesIn(join(webRoot, "content/docs", version)))
    assert.match(await readFile(join(webRoot, "content/docs/rc/api/signature.md"), "utf8"), /Previousrcmarker/)
    assert.match(await readFile(join(webRoot, "content/docs/canary/api/signature.md"), "utf8"), /Canaryonlymarker/)
    for (const version of deferred) await writeFile(join(released, `${version}.json`), saved.get(version), { flag: "wx" })
    // A clean regeneration discards stale generated output, never the release snapshot source
    await writeFile(
        join(webRoot, "content/docs/latest/stale.md"),
        markdown("Stale generated page", "Not part of a release"),
    )
    await generate({ releasesDirectory: released, publicBuild: true })
    for (const [version] of fixtures) {
        assert.equal(await readFile(join(released, `${version}.json`), "utf8"), saved.get(version))
    }
    for (const [version, files] of before) assert.deepEqual(await filesIn(join(webRoot, "content/docs", version)), files)
    assert.deepEqual((await readdir(join(webRoot, "content/docs"))).sort(), ["1000.0.0", "1000.0.1", "canary", "latest", "meta.json", "rc"])
    assert.match(await readFile(join(webRoot, "content/docs/rc/api/signature.md"), "utf8"), /Rconlymarker/)
    assert.match(await readFile(join(webRoot, "content/docs/canary/api/signature.md"), "utf8"), /Latestcanarymarker/)
    assert.match(await readFile(join(webRoot, "content/docs/rc/api/index.md"), "utf8"), /\/docs\/rc\/api\/signature/)
    assert.match(await readFile(join(webRoot, "content/docs/canary/api/index.md"), "utf8"), /\/docs\/canary\/api\/signature/)
    assert.ok(!(await filesIn(join(webRoot, "content/docs/latest"))).some((file) => file.path === "stale.md"))
    const outDir = join(root, "dist")
    await build({ root: webRoot, outDir, logLevel: "warn" })
    execFileSync(
        process.execPath,
        [join(dirname(require.resolve("@playwright/test/package.json")), "cli.js"), "test"],
        {
            cwd: webRoot,
            env: { ...process.env, DOCS_TEST_VERSIONS: "1", DOCS_TEST_OUTPUT_DIR: outDir },
            stdio: "inherit",
            timeout: 180_000,
            windowsHide: true,
        },
    )
} finally {
    // Restore generated development content even if a fixture assertion fails
    await generate()
    if (dirname(root) !== resolve(temporaryParent)) throw new Error("Unexpected documentation fixture directory")
    await rm(root, { recursive: true, force: true })
}
