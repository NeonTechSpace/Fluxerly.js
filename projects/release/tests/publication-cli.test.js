import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { prepareCandidate } from "../candidate.js"
import { fixture, stageFixture, write } from "./helpers.js"

const cli = fileURLToPath(new URL("../cli.js", import.meta.url))
const name = "@neontechspace/fluxerly"
const version = "1000.0.0-canary.1"
const npmToken = `npm_${"a".repeat(36)}`

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
        registries: { inventory: async () => ({ npmVersions: [] }) },
        stage: stageFixture(),
    })
    return { root, directory, checksum: candidate.checksum }
}

// The preload replaces npm registry access and the publisher subprocess inside the CLI process
function preload({ trace, published, different, tarball }) {
    return `
        import { EventEmitter } from "node:events"
        import { createHash } from "node:crypto"
        import fs from "node:fs"
        import childProcess from "node:child_process"
        import { syncBuiltinESMExports } from "node:module"
        import { PassThrough } from "node:stream"

        const name = ${JSON.stringify(name)}
        const version = ${JSON.stringify(version)}
        const trace = ${JSON.stringify(trace)}
        const served = ${JSON.stringify(Boolean(different))} ? Buffer.from("Unreviewed bytes") : fs.readFileSync(${JSON.stringify(tarball)})
        const tarballUrl = "https://registry.npmjs.org/@neontechspace/fluxerly/-/fluxerly-" + version + ".tgz"
        const integrity = "sha512-" + createHash("sha512").update(served).digest("base64")
        const state = {
            published: ${JSON.stringify(Boolean(published))},
            tags: ${JSON.stringify(published ? { canary: version } : {})},
            requests: [],
            spawns: [],
        }
        globalThis.fetch = async (input) => {
            const url = new URL(String(input))
            state.requests.push(url.href)
            if (url.href === tarballUrl) return new Response(served)
            if (url.origin === "https://registry.npmjs.org" && decodeURIComponent(url.pathname.slice(1)) === name) {
                const versions = state.published ? { [version]: { dist: { tarball: tarballUrl, integrity } } } : {}
                return new Response(JSON.stringify({ name, versions, "dist-tags": state.tags }))
            }
            throw new Error("Unexpected registry request")
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
            })
            state.published = true
            state.tags[arguments_[arguments_.indexOf("--tag") + 1]] = version
            const child = new EventEmitter()
            child.stdout = new PassThrough()
            child.stderr = new PassThrough()
            queueMicrotask(() => {
                child.stdout.end("npm notice publishing " + name + "\\n")
                child.stderr.end("npm notice using ${npmToken} and authorization: Bearer test-oidc-token\\n")
                setImmediate(() => child.emit("close", 0))
            })
            return child
        }
        process.once("exit", () => fs.writeFileSync(trace, JSON.stringify(state)))
        syncBuiltinESMExports()
    `
}

function runCli(candidate, args, { published = false, different = false, oidc = true, trace = join(candidate.root, "trace.json") } = {}) {
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
            trace, published, different, tarball: join(candidate.directory, "sdk.tgz"),
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

test("npm publication passes only OIDC authentication to its publisher and surfaces redacted output", async () => {
    const candidate = await candidateFixture()
    try {
        const result = runCli(candidate, ["publish", candidate.directory, "--checksum", candidate.checksum])
        assert.equal(result.status, 0, result.stderr)
        const output = JSON.parse(result.stdout)
        assert.equal(output.directory, candidate.directory)
        assert.equal(output.checksum, candidate.checksum)
        assert.deepEqual([output.npm, output.complete, output.tag, output.published], ["published", true, "canary", "now"])
        assert.deepEqual(result.trace.spawns.length, 1)
        assertNpmOnly(result.trace)
        const [spawn] = result.trace.spawns
        assert.equal(spawn.hasNpmToken, false)
        assert.equal(spawn.hasNodeAuthToken, false)
        assert.equal(spawn.hasInheritedConfig, false)
        assert.equal(spawn.isolatedConfigExists, true)
        assert.equal(existsSync(spawn.config), false)
        assert.equal(spawn.arguments[1], join(candidate.directory, "sdk.tgz"))
        assert.match(result.stderr, /npm notice publishing/)
        assert.match(result.stderr, /npm notice using \[redacted\]/)
        assert.doesNotMatch(result.stderr, new RegExp(`${npmToken}|test-oidc-token`))
    } finally {
        await rm(candidate.root, { recursive: true })
    }
})

test("npm verification, status and publication reruns compare served bytes and never publish again", async () => {
    const candidate = await candidateFixture()
    try {
        for (const action of ["verify", "status", "publish"]) {
            const result = runCli(candidate, [action, candidate.directory, "--checksum", candidate.checksum], {
                published: true,
                trace: join(candidate.root, `${action}-trace.json`),
            })
            assert.equal(result.status, 0, result.stderr)
            const output = JSON.parse(result.stdout)
            assert.equal(output.npm, "published")
            if (action === "publish") assert.equal(output.published, "already")
            assert.deepEqual(output.distTags, { canary: version })
            assert.deepEqual(result.trace.spawns, [])
            assertNpmOnly(result.trace)
            assert.ok(result.trace.requests.some((request) => request.endsWith(".tgz")))
        }
        const status = runCli(candidate, ["status", candidate.directory, "--checksum", candidate.checksum], {
            published: true,
            different: true,
            trace: join(candidate.root, "different-status-trace.json"),
        })
        assert.equal(status.status, 0, status.stderr)
        assert.deepEqual([JSON.parse(status.stdout).npm, JSON.parse(status.stdout).complete], ["different", false])
        const verify = runCli(candidate, ["verify", candidate.directory, "--checksum", candidate.checksum], {
            published: true,
            different: true,
            trace: join(candidate.root, "different-verify-trace.json"),
        })
        assert.equal(verify.status, 1)
        assert.match(verify.stderr, /different bytes/)
    } finally {
        await rm(candidate.root, { recursive: true })
    }
})

test("Publication input and authentication failures stop before registry effects", async () => {
    const candidate = await candidateFixture()
    try {
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
