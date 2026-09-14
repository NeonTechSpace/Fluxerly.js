import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { prepareCandidate } from "../candidate.mjs"
import { fixture, stageFixture, write } from "./helpers.mjs"

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
const name = "@neontechspace/fluxerly"
const version = "1000.0.0-canary.1"

async function candidateFixture() {
    const root = await fixture(version)
    await write(join(root, "sdk/CHANGELOG.md"), `# SDK\n\n## ${version}\n\nRelease candidate\n`)
    const docs = join(root, "snapshot.json")
    await write(docs, {
        schemaVersion: 1,
        version,
        sourceCommit: "a".repeat(40),
        files: [{ path: "guides/index.md", content: "Guide\n" }],
    })
    const directory = join(root, "candidate")
    const candidate = await prepareCandidate({
        workspace: root,
        output: directory,
        docs,
        bootstrap: true,
        registries: { inventory: async () => ({ npmVersions: [] }) },
        stage: stageFixture(),
    })
    return { root, directory, checksum: candidate.checksum }
}

function preload({ trace, published, lockDirectory }) {
    return `
        import { EventEmitter } from "node:events"
        import fs from "node:fs"
        import childProcess from "node:child_process"
        import { syncBuiltinESMExports } from "node:module"
        import { join } from "node:path"

        const name = ${JSON.stringify(name)}
        const version = ${JSON.stringify(version)}
        const trace = ${JSON.stringify(trace)}
        const lockDirectory = ${JSON.stringify(lockDirectory)}
        const state = {
            published: ${JSON.stringify(Boolean(published))},
            requests: [],
            spawns: [],
        }
        globalThis.fetch = async (input) => {
            const url = new URL(String(input))
            state.requests.push(url.href)
            if (url.origin === "https://registry.npmjs.org" && decodeURIComponent(url.pathname.slice(1)) === name) {
                const versions = state.published ? { [version]: {} } : {}
                const tags = state.published ? { canary: version } : {}
                return new Response(JSON.stringify({ name, versions, "dist-tags": tags }))
            }
            throw new Error("Published file download is not allowed in this CLI test")
        }
        childProcess.spawn = (executable, arguments_, options) => {
            if (!arguments_.includes("--provenance")) throw new Error("Unexpected subprocess")
            const environment = options.env
            const config = environment.NPM_CONFIG_USERCONFIG
            state.spawns.push({
                executable,
                arguments: arguments_,
                cwd: options.cwd,
                hasNpmToken: "NPM_TOKEN" in environment,
                hasNodeAuthToken: "NODE_AUTH_TOKEN" in environment,
                hasInheritedConfig: config === "inherited-npmrc",
                isolatedConfigExists: typeof config === "string" && fs.existsSync(config),
                config,
                lockExists: fs.existsSync(join(lockDirectory, ".release-publish-npm.lock")),
            })
            state.published = true
            const child = new EventEmitter()
            queueMicrotask(() => child.emit("close", 0))
            return child
        }
        process.once("exit", () => fs.writeFileSync(trace, JSON.stringify(state)))
        syncBuiltinESMExports()
    `
}

function runCli(candidate, args, { published = false, oidc = true, trace = join(candidate.root, "trace.json") } = {}) {
    const environment = {
        ...process.env,
        RUNNER_TEMP: tmpdir(),
        NPM_TOKEN: "test-npm-token",
        NODE_AUTH_TOKEN: "test-node-auth-token",
        NPM_CONFIG_USERCONFIG: "inherited-npmrc",
        npm_execpath: "fake-pnpm",
    }
    if (oidc) Object.assign(environment, {
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-oidc-token",
    })
    else {
        delete environment.GITHUB_ACTIONS
        delete environment.ACTIONS_ID_TOKEN_REQUEST_URL
        delete environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    }
    const result = spawnSync(
        process.execPath,
        ["--import", `data:text/javascript,${encodeURIComponent(preload({
            trace, published, lockDirectory: join(import.meta.dirname, "..", ".."),
        }))}`, cli, ...args],
        { encoding: "utf8", timeout: 10_000, windowsHide: true, env: environment },
    )
    assert.ifError(result.error)
    return { ...result, trace: JSON.parse(readFileSync(trace, "utf8")) }
}

