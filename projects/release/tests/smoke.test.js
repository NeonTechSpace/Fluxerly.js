import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { entryPoints, importProgram, smokeRegistryInstall } from "../smoke.js"

const exports = { ".": {}, "./effect": {}, "./testing": {}, "./effect/testing": {} }

function fakeNpm({ failures = 0, installedVersion } = {}) {
    const calls = []
    return {
        calls,
        run(args, cwd, env) {
            calls.push({ args, env })
            if (args[0] === "npm-cli.js") {
                if (calls.length <= failures) throw new Error("ETARGET")
                const target = join(cwd, "node_modules", "@neontechspace", "fluxerly")
                mkdirSync(target, { recursive: true })
                const version = installedVersion ?? args[2].split("@").at(-1)
                writeFileSync(join(target, "package.json"), JSON.stringify({ name: "@neontechspace/fluxerly", version, exports }))
            }
        },
    }
}

test("Registry smoke installs the exact version from npm and imports every exported entry point", async () => {
    const npm = fakeNpm({ failures: 2 })
    const waits = []
    const result = await smokeRegistryInstall({
        version: "1000.0.0-rc.1",
        npm: "npm-cli.js",
        run: npm.run,
        wait: async (milliseconds) => { waits.push(milliseconds) },
        progress: () => {},
    })
    assert.equal(result.version, "1000.0.0-rc.1")
    const installs = npm.calls.filter((call) => call.args[0] === "npm-cli.js")
    assert.equal(installs.length, 3)
    assert.equal(waits.length, 2)
    const [install] = installs
    assert.equal(install.args[2], "@neontechspace/fluxerly@1000.0.0-rc.1")
    assert.ok(install.args.includes("--ignore-scripts"))
    assert.equal(install.args[install.args.indexOf("--registry") + 1], "https://registry.npmjs.org/")
    assert.equal("NPM_TOKEN" in install.env, false)
    const program = npm.calls.at(-1).args
    assert.deepEqual(program.slice(0, 2), ["--input-type=module", "--eval"])
    assert.deepEqual(result.entries, Object.keys(exports))
    assert.equal(program[2], importProgram(Object.keys(exports)))
})

test("Registry smoke fails for other installed versions, exhausted retries and non-release versions", async () => {
    const options = { npm: "npm-cli.js", wait: async () => {}, progress: () => {} }
    await assert.rejects(
        smokeRegistryInstall({ ...options, version: "1000.0.0", run: fakeNpm({ installedVersion: "1000.0.1" }).run }),
        /different package identity or version/,
    )
    const unavailable = fakeNpm({ failures: 10 })
    await assert.rejects(
        smokeRegistryInstall({ ...options, version: "1000.0.0", run: unavailable.run, attempts: 3 }),
        /after 3 attempts/,
    )
    assert.equal(unavailable.calls.length, 3)
    for (const version of ["latest", "^1000.0.0", "0.1.0"])
        await assert.rejects(smokeRegistryInstall({ ...options, version, run: fakeNpm().run }))
})

test("The import program loads each entry point and fails when one exports no functions", () => {
    const consumer = mkdtempSync(join(realpathSync(tmpdir()), "fluxerly-smoke-test-"))
    try {
        const target = join(consumer, "node_modules", "@neontechspace", "fluxerly")
        mkdirSync(join(target, "effect"), { recursive: true })
        const manifest = {
            name: "@neontechspace/fluxerly",
            type: "module",
            exports: { ".": "./index.js", "./effect": "./effect.js", "./effect/testing": "./effect/testing.js" },
        }
        writeFileSync(join(target, "package.json"), JSON.stringify(manifest))
        writeFileSync(join(target, "index.js"), "export function createClient() {}\n")
        writeFileSync(join(target, "effect.js"), "export function createClient() {}\n")
        writeFileSync(join(target, "effect", "testing.js"), "export const value = 1\n")
        const run = () =>
            execFileSync(process.execPath, ["--input-type=module", "--eval", importProgram(entryPoints(manifest))], {
                cwd: consumer,
                stdio: "pipe",
            })
        assert.throws(run, /@neontechspace\/fluxerly\/effect\/testing exports no functions/)
        writeFileSync(join(target, "effect", "testing.js"), "export function createTestClient() {}\n")
        run()
        rmSync(join(target, "effect.js"))
        assert.throws(run, /ERR_MODULE_NOT_FOUND/)
    } finally {
        rmSync(consumer, { recursive: true, force: true })
    }
})

test("Entry points come from the installed manifest and must include the root", () => {
    assert.deepEqual(entryPoints({ exports: { ".": {}, "./testing": {} } }), [".", "./testing"])
    for (const exports of [undefined, { "./effect": {} }, { ".": {}, "./*": {} }])
        assert.throws(() => entryPoints({ exports }), /public entry points/)
})
