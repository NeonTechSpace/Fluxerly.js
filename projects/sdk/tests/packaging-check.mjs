import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { packageManifest, prepareNpmPackage, validateVersion } from "../scripts/packages.mjs"

const sdk = fileURLToPath(new URL("../", import.meta.url))

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

test("npm staging preserves compiler artifacts and documentation at a candidate version", () => {
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
        assert.equal(readFileSync(join(npm, "package.json"), "utf8"), JSON.stringify(manifest, null, 2))
        assert.equal(manifest.version, version)
        assert.equal(manifest.engines.node, ">=24.11.0")
        assert.ok(!manifest.private && !manifest.scripts && !manifest.devDependencies)
        assert.equal(manifest.dependencies.effect, undefined)
        assert.equal(manifest.peerDependencies.effect, "4.0.0-rc.115")
        assert.equal(manifest.peerDependenciesMeta, undefined)
        assert.throws(() => prepareNpmPackage(npm, version), { code: "EEXIST" })
        assert.equal(readFileSync(join(sdk, "package.json"), "utf8"), original)
    })
})

test("Candidate versions reject paths, ambiguous release stages and invalid SemVer integers", () => {
    for (const version of [
        "../package",
        "v1.0.0",
        "01.0.0",
        "1.0.0-rc.01",
        "1.0.0-dev.1",
        "1.0.0+build.1",
        "0.1.0-alpha.1",
        "1000.0.0-beta.1",
    ]) {
        assert.throws(() => validateVersion(version))
        assert.throws(() => packageManifest(version))
    }
    for (const version of ["0.0.0", "1000.0.0-canary.1", "1000.0.0-rc.1", "1000.0.0"]) {
        assert.equal(validateVersion(version), version)
    }
})

test("A canonical changelog is included only when present, with exact bytes", async () => {
    const root = realpathSync(tmpdir())
    const directory = mkdtempSync(join(root, "fluxerly-changelog-package-test-"))
    try {
        const fixture = join(directory, "projects/sdk")
        for (const path of ["scripts", "src", "dist", "consumer"]) mkdirSync(join(fixture, path), { recursive: true })
        copyFileSync(join(sdk, "package.json"), join(fixture, "package.json"))
        for (const path of ["build.mjs", "packages.mjs"])
            copyFileSync(join(sdk, "scripts", path), join(fixture, "scripts", path))
        writeFileSync(join(directory, "LICENSE"), "Fixture license\n")
        writeFileSync(join(fixture, "README.md"), "Fixture README\n")
        writeFileSync(join(fixture, "consumer/AGENTS.md"), "Fixture consumer instructions\n")
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
        const prepared = await import(pathToFileURL(join(fixture, "scripts/packages.mjs")))
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
