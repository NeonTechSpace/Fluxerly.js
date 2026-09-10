import type { ChildProcess } from "node:child_process"
import { Effect } from "effect"
import { expect, test, vi } from "vitest"

const fork = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>()
    return { ...actual, fork }
})

import { supervisor } from "../src/index.js"
import { supervisor as nativeSupervisor } from "../src/effect.js"
import type { SupervisorOptions } from "../src/supervisor.js"

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
] as const)("both public facades reject %s without spawning", async (_name, invalid) => {
    const options = {
        entry: process.execPath,
        totalShards: 2,
        assignments: [{ id: "first", shardIds: [0] }],
        ...invalid,
    } satisfies SupervisorOptions
    const defaultApi = supervisor.create(options)
    expect(defaultApi.isErr() && defaultApi.error).toMatchObject({ _tag: "ConfigurationError" })
    const native = await Effect.runPromiseExit(nativeSupervisor.create(options))
    expect(native._tag).toBe("Failure")
    if (native._tag === "Failure") {
        expect(native.cause.reasons).toHaveLength(1)
        expect(native.cause.reasons[0]).toMatchObject({ _tag: "Fail", error: { _tag: "ConfigurationError" } })
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

test("an unspawned child releases its startup and shutdown timers before terminal failure", async () => {
    vi.useFakeTimers()
    try {
        fork.mockReturnValueOnce(childWithoutPid())
        const created = supervisor.create({
            entry: process.execPath,
            totalShards: 1,
            assignments: [{ id: "unspawned", shardIds: [0] }],
            shutdownTimeoutMs: 60_000,
        })
        if (created.isErr()) throw created.error
        const managed = created.value
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
