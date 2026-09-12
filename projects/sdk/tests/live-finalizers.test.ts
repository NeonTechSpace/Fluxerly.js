import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import {
    closeSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, test } from "vitest"

const temporaryParent = realpathSync(tmpdir())
const temporaryRoots: string[] = []
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
    const root = mkdtempSync(join(temporaryParent, "fluxerly-live-finalizers-"))
    temporaryRoots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    mkdirSync(join(root, "node_modules"))
    symlinkSync(
        fileURLToPath(new URL("../node_modules/effect", import.meta.url)),
        join(root, "node_modules/effect"),
        "junction",
    )
    copyFileSync(new URL("./live/expressions.mjs", import.meta.url), join(root, "tests/live/expressions.mjs"))
    writeFileSync(
        join(root, "trap.mjs"),
        `
            const originalSetTimeout = globalThis.setTimeout
            let watchdog
            globalThis.setTimeout = (callback, delay, ...args) => {
                const timer = originalSetTimeout(callback, delay, ...args)
                if (delay === 240_000) watchdog = timer
                return timer
            }
            const originalClearTimeout = globalThis.clearTimeout
            globalThis.clearTimeout = (timer) => {
                if (timer === watchdog) console.log(JSON.stringify({ fixture: "watchdog_cleared" }))
                return originalClearTimeout(timer)
            }
        `,
    )
    const scriptPath = join(root, "tests/live/expressions.mjs")
    const script = readFileSync(scriptPath, "utf8")
    const injected = script.replace(
        'try {\n    lock = openSync(lockPath, "wx")',
        `try {
    if (process.env.FLUXERLY_LIVE_FINALIZER_FIXTURE === "1") {
        lock = openSync(lockPath, "wx")
        writeSync(lock, String(process.pid))
        journal = { owned: true }
        verified = true
        const ownedClient = (name) => {
            const owned = {
                state: "Connected",
                async shutdown() {
                    console.log(JSON.stringify({ fixture: name }))
                    if (process.env.FLUXERLY_LIVE_FINALIZER_FAILURES?.split(",").includes(name)) {
                        owned.state = "Unknown"
                        console.log(JSON.stringify({ fixture: name, state: owned.state }))
                        throw Error(${JSON.stringify(privateFailure)})
                    }
                    owned.state = "Closed"
                    console.log(JSON.stringify({ fixture: name, state: owned.state }))
                },
            }
            return owned
        }
        webhookClient = ownedClient("webhook_client_shutdown")
        client = ownedClient("client_shutdown")
        scope = Scope.makeUnsafe()
        await Effect.runPromise(
            Effect.addFinalizer(() => Effect.sync(() => {
                console.log(JSON.stringify({ fixture: "scope_close" }))
                if (process.env.FLUXERLY_LIVE_FINALIZER_FAILURES?.split(",").includes("scope_close"))
                    throw Error(${JSON.stringify(privateFailure)})
            })).pipe(Effect.provideService(Scope.Scope, scope)),
        )
        cleanup = async () => console.log(JSON.stringify({ fixture: "remote_cleanup" }))
        throw Error("fixture main failure")
    }
    lock = openSync(lockPath, "wx")`,
    )
    expect(injected).not.toBe(script)
    writeFileSync(scriptPath, injected)
    return root
}

function run(root: string, mode: string, failures: string[] = []) {
    const child = spawnSync(process.execPath, ["--import", "./trap.mjs", "tests/live/expressions.mjs", mode], {
        cwd: root,
        env: {
            ...process.env,
            FLUXERLY_LIVE_FINALIZER_FIXTURE: "1",
            FLUXERLY_LIVE_FINALIZER_FAILURES: failures.join(","),
        },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status).toBe(1)
    const output = child.stdout + child.stderr
    expect(output).not.toContain(privateFailure)
    return output
}

function installDependency(root: string, name: string) {
    symlinkSync(
        fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)),
        join(root, "node_modules", name),
        "junction",
    )
}

