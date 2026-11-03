import { spawnSync } from "node:child_process"
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test, vi } from "vitest"
import { copyHarnessSupport, lockFiles } from "./support/fixture-root.js"
import { jsonLines } from "./support/json-lines.js"

const childTimeoutMs = 60_000
// Allow every sequential child its own limit, plus one child limit for fixture setup and cleanup
vi.setConfig({ testTimeout: (1 + 1) * childTimeoutMs })

const temporaryParent = realpathSync(tmpdir())
const temporaryRoots: string[] = []
const fixtureToken = "fixture-token-not-a-credential"

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(temporaryParent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

/** A fixture root whose sandbox answers the test-channel create with a 429 that asks for a wait over ten seconds */
function fixture(probeFailure = false) {
    const root = mkdtempSync(join(temporaryParent, "fluxerly-command-conveniences-"))
    temporaryRoots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    mkdirSync(join(root, "node_modules"), { recursive: true })
    symlinkSync(
        fileURLToPath(new URL("../../node_modules/effect", import.meta.url)),
        join(root, "node_modules/effect"),
        "junction",
    )
    copyFileSync(
        new URL("./command-conveniences.js", import.meta.url),
        join(root, "tests/live/command-conveniences.mjs"),
    )
    copyHarnessSupport(root)
    copyFileSync(new URL("./upload-diagnostics.mjs", import.meta.url), join(root, "tests/live/upload-diagnostics.mjs"))
    if (probeFailure) {
        const sdk = join(root, "node_modules/@neontechspace/fluxerly")
        mkdirSync(sdk, { recursive: true })
        writeFileSync(
            join(sdk, "package.json"),
            JSON.stringify({
                type: "module",
                exports: { ".": "./default.js", "./effect": "./effect.js" },
            }),
        )
        writeFileSync(join(sdk, "default.js"), `export { createDefault as createClient, commands } from "./fixture.js"`)
        writeFileSync(join(sdk, "effect.js"), `export { createNative as createClient, commands } from "./fixture.js"`)
        writeFileSync(
            join(sdk, "fixture.js"),
            `
            import { Effect } from "effect"
            export const commands = {}
            const success = (value) => ({ isErr: () => false, isOk: () => true, value })
            const failure = { _tag: "MessageError", reason: "rejected", status: 500, outcome: "unknown" }
            function create(native) {
                const ok = (value) => native ? Effect.succeed(value) : success(value)
                const subscription = { close: () => ok(), waitForClose: () => ok(), result: () => ok({ messages: [] }) }
                return {
                    connect: () => ok(), shutdown: () => ok(), on: () => native ? ok(subscription) : subscription,
                    messages: {
                        collect: () => native ? ok(subscription) : subscription,
                        send: () => native ? Effect.fail(failure) : { isErr: () => true, error: failure },
                    },
                }
            }
            export const createDefault = () => create(false)
            export const createNative = () => Effect.succeed(create(true))
        `,
        )
    }
    writeFileSync(
        join(root, ".env.test.local"),
        `FLUXER_TEST_GUILD_ID=100\nFLUXER_TEST_APPLICATION_ID=150\nFLUXER_TEST_BOT_TOKEN=${fixtureToken}\n`,
    )
    writeFileSync(
        join(root, "trap.mjs"),
        `
            const reads = {
                "/api/v1/applications/@me": { id: "150", bot: { id: "200" } },
                "/api/v1/users/@me": { id: "200", bot: true },
                "/api/v1/guilds/100": { id: "100" },
                "/api/v1/guilds/100/members/200": { user: { id: "200" } },
                "/api/v1/guilds/100/channels": [],
            }
            let channel
            globalThis.fetch = async (url, options = {}) => {
                const path = new URL(url).pathname
                const method = options.method ?? "GET"
                console.log(JSON.stringify({ fixture: "remote_request", method, path }))
                if (${probeFailure} && method === "POST" && path === "/api/v1/guilds/100/channels") {
                    channel = { id: "300", guild_id: "100", ...JSON.parse(options.body) }
                    return Response.json(channel)
                }
                if (${probeFailure} && path === "/api/v1/guilds/100/channels") return Response.json(channel ? [channel] : [])
                if (${probeFailure} && path === "/api/v1/channels/300") {
                    if (method === "DELETE") { channel = undefined; return new Response(null, { status: 204 }) }
                    return Response.json(channel ?? null, { status: channel ? 200 : 404 })
                }
                if (method === "GET" && reads[path]) return Response.json(reads[path])
                if (method === "POST" && path === "/api/v1/guilds/100/channels")
                    return Response.json({ retry_after: 60 }, { status: 429 })
                return Response.json(null, { status: 500 })
            }
        `,
    )
    return root
}

test.each(["default", "effect"])(
    "%s command conveniences removes the journal of a test-channel create that Fluxer refused with 429",
    (mode) => {
        const root = fixture()
        const child = spawnSync(
            process.execPath,
            ["--import", "./trap.mjs", "tests/live/command-conveniences.mjs", mode, "help"],
            { cwd: root, encoding: "utf8", timeout: childTimeoutMs, windowsHide: true },
        )
        expect(child.error).toBeUndefined()
        expect(child.status).toBe(1)
        const output = child.stdout + child.stderr
        expect(output).not.toContain(fixtureToken)
        const lines = jsonLines(output)
        expect(lines).toContainEqual(
            expect.objectContaining({ stage: "create_test_owned_channel", passed: false, journalRetained: true }),
        )
        // The refused create is not replayed, and cleanup confirms the channel is absent before removing the journal
        expect(lines.filter((line) => line.fixture === "remote_request" && line.method === "POST")).toHaveLength(1)
        expect(lines).toContainEqual(expect.objectContaining({ check: "planned_channel_creation_not_dispatched" }))
        expect(existsSync(join(root, ".env.test.command-conveniences-help.local"))).toBe(false)
        expect(lockFiles(root)).toEqual([])
    },
)

test.each(["default", "effect"])(
    "%s probe failure reports the provider status and still removes its channel",
    (mode) => {
        const root = fixture(true)
        const child = spawnSync(
            process.execPath,
            ["--import", "./trap.mjs", "tests/live/command-conveniences.mjs", mode, "fields"],
            { cwd: root, encoding: "utf8", timeout: childTimeoutMs, windowsHide: true },
        )
        expect(child.error).toBeUndefined()
        expect(child.status).toBe(1)
        const output = child.stdout + child.stderr
        expect(output).not.toContain(fixtureToken)
        const lines = jsonLines(output)
        expect(lines).toContainEqual(
            expect.objectContaining({
                stage: "selected_fields_observed_gateway_registration",
                passed: false,
                tag: "MessageError",
                reason: "rejected",
                status: 500,
                outcome: "unknown",
                providerFault: true,
            }),
        )
        expect(lines).toContainEqual(expect.objectContaining({ check: "test_owned_channel_removed", passed: true }))
        expect(existsSync(join(root, ".env.test.command-conveniences-fields.local"))).toBe(false)
        expect(lockFiles(root)).toEqual([])
    },
)
