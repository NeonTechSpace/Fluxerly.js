import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "./build.mjs"

const sdk = fileURLToPath(new URL("../", import.meta.url))

export function validateVersion(version) {
    assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(canary|rc)\.(0|[1-9]\d*))?$/)
    return version
}

export function packageManifest(version) {
    const manifest = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"))
    assert.deepEqual(Object.keys(manifest.exports).toSorted(), [".", "./effect"])
    for (const entry of Object.values(manifest.exports)) {
        assert.ok(entry.import.startsWith("./dist/") && entry.import.endsWith(".js"))
        assert.equal(entry.types, entry.import.replace(/\.js$/, ".d.ts"))
    }
    assert.deepEqual(Object.keys(manifest.imports), ["#sdk/*"])
    assert.equal(manifest.imports["#sdk/*"].default, "./dist/*.js")
    const { private: _, scripts: __, devDependencies: ___, ...published } = manifest
    return { ...published, version: validateVersion(version) }
}

export function writeJson(path, value) {
    writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`)
}

export function commonFiles() {
    const source = globSync("src/**/*.ts", { cwd: sdk })
        .map((path) => path.replaceAll("\\", "/"))
        .toSorted()
    assert.ok(source.length > 0)
    const output = globSync("dist/**/*", { cwd: sdk, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(sdk.length).replaceAll("\\", "/"))
        .toSorted()
    const expected = source
        .flatMap((path) => {
            const stem = path.replace(/^src\//, "dist/").replace(/\.ts$/, "")
            return [".js", ".js.map", ".d.ts", ".d.ts.map"].map((extension) => stem + extension)
        })
        .toSorted()
    assert.deepEqual(output, expected, "Build output differs from the source inventory; run the clean SDK build")
    return [
        ...source,
        ...output,
        "README.md",
        "consumer/AGENTS.md",
        "LICENSE",
        ...(existsSync(join(sdk, "CHANGELOG.md")) ? ["CHANGELOG.md"] : []),
    ].toSorted()
}

export function copyCommonFiles(target) {
    const files = commonFiles()
    for (const path of files) {
        mkdirSync(dirname(join(target, path)), { recursive: true })
        copyFileSync(path === "LICENSE" ? join(sdk, "../../LICENSE") : join(sdk, path), join(target, path))
    }
    return files
}

export function prepareNpmPackage(target, version) {
    const manifest = packageManifest(version)
    mkdirSync(target)
    const files = copyCommonFiles(target)
    // pnpm pack serializes the shipped manifest this way; bind staging checksums to those exact archive bytes
    writeFileSync(join(target, "package.json"), JSON.stringify(manifest, null, 2))
    return [...files, "package.json"].toSorted()
}

export function fileManifest(directory, files) {
    return files.toSorted().map((path) => {
        const bytes = readFileSync(join(directory, path))
        return { path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
    })
}

export async function stageRelease({ version, output, packageManagerPath = process.env.npm_execpath }) {
    validateVersion(version)
    assert.ok(isAbsolute(output), "Output must be an absolute new directory")
    assert.ok(packageManagerPath, "Run staging through pnpm")
    mkdirSync(output)
    const npmDirectory = join(output, "npm")
    const npmFiles = prepareNpmPackage(npmDirectory, version)
    const tarball = join(output, "sdk.tgz")
    const args = ["pack", "--out", tarball, "--json"]
    const options = { cwd: npmDirectory, encoding: "utf8", timeout: 120_000, windowsHide: true }
    const json = /\.[cm]?js$/.test(packageManagerPath)
        ? execFileSync(process.execPath, [packageManagerPath, ...args], options)
        : execFileSync(packageManagerPath, args, options)
    const packed = JSON.parse(json)
    assert.deepEqual(packed.files.map((file) => file.path).toSorted(), npmFiles, "Unexpected npm pack inventory")
    const manifestPath = join(output, "manifest.json")
    writeJson(manifestPath, {
        name: packageManifest(version).name,
        version,
        npm: fileManifest(npmDirectory, npmFiles),
        tarball: fileManifest(output, ["sdk.tgz"])[0],
    })
    return { npm: { directory: npmDirectory, tarball }, manifestPath }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const arguments_ = process.argv.slice(2)
    assert.equal(arguments_.length, 4, "Usage: packages:prepare --version VERSION --out ABSOLUTE_DIRECTORY")
    assert.equal(arguments_[0], "--version")
    assert.equal(arguments_[2], "--out")
    validateVersion(arguments_[1])
    assert.ok(isAbsolute(arguments_[3]))
    build()
    console.log(JSON.stringify(await stageRelease({ version: arguments_[1], output: arguments_[3] })))
}
