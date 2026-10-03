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
import { jsonLines, type JsonLine } from "./support/json-lines.js"

const childTimeoutMs = 60_000
// Allow every sequential child its own limit, plus one child limit for fixture setup and cleanup
vi.setConfig({ testTimeout: (1 + 1) * childTimeoutMs })

const temporaryParent = realpathSync(tmpdir())
const temporaryRoots: string[] = []
const channelName = "fluxerly-sdk-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const fixtureToken = "fixture-not-a-credential"

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(temporaryParent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

// A stand-in default SDK whose client fails right after acquisition, in the nonce send or the state observer.
// Its shutdown can be made to fail so the harness must retain its recovery evidence
const fakeSdk = {
    "package.json": JSON.stringify({ name: "@neontechspace/fluxerly", type: "module", exports: { ".": "./index.js" } }),
    "index.js": `
        const failure = () => Error("fixture acquisition-adjacent failure")
        export const createClient = () => ({
            state: "Disconnected",
            messages: { send: async () => { throw failure() } },
            observeState: () => { throw failure() },
            shutdown: async () => {
                console.log(JSON.stringify({ fixture: "client_shutdown" }))
                if (process.env.FLUXERLY_MESSAGES_SHUTDOWN_FAILURE === "1") throw Error(${JSON.stringify("fixture-private-shutdown-detail")})
                return { isOk: () => true, isErr: () => false }
            },
        })
    `,
}

// Runs the real harness. By default a journal retained by an earlier run triggers recovery cleanup before new work,
// and the journaled moderation target names a different bot than the verified one, so moderation recovery refuses.
// With `journal: null` the run starts fresh, creating its temporary channel before the stand-in SDK client
function fixture(journal: { guildId?: string; channelId?: string | null } | null = {}) {
    const root = mkdtempSync(join(temporaryParent, "fluxerly-message-cleanup-"))
    temporaryRoots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    mkdirSync(join(root, "node_modules/@neontechspace"), { recursive: true })
    copyFileSync(new URL("./messages.js", import.meta.url), join(root, "tests/live/messages.mjs"))
    for (const helper of [
        "upload-diagnostics.mjs",
        "channel-fixture.mjs",
        "reaction-fixture.mjs",
        "guild-fixture.mjs",
        "moderation-fixture.mjs",
        "attachment-sources.mjs",
        "attachment-refresh.js",
    ])
        copyFileSync(new URL(`./${helper}`, import.meta.url), join(root, `tests/live/${helper}`))
    copyHarnessSupport(root)
    for (const [target, source] of [
        ["node_modules/effect", "../../node_modules/effect"],
        ["node_modules/ws", "../../node_modules/ws"],
    ] as const)
        symlinkSync(fileURLToPath(new URL(source, import.meta.url)), join(root, target), "junction")
    const sdk = join(root, "node_modules/@neontechspace/fluxerly")
    mkdirSync(sdk)
    for (const [file, content] of Object.entries(fakeSdk)) writeFileSync(join(sdk, file), content)
    writeFileSync(
        join(root, ".env.test.local"),
        `FLUXER_TEST_GUILD_ID=100\nFLUXER_TEST_APPLICATION_ID=200\nFLUXER_TEST_BOT_TOKEN=${fixtureToken}\n`,
    )
    if (journal)
        writeFileSync(
            join(root, ".env.test.messages.local"),
            JSON.stringify({
                guildId: journal.guildId ?? "100",
                name: channelName,
                ...(journal.channelId === null ? {} : { channelId: journal.channelId ?? "300" }),
                moderation: { userId: "400", botId: "200", reason: `${channelName}-moderation` },
            }),
        )
    writeFileSync(
        join(root, "trap.mjs"),
        `
            const name = ${JSON.stringify(channelName)}
            const ownershipConflict = process.env.FLUXERLY_MESSAGES_OWNERSHIP_CONFLICT_FIXTURE === "1"
            let channelPresent = true
            const created = []
            globalThis.fetch = async (url, options = {}) => {
                const path = new URL(url).pathname
                const method = options.method ?? "GET"
                if (method === "GET" && path === "/v1/applications/@me") return Response.json({ id: "200", bot: { id: "300" } })
                if (method === "GET" && path === "/v1/users/@me") return Response.json({ id: "300", bot: true })
                if (method === "GET" && path === "/v1/guilds/100") return Response.json({ id: "100" })
                if (method === "POST" && path === "/v1/guilds/100/channels") {
                    const channel = { id: "310", ...JSON.parse(options.body), guild_id: "100" }
                    created.push(channel)
                    console.log(JSON.stringify({ fixture: "temporary_channel_created" }))
                    return Response.json(channel)
                }
                if (path === "/v1/channels/310") {
                    if (method === "DELETE") {
                        created.splice(0)
                        console.log(JSON.stringify({ fixture: "temporary_channel_deleted" }))
                        return Response.json({})
                    }
                    return created.length ? Response.json(created[0]) : Response.json(null, { status: 404 })
                }
                if (method === "GET" && path === "/v1/guilds/100/channels")
                    return Response.json([
                        ...(channelPresent ? [{ id: ownershipConflict ? "301" : "300", name, guild_id: "100", type: 0 }] : []),
                        ...created,
                    ])
                if (method === "GET" && path === "/v1/channels/300")
                    return channelPresent
                        ? Response.json({ id: "300", name: ownershipConflict ? "renamed-owned-channel" : name, guild_id: "100", type: 0 })
                        : Response.json(null, { status: 404 })
                if (method === "GET" && path === "/v1/channels/301")
                    return channelPresent
                        ? Response.json({ id: "301", name, guild_id: "100", type: 0 })
                        : Response.json(null, { status: 404 })
                if (method === "DELETE" && (path === "/v1/channels/300" || path === "/v1/channels/301")) {
                    channelPresent = false
                    return Response.json({})
                }
                if (method !== "GET") console.log(JSON.stringify({ fixture: "unexpected_write", method, path }))
                return Response.json([])
            }
            process.on("exit", () => console.log(JSON.stringify({ fixture: "channel_present", channelPresent })))
        `,
    )
    return root
}

function spawn(root: string, args: readonly string[], environment: Record<string, string>) {
    const child = spawnSync(process.execPath, ["--import", "./trap.mjs", "tests/live/messages.mjs", ...args], {
        cwd: root,
        env: { ...process.env, FLUXER_TEST_MODERATION_USER_ID: "400", ...environment },
        encoding: "utf8",
        timeout: childTimeoutMs,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status).toBe(1)
    const output = child.stdout + child.stderr
    expect(output).not.toContain(fixtureToken)
    expect(output).not.toContain("fixture-private-shutdown-detail")
    const lines = jsonLines(output)
    expect(lines.filter((line) => line.fixture === "unexpected_write")).toEqual([])
    return lines
}

const fixtureEvents = (lines: readonly JsonLine[]) =>
    lines.flatMap((line) => (typeof line.fixture === "string" ? [line.fixture] : []))

function run(root: string, environment: Record<string, string> = {}) {
    const lines = spawn(root, ["default"], environment)
    // Recovery fails, so the run never starts new work, keeps its journal and releases the lock
    expect(lines).toContainEqual(expect.objectContaining({ check: "recovery_only", passed: false }))
    expect(fixtureEvents(lines)).not.toContain("temporary_channel_created")
    expect(existsSync(join(root, ".env.test.messages.local"))).toBe(true)
    expect(lockFiles(root)).toEqual([])
    return lines
}

test.each([
    ["nonce", "--nonce-only"],
    ["observer", "--recover"],
])("default %s failure immediately after acquisition shuts down the client before cleanup", (_point, flag) => {
    const root = fixture(null)
    const lines = spawn(root, ["default", flag], {})
    expect(
        fixtureEvents(lines).filter((event) =>
            ["temporary_channel_created", "client_shutdown", "temporary_channel_deleted"].includes(event),
        ),
    ).toEqual(["temporary_channel_created", "client_shutdown", "temporary_channel_deleted"])
    expect(existsSync(join(root, `.env.test.messages-${flag.slice(2)}.local`))).toBe(false)
    expect(lockFiles(root)).toEqual([])
})

test.each([
    ["nonce", "--nonce-only"],
    ["observer", "--recover"],
])("default %s failure with an unproven shutdown retains the journal, channel and lock", (_point, flag) => {
    const root = fixture(null)
    const lines = spawn(root, ["default", flag], { FLUXERLY_MESSAGES_SHUTDOWN_FAILURE: "1" })
    expect(fixtureEvents(lines)).toContain("client_shutdown")
    expect(lines).toContainEqual(expect.objectContaining({ check: "sdk_not_quiescent_lock_retained", passed: false }))
    expect(fixtureEvents(lines)).not.toContain("temporary_channel_deleted")
    expect(existsSync(join(root, `.env.test.messages-${flag.slice(2)}.local`))).toBe(true)
    expect(lockFiles(root)).toEqual([`.env.test.local.lock.messages-${flag.slice(2)}`])
})

const channelRemoved = { check: "test_channel_and_messages_removed", passed: true }

test("message live cleanup deletes the owned channel after moderation recovery fails", () => {
    const lines = run(fixture())
    expect(lines).toContainEqual(expect.objectContaining(channelRemoved))
    expect(lines).toContainEqual({ fixture: "channel_present", channelPresent: false })
})

test("message cleanup reconciles an unknown channel ID through its unique marker", () => {
    const lines = run(fixture({ channelId: null }))
    expect(lines).toContainEqual(expect.objectContaining(channelRemoved))
    expect(lines).toContainEqual({ fixture: "channel_present", channelPresent: false })
})

test("message cleanup retains evidence when the recorded channel ID conflicts with a matching marker", () => {
    const lines = run(fixture(), { FLUXERLY_MESSAGES_OWNERSHIP_CONFLICT_FIXTURE: "1" })
    expect(lines).not.toContainEqual(expect.objectContaining(channelRemoved))
    expect(lines).toContainEqual({ fixture: "channel_present", channelPresent: true })
})

test("message live cleanup retains the journal and channel when the journal guild identity is invalid", () => {
    const lines = run(fixture({ guildId: "999" }))
    expect(lines).not.toContainEqual(expect.objectContaining(channelRemoved))
    expect(lines).toContainEqual({ fixture: "channel_present", channelPresent: true })
})