function usersFixture() {
    const root = mkdtempSync(join(temporaryParent, "fluxerly-users-finalizers-"))
    temporaryRoots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    mkdirSync(join(root, "node_modules"))
    installDependency(root, "effect")
    installDependency(root, "ws")
    writeFileSync(join(root, ".env.test.local"), "FLUXER_TEST_BOT_TOKEN=x\nFLUXER_TEST_GUILD_ID=1\n")
    copyFileSync(new URL("./live/users.mjs", import.meta.url), join(root, "tests/live/users.mjs"))
    writeFileSync(
        join(root, "trap.mjs"),
        `
            const original = globalThis.setTimeout
            let watchdog
            globalThis.setTimeout = (callback, delay, ...args) => {
                const timer = original(callback, delay, ...args)
                if (delay === 180_000) watchdog = timer
                return timer
            }
            const clear = globalThis.clearTimeout
            globalThis.clearTimeout = (timer) => {
                if (timer === watchdog) console.log(JSON.stringify({ fixture: "watchdog_cleared" }))
                return clear(timer)
            }
        `,
    )
    const scriptPath = join(root, "tests/live/users.mjs")
    const script = readFileSync(scriptPath, "utf8")
    const injected = script.replace(
        'try {\n    lock = openSync(lockPath, "wx")',
        `try {
    if (process.env.FLUXERLY_USERS_FINALIZER_FIXTURE === "1") {
        lock = openSync(lockPath, "wx")
        writeSync(lock, String(process.pid))
        verified = true
        journal = { owned: true }
        bot = {
            state: "Connected",
            presence: { set: () => ({ _unsafeUnwrap: () => Promise.reject(Error(${JSON.stringify(privateFailure)})) }) },
            async shutdown() { this.state = "Closed"; console.log(JSON.stringify({ fixture: "bot_shutdown", state: this.state })) },
        }
        scope = Scope.makeUnsafe()
        await Effect.runPromise(Effect.addFinalizer(() => Effect.sync(() => console.log(JSON.stringify({ fixture: "scope_close" })))).pipe(Effect.provideService(Scope.Scope, scope)))
        cleanup = async () => console.log(JSON.stringify({ fixture: "remote_cleanup" }))
        throw Error("fixture main failure")
    }
    lock = openSync(lockPath, "wx")`,
    )
    expect(injected).not.toBe(script)
    writeFileSync(scriptPath, injected)
    return root
}

function voiceFixture() {
    const root = mkdtempSync(join(temporaryParent, "fluxerly-voice-finalizers-"))
    temporaryRoots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    mkdirSync(join(root, "node_modules"))
    installDependency(root, "effect")
    copyFileSync(new URL("./live/voice-controls.mjs", import.meta.url), join(root, "tests/live/voice-controls.mjs"))
    writeFileSync(
        join(root, "trap.mjs"),
        `
            const original = globalThis.setTimeout
            let watchdog
            globalThis.setTimeout = (callback, delay, ...args) => {
                const timer = original(callback, delay, ...args)
                if (delay === 330_000) watchdog = timer
                return timer
            }
            const clear = globalThis.clearTimeout
            globalThis.clearTimeout = (timer) => {
                if (timer === watchdog) console.log(JSON.stringify({ fixture: "watchdog_cleared" }))
                return clear(timer)
            }
        `,
    )
    const scriptPath = join(root, "tests/live/voice-controls.mjs")
    const script = readFileSync(scriptPath, "utf8")
    const injected = script.replace(
        "try {\n    await run()",
        `try {
    if (process.env.FLUXERLY_VOICE_FINALIZER_FIXTURE === "1") {
        lock = openSync(lockPath, "wx")
        writeSync(lock, String(process.pid))
        verified = true
        journal = { owned: true }
        stops = [
            async () => console.log(JSON.stringify({ fixture: "subscription_stop_two" })),
            async () => {
                console.log(JSON.stringify({ fixture: "subscription_stop_one" }))
                if (process.env.FLUXERLY_VOICE_STOP_FAILURE === "1") throw Error(${JSON.stringify(privateFailure)})
            },
        ]
        client = { async shutdown() { console.log(JSON.stringify({ fixture: "client_shutdown" })) } }
        scope = Scope.makeUnsafe()
        await Effect.runPromise(Effect.addFinalizer(() => Effect.sync(() => console.log(JSON.stringify({ fixture: "scope_close" })))).pipe(Effect.provideService(Scope.Scope, scope)))
        restore = async () => console.log(JSON.stringify({ fixture: "remote_cleanup" }))
        throw Error("fixture main failure")
    }
    await run()`,
    )
    expect(injected).not.toBe(script)
    writeFileSync(scriptPath, injected)
    return root
}

