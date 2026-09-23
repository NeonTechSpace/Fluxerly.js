import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stageRelease } from "../scripts/packages.js"
import { readCandidate } from "../../release/candidate.js"

const sdk = fileURLToPath(new URL("../", import.meta.url))
const source = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"))
const require = createRequire(import.meta.url)
const npmManifest = require("npm/package.json")
assert.match(source.devDependencies.npm, /^\d+\.\d+\.\d+$/, "Pin the npm consumer-test CLI exactly")
const npm = join(dirname(require.resolve("npm/package.json")), npmManifest.bin.npm)
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== "--candidate" || !isAbsolute(args[1])))
    throw new Error("Use no arguments or --candidate ABSOLUTE_DIRECTORY")
const candidate = args.length ? await readCandidate(args[1]) : null
if (candidate && (candidate.name !== source.name || candidate.version !== source.version))
    throw new Error("Candidate identity does not match the checked source")
const root = realpathSync(tmpdir())
const temporary = mkdtempSync(join(root, "fluxerly-npm-package-check-"))
function run(args, cwd, timeout = 120_000) {
    return execFileSync(process.execPath, args, { cwd, encoding: "utf8", timeout, windowsHide: true })
}
try {
    const npmVersion = run([npm, "--version"], temporary).trim()
    assert.equal(npmVersion, source.devDependencies.npm, "Use the pinned npm CLI on the selected Node runtime")
    console.log(`npm packed peer check runtime: Node ${process.version}, npm ${npmVersion}`)
    const staged = candidate
        ? { npm: { tarball: join(args[1], "sdk.tgz"), directory: join(args[1], "npm") } }
        : await stageRelease({ version: source.version, output: join(temporary, "artifacts") })
    const files = candidate
        ? Object.keys(candidate.files)
        : JSON.parse(readFileSync(staged.manifestPath, "utf8")).npm.map((file) => file.path)
    const install = [
        npm,
        "install",
        "--ignore-scripts",
        "--strict-peer-deps",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(temporary, "cache"),
    ]
    for (const kind of ["default", "effect", "incompatible"]) {
        const consumer = join(temporary, kind)
        mkdirSync(consumer)
        const dependencies = { [source.name]: `file:${staged.npm.tarball.replaceAll("\\", "/")}` }
        if (kind === "effect") dependencies.effect = source.peerDependencies.effect
        if (kind === "incompatible") {
            const fixture = join(temporary, "incompatible-effect")
            mkdirSync(fixture)
            writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "effect", version: "4.0.0-rc.116" }))
            dependencies.effect = `file:${fixture.replaceAll("\\", "/")}`
        }
        writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }))
        const result = spawnSync(process.execPath, install, {
            cwd: consumer,
            encoding: "utf8",
            timeout: 120_000,
            windowsHide: true,
        })
        if (result.error) throw result.error
        if (kind === "incompatible") {
            assert.notEqual(result.status, 0)
            assert.match(result.stdout + result.stderr, /ERESOLVE/)
            console.log("npm strict peer install rejected a different Effect RC")
            continue
        }
        assert.equal(result.status, 0, result.stdout + result.stderr)
        const installed = join(consumer, "node_modules", source.name)
        for (const file of files) {
            assert.deepEqual(readFileSync(join(installed, file)), readFileSync(join(staged.npm.directory, file)))
        }
        assert.equal(
            existsSync(join(consumer, "node_modules/typescript")),
            false,
            "JavaScript usage must not install TypeScript",
        )
        const program =
            kind === "default"
                ? `import { createClient } from ${JSON.stringify(source.name)}; const result = createClient({ token: "fixture" }); if (result.isErr()) throw result.error; await result.value.shutdown()`
                : `import { Effect } from "effect"; import { createClient } from ${JSON.stringify(`${source.name}/effect`)}; import { createRequire } from "node:module"; import { resolve } from "node:path"; const app = createRequire(resolve("package.json")); const sdk = createRequire(resolve("node_modules/${source.name}/package.json")); if (app.resolve("effect") !== sdk.resolve("effect")) throw Error("Separate Effect runtime"); await Effect.runPromise(Effect.scoped(createClient({ token: "fixture" })))`
        run(["--input-type=module", "--eval", program], consumer, 10_000)
        console.log(`npm ${kind} automatic/runtime peer consumer passed`)
    }
} finally {
    assert.equal(dirname(realpathSync(temporary)), root)
    rmSync(temporary, { recursive: true })
}
