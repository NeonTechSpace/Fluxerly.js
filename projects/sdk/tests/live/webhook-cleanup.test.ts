import { spawnSync } from "node:child_process"
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
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
vi.setConfig({ testTimeout: (2 + 1) * childTimeoutMs })

const temporaryParent = realpathSync(tmpdir())
const temporaryRoots: string[] = []
const fixtureToken = "fixture-token-not-a-credential"
const privateFailure = "fixture-private-finalizer-detail"
const marker = "fluxerly-wh-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const journalPath = (root: string) => join(root, ".env.test.webhooks.local")
// A shortened harness deadline, distinct from every other timer the harness sets
const watchdogMs = 1_000

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(temporaryParent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

// A stand-in SDK: the bot client is created and then fails to connect, so the real harness reaches its finalizer
// with owned writers. Shutdown and scope-finalizer failures are selected per run
const fakeSdk = {
    "package.json": JSON.stringify({
        name: "@neontechspace/fluxerly",
        type: "module",
        exports: { ".": "./index.js", "./effect": "./effect.js" },
    }),
    "shared.js": `
        export const failing = (name) => (process.env.FLUXERLY_WEBHOOKS_FINALIZER_FAILURES ?? "").split(",").includes(name)
        export const finalize = (name) => {
            console.log(JSON.stringify({ fixture: name }))
            if (failing(name)) throw Error(${JSON.stringify(privateFailure)})
        }
    `,
    "index.js": `
        import { finalize } from "./shared.js"
        export const createClient = () => ({
            state: "Disconnected",
            on: () => ({ close() {} }),
            connect: async () => ({ isErr: () => true, error: Error("fixture connect failure") }),
            shutdown: async () => finalize("bot_client_shutdown"),
        })
    `,
    "effect.js": `
        import { Effect } from "effect"
        import { finalize } from "./shared.js"
        export const createClient = () =>
            Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Effect.sync(() => finalize("scope_close")))
                return {
                    state: "Disconnected",
                    on: () => Effect.void,
                    connect: () => Effect.fail(Error("fixture connect failure")),
                    shutdown: () => Effect.sync(() => finalize("bot_client_shutdown")),
                }
            })
    `,
}

function fixture(journal?: object) {
    const root = mkdtempSync(join(temporaryParent, "fluxerly-webhook-cleanup-"))
    temporaryRoots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    const sdk = join(root, "node_modules/@neontechspace/fluxerly")
    mkdirSync(sdk, { recursive: true })
    for (const [file, content] of Object.entries(fakeSdk)) writeFileSync(join(sdk, file), content)
    symlinkSync(
        fileURLToPath(new URL("../../node_modules/effect", import.meta.url)),
        join(root, "node_modules/effect"),
        "junction",
    )
    copyFileSync(new URL("./webhooks.js", import.meta.url), join(root, "tests/live/webhooks.mjs"))
    copyHarnessSupport(root)
    writeFileSync(
        join(root, ".env.test.local"),
        `FLUXER_TEST_GUILD_ID=100\nFLUXER_TEST_APPLICATION_ID=150\nFLUXER_TEST_BOT_TOKEN=${fixtureToken}\n`,
    )
    if (journal) writeFileSync(journalPath(root), JSON.stringify(journal))
    writeFileSync(
        join(root, "trap.mjs"),
        `
            const marker = ${JSON.stringify(marker)}
            const hooks = []
            if (process.env.FLUXERLY_WEBHOOKS_RECOVERY_FIXTURE === "1")
                hooks.push(
                    { id: "400", name: marker + "-token", user: { id: "200" }, guild_id: "100", channel_id: "300" },
                    { id: "401", name: marker + "-unknown", user: { id: "200" }, guild_id: "100", channel_id: "999" },
                )
            if (process.env.FLUXERLY_WEBHOOKS_FOREIGN_COLLISION === "1")
                hooks.unshift({ id: "402", name: marker + "-token", user: { id: "201" }, guild_id: "100", channel_id: "300" })
            const channels =
                process.env.FLUXERLY_WEBHOOKS_RECOVERY_FIXTURE === "1"
                    ? [{ id: "300", name: marker + "-a", guild_id: "100", type: 0 }]
                    : []
            const deletions = []
            let nextChannel = 310
            const identity = {
                "/v1/applications/@me": { id: "150", bot: { id: "200" } },
                "/v1/users/@me": { id: "200", bot: true },
                "/v1/guilds/100": { id: "100" },
            }
            const fixtureFetch = async (url, options = {}) => {
                const path = new URL(url).pathname
                const method = options.method ?? "GET"
                if (method === "GET" && identity[path]) return Response.json(identity[path])
                console.log(JSON.stringify({ fixture: "remote_request", method, path }))
                if (process.env.FLUXERLY_WEBHOOKS_CLEANUP_FAILURE === "1" && path === "/v1/guilds/100/webhooks")
                    throw Error(${JSON.stringify(privateFailure)})
                if (path === "/v1/guilds/100/webhooks") return Response.json(hooks)
                if (path === "/v1/guilds/100/channels" && method === "GET") return Response.json(channels)
                if (path === "/v1/guilds/100/channels" && method === "POST") {
                    const channel = { id: String(nextChannel++), ...JSON.parse(options.body), guild_id: "100" }
                    channels.push(channel)
                    return Response.json(channel)
                }
                const [, , kind, id] = path.split("/")
                const list = kind === "webhooks" ? hooks : kind === "channels" ? channels : undefined
                const index = list?.findIndex((item) => item.id === id) ?? -1
                if (method === "DELETE" && index >= 0) {
                    list.splice(index, 1)
                    deletions.push(id)
                    return Response.json({})
                }
                if (method === "GET" && list) return index >= 0 ? Response.json(list[index]) : Response.json(null, { status: 404 })
                return Response.json(null, { status: 500 })
            }
            globalThis.fetch = fixtureFetch
            // A writer that stays alive until the deadline, as an unproven shutdown could leave one
            if (process.env.FLUXERLY_WEBHOOKS_ACTIVE_WRITER === "1") setInterval(() => {}, 1_000)
            // The harness deadline is the only timer with the shortened delay the test selected
            const watchdogMs = Number(process.env.FLUXERLY_LIVE_WATCHDOG_MS)
            const set = globalThis.setTimeout
            let watchdog
            globalThis.setTimeout = (callback, delay, ...args) => {
                const timer = set(callback, delay, ...args)
                if (delay === watchdogMs) watchdog = timer
                return timer
            }
            const clear = globalThis.clearTimeout
            globalThis.clearTimeout = (timeout) => {
                if (timeout === watchdog) console.log(JSON.stringify({ fixture: "watchdog_cleared" }))
                return clear(timeout)
            }
            process.on("exit", () =>
                console.log(JSON.stringify({ fixture: "fetch_restored", restored: globalThis.fetch === fixtureFetch })),
            )
            process.on("exit", () => console.log(JSON.stringify({ fixture: "recovery_state", hooks, channels, deletions })))
        `,
    )
    return root
}

function run(
    root: string,
    mode: string,
    options: { cleanupFailure?: boolean; failures?: string[]; recovery?: boolean; foreignCollision?: boolean } = {},
) {
    const child = spawnSync(process.execPath, ["--import", "./trap.mjs", "tests/live/webhooks.mjs", mode], {
        cwd: root,
        env: {
            ...process.env,
            FLUXERLY_WEBHOOKS_CLEANUP_FAILURE: options.cleanupFailure ? "1" : "0",
            FLUXERLY_WEBHOOKS_FINALIZER_FAILURES: options.failures?.join(",") ?? "",
            FLUXERLY_WEBHOOKS_ACTIVE_WRITER: options.failures?.length ? "1" : "0",
            FLUXERLY_WEBHOOKS_RECOVERY_FIXTURE: options.recovery ? "1" : "0",
            FLUXERLY_WEBHOOKS_FOREIGN_COLLISION: options.foreignCollision ? "1" : "0",
            FLUXERLY_LIVE_WATCHDOG_MS: String(watchdogMs),
        },
        encoding: "utf8",
        timeout: childTimeoutMs,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status).toBe(1)
    const output = child.stdout + child.stderr
    expect(output).not.toContain(fixtureToken)
    expect(output).not.toContain(privateFailure)
    const lines = jsonLines(output)
    expect(lines).toContainEqual({ fixture: "fetch_restored", restored: true })
    if (options.failures?.length) expect(lines).not.toContainEqual({ fixture: "watchdog_cleared" })
    else expect(lines).toContainEqual({ fixture: "watchdog_cleared" })
    return lines
}

type RecoveryState = {
    readonly hooks: readonly JsonLine[]
    readonly channels: readonly JsonLine[]
    readonly deletions: readonly string[]
}

function recoveryState(lines: readonly JsonLine[]) {
    const state = lines.find((line) => line.fixture === "recovery_state")
    expect(state).toBeDefined()
    return state as unknown as RecoveryState
}

const remoteRequests = (lines: readonly JsonLine[], method: string) =>
    lines.filter((line) => line.fixture === "remote_request" && line.method === method)

test.each([
    ["default", "bot_client_shutdown"],
    ["effect", "bot_client_shutdown"],
    ["effect", "scope_close"],
])("%s webhook live cleanup retains evidence and a deadline when %s fails", (mode, failure) => {
    const root = fixture()
    const lines = run(root, mode, { failures: [failure] })
    expect(lines).toContainEqual({ fixture: "bot_client_shutdown" })
    if (mode === "effect") expect(lines).toContainEqual({ fixture: "scope_close" })
    expect(lines).toContainEqual(
        expect.objectContaining({ check: "local_cleanup", finalizer: failure, passed: false, journalRetained: true }),
    )
    expect(lines).toContainEqual(expect.objectContaining({ passed: false, reason: "deadline", journalRetained: true }))
    // Owned channels were created, but no cleanup request follows an unproven shutdown
    expect(remoteRequests(lines, "GET").filter((line) => line.path === "/v1/guilds/100/webhooks")).toEqual([])
    expect(JSON.parse(readFileSync(journalPath(root), "utf8")).channels).toHaveLength(2)
    expect(lockFiles(root)).toEqual([".env.test.local.lock.webhooks"])
})

test.each(["default", "effect"])(
    "%s webhook live cleanup releases a quiescent lock and recovers a retained journal",
    (mode) => {
        const root = fixture()
        const failed = run(root, mode, { cleanupFailure: true })
        expect(failed).toContainEqual({ fixture: "bot_client_shutdown" })
        expect(failed).toContainEqual(
            expect.objectContaining({ check: "cleanup", passed: false, journalRetained: true }),
        )
        expect(JSON.parse(readFileSync(journalPath(root), "utf8")).channels).toHaveLength(2)
        expect(lockFiles(root)).toEqual([])

        const recovered = run(root, mode)
        expect(recovered).toContainEqual(
            expect.objectContaining({ check: "webhook_and_channels_cleanup_verified", passed: true }),
        )
        expect(existsSync(journalPath(root))).toBe(false)
        expect(lockFiles(root)).toEqual([])
    },
)

const pendingJournal = {
    guildId: "100",
    botId: "200",
    marker,
    webhookPending: true,
    channels: [{ id: "300", name: `${marker}-a` }],
}

test.each(["default", "effect"])("%s webhook live recovery removes only the owned token-edited webhook", (mode) => {
    const root = fixture(pendingJournal)
    const lines = run(root, mode, { recovery: true })
    expect(lines).toContainEqual(
        expect.objectContaining({ check: "webhook_and_channels_cleanup_verified", passed: true }),
    )
    const state = recoveryState(lines)
    // Recovery deleted the owned webhook and channel, and kept the same-marker webhook in an unowned channel
    expect(state.deletions).toEqual(expect.arrayContaining(["400", "300"]))
    expect(state.deletions).not.toContain("401")
    expect(state.hooks).toContainEqual(expect.objectContaining({ id: "401", name: `${marker}-unknown` }))
    expect(existsSync(journalPath(root))).toBe(false)
    expect(lockFiles(root)).toEqual([])
})

test.each(["default", "effect"])(
    "%s webhook live recovery retains the journal and channel for a foreign token-name collision",
    (mode) => {
        const root = fixture(pendingJournal)
        const lines = run(root, mode, { recovery: true, foreignCollision: true })
        const state = recoveryState(lines)
        expect(state.hooks).toContainEqual(expect.objectContaining({ id: "402", name: `${marker}-token` }))
        expect(state.channels).toEqual([expect.objectContaining({ id: "300" })])
        expect(state.deletions).toEqual([])
        expect(remoteRequests(lines, "POST")).toEqual([])
        expect(JSON.parse(readFileSync(journalPath(root), "utf8")).marker).toBe(marker)
        expect(lockFiles(root)).toEqual([])
    },
)
