import { typedResult } from "../../support/settle.js"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { Effect } from "effect"
import { expect, test, vi } from "vitest"

const fork = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>()
    return { ...actual, fork }
})

import { ConfigurationError, supervisor } from "../../../src/index.js"
import { supervisor as nativeSupervisor } from "../../../src/effect.js"
import type { SupervisorOptions } from "../../../src/supervisor.js"

test.each([
    ["relative entry", { entry: "worker.mjs" }],
    [
        "overlapping assignments",
        {
            assignments: [
                { id: "first", shardIds: [0] },
                { id: "second", shardIds: [0] },
            ],
        },
    ],
    ["out-of-range shard", { assignments: [{ id: "first", shardIds: [2] }] }],
    ["unsafe Identify pacing", { identify: { minimumSpacingMs: 999 } }],
    ["negative restart budget", { restart: { maxAttempts: -1 } }],
    ["zero healthy reset period", { restart: { healthyResetMs: 0 } }],
] as const)("both public facades reject %s without spawning", async (_name, invalid) => {
    const options = {
        entry: process.execPath,
        totalShards: 2,
        assignments: [{ id: "first", shardIds: [0] }],
        ...invalid,
    } satisfies SupervisorOptions
    expect(() => supervisor.create(options)).toThrow(ConfigurationError)
    const native = await Effect.runPromiseExit(nativeSupervisor.create(options))
    expect(native._tag).toBe("Failure")
    if (native._tag === "Failure") {
        expect(native.cause.reasons).toHaveLength(1)
        const reason = native.cause.reasons[0]
        expect(reason?._tag === "Die" && reason.defect).toBeInstanceOf(ConfigurationError)
    }
    expect(fork).not.toHaveBeenCalled()
})

test("both public facades name a misspelled supervisor option and suggest the closest one", async () => {
    const options = {
        entry: process.execPath,
        totalShards: 2,
        assignments: [{ id: "first", shardIds: [0] }],
        restrat: {},
    }
    let thrown: unknown
    try {
        supervisor.create(options as never)
    } catch (error) {
        thrown = error
    }
    const native = await Effect.runPromiseExit(nativeSupervisor.create(options as never))
    const reason = native._tag === "Failure" ? native.cause.reasons[0] : undefined
    for (const error of [thrown, reason?._tag === "Die" ? reason.defect : undefined]) {
        expect(error).toBeInstanceOf(ConfigurationError)
        expect(error).toMatchObject({ field: "supervisor", hint: expect.stringContaining('"restart"') })
    }
    expect(fork).not.toHaveBeenCalled()
})

function childWithoutPid(): ChildProcess {
    let child: {
        readonly pid: undefined
        readonly connected: false
        on: (event: string, listener: (...arguments_: unknown[]) => void) => unknown
        once: (event: string, listener: (...arguments_: unknown[]) => void) => unknown
    }
    child = {
        pid: undefined,
        connected: false,
        on: () => child,
        once: (event, listener) => {
            if (event === "error") queueMicrotask(() => listener(new Error("private process failure")))
            return child
        },
    }
    return child as ChildProcess
}

function acknowledgedChild(): ChildProcess {
    const child = Object.assign(new EventEmitter(), {
        pid: 101,
        connected: true,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        send(message: unknown) {
            if (typeof message === "object" && message !== null && "type" in message && message.type === "assignment")
                queueMicrotask(() => child.emit("message", { type: "ready", generation: 1 }))
            if (typeof message === "object" && message !== null && "type" in message && message.type === "shutdown") {
                child.connected = false
                child.exitCode = 0
                queueMicrotask(() => {
                    child.emit("disconnect")
                    child.emit("exit", 0, null)
                })
            }
            return true
        },
        kill() {
            child.connected = false
            child.exitCode = 0
            queueMicrotask(() => {
                child.emit("disconnect")
                child.emit("exit", 0, null)
            })
            return true
        },
    })
    queueMicrotask(() => child.emit("message", { type: "hello" }))
    return child as ChildProcess
}

test("the owned child removes every spelling of the development source condition", async () => {
    const child = acknowledgedChild()
    fork.mockReturnValueOnce(child)
    const created = supervisor.create({
        entry: process.execPath,
        totalShards: 1,
        assignments: [{ id: "condition-filter", shardIds: [0] }],
        execArgv: [
            "--conditions",
            "fluxerly-source",
            "-C",
            "fluxerly-source",
            "--conditions=fluxerly-source",
            "--no-warnings",
            "-C",
            "unrelated-condition",
            "--conditions",
            "another-condition",
        ],
    })
    await created.start()
    expect(fork).toHaveBeenCalledWith(
        process.execPath,
        [],
        expect.objectContaining({
            execArgv: ["--no-warnings", "-C", "unrelated-condition", "--conditions", "another-condition"],
        }),
    )
    await created.shutdown()
    await created.waitForClose()
    fork.mockReset()
})