function assertNpmOnly(trace) {
    assert.ok(trace.requests.length > 0)
    assert.ok(trace.requests.every(request => new URL(request).origin === "https://registry.npmjs.org"), trace.requests.join("\n"))
}

function assertLockRemoved() {
    assert.equal(existsSync(join(import.meta.dirname, "..", "..", ".release-publish-npm.lock")), false)
}

test("npm publication passes only OIDC authentication to its publisher", async () => {
    const candidate = await candidateFixture()
    try {
        assertLockRemoved()
        const result = runCli(candidate, ["publish", candidate.directory, "--checksum", candidate.checksum])
        assert.equal(result.status, 0, result.stderr)
        const output = JSON.parse(result.stdout)
        assert.equal(output.directory, candidate.directory)
        assert.equal(output.checksum, candidate.checksum)
        assert.equal(output.npm, "published")
        assert.equal(output.complete, true)
        assert.equal(output.tag, "canary")
        assert.deepEqual(result.trace.spawns.length, 1)
        assertNpmOnly(result.trace)
        const [spawn] = result.trace.spawns
        assert.equal(spawn.hasNpmToken, false)
        assert.equal(spawn.hasNodeAuthToken, false)
        assert.equal(spawn.hasInheritedConfig, false)
        assert.equal(spawn.isolatedConfigExists, true)
        assert.equal(spawn.lockExists, true)
        assert.equal(existsSync(spawn.config), false)
        assert.equal(spawn.arguments[1], join(candidate.directory, "sdk.tgz"))
        assertLockRemoved()
    } finally {
        await rm(candidate.root, { recursive: true })
    }
})

test("npm verification and status use metadata only and never publish", async () => {
    const candidate = await candidateFixture()
    try {
        for (const action of ["verify", "status"]) {
            const result = runCli(candidate, [action, candidate.directory, "--checksum", candidate.checksum], {
                published: true,
                trace: join(candidate.root, `${action}-trace.json`),
            })
            assert.equal(result.status, 0, result.stderr)
            assert.deepEqual(JSON.parse(result.stdout).npm, "published")
            assert.deepEqual(result.trace.spawns, [])
            assertNpmOnly(result.trace)
        }
    } finally {
        await rm(candidate.root, { recursive: true })
    }
})

test("Publication failures stop before publishing and release the npm lock", async () => {
    const candidate = await candidateFixture()
    try {
        const existing = runCli(candidate, ["publish", candidate.directory, "--checksum", candidate.checksum], {
            published: true,
            trace: join(candidate.root, "existing-trace.json"),
        })
        assert.equal(existing.status, 1)
        assert.match(existing.stderr, /already published/)
        assert.deepEqual(existing.trace.spawns, [])
        assertNpmOnly(existing.trace)
        assertLockRemoved()

        const missingOidc = runCli(candidate, ["publish", candidate.directory, "--checksum", candidate.checksum], {
            oidc: false,
            trace: join(candidate.root, "missing-oidc-trace.json"),
        })
        assert.equal(missingOidc.status, 1)
        assert.match(missingOidc.stderr, /GitHub OIDC/)
        assert.deepEqual(missingOidc.trace.requests, [])
        assert.deepEqual(missingOidc.trace.spawns, [])

        const unsupportedOption = runCli(candidate, ["publish", candidate.directory, "--checksum", candidate.checksum, "--registry", "npm"], {
            trace: join(candidate.root, "unsupported-option-trace.json"),
        })
        assert.equal(unsupportedOption.status, 1)
        assert.match(unsupportedOption.stderr, /Unknown or duplicate release option/)
        assert.deepEqual(unsupportedOption.trace.requests, [])
        assert.deepEqual(unsupportedOption.trace.spawns, [])

        const invalidChecksum = runCli(candidate, ["publish", candidate.directory, "--checksum", "f".repeat(64)], {
            trace: join(candidate.root, "invalid-checksum-trace.json"),
        })
        assert.equal(invalidChecksum.status, 1)
        assert.match(invalidChecksum.stderr, /externally reviewed checksum/)
        assert.deepEqual(invalidChecksum.trace.requests, [])
        assert.deepEqual(invalidChecksum.trace.spawns, [])
    } finally {
        await rm(candidate.root, { recursive: true })
    }
})