function supervisorFixture() {
    const root = mkdtempSync(join(temporaryParent, "fluxerly-supervisor-finalizers-"))
    temporaryRoots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    copyFileSync(new URL("./live/supervisor.mjs", import.meta.url), join(root, "tests/live/supervisor.mjs"))
    writeFileSync(
        join(root, "trap.mjs"),
        `
            const original = globalThis.clearTimeout
            globalThis.clearTimeout = (timer) => {
                console.log(JSON.stringify({ fixture: "watchdog_cleared" }))
                return original(timer)
            }
        `,
    )
    const scriptPath = join(root, "tests/live/supervisor.mjs")
    const script = readFileSync(scriptPath, "utf8")
    const injected = script.replace(
        'try {\n    assert.ok(mode === "default" || mode === "effect")',
        `try {
    if (process.env.FLUXERLY_SUPERVISOR_FINALIZER_FIXTURE === "1") {
        lock = openSync(lockPath, "wx")
        writeSync(lock, String(process.pid))
        proofServer = {
            close: async () => console.log(JSON.stringify({ fixture: "proof_server_closed" })),
            proofs: () => [],
        }
        supervisor = {
            waitForClose: async () => ({ isOk: () => true, value: undefined }),
            shutdown: async () => {
                console.log(JSON.stringify({ fixture: "supervisor_shutdown" }))
                if (process.env.FLUXERLY_SUPERVISOR_SHUTDOWN_FAILURE === "1") throw Error(${JSON.stringify(privateFailure)})
                return { isOk: () => true, value: undefined }
            },
            status: () => ({ children: [] }),
        }
        throw Error("fixture main failure")
    }
    assert.ok(mode === "default" || mode === "effect")`,
    )
    expect(injected).not.toBe(script)
    writeFileSync(scriptPath, injected)
    return root
}

function finalizerBody(file: string) {
    const source = readFileSync(new URL(`./live/${file}.mjs`, import.meta.url), "utf8")
    const marker = source.lastIndexOf("} finally {")
    expect(marker).toBeGreaterThanOrEqual(0)
    const start = marker + "} finally ".length
    let depth = 0
    let quote = ""
    for (let index = start; index < source.length; index++) {
        const character = source.charAt(index)
        if (quote) {
            if (character === "\\") index++
            else if (character === quote) quote = ""
            continue
        }
        if (["'", '"', "`"].includes(character)) {
            quote = character
            continue
        }
        if (character === "{") depth++
        else if (character === "}" && --depth === 0) return source.slice(start + 1, index)
    }
    throw Error(`Could not extract ${file} finalizer`)
}

