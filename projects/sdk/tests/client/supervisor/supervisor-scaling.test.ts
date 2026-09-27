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
import type { SupervisorOptions, SupervisorStatus } from "../../../src/supervisor.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { startInstance } from "../../support/instance.js"
import { captureLogs } from "../../support/log-capture.js"
import { sendJson, type RecordedRequest } from "../../support/rest-server.js"

type Message = { readonly type: string; readonly [key: string]: unknown }

/**
 * A scripted child process: It says hello, finishes configuration when assigned and records every parent message.
 * The test drives the rest of the protocol through emit
 */
function scriptedChild(pid: number) {
    const received: Message[] = []
    const child = Object.assign(new EventEmitter(), {
        pid,
        connected: true,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        received,
        send(message: Message) {
            received.push(message)
            if (message.type === "assignment")
                queueMicrotask(() => child.emit("message", { type: "ready", generation: message.generation }))
            if (message.type === "shutdown") child.exit(0)
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

type Child = ReturnType<typeof scriptedChild>

function forkScripted() {
    const children: Child[] = []
    fork.mockImplementation(() => {
        const child = scriptedChild(200 + children.length)
        children.push(child)
        return child
    })
    return children
}

/** The same lifecycle in either public API, with Promise results for comparison */
async function managed(mode: Mode, options: SupervisorOptions) {
    if (mode === "default") {
        const created = supervisor.create(options)
        return {
            start: async () => {
                const result = await created.start()
                return result.isErr() ? result.error : undefined
            },
            shutdown: () => created.shutdown().then(() => undefined),
            status: (): SupervisorStatus => created.status(),
        }
    }
    const created = await Effect.runPromise(nativeSupervisor.create(options))
    return {
        start: () =>
            Effect.runPromise(
                created.start().pipe(
                    Effect.flip,
                    Effect.orElseSucceed(() => undefined),
                ),
            ),
        shutdown: () => Effect.runPromise(created.shutdown()),
        status: (): SupervisorStatus => created.status(),
    }
}

async function createFailure(mode: Mode, options: unknown): Promise<unknown> {
    if (mode === "default") {
        try {
            supervisor.create(options as SupervisorOptions)
        } catch (error) {
            return error
        }
        return undefined
    }
    const exit = await Effect.runPromiseExit(nativeSupervisor.create(options as SupervisorOptions))
    const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined
    return reason?._tag === "Die" ? reason.defect : undefined
}

const base = { entry: process.execPath }

test.each(
    modes.flatMap((mode) =>
        (
            [
                ["no child plan", { totalShards: 2 }, "assignments"],
                [
                    "assignments with processes",
                    { totalShards: 2, processes: 2, assignments: [{ id: "a", shardIds: [0] }] },
                    "supervisor",
                ],
                ["more processes than shards", { totalShards: 2, processes: 3 }, "processes"],
                ["zero shards per process", { totalShards: 2, shardsPerProcess: 0 }, "shardsPerProcess"],
                [
                    "automatic total with assignments",
                    { totalShards: "auto", assignments: [{ id: "a", shardIds: [0] }] },
                    "assignments",
                ],
                ["automatic total without a token", { totalShards: "auto", processes: 2 }, "token"],
                [
                    "counting token with a numeric total",
                    { totalShards: 2, processes: 2, token: "fixture-only" },
                    "token",
                ],
                [
                    "coordinator combined with spacing",
                    {
                        totalShards: 1,
                        processes: 1,
                        identify: { minimumSpacingMs: 1_000, coordinator: { permit: async () => {} } },
                    },
                    "identify",
                ],
                [
                    "coordinator without permit",
                    { totalShards: 1, processes: 1, identify: { coordinator: {} } },
                    "identify",
                ],
                ["restart true", { totalShards: 1, processes: 1, restart: true }, "restart"],
                [
                    "short diagnostics interval",
                    { totalShards: 1, processes: 1, diagnosticsIntervalMs: 999 },
                    "diagnosticsIntervalMs",
                ],
            ] as const
        ).map(([name, options, field]) => [mode, name, options, field] as const),
    ),
)("%s supervisor rejects %s without spawning", async (mode, _name, options, field) => {
    const error = await createFailure(mode, { ...base, ...options })
    expect(error).toBeInstanceOf(ConfigurationError)
    expect(error).toMatchObject({ field })
    expect(fork).not.toHaveBeenCalled()
})

test.each(modes)("%s processes and shardsPerProcess split every shard into contiguous children", async (mode) => {
    const assignments = async (options: Partial<SupervisorOptions>) =>
        (await managed(mode, { ...base, totalShards: 5, ...options }))
            .status()
            .children.map((child) => [child.id, child.assignment.shardIds])
    expect(await assignments({ processes: 2 })).toEqual([
        ["process-0", [0, 1, 2]],
        ["process-1", [3, 4]],
    ])
    expect(await assignments({ shardsPerProcess: 2 })).toEqual([
        ["process-0", [0, 1]],
        ["process-1", [2, 3]],
        ["process-2", [4]],
    ])
    expect(fork).not.toHaveBeenCalled()
})

/** A bot in the given number of communities, listed in ascending ID pages as Fluxer returns them */
function guildPages(count: number) {
    return (request: RecordedRequest, response: import("node:http").ServerResponse) => {
        const limit = Number(request.query.get("limit"))
        const after = Number(request.query.get("after") ?? 0)
        const ids = Array.from({ length: Math.max(0, Math.min(limit, count - after)) }, (_, index) => after + index + 1)
        sendJson(
            response,
            ids.map((id) => ({ id: String(id), name: "fixture", owner_id: "90", features: [] })),
        )
    }
}

test.each(modes)(
    "%s totalShards auto counts the communities at start and splits the plan across processes",
    async (mode) => {
        try {
            const { instance } = await startInstance({ routes: { "GET /v1/users/@me/guilds": guildPages(4_001) } })
            const children = forkScripted()
            const logs = captureLogs()
            const owner = await managed(mode, {
                ...base,
                totalShards: "auto",
                processes: 2,
                token: "fixture-only-not-a-credential",
                instance: { url: instance, allowInsecure: true },
                logging: logs.logging,
            })
            expect(owner.status().children).toEqual([])
            expect(await owner.start()).toBeUndefined()
            // 4,001 communities need three shards at 2,000 each, split into blocks of two and one
            expect(owner.status().children.map((child) => [child.id, child.assignment])).toEqual([
                ["process-0", { totalShards: 3, shardIds: [0, 1] }],
                ["process-1", { totalShards: 3, shardIds: [2] }],
            ])
            expect(
                children.map((child) => child.received.find((message) => message.type === "assignment")?.assignment),
            ).toEqual([
                { totalShards: 3, shardIds: [0, 1] },
                { totalShards: 3, shardIds: [2] },
            ])
            expect(logs.withCode("supervisor.automaticSharding")).toEqual([
                expect.objectContaining({
                    level: "info",
                    fields: expect.objectContaining({ guilds: 4_001, totalShards: 3, children: 2 }),
                }),
            ])
            await owner.shutdown()
        } finally {
            fork.mockReset()
        }
    },
)

test.each(modes)(
    "%s a failed automatic count fails start with reason shardCount and the count's error",
    async (mode) => {
        try {
            const { instance } = await startInstance({
                routes: {
                    "GET /v1/users/@me/guilds": (_request, response) =>
                        sendJson(response, { code: 0, message: "401: Unauthorized" }, 401),
                },
            })
            const owner = await managed(mode, {
                ...base,
                totalShards: "auto",
                processes: 2,
                token: "fixture-only-not-a-credential",
                instance: { url: instance, allowInsecure: true },
                logging: { level: "silent" },
            })
            const failure = await owner.start()
            expect(failure).toMatchObject({ _tag: "SupervisorError", reason: "shardCount", childId: null })
            expect((failure as Error).cause).toMatchObject({ _tag: "AuthenticationError" })
            expect(owner.status()).toMatchObject({ state: "failed", children: [] })
            expect(fork).not.toHaveBeenCalled()
        } finally {
            fork.mockReset()
        }
    },
)

test.each(modes)(
    "%s shutdown during the automatic count stops it without starting a child",
    async (mode) => {
        try {
            let entered!: () => void
            const counting = new Promise<void>((resolve) => (entered = resolve))
            const { instance } = await startInstance({
                routes: {
                    // The page never answers, so only shutdown can end the count
                    "GET /v1/users/@me/guilds": () => entered(),
                },
            })
            const owner = await managed(mode, {
                ...base,
                totalShards: "auto",
                processes: 1,
                token: "fixture-only-not-a-credential",
                instance: { url: instance, allowInsecure: true },
                logging: { level: "silent" },
            })
            const starting = owner.start()
            await counting
            await owner.shutdown()
            expect(await starting).toMatchObject({ _tag: "SupervisorError", reason: "closed" })
            expect(owner.status()).toMatchObject({ state: "closed", children: [] })
            expect(fork).not.toHaveBeenCalled()
        } finally {
            fork.mockReset()
        }
    },
    10_000,
)

test.each(modes)(
    "%s identify coordinator gates every grant, replaces spacing and turns a refusal into a retryable denial",
    async (mode) => {
        try {
            const children = forkScripted()
            const logs = captureLogs()
            const refusal = new Error("coordinator refused")
            const permits: [number, number][] = []
            const owner = await managed(mode, {
                ...base,
                totalShards: 2,
                processes: 2,
                identify: {
                    coordinator: {
                        async permit(shardId: number, totalShards: number) {
                            permits.push([shardId, totalShards])
                            if (permits.length === 1) throw refusal
                        },
                    },
                },
                logging: logs.logging,
            })
            expect(await owner.start()).toBeUndefined()
            const [first, second] = children as [Child, Child]
            first.emit("message", { type: "identify", generation: 1, requestId: 0, shardId: 0 })
            second.emit("message", { type: "identify", generation: 1, requestId: 0, shardId: 1 })
            await vi.waitFor(() => expect(first.received.map((message) => message.type)).toContain("denied"))
            expect(first.received.find((message) => message.type === "denied")).toEqual({
                type: "denied",
                generation: 1,
                requestId: 0,
            })
            expect(logs.withCode("supervisor.identifyPermitFailed")).toEqual([
                expect.objectContaining({ level: "error", fields: expect.objectContaining({ shardId: 0 }) }),
            ])
            // The refusal released the permit, so the second child is granted without the one-second spacing
            await vi.waitFor(() => expect(second.received.map((message) => message.type)).toContain("grant"))
            second.emit("message", { type: "sent", generation: 1, requestId: 0 })
            first.emit("message", { type: "identify", generation: 1, requestId: 1, shardId: 0 })
            const retried = performance.now()
            await vi.waitFor(() => expect(first.received.filter((message) => message.type === "grant")).toHaveLength(1))
            expect(performance.now() - retried).toBeLessThan(500)
            expect(permits).toEqual([
                [0, 2],
                [1, 2],
                [0, 2],
            ])
            expect(owner.status().state).toBe("running")
            await owner.shutdown()
        } finally {
            fork.mockReset()
        }
    },
)

test.each(modes)("%s a child cancel or shutdown aborts the coordinator's pending permit", async (mode) => {
    try {
        const children = forkScripted()
        const signals: AbortSignal[] = []
        const owner = await managed(mode, {
            ...base,
            totalShards: 1,
            processes: 1,
            identify: {
                coordinator: {
                    permit: (_shardId: number, _totalShards: number, signal: AbortSignal) => {
                        signals.push(signal)
                        return new Promise<void>(() => {})
                    },
                },
            },
        })
        await owner.start()
        const child = children[0]!
        child.emit("message", { type: "identify", generation: 1, requestId: 0, shardId: 0 })
        await vi.waitFor(() => expect(signals).toHaveLength(1))
        child.emit("message", { type: "cancel", generation: 1, requestId: 0 })
        expect(signals[0]!.aborted).toBe(true)
        expect(child.received.at(-1)).toEqual({ type: "cancelled", generation: 1, requestId: 0 })
        child.emit("message", { type: "identify", generation: 1, requestId: 1, shardId: 0 })
        await vi.waitFor(() => expect(signals).toHaveLength(2))
        await owner.shutdown()
        expect(signals[1]!.aborted).toBe(true)
        expect(child.received.some((message) => message.type === "grant")).toBe(false)
    } finally {
        fork.mockReset()
    }
})

function diagnosticsSnapshot() {
    return {
        state: "Connected",
        gatewayLatencyMs: 42,
        shards: [{ shardId: 0, state: "Connected", gatewayLatencyMs: 42, recovery: null }],
        rest: {
            activeRequests: 1,
            activeCapacity: 8,
            queuedRequests: 0,
            queuedCapacity: 256,
            queuedJsonBytes: 0,
            queuedJsonByteCapacity: 4_194_304,
        },
        uploads: { reservedBytes: 0, byteCapacity: 104_857_600 },
        gatewayRequests: { activeRequests: 0, activeCapacity: 4 },
        events: { subscriptions: 1, messageCollectors: 0, reactionCollectors: 0, activeHandlers: 0 },
        caches: {},
        counters: { handlerFailures: 2 },
    }
}

test.each(modes)(
    "%s status exposes each child's latest diagnostics and clears them when the child exits",
    async (mode) => {
        try {
            const children = forkScripted()
            const owner = await managed(mode, { ...base, totalShards: 1, processes: 1, diagnosticsIntervalMs: 2_000 })
            await owner.start()
            const child = children[0]!
            expect(child.received.find((message) => message.type === "assignment")).toMatchObject({
                diagnosticsIntervalMs: 2_000,
            })
            expect(owner.status().children[0]!.diagnostics).toBeNull()
            const before = Date.now()
            child.emit("message", { type: "diagnostics", generation: 1, diagnostics: diagnosticsSnapshot() })
            const diagnostics = owner.status().children[0]!.diagnostics
            expect(diagnostics?.client).toEqual(diagnosticsSnapshot())
            expect(diagnostics?.receivedAt).toBeGreaterThanOrEqual(before)
            expect(Object.isFrozen(diagnostics?.client.rest)).toBe(true)
            child.exit(1)
            await vi.waitFor(() => expect(owner.status().children[0]).toMatchObject({ pid: null, diagnostics: null }))
            await owner.shutdown()
        } finally {
            fork.mockReset()
        }
    },
)

test.each(modes)("%s a diagnostics message without the snapshot's fields is a protocol failure", async (mode) => {
    try {
        const children = forkScripted()
        const owner = await managed(mode, { ...base, totalShards: 1, processes: 1 })
        await owner.start()
        children[0]!.emit("message", { type: "diagnostics", generation: 1, diagnostics: { state: "Connected" } })
        await vi.waitFor(() => expect(owner.status().state).toBe("failed"))
        await owner.shutdown()
    } finally {
        fork.mockReset()
    }
})

test.each(modes)(
    "%s totalShards auto answers a child's 4011 by restarting every child under a larger plan, three times an hour",
    async (mode) => {
        try {
            const { instance } = await startInstance({ routes: { "GET /v1/users/@me/guilds": guildPages(1) } })
            const children = forkScripted()
            const logs = captureLogs()
            const owner = await managed(mode, {
                ...base,
                totalShards: "auto",
                processes: 2,
                shutdownTimeoutMs: 3_000,
                token: "fixture-only-not-a-credential",
                instance: { url: instance, allowInsecure: true },
                logging: logs.logging,
            })
            expect(await owner.start()).toBeUndefined()
            // Children drain running work within shutdownTimeoutMs, keeping one second to close
            expect(children[0]!.received.find((message) => message.type === "assignment")).toMatchObject({
                drainMs: 2_000,
            })
            const totals = () => owner.status().children.map((child) => child.assignment.totalShards)
            expect(totals()).toEqual([1])
            // One community still fits one shard, so each move adds a shard, as a client with sharding "auto" does
            for (const expected of [2, 3, 4]) {
                const running = children.filter((child) => child.connected)
                running[0]!.emit("message", { type: "failed", generation: 1, reason: "sharding" })
                await vi.waitFor(() => expect(totals()).toEqual(Array(Math.min(2, expected)).fill(expected)))
                await vi.waitFor(() =>
                    expect(owner.status().children.every((child) => child.state === "running")).toBe(true),
                )
                // Every child of the old plan was asked to stop, not only the one that reported the closure
                for (const child of running) expect(child.received.at(-1)).toMatchObject({ type: "shutdown" })
            }
            expect(logs.withCode("supervisor.resharded")).toEqual(
                [
                    [1, 2],
                    [2, 3],
                    [3, 4],
                ].map(([previousTotalShards, totalShards]) =>
                    expect.objectContaining({
                        level: "warn",
                        fields: expect.objectContaining({ guilds: 1, previousTotalShards, totalShards }),
                    }),
                ),
            )
            expect(logs.withCode("supervisor.restart")).toEqual([])
            // A fourth closure within the hour stops the supervisor instead of moving again
            children
                .find((child) => child.connected)!
                .emit("message", {
                    type: "failed",
                    generation: 1,
                    reason: "sharding",
                })
            await vi.waitFor(() => expect(owner.status().state).toBe("failed"))
            expect(logs.withCode("supervisor.resharded").at(-1)).toMatchObject({ level: "error" })
            await owner.shutdown()
        } finally {
            fork.mockReset()
        }
    },
    15_000,
)

test.each(modes)("%s a 4011 report under a numeric totalShards restarts only that child", async (mode) => {
    try {
        const children = forkScripted()
        const logs = captureLogs()
        const owner = await managed(mode, { ...base, totalShards: 2, processes: 2, logging: logs.logging })
        await owner.start()
        children[0]!.emit("message", { type: "failed", generation: 1, reason: "sharding" })
        await vi.waitFor(() => expect(logs.withCode("supervisor.restart")).toHaveLength(1))
        expect(children[1]!.received.some((message) => message.type === "shutdown")).toBe(false)
        expect(owner.status().children.map((child) => child.assignment.totalShards)).toEqual([2, 2])
        expect(logs.withCode("supervisor.resharded")).toEqual([])
        await owner.shutdown()
    } finally {
        fork.mockReset()
    }
})
