import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { Effect } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"

const fork = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>()
    return { ...actual, fork }
})

import { supervisor } from "../../../src/index.js"
import { supervisor as nativeSupervisor } from "../../../src/effect.js"
import type { SupervisorOptions, SupervisorStatus } from "../../../src/supervisor.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { hostTurnsUntil } from "../../support/client-clock.js"
import { captureLogs } from "../../support/log-capture.js"

afterEach(() => {
    vi.useRealTimers()
    fork.mockReset()
})

type Message = { readonly type: string; readonly [key: string]: unknown }

/**
 * A scripted child process with piped output, returned by the next fork. It says hello and, unless told otherwise,
 * becomes ready when assigned and exits when asked to stop. A failSend message type fails its IPC send callback
 */
function scriptedChild(
    behavior: { readonly ready?: boolean; readonly exitOnShutdown?: boolean; readonly failSend?: string } = {},
) {
    const kills: string[] = []
    const child = Object.assign(new EventEmitter(), {
        pid: 300,
        connected: true,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kills,
        send(message: Message, _handle: unknown, _options: unknown, callback?: (error: Error | null) => void) {
            if (message.type === behavior.failSend) {
                queueMicrotask(() => callback?.(new Error("fixture IPC failure")))
                return true
            }
            if (message.type === "assignment" && behavior.ready !== false)
                queueMicrotask(() => child.emit("message", { type: "ready", generation: message.generation }))
            if (message.type === "shutdown" && behavior.exitOnShutdown !== false) child.exit(0, null)
            queueMicrotask(() => callback?.(null))
            return true
        },
        kill(signal: string) {
            kills.push(signal)
            child.exit(null, "SIGKILL")
            return true
        },
        exit(code: number | null, signal: NodeJS.Signals | null) {
            if (child.exitCode !== null || child.signalCode !== null) return
            child.connected = false
            child.exitCode = code
            child.signalCode = signal
            queueMicrotask(() => {
                for (const stream of [child.stdout, child.stderr]) if (!stream.destroyed) stream.end()
                child.emit("disconnect")
                child.emit("exit", code, signal)
            })
        },
    })
    // The child says hello once the supervisor forks it and attaches its listeners
    fork.mockImplementationOnce(() => {
        queueMicrotask(() => child.emit("message", { type: "hello" }))
        return child
    })
    return child
}

/** One supervisor with one child in either public API, with Promise results and failures returned as values */
async function managed(mode: Mode, options: Partial<SupervisorOptions>) {
    const settings = {
        entry: process.execPath,
        totalShards: 1,
        assignments: [{ id: "only", shardIds: [0] }],
        ...options,
    } as unknown as SupervisorOptions
    if (mode === "default") {
        const created = supervisor.create(settings)
        onTestFinished(async () => {
            await created.shutdown()
        })
        return {
            start: async () => {
                const result = await created.start()
                return result.isErr() ? result.error : undefined
            },
            shutdown: () => created.shutdown().then(() => undefined),
            closed: async () => {
                const result = await created.waitForClose()
                return result.isErr() ? result.error : undefined
            },
            status: (): SupervisorStatus => created.status(),
        }
    }
    const created = await Effect.runPromise(nativeSupervisor.create(settings))
    onTestFinished(() => Effect.runPromise(created.shutdown()))
    const failure = <E>(effect: Effect.Effect<void, E>) =>
        Effect.runPromise(
            effect.pipe(
                Effect.flip,
                Effect.orElseSucceed(() => undefined),
            ),
        )
    return {
        start: () => failure(created.start()),
        shutdown: () => Effect.runPromise(created.shutdown()),
        closed: () => failure(created.waitForClose()),
        status: (): SupervisorStatus => created.status(),
    }
}

const codes = (logs: ReturnType<typeof captureLogs>) => logs.codes()

test.each(modes)("%s records a failed read of child output instead of ending forwarding silently", async (mode) => {
    const logs = captureLogs()
    const child = scriptedChild()
    const workers = await managed(mode, { logging: logs.logging })
    expect(await workers.start()).toBeUndefined()
    child.stdout.destroy(new Error("fixture read failure"))
    await hostTurnsUntil(() => logs.withCode("supervisor.outputFailed").length > 0)
    expect(logs.withCode("supervisor.outputFailed")).toEqual([
        expect.objectContaining({
            level: "warn",
            fields: expect.objectContaining({ child: "only", stream: "stdout" }),
            error: expect.objectContaining({ message: "fixture read failure" }),
        }),
    ])
    // Only forwarding stopped. The child keeps running
    expect(workers.status().children[0]).toMatchObject({ state: "running" })
})

