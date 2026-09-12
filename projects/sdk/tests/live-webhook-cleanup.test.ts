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
import { afterEach, expect, test } from "vitest"

const temporaryParent = realpathSync(tmpdir())
const temporaryRoots: string[] = []
const fixtureToken = "fixture-token-not-a-credential"
const privateFailure = "fixture-private-finalizer-detail"

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(temporaryParent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

function fixture() {
    const root = mkdtempSync(join(temporaryParent, "fluxerly-webhook-cleanup-"))
    temporaryRoots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    mkdirSync(join(root, "node_modules"))
    symlinkSync(
        fileURLToPath(new URL("../node_modules/effect", import.meta.url)),
        join(root, "node_modules/effect"),
        "junction",
    )
    copyFileSync(new URL("./live/webhooks.mjs", import.meta.url), join(root, "tests/live/webhooks.mjs"))
    writeFileSync(
        join(root, "trap.mjs"),
        `
            const marker = "fluxerly-wh-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            const hooks = [
                {
                    id: "400",
                    name: marker + "-token",
                    user: { id: "200" },
                    guild_id: "100",
                    channel_id: "300",
                },
                {
                    id: "401",
                    name: marker + "-unknown",
                    user: { id: "200" },
                    guild_id: "100",
                    channel_id: "999",
                },
            ]
            if (process.env.FLUXERLY_WEBHOOKS_FOREIGN_COLLISION === "1")
                hooks.unshift({
                    id: "402",
                    name: marker + "-token",
                    user: { id: "201" },
                    guild_id: "100",
                    channel_id: "300",
                })
            const channels = [{ id: "300", name: marker + "-a", guild_id: "100", type: 0 }]
            const deletions = []
            const fixtureFetch = async (url, options = {}) => {
                const path = new URL(url).pathname
                const method = options.method ?? "GET"
                console.log(JSON.stringify({ fixture: "remote_reconciliation", path }))
                if (process.env.FLUXERLY_WEBHOOKS_CLEANUP_FAILURE === "1") throw Error(${JSON.stringify(privateFailure)})
                if (process.env.FLUXERLY_WEBHOOKS_RECOVERY_FIXTURE === "1") {
                    if (path === "/v1/guilds/100/webhooks") return Response.json(hooks)
                    if (method === "DELETE" && path === "/v1/webhooks/400") {
                        hooks.splice(
                            hooks.findIndex((item) => item.id === "400"),
                            1,
                        )
                        deletions.push("400")
                        return Response.json({})
                    }
                    if (method === "GET" && path === "/v1/webhooks/400") return Response.json(null, { status: 404 })
                    if (path === "/v1/guilds/100/channels") return Response.json(channels)
                    if (method === "DELETE" && path === "/v1/channels/300") {
                        channels.splice(
                            channels.findIndex((item) => item.id === "300"),
                            1,
                        )
                        deletions.push("300")
                        return Response.json({})
                    }
                    if (method === "GET" && path === "/v1/channels/300") return Response.json(null, { status: 404 })
                }
                return Response.json([])
            }
            globalThis.fetch = fixtureFetch
            const set = globalThis.setTimeout
            let watchdog
            globalThis.setTimeout = (callback, delay, ...args) => {
                const timer = set(callback, delay === 180_000 ? 500 : delay, ...args)
                if (delay === 180_000) watchdog = timer
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
            process.on("exit", () =>
                console.log(JSON.stringify({ fixture: "recovery_state", hooks, channels, deletions })),
            )
        `,
    )
    const script = readFileSync(join(root, "tests/live/webhooks.mjs"), "utf8")
    const fixtureBranch = `
    if (process.env.FLUXERLY_WEBHOOKS_RECOVERY_FIXTURE === "1") {
        lock = openSync(lockPath, "wx")
        writeSync(lock, String(process.pid))
        token = ${JSON.stringify(fixtureToken)}
        guildId = "100"
        botId = "200"
        verified = true
        journal = {
            guildId,
            botId,
            marker: "fluxerly-wh-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            webhookPending: true,
            channels: [{ id: "300", name: "fluxerly-wh-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-a" }],
        }
        writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })
        await cleanup()
        throw Error("Fixture recovery complete")
    }
    if (process.env.FLUXERLY_WEBHOOKS_FINALIZER_FIXTURE === "1") {
        lock = openSync(lockPath, "wx")
        writeSync(lock, String(process.pid))
        token = ${JSON.stringify(fixtureToken)}
        guildId = "100"
        botId = "200"
        verified = true
        journal = existsSync(journalPath)
            ? JSON.parse(readFileSync(journalPath, "utf8"))
            : {
                  guildId,
                  botId,
                  marker: "fluxerly-wh-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  channels: [],
              }
        if (!existsSync(journalPath)) writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })
        const finalizer = (name) => () => {
            console.log(JSON.stringify({ fixture: name }))
            if (process.env.FLUXERLY_WEBHOOKS_FINALIZER_FAILURES?.split(",").includes(name))
                throw Error(${JSON.stringify(privateFailure)})
        }
        const shutdown = (name) => () => mode === "default"
            ? Promise.resolve().then(finalizer(name))
            : Effect.sync(finalizer(name))
        hook = { shutdown: shutdown("webhook_client_shutdown") }
        bot = { shutdown: shutdown("bot_client_shutdown") }
        scope = Scope.makeUnsafe()
        await Effect.runPromise(
            Effect.addFinalizer(() => Effect.sync(finalizer("scope_close"))).pipe(Effect.provideService(Scope.Scope, scope)),
        )
        if (process.env.FLUXERLY_WEBHOOKS_ACTIVE_WRITER === "1") setInterval(() => {}, 1_000)
        throw Error("Fixture main failure")
    }
`
    const injected = script.replace(
        'try {\n    lock = openSync(lockPath, "wx")',
        `try {${fixtureBranch}    lock = openSync(lockPath, "wx")`,
    )
    expect(injected).not.toBe(script)
    writeFileSync(join(root, "tests/live/webhooks.mjs"), injected)
    return root
}

function run(
    root: string,
    mode: string,
    options: {
        cleanupFailure?: boolean
        failures?: string[]
        activeWriter?: boolean
        recovery?: boolean
        foreignCollision?: boolean
    } = {},
) {
    const child = spawnSync(process.execPath, ["--import", "./trap.mjs", "tests/live/webhooks.mjs", mode], {
        cwd: root,
        env: {
            ...process.env,
            FLUXERLY_WEBHOOKS_FINALIZER_FIXTURE: "1",
            FLUXERLY_WEBHOOKS_CLEANUP_FAILURE: options.cleanupFailure ? "1" : "0",
            FLUXERLY_WEBHOOKS_FINALIZER_FAILURES: options.failures?.join(",") ?? "",
            FLUXERLY_WEBHOOKS_ACTIVE_WRITER: options.activeWriter ? "1" : "0",
            FLUXERLY_WEBHOOKS_RECOVERY_FIXTURE: options.recovery ? "1" : "0",
            FLUXERLY_WEBHOOKS_FOREIGN_COLLISION: options.foreignCollision ? "1" : "0",
        },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status).toBe(1)
    const output = child.stdout + child.stderr
    expect(output).not.toContain(fixtureToken)
    expect(output).not.toContain(privateFailure)
    expect(output).toContain('"fixture":"fetch_restored","restored":true')
    if (options.failures?.length) expect(output).not.toContain('"fixture":"watchdog_cleared"')
    else expect(output).toContain('"fixture":"watchdog_cleared"')
    return output
}

test.each(["default", "effect"])(
    "%s webhook live cleanup retains evidence and a deadline when quiescence fails",
    (mode) => {
        for (const failure of ["webhook_client_shutdown", "bot_client_shutdown", "scope_close"]) {
            const root = fixture()
            const output = run(root, mode, {
                failures: [failure],
                activeWriter: true,
            })

            for (const finalizer of ["webhook_client_shutdown", "bot_client_shutdown", "scope_close"])
                expect(output).toContain(`"fixture":"${finalizer}"`)
            expect(output).toContain(`"finalizer":"${failure}"`)
            expect(output).toContain('"reason":"deadline"')
            expect(output).not.toContain('"fixture":"remote_reconciliation"')
            expect(existsSync(join(root, ".env.test.webhooks.local"))).toBe(true)
            expect(existsSync(join(root, ".env.test.local.lock"))).toBe(true)
        }
    },
)

test.each(["default", "effect"])(
    "%s webhook live cleanup releases a quiescent lock and recovers a retained journal",
    (mode) => {
        const root = fixture()
        const failed = run(root, mode, { cleanupFailure: true })

        expect(failed).toContain('"fixture":"remote_reconciliation"')
        expect(failed).toContain('"check":"cleanup","passed":false,"journalRetained":true')
        expect(existsSync(join(root, ".env.test.webhooks.local"))).toBe(true)
        expect(existsSync(join(root, ".env.test.local.lock"))).toBe(false)

        const recovered = run(root, mode)
        expect(recovered).toContain('"check":"webhook_and_channels_cleanup_verified","passed":true')
        expect(existsSync(join(root, ".env.test.webhooks.local"))).toBe(false)
        expect(existsSync(join(root, ".env.test.local.lock"))).toBe(false)
    },
)

test.each(["default", "effect"])("%s webhook live recovery removes only the owned token-edited webhook", (mode) => {
    const root = fixture()
    const output = run(root, mode, { recovery: true })

    expect(output).toContain('"check":"webhook_and_channels_cleanup_verified","passed":true')
    expect(output).toContain('"deletions":["400","300"]')
    expect(output).toContain('"id":"401","name":"fluxerly-wh-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-unknown"')
    expect(existsSync(join(root, ".env.test.webhooks.local"))).toBe(false)
    expect(existsSync(join(root, ".env.test.local.lock"))).toBe(false)
})

test.each(["default", "effect"])(
    "%s webhook live recovery retains the journal and channel for a foreign token-name collision",
    (mode) => {
        const root = fixture()
        const output = run(root, mode, { recovery: true, foreignCollision: true })

        expect(output).toContain('"id":"402","name":"fluxerly-wh-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-token"')
        expect(output).toContain('"channels":[{"id":"300"')
        expect(output).toContain('"deletions":[]')
        expect(existsSync(join(root, ".env.test.webhooks.local"))).toBe(true)
        expect(existsSync(join(root, ".env.test.local.lock"))).toBe(false)
    },
)
