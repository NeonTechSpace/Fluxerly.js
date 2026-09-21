import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import test from "node:test"
import { withReleaseAuthentication } from "../authentication.js"

const tokens = { RUNNER_TEMP: tmpdir(), NPM_TOKEN: "npm-test", NODE_AUTH_TOKEN: "other-test" }
const oidc = { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-test" }

test("GitHub OIDC publishers receive an isolated configuration with no fallback tokens", () => {
    const source = {
        ...tokens,
        ...oidc,
        npm_config_userconfig: "lowercase-config",
        NPM_CONFIG_USERCONFIG: "uppercase-config",
        npm_token: "lowercase-npm-token",
        node_auth_token: "lowercase-node-token",
    }
    const snapshot = { ...source }
    let config
    const result = withReleaseAuthentication(source, (env) => {
        config = env.NPM_CONFIG_USERCONFIG
        for (const name of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "npm_token", "node_auth_token", "npm_config_userconfig"])
            assert.equal(env[name], undefined)
        assert.notEqual(config, source.NPM_CONFIG_USERCONFIG)
        assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, oidc.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
        assert.equal(readFileSync(config, "utf8"), "registry=https://registry.npmjs.org/\n")
        return "published"
    })
    assert.equal(result, "published")
    assert.equal(existsSync(config), false)
    assert.deepEqual(source, snapshot)
})

test("Missing or incomplete GitHub OIDC stops before a publisher can run", () => {
    const sources = [
        { ...tokens },
        { ...tokens, GITHUB_ACTIONS: "true" },
        { ...tokens, ...oidc, ACTIONS_ID_TOKEN_REQUEST_URL: "" },
        { ...tokens, ...oidc, ACTIONS_ID_TOKEN_REQUEST_TOKEN: " " },
    ]
    for (const source of sources) {
        const snapshot = { ...source }
        let called = false
        assert.throws(() => withReleaseAuthentication(source, () => { called = true }), /GitHub OIDC/)
        assert.equal(called, false)
        assert.deepEqual(source, snapshot)
    }
})

test("Async OIDC publishers retain the isolated configuration until publication completes", async () => {
    let config
    let complete
    const result = withReleaseAuthentication({ ...tokens, ...oidc }, async (env) => {
        config = env.NPM_CONFIG_USERCONFIG
        assert.equal(existsSync(config), true)
        await new Promise((resolve) => { complete = resolve })
        assert.equal(existsSync(config), true)
        return "published"
    })
    assert.equal(existsSync(config), true)
    complete()
    assert.equal(await result, "published")
    assert.equal(existsSync(config), false)
})

test("Rejected async OIDC publishers clean up without a retry", async () => {
    let attempts = 0
    let config
    const failure = new Error("OIDC authentication rejected")
    const result = withReleaseAuthentication({ ...tokens, ...oidc }, async (env) => {
        attempts++
        config = env.NPM_CONFIG_USERCONFIG
        assert.equal(env.NPM_TOKEN, undefined)
        await Promise.resolve()
        throw failure
    })
    await assert.rejects(result, (error) => error === failure)
    assert.equal(attempts, 1)
    assert.equal(existsSync(config), false)
})