function finalizerBodyAfter(source: string, marker: string) {
    const index = source.indexOf(marker)
    expect(index).toBeGreaterThanOrEqual(0)
    const start = index + "} finally ".length
    let depth = 0
    let quote = ""
    for (let cursor = start; cursor < source.length; cursor++) {
        const character = source.charAt(cursor)
        if (quote) {
            if (character === "\\") cursor++
            else if (character === quote) quote = ""
            continue
        }
        if (["'", '"', "`"].includes(character)) {
            quote = character
            continue
        }
        if (character === "{") depth++
        else if (character === "}" && --depth === 0) return source.slice(start + 1, cursor)
    }
    throw Error("Could not extract finalizer")
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const extractedOwners = [
    { file: "consumer-operations", remote: true, watchdog: true },
    { file: "consumer-features", remote: true, watchdog: false },
    { file: "administration", remote: true, watchdog: true },
    { file: "invites", remote: true, watchdog: true },
    { file: "guild-feature-toggles", remote: true, watchdog: true },
    { file: "discovery", remote: true, watchdog: true },
    { file: "vanity-url", remote: true, watchdog: true },
    { file: "members", remote: true, watchdog: true },
    { file: "member-chunks", remote: false, watchdog: true },
    { file: "member-search", remote: false, watchdog: true },
    { file: "guild-lifecycle", remote: false, watchdog: true },
    { file: "own-history", remote: true, watchdog: true },
    { file: "command-conveniences", remote: true, watchdog: true },
    { file: "role-display-reset", remote: true, watchdog: true },
]

async function runExtractedFinalizer(
    owner: (typeof extractedOwners)[number],
    failShutdown: boolean,
    failScope = false,
) {
    const root = mkdtempSync(join(temporaryParent, `fluxerly-${owner.file}-finalizer-`))
    temporaryRoots.push(root)
    const lockPath = join(root, ".env.test.local.lock")
    writeFileSync(lockPath, String(process.pid))
    const lock = openSync(lockPath, "r+")
    const events: string[] = []
    const scope = Scope.makeUnsafe()
    await Effect.runPromise(
        Effect.addFinalizer(() =>
            Effect.sync(() => {
                events.push("scope_close")
                if (failScope) throw Error(privateFailure)
            }),
        ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const client = {
        state: "Connected",
        async shutdown() {
            events.push("client_shutdown")
            if (failShutdown) {
                this.state = "Unknown"
                throw Error(privateFailure)
            }
            this.state = "Closed"
        },
    }
    const watchdog = {}
    const originalClearTimeout = globalThis.clearTimeout
    const originalFetch = globalThis.fetch
    globalThis.clearTimeout = (timer) => {
        if (timer === watchdog) events.push("watchdog_cleared")
        return originalClearTimeout(timer)
    }
    const context = {
        Effect,
        Exit,
        Scope,
        WebSocket: { prototype: { send: () => undefined } },
        assert,
        cleanup: async () => events.push("remote_cleanup"),
        client,
        clientFetch: originalFetch,
        closeSync,
        console: { error: () => undefined },
        deadlineTimer: {},
        feature: "fixture",
        gateway: { restore: () => events.push("gateway_restore") },
        journal: { owned: true },
        lock,
        lockPath,
        mode: "fixture",
        process: { exitCode: 0, pid: process.pid },
        rawFetch: originalFetch,
        rawSend: () => undefined,
        readFileSync,
        releaseLock: () => {
            events.push("release_lock")
            closeSync(lock)
            unlinkSync(lockPath)
        },
        report: (name: string, passed?: boolean) => events.push(`report:${name}:${passed}`),
        reportsScope: "fixture",
        scope,
        unlinkSync,
        value: async (operation: unknown) =>
            Effect.isEffect(operation)
                ? Effect.runPromise(operation as Effect.Effect<unknown, unknown, never>)
                : await operation,
        verified: true,
        watch: { restore: () => events.push("watch_restore"), verifyClosed: () => events.push("watch_closed") },
        watchdog,
    }
    try {
        const run = new AsyncFunction(...Object.keys(context), finalizerBody(owner.file))
        await run(...Object.values(context))
    } finally {
        globalThis.clearTimeout = originalClearTimeout
        globalThis.fetch = originalFetch
        if (existsSync(lockPath)) closeSync(lock)
    }
    return { client, events, lockExists: existsSync(lockPath) }
}

test.each(["default", "effect"])(
    "%s expression finalizers retain evidence when a writer cannot be proven quiescent",
    (mode) => {
        const root = fixture()
        const output = run(root, mode, ["webhook_client_shutdown"])
        expect(output).toContain('"fixture":"webhook_client_shutdown"')
        expect(output).toContain('"fixture":"webhook_client_shutdown","state":"Unknown"')
        expect(output).toContain('"fixture":"client_shutdown"')
        expect(output).toContain('"fixture":"client_shutdown","state":"Closed"')
        expect(output).toContain('"fixture":"scope_close"')
        expect(output).not.toContain('"fixture":"remote_cleanup"')
        expect(output).not.toContain('"fixture":"watchdog_cleared"')
        expect(existsSync(join(root, ".env.test.local.lock"))).toBe(true)
        const lock = openSync(join(root, ".env.test.local.lock"), "r+")
        closeSync(lock)
        unlinkSync(join(root, ".env.test.local.lock"))
    },
)

test.each(["default", "effect"])(
    "%s expression finalizers release a quiescent harness after all owned writers close",
    (mode) => {
        const root = fixture()
        const output = run(root, mode)
        expect(output).toContain('"fixture":"webhook_client_shutdown","state":"Closed"')
        expect(output).toContain('"fixture":"client_shutdown","state":"Closed"')
        expect(output).toContain('"fixture":"scope_close"')
        expect(output).toContain('"fixture":"remote_cleanup"')
        expect(output).toContain('"fixture":"watchdog_cleared"')
        expect(existsSync(join(root, ".env.test.local.lock"))).toBe(false)
    },
)

test.each(["default", "effect"])(
    "%s expression closes independent owned writers after a scope finalizer failure",
    (mode) => {
        const root = fixture()
        const output = run(root, mode, ["scope_close"])
        expect(output).toContain('"fixture":"webhook_client_shutdown","state":"Closed"')
        expect(output).toContain('"fixture":"client_shutdown","state":"Closed"')
        expect(output).toContain('"fixture":"scope_close"')
        expect(output).not.toContain('"fixture":"remote_cleanup"')
        expect(output).not.toContain('"fixture":"watchdog_cleared"')
        expect(existsSync(join(root, ".env.test.local.lock"))).toBe(true)
        closeSync(openSync(join(root, ".env.test.local.lock"), "r+"))
        unlinkSync(join(root, ".env.test.local.lock"))
    },
)

test("users finalizes its bot and scope after a presence-reset defect, then recovers only owned resources", () => {
    const root = usersFixture()
    const child = spawnSync(process.execPath, ["--import", "./trap.mjs", "tests/live/users.mjs", "default"], {
        cwd: root,
        env: { ...process.env, FLUXER_TEST_DM_USER_ID: "1", FLUXERLY_USERS_FINALIZER_FIXTURE: "1" },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status).toBe(1)
    const output = child.stdout + child.stderr
    expect(output).not.toContain(privateFailure)
    expect(output).toContain('"check":"presence_reset","passed":false')
    expect(output).toContain('"fixture":"bot_shutdown","state":"Closed"')
    expect(output).toContain('"fixture":"scope_close"')
    expect(output).toContain('"fixture":"remote_cleanup"')
    expect(output).toContain('"fixture":"watchdog_cleared"')
    expect(existsSync(join(root, ".env.test.local.lock"))).toBe(false)
})

test("voice subscription-stop uncertainty still finalizes its client and scope while retaining recovery evidence", () => {
    const root = voiceFixture()
    const child = spawnSync(process.execPath, ["--import", "./trap.mjs", "tests/live/voice-controls.mjs", "default"], {
        cwd: root,
        env: {
            ...process.env,
            FLUXER_TEST_VOICE_USER_ID: "1",
            FLUXERLY_VOICE_FINALIZER_FIXTURE: "1",
            FLUXERLY_VOICE_STOP_FAILURE: "1",
        },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status).toBe(1)
    const output = child.stdout + child.stderr
    expect(output).not.toContain(privateFailure)
    expect(output).toContain('"fixture":"subscription_stop_one"')
    expect(output).toContain('"fixture":"subscription_stop_two"')
    expect(output).toContain('"fixture":"client_shutdown"')
    expect(output).toContain('"fixture":"scope_close"')
    expect(output).not.toContain('"fixture":"remote_cleanup"')
    expect(output).not.toContain('"fixture":"watchdog_cleared"')
    expect(existsSync(join(root, ".env.test.local.lock"))).toBe(true)
    closeSync(openSync(join(root, ".env.test.local.lock"), "r+"))
    unlinkSync(join(root, ".env.test.local.lock"))
})

test("voice recovery runs only after its original client is quiescent", () => {
    const root = voiceFixture()
    const child = spawnSync(process.execPath, ["--import", "./trap.mjs", "tests/live/voice-controls.mjs", "default"], {
        cwd: root,
        env: { ...process.env, FLUXER_TEST_VOICE_USER_ID: "1", FLUXERLY_VOICE_FINALIZER_FIXTURE: "1" },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status).toBe(1)
    const output = child.stdout + child.stderr
    expect(output).toContain('"fixture":"subscription_stop_one"')
    expect(output).toContain('"fixture":"subscription_stop_two"')
    expect(output).toContain('"fixture":"client_shutdown"')
    expect(output).toContain('"fixture":"scope_close"')
    expect(output).toContain('"fixture":"remote_cleanup"')
    expect(output).toContain('"fixture":"watchdog_cleared"')
    expect(existsSync(join(root, ".env.test.local.lock"))).toBe(false)
})

test("supervisor retains its lock and watchdog when child shutdown is uncertain", () => {
    const root = supervisorFixture()
    const child = spawnSync(process.execPath, ["--import", "./trap.mjs", "tests/live/supervisor.mjs", "default"], {
        cwd: root,
        env: {
            ...process.env,
            FLUXERLY_SUPERVISOR_FINALIZER_FIXTURE: "1",
            FLUXERLY_SUPERVISOR_SHUTDOWN_FAILURE: "1",
        },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    const output = child.stdout + child.stderr
    expect(output).not.toContain(privateFailure)
    expect(output).toContain('"fixture":"supervisor_shutdown"')
    expect(output).toContain('"fixture":"proof_server_closed"')
    expect(output).not.toContain('"fixture":"watchdog_cleared"')
    expect(existsSync(join(root, ".env.test.local.lock"))).toBe(true)
    closeSync(openSync(join(root, ".env.test.local.lock"), "r+"))
    unlinkSync(join(root, ".env.test.local.lock"))
})

test("supervisor releases its lock only after child shutdown and proof-server closure", () => {
    const root = supervisorFixture()
    const child = spawnSync(process.execPath, ["--import", "./trap.mjs", "tests/live/supervisor.mjs", "default"], {
        cwd: root,
        env: { ...process.env, FLUXERLY_SUPERVISOR_FINALIZER_FIXTURE: "1" },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    const output = child.stdout + child.stderr
    expect(output).not.toContain(privateFailure)
    expect(output).toContain('"fixture":"supervisor_shutdown"')
    expect(output).toContain('"fixture":"proof_server_closed"')
    expect(output).toContain('"fixture":"watchdog_cleared"')
    expect(existsSync(join(root, ".env.test.local.lock"))).toBe(false)
})

test("messages default shutdown rejection retains the recovery lock", async () => {
    const source = readFileSync(new URL("./live/messages.mjs", import.meta.url), "utf8")
    const shutdownBody = finalizerBodyAfter(source, "} finally {\n            clearTimeout(timer)")
    const runShutdown = new AsyncFunction(
        "client",
        "quiescent",
        "timer",
        "stopState",
        "assert",
        `try {${shutdownBody}} catch {} return quiescent`,
    )
    let stopped = false
    const quiescent = await runShutdown(
        { shutdown: async () => Promise.reject(Error(privateFailure)) },
        true,
        {},
        () => {
            stopped = true
        },
        assert,
    )
    expect(quiescent).toBe(false)
    expect(stopped).toBe(true)

    const root = mkdtempSync(join(temporaryParent, "fluxerly-messages-finalizer-"))
    temporaryRoots.push(root)
    const lockPath = join(root, ".env.test.local.lock")
    writeFileSync(lockPath, String(process.pid))
    const lock = openSync(lockPath, "r+")
    let cleaned = false
    const cleanup = async () => {
        cleaned = true
    }
    const runCleanup = new AsyncFunction(
        "gatewayProbe",
        "rawFetch",
        "quiescent",
        "verified",
        "journal",
        "cleanup",
        "report",
        "lock",
        "lockPath",
        "closeSync",
        "unlinkSync",
        finalizerBody("messages"),
    )
    try {
        await runCleanup(
            undefined,
            globalThis.fetch,
            quiescent,
            true,
            {},
            cleanup,
            () => undefined,
            lock,
            lockPath,
            closeSync,
            unlinkSync,
        )
        expect(cleaned).toBe(false)
        expect(existsSync(lockPath)).toBe(true)
    } finally {
        closeSync(lock)
        unlinkSync(lockPath)
    }
})

test("messages native scope-close failure is reported and folded into the scenario exit", async () => {
    const source = readFileSync(new URL("./live/messages.mjs", import.meta.url), "utf8")
    const scopeBody = finalizerBodyAfter(source, "} finally {\n            const scenarioExit")
    const runScope = new AsyncFunction(
        "effectScope",
        "exit",
        "Effect",
        "Scope",
        "Exit",
        "Cause",
        "quiescent",
        "process",
        "report",
        `${scopeBody}; return { exit, quiescent }`,
    )
    const scenarioExit = Exit.void
    const scopeFailure = Exit.failCause(Cause.die("fixture scope defect"))
    const calls: unknown[] = []
    const reports: unknown[] = []
    const process = { exitCode: 0 }
    const result = await runScope(
        {},
        scenarioExit,
        { runPromiseExit: async () => scopeFailure },
        { close: (_scope: unknown, exit: unknown) => (calls.push(exit), undefined) },
        Exit,
        Cause,
        true,
        process,
        (...args: unknown[]) => reports.push(args),
    )
    expect(calls).toEqual([scenarioExit])
    expect(Exit.isFailure(result.exit)).toBe(true)
    expect(result.quiescent).toBe(false)
    expect(process.exitCode).toBe(1)
    expect(reports).toEqual([["scope_cleanup", false]])
})

test("messages native scenario failure releases recovery protection after successful scope close", async () => {
    const source = readFileSync(new URL("./live/messages.mjs", import.meta.url), "utf8")
    const scopeBody = finalizerBodyAfter(source, "} finally {\n            const scenarioExit")
    const runScope = new AsyncFunction(
        "effectScope",
        "exit",
        "Effect",
        "Scope",
        "Exit",
        "Cause",
        "quiescent",
        "process",
        "report",
        `${scopeBody}; return { exit, quiescent }`,
    )
    const scenarioExit = Exit.fail("fixture scenario failure")
    const calls: unknown[] = []
    const reports: unknown[] = []
    const process = { exitCode: 0 }
    const result = await runScope(
        {},
        scenarioExit,
        { runPromiseExit: async () => Exit.void },
        { close: (_scope: unknown, exit: unknown) => (calls.push(exit), undefined) },
        Exit,
        Cause,
        true,
        process,
        (...args: unknown[]) => reports.push(args),
    )
    expect(calls).toEqual([scenarioExit])
    expect(result.exit).toBe(scenarioExit)
    expect(result.quiescent).toBe(true)
    expect(process.exitCode).toBe(0)
    expect(reports).toEqual([])
})

test("messages native scope-close failure preserves the scenario failure", async () => {
    const source = readFileSync(new URL("./live/messages.mjs", import.meta.url), "utf8")
    const scopeBody = finalizerBodyAfter(source, "} finally {\n            const scenarioExit")
    const runScope = new AsyncFunction(
        "effectScope",
        "exit",
        "Effect",
        "Scope",
        "Exit",
        "Cause",
        "quiescent",
        "process",
        "report",
        `${scopeBody}; return { exit, quiescent }`,
    )
    const scopeFailure = Exit.failCause(Cause.die("fixture scope defect"))
    const result = await runScope(
        {},
        Exit.fail("fixture scenario failure"),
        { runPromiseExit: async () => scopeFailure },
        { close: () => undefined },
        Exit,
        Cause,
        true,
        { exitCode: 0 },
        () => undefined,
    )
    expect(Exit.isFailure(result.exit)).toBe(true)
    if (Exit.isFailure(result.exit)) {
        expect(Cause.hasFails(result.exit.cause)).toBe(true)
        expect(Cause.hasDies(result.exit.cause)).toBe(true)
    }
    expect(result.quiescent).toBe(false)
})

test.each(extractedOwners)("$file finalizer closes its scope before successful owned cleanup", async (owner) => {
    const result = await runExtractedFinalizer(owner, false)
    expect(result.client.state).toBe("Closed")
    expect(result.events).toContain("client_shutdown")
    expect(result.events).toContain("scope_close")
    if (owner.remote) expect(result.events).toContain("remote_cleanup")
    if (owner.file === "member-chunks") expect(result.events).toContain("watch_closed")
    if (owner.file === "member-search") expect(result.events).toContain("release_lock")
    if (owner.watchdog) expect(result.events).toContain("watchdog_cleared")
    expect(result.lockExists).toBe(false)
})

test.each(extractedOwners)(
    "$file retains protection when its client shutdown cannot prove writer quiescence",
    async (owner) => {
        const result = await runExtractedFinalizer(owner, true)
        expect(result.client.state).toBe("Unknown")
        expect(result.events).toContain("client_shutdown")
        expect(result.events).toContain("scope_close")
        expect(result.events).not.toContain("remote_cleanup")
        expect(result.events).not.toContain("watchdog_cleared")
        expect(result.lockExists).toBe(true)
    },
)

test.each(
    extractedOwners.filter((owner) =>
        ["own-history", "command-conveniences", "role-display-reset"].includes(owner.file),
    ),
)("$file retains protection when scope close cannot prove writer quiescence", async (owner) => {
    const result = await runExtractedFinalizer(owner, false, true)
    expect(result.client.state).toBe("Closed")
    expect(result.events).toContain("client_shutdown")
    expect(result.events).toContain("scope_close")
    expect(result.events).not.toContain("remote_cleanup")
    expect(result.events).not.toContain("watchdog_cleared")
    expect(result.lockExists).toBe(true)
})
