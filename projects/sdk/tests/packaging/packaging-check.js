import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { packageManifest, prepareNpmPackage, validateVersion } from "../../scripts/packages.js"

const sdk = fileURLToPath(new URL("../../", import.meta.url))

function temporary(check) {
    const root = realpathSync(tmpdir())
    const directory = mkdtempSync(join(root, "fluxerly-packaging-test-"))
    try {
        return check(directory)
    } finally {
        assert.equal(dirname(realpathSync(directory)), root)
        rmSync(directory, { recursive: true })
    }
}

await test("npm staging preserves compiler artifacts and documentation at a candidate version", () => {
    temporary((directory) => {
        const original = readFileSync(join(sdk, "package.json"), "utf8")
        const npm = join(directory, "npm")
        const version = "1000.0.0-canary.7"
        const npmFiles = prepareNpmPackage(npm, version)
        for (const path of npmFiles.filter((path) => path !== "package.json")) {
            const source = path === "LICENSE" ? join(sdk, "../../LICENSE") : join(sdk, path)
            assert.deepEqual(readFileSync(join(npm, path)), readFileSync(source), path)
        }
        const manifest = JSON.parse(readFileSync(join(npm, "package.json"), "utf8"))
        const source = JSON.parse(original)
        // Each entry point, including ./testing and ./effect/testing, resolves to a staged file for every condition
        assert.deepEqual(Object.keys(manifest.exports), [".", "./effect", "./testing", "./effect/testing"])
        for (const [entry, conditions] of Object.entries(manifest.exports))
            for (const target of Object.values(conditions))
                assert.ok(npmFiles.includes(target.replace(/^\.\//, "")), `${entry} maps to unstaged ${target}`)
        assert.equal(manifest.version, version)
        assert.ok(!manifest.private && !manifest.scripts && !manifest.devDependencies)
        for (const field of ["engines", "dependencies", "peerDependencies", "peerDependenciesMeta"])
            assert.deepEqual(manifest[field], source[field], field)
        // Effect stays a peer so a native application and the SDK share one runtime
        assert.equal(manifest.dependencies.effect, undefined)
        assert.ok(manifest.peerDependencies.effect)
        assert.throws(() => prepareNpmPackage(npm, version), { code: "EEXIST" })
        assert.equal(readFileSync(join(sdk, "package.json"), "utf8"), original)
    })
})

await test("Candidate versions reject paths, ambiguous release stages and invalid SemVer integers", () => {
    for (const version of ["../package", "v1.0.0", "01.0.0", "1.0.0-rc.01", "1.0.0-dev.1", "1.0.0+build.1"]) {
        assert.throws(() => validateVersion(version))
        assert.throws(() => packageManifest(version))
    }
    for (const version of ["0.0.0", "1000.0.0-canary.1", "1000.0.0-rc.1", "1000.0.0"]) {
        assert.equal(validateVersion(version), version)
    }
})

await test("A canonical changelog is included only when present, with exact bytes", async () => {
    const root = realpathSync(tmpdir())
    const directory = mkdtempSync(join(root, "fluxerly-changelog-package-test-"))
    try {
        const fixture = join(directory, "projects/sdk")
        for (const path of ["scripts", "src", "dist", "consumer"]) mkdirSync(join(fixture, path), { recursive: true })
        copyFileSync(join(sdk, "package.json"), join(fixture, "package.json"))
        for (const path of ["build.js", "packages.js"])
            copyFileSync(join(sdk, "scripts", path), join(fixture, "scripts", path))
        writeFileSync(join(directory, "LICENSE"), "Fixture license\n")
        writeFileSync(join(fixture, "README.md"), "Fixture README\n")
        writeFileSync(join(fixture, "consumer/AGENTS.md"), "Fixture consumer instructions\n")
        copyFileSync(join(sdk, "esm-only.cjs"), join(fixture, "esm-only.cjs"))
        // Package preparation validates versions with the release planner beside the SDK directory
        mkdirSync(join(directory, "projects/release"), { recursive: true })
        writeFileSync(
            join(directory, "projects/release/planning.js"),
            `export { parseVersion } from ${JSON.stringify(pathToFileURL(join(sdk, "../release/planning.js")).href)}\n`,
        )
        for (const entry of ["index", "effect"]) {
            writeFileSync(join(fixture, "src", `${entry}.ts`), "export {}\n")
            writeFileSync(join(fixture, "dist", `${entry}.js`), "export {}\n")
            writeFileSync(join(fixture, "dist", `${entry}.d.ts`), "export {}\n")
            for (const extension of ["js.map", "d.ts.map"]) {
                writeFileSync(
                    join(fixture, "dist", `${entry}.${extension}`),
                    JSON.stringify({ version: 3, sources: [`../src/${entry}.ts`], mappings: "AAAA" }),
                )
            }
        }
        const prepared = await import(pathToFileURL(join(fixture, "scripts/packages.js")))
        for (const present of [false, true]) {
            const changelog = "# Changelog\n\n## 1000.0.0-canary.1\n\n- Fixture release\n"
            if (present) writeFileSync(join(fixture, "CHANGELOG.md"), changelog)
            const target = join(directory, `npm-${present}`)
            const files = prepared.prepareNpmPackage(target, "1000.0.0-canary.1")
            assert.equal(files.includes("CHANGELOG.md"), present)
            if (present) assert.equal(readFileSync(join(target, "CHANGELOG.md"), "utf8"), changelog)
        }
    } finally {
        assert.equal(dirname(realpathSync(directory)), root)
        rmSync(directory, { recursive: true })
    }
})
