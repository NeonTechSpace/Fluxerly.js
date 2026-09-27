import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { assertReleaseSupport, validateReleaseSupport } from "../support.js"

const cli = fileURLToPath(new URL("../cli.js", import.meta.url))
const sentinel = `
    import fs from "node:fs/promises"
    import childProcess from "node:child_process"
    import { syncBuiltinESMExports } from "node:module"
    const unexpected = () => { throw new Error("Unexpected release boundary access") }
    for (const name of ["readFile", "writeFile", "open", "cp", "mkdtemp", "mkdir", "rm", "unlink"])
        fs[name] = unexpected
    childProcess.spawn = unexpected
    childProcess.spawnSync = unexpected
    globalThis.fetch = unexpected
    syncBuiltinESMExports()
`

test("Release support succeeds locally and malformed release commands still stop before effects", () => {
    for (const [args, status, reason] of [
        [["check-support"], 0, undefined],
        [["version", "--epoch", "bogus", "--channel", "canary"], 1, /Epoch/],
        [["prepare"], 1, /--output/],
        [["status", "nonexistent-candidate"], 1, /--checksum/],
        [["verify", "nonexistent-candidate"], 1, /--checksum/],
        [["publish", "nonexistent-candidate"], 1, /--checksum/],
    ]) {
        const result = spawnSync(
            process.execPath,
            ["--import", `data:text/javascript,${encodeURIComponent(sentinel)}`, cli, ...args],
            {
                encoding: "utf8",
                timeout: 10_000,
                windowsHide: true,
                env: {
                    ...process.env,
                    NPM_TOKEN: "test-placeholder",
                    NODE_AUTH_TOKEN: "test-placeholder",
                    npm_execpath: "nonexistent-publisher",
                },
            },
        )
        assert.ifError(result.error)
        assert.equal(result.status, status, `${args[0]}: ${result.stderr}`)
        assert.doesNotMatch(result.stderr, /Unexpected release boundary access/, args[0])
        if (reason) {
            assert.equal(result.stdout, "", args[0])
            assert.match(result.stderr, reason, args[0])
        } else {
            assert.notEqual(result.stdout.trim(), "", args[0])
            assert.equal(result.stderr, "", args[0])
        }
    }
})

test("Release support retains the exact required npm Effect peer", () => {
    const sdk = { peerDependencies: { effect: "4.0.0-rc.115" }, devDependencies: { effect: "4.0.0-rc.115" } }
    assert.doesNotThrow(() => validateReleaseSupport(sdk))
    for (const changed of [
        { ...sdk, peerDependencies: {} },
        { ...sdk, peerDependencies: { effect: "^4.0.0" } },
        { ...sdk, devDependencies: { effect: "4.0.0-rc.116" } },
        { ...sdk, peerDependenciesMeta: { effect: { optional: true } } },
    ]) assert.throws(() => validateReleaseSupport(changed), /exact Effect/)
})

test("The support gate leaves local planning, fragment authoring and candidate inspection available", (t) => {
    // An unsupported SDK manifest makes every gated command fail, so only ungated commands can pass
    const readFileSync = fs.readFileSync
    t.mock.method(fs, "readFileSync", (path, ...rest) =>
        String(path).replaceAll("\\", "/").endsWith("/sdk/package.json")
            ? JSON.stringify({ peerDependencies: {} })
            : readFileSync(path, ...rest),
    )
    syncBuiltinESMExports()
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
    })
    for (const action of ["plan", "changeset", "inspect"]) assert.doesNotThrow(() => assertReleaseSupport(action), action)
    for (const action of ["check-support", "version", "prepare", "verify", "publish", "status"])
        assert.throws(() => assertReleaseSupport(action), /exact Effect/, action)
})
