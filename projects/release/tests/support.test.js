import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
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
    for (const [args, status, error] of [
        [["check-support"], 0, ""],
        [["version", "--epoch", "bogus", "--channel", "canary"], 1, "Epoch must be a number"],
        [["prepare"], 1, "Prepare needs --output NEW_ABSOLUTE_DIRECTORY"],
        [["status", "nonexistent-candidate"], 1, "Status, verify and publish require --checksum"],
        [["verify", "nonexistent-candidate"], 1, "Status, verify and publish require --checksum"],
        [["publish", "nonexistent-candidate"], 1, "Status, verify and publish require --checksum"],
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
        assert.equal(result.status, status, args[0])
        if (status === 0)
            assert.equal(
                result.stdout,
                "Release prerequisite passed: Exact required Effect peer matches the SDK development dependency\n",
            )
        else assert.equal(result.stdout, "", args[0])
        assert.ok(result.stderr.trim().startsWith(error), result.stderr)
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

test("The support gate leaves local planning, fragment authoring and candidate inspection available", () => {
    for (const action of ["plan", "changeset", "inspect"]) assert.doesNotThrow(() => assertReleaseSupport(action))
})