test.each(modes)("%s records a missed startup deadline before shutting down", async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const logs = captureLogs()
    scriptedChild({ ready: false })
    const workers = await managed(mode, { startupTimeoutMs: 30, logging: logs.logging })
    const started = workers.start()
    await vi.advanceTimersByTimeAsync(30)
    expect(await started).toMatchObject({ _tag: "SupervisorError", reason: "startupTimeout" })
    expect(logs.withCode("supervisor.startupTimeout")).toEqual([
        expect.objectContaining({
            level: "error",
            fields: expect.objectContaining({ child: "only", startupTimeoutMs: 30 }),
        }),
    ])
    expect(codes(logs).indexOf("supervisor.startupTimeout")).toBeLessThan(codes(logs).indexOf("supervisor.exit"))
})

test.each(modes)("%s records an unconfirmed Identify grant before stopping the child", async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const logs = captureLogs()
    const child = scriptedChild()
    // Without restarts, the stopped child is not replaced, so the test owns exactly one process
    const workers = await managed(mode, { logging: logs.logging, restart: false })
    expect(await workers.start()).toBeUndefined()
    child.emit("message", { type: "identify", generation: 1, requestId: 0, shardId: 0 })
    // The child never reports the Identify as sent, so the 5 second acknowledgement deadline passes
    await vi.advanceTimersByTimeAsync(5_000)
    await hostTurnsUntil(() => codes(logs).includes("supervisor.exit"))
    expect(logs.withCode("supervisor.identifyUnacknowledged")).toEqual([
        expect.objectContaining({ level: "warn", fields: expect.objectContaining({ child: "only", shardId: 0 }) }),
    ])
    expect(codes(logs).indexOf("supervisor.identifyUnacknowledged")).toBeLessThan(
        codes(logs).indexOf("supervisor.exit"),
    )
})

test.each(modes)("%s records why it force-terminates a child that ignores a stop request", async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const logs = captureLogs()
    const child = scriptedChild({ exitOnShutdown: false })
    const workers = await managed(mode, { shutdownTimeoutMs: 50, logging: logs.logging })
    expect(await workers.start()).toBeUndefined()
    const stopping = workers.shutdown()
    await vi.advanceTimersByTimeAsync(50)
    await stopping
    expect(child.kills).toEqual(["SIGKILL"])
    expect(logs.withCode("supervisor.terminated")).toEqual([
        expect.objectContaining({
            level: "warn",
            fields: expect.objectContaining({ child: "only", shutdownTimeoutMs: 50 }),
        }),
    ])
    expect(codes(logs).indexOf("supervisor.terminated")).toBeLessThan(codes(logs).indexOf("supervisor.exit"))
})

test.each(modes)(
    "%s records why it shuts down and force-terminates a child that lost its message channel",
    async (mode) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        const logs = captureLogs()
        const child = scriptedChild()
        const workers = await managed(mode, { shutdownTimeoutMs: 50, logging: logs.logging })
        expect(await workers.start()).toBeUndefined()
        child.connected = false
        child.emit("disconnect")
        await vi.advanceTimersByTimeAsync(50)
        expect(await workers.closed()).toMatchObject({ _tag: "SupervisorError", reason: "closed" })
        expect(child.kills).toEqual(["SIGKILL"])
        expect(logs.withCode("supervisor.terminated")).toEqual([
            expect.objectContaining({
                level: "error",
                fields: expect.objectContaining({ child: "only", shutdownTimeoutMs: 50 }),
            }),
        ])
    },
)

test.each(modes)("%s keeps the error of a failed message send to a child in its record", async (mode) => {
    const logs = captureLogs()
    scriptedChild({ failSend: "assignment" })
    const workers = await managed(mode, { logging: logs.logging })
    expect(await workers.start()).toMatchObject({ _tag: "SupervisorError", reason: "spawn" })
    expect(logs.withCode("supervisor.spawnFailed")).toEqual([
        expect.objectContaining({ level: "error", error: expect.objectContaining({ message: "fixture IPC failure" }) }),
    ])
})