test("an unspawned child releases its startup and shutdown timers before terminal failure", async () => {
    vi.useFakeTimers()
    try {
        fork.mockReturnValueOnce(childWithoutPid())
        const managed = supervisor.create({
            entry: process.execPath,
            totalShards: 1,
            assignments: [{ id: "unspawned", shardIds: [0] }],
            shutdownTimeoutMs: 60_000,
        })
        const terminal = managed.waitForClose()
        const started = managed.start()

        await vi.runAllTicks()
        const startResult = await started
        const terminalResult = await terminal

        expect(fork).toHaveBeenCalledTimes(1)
        expect(startResult.isErr() && startResult.error).toMatchObject({
            _tag: "SupervisorError",
            childId: "unspawned",
            reason: "spawn",
        })
        expect(terminalResult.isErr() && terminalResult.error).toMatchObject({
            _tag: "SupervisorError",
            childId: "unspawned",
            reason: "spawn",
        })
        if (startResult.isErr()) expect(startResult.error.message).not.toContain("private process failure")
        if (terminalResult.isErr()) expect(terminalResult.error.message).not.toContain("private process failure")
        expect(managed.status().children[0]).toMatchObject({ pid: null })
        expect(vi.getTimerCount()).toBe(0)
    } finally {
        vi.useRealTimers()
        fork.mockReset()
    }
})

/** A child that finishes configuration for each generation it is assigned and exits with a chosen code on request */
function crashingChild() {
    const child = Object.assign(new EventEmitter(), {
        pid: 102,
        connected: true,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        send(message: unknown) {
            const received = message as { readonly type?: unknown; readonly generation?: unknown }
            if (received.type === "assignment")
                queueMicrotask(() => child.emit("message", { type: "ready", generation: received.generation }))
            if (received.type === "shutdown") child.exit(0)
            return true
        },
        kill() {
            child.exit(0)
            return true
        },
        exit(code: number) {
            if (!child.connected) return
            child.connected = false
            child.exitCode = code
            queueMicrotask(() => {
                child.emit("disconnect")
                child.emit("exit", code, null)
            })
        },
    })
    queueMicrotask(() => child.emit("message", { type: "hello" }))
    return child
}

test.each(["default", "native"] as const)(
    "%s supervisor restores a child's restart budget after a healthy run, while a crash loop still exhausts it",
    async (mode) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] })
        try {
            const children: ReturnType<typeof crashingChild>[] = []
            fork.mockImplementation(() => {
                const child = crashingChild()
                children.push(child)
                return child
            })
            const options = {
                entry: process.execPath,
                totalShards: 1,
                assignments: [{ id: "healthy", shardIds: [0] }],
                restart: { maxAttempts: 1, minDelayMs: 10, maxDelayMs: 10, healthyResetMs: 1_000 },
            } satisfies SupervisorOptions
            const managed =
                mode === "default"
                    ? supervisor.create(options)
                    : await Effect.runPromise(nativeSupervisor.create(options))
            const settle = async (operation: unknown) =>
                Effect.isEffect(operation)
                    ? Effect.runPromise(typedResult(operation as Effect.Effect<unknown, unknown>))
                    : operation
            const ready = () =>
                vi.waitFor(() => expect(managed.status().children[0]!.state).toBe("running"), { interval: 1 })
            await settle(managed.start())
            // Each child runs for one second after configuration before it crashes, so every exit restores the budget
            for (let crash = 0; crash < 3; crash++) {
                await vi.advanceTimersByTimeAsync(1_000)
                children.at(-1)!.exit(1)
                await vi.advanceTimersByTimeAsync(10)
                await ready()
            }
            expect(managed.status().children[0]).toMatchObject({ generation: 4, restarts: 1, state: "running" })
            // A crash before a healthy run counts against the budget, which the last restart already used
            await vi.advanceTimersByTimeAsync(500)
            children.at(-1)!.exit(1)
            const closing = settle(managed.waitForClose())
            await vi.advanceTimersByTimeAsync(10_000)
            expect(JSON.stringify(await closing)).toContain("restartLimit")
            expect(managed.status().children[0]).toMatchObject({ generation: 4, restarts: 1, state: "failed" })
        } finally {
            vi.useRealTimers()
            fork.mockReset()
        }
    },
)
