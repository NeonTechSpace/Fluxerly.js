import assert from "node:assert/strict"
import {
    closeSync,
    existsSync,
    mkdtempSync,
    openSync,
    readFileSync,
    realpathSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, test } from "vitest"

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const temporaryParent = realpathSync(tmpdir())
const temporaryRoots: string[] = []

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(temporaryParent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

function sourceBetween(file: string, start: string, end: string) {
    const source = readFileSync(new URL(`./live/${file}.mjs`, import.meta.url), "utf8").replaceAll("\r\n", "\n")
    expect(source.split(start)).toHaveLength(2)
    const body = source.slice(source.indexOf(start) + start.length)
    expect(body).toContain(end)
    return body.slice(0, body.indexOf(end))
}

test.each(["muted", "deafened"] as const)(
    "voice recovery refuses a concurrent %s change after the participant has already rejoined",
    async (flag) => {
        const result = voiceRecovery({ channelId: "3", muted: flag === "muted", deafened: flag === "deafened" })
        const before = structuredClone(result.journal)
        await expect(result.run()).rejects.toThrow("Concurrent participant voice-flag change after disconnect")
        expect(result.journal).toEqual(before)
        expect(result.events).toEqual([])
    },
)

test("voice recovery accepts an unchanged participant who has already rejoined", async () => {
    const result = voiceRecovery({ channelId: "3", muted: false, deafened: false })
    await result.run()
    expect(result.events).toEqual(["save", "verify", "remove_channel", "remove_journal", "report"])
})

function voiceRecovery(current: { channelId: string; muted: boolean; deafened: boolean }) {
    const journal = {
        kind: "voice-controls",
        guildId: "1",
        botId: "2",
        userId: "4",
        phase: "awaiting_rejoin",
        baseline: { channelId: "3", muted: false, deafened: false },
        current: { channelId: null, muted: false, deafened: false },
    }
    const events: string[] = []
    const unexpected = async () => {
        events.push("unexpected_mutation_or_rejoin")
        throw Error("Unexpected mutation or rejoin")
    }
    const context = {
        assert,
        verified: true,
        journal,
        guildId: "1",
        botId: "2",
        voiceUserId: "4",
        freshCurrentState: async () => current,
        reconcilePending: unexpected,
        requireRejoin: unexpected,
        sameState: unexpected,
        mutate: unexpected,
        save: () => events.push("save"),
        verifyState: async (expected: unknown) => {
            expect(expected).toEqual(journal.baseline)
            events.push("verify")
        },
        removeTestChannel: async () => events.push("remove_channel"),
        unlinkSync: () => events.push("remove_journal"),
        journalPath: "fixture-journal",
        report: () => events.push("report"),
    }
    const body = sourceBetween("voice-controls", "async function restore() {\n", "\n}\n\nconst watchdog")
    const run = new AsyncFunction(...Object.keys(context), body)
    return { journal, events, run: () => run(...Object.values(context)) }
}

test.each([false, true])(
    "supervisor preflight cleanup releases its lock when no owner was acquired (server: %s)",
    async (server) => {
        const result = await supervisorCleanup(undefined, server)
        expect(result.events).toEqual(
            server ? ["server_close", "release_lock", "clear_watchdog"] : ["release_lock", "clear_watchdog"],
        )
        expect(result.process.exitCode).toBe(0)
        expect(result.lockExists).toBe(false)
    },
)

test("supervisor cleanup retains its lock after acquired-owner shutdown fails", async () => {
    const supervisor = {
        shutdown: async () => Promise.reject(Error("fixture shutdown failure")),
        waitForClose: async () => undefined,
    }
    const result = await supervisorCleanup(supervisor, true)
    expect(result.events).toEqual(["server_close", "report_cleanup"])
    expect(result.process.exitCode).toBe(1)
    expect(result.lockExists).toBe(true)
})

async function supervisorCleanup(supervisor: unknown, server: boolean) {
    const events: string[] = []
    const fixtureProcess = { exitCode: 0, pid: process.pid }
    const root = mkdtempSync(join(temporaryParent, "fluxerly-supervisor-safety-"))
    temporaryRoots.push(root)
    const lockPath = join(root, ".env.test.local.lock")
    writeFileSync(lockPath, String(process.pid))
    const descriptor = openSync(lockPath, "r+")
    const shutdown = sourceBetween("supervisor", "async function shutdown(Effect) {\n", "\n}\n\nfunction releaseLock")
    const finalizer = sourceBetween("supervisor", "} finally {\n    let cleanupSucceeded", "\n}\n")
    const release = sourceBetween("supervisor", "function releaseLock() {\n", "\n}\n\nconst watchdog")
    const context = {
        assert,
        supervisor,
        proofServer: server ? { close: async () => events.push("server_close") } : undefined,
        nativeEffect: undefined,
        callSupervisor: async (operation: () => unknown) => operation(),
        events,
        descriptor,
        lockPath,
        readFileSync,
        closeSync,
        unlinkSync,
        existsSync,
        clearTimeout: () => events.push("clear_watchdog"),
        watchdog: {},
        report: () => events.push("report_cleanup"),
        process: fixtureProcess,
    }
    const run = new AsyncFunction(
        ...Object.keys(context),
        `let lock = descriptor, supervisorClosed = false, serverClosed = false; async function shutdown(Effect) {${shutdown}} function releaseLock() { events.push("release_lock"); ${release}} let cleanupSucceeded${finalizer}`,
    )
    try {
        await run(...Object.values(context))
        return { events, process: fixtureProcess, lockExists: existsSync(lockPath) }
    } finally {
        if (existsSync(lockPath)) closeSync(descriptor)
    }
}

const vanityGates = [
    { name: "recovery", start: "    if (existsSync(journalPath)) {\n", end: "        journal = JSON.parse" },
    {
        name: "mutation",
        start: '        stage = "manual_mutation_preflight"\n',
        end: '        assert.ok(guild.features.includes("VANITY_URL")',
    },
]

test.each(vanityGates)("vanity $name rejects stored-only mutation authorization", ({ start, end }) => {
    const gate = sourceBetween("vanity-url", start, end)
    const run = new Function("assert", "mutate", "env", "process", gate)
    expect(() => run(assert, true, { FLUXER_TEST_VANITY_MUTATIONS: "1" }, { env: {} })).toThrow()
})

test.each(vanityGates)("vanity $name accepts current process mutation authorization", ({ start, end }) => {
    const gate = sourceBetween("vanity-url", start, end)
    const run = new Function("assert", "mutate", "env", "process", gate)
    expect(() =>
        run(assert, true, { FLUXER_TEST_VANITY_MUTATIONS: "1" }, { env: { FLUXER_TEST_VANITY_MUTATIONS: "1" } }),
    ).not.toThrow()
})
