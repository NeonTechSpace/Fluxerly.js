import { once } from "node:events"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { expect, onTestFinished, test, vi } from "vitest"
import WebSocket, { WebSocketServer } from "ws"
import { supervisor as defaultSupervisor } from "../src/index.js"
import { supervisor as nativeSupervisor } from "../src/effect.js"
import type { SupervisorAssignmentOptions, SupervisorOptions, SupervisorStatus } from "../src/supervisor.js"

type Mode = "default" | "native"
type Identify = { readonly at: number; readonly shardId: number }
type Resume = { readonly at: number }
type Signal = { readonly at: number; readonly mode: string; readonly operation: 2 | 6 }
type Proof = { readonly at: number; readonly mode: string; readonly state: string }
type Managed = {
    start(): Promise<void>
    waitForClose(): Promise<void>
    shutdown(): Promise<void>
    status(): SupervisorStatus
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function entry(mode: Mode): string | URL {
    const value = new URL("./supervisor-public-loopback-child.mjs", import.meta.url)
    return mode === "default" ? fileURLToPath(value) : value
}

function document(origin: string) {
    return {
        api_code_version: 1,
        endpoints: {
            api_public: origin,
            gateway: origin.replace("http:", "ws:"),
            media: origin,
            static_cdn: origin,
            webapp: origin,
            invite: origin,
        },
        features: { presigned_attachment_uploads: true },
    }
}

async function loopbackGateway({
    totalShards,
    closeFirstAfterReady = false,
    holdConfigureForShard,
}: {
    readonly totalShards: number
    readonly closeFirstAfterReady?: boolean
    readonly holdConfigureForShard?: number
}) {
    let origin = ""
    let ready = false
    let firstClosed = false
    let closed = false
    let readySends = 0
    let configureReleased = holdConfigureForShard === undefined
    let configureResponse: import("node:http").ServerResponse | undefined
    const identifies: Identify[] = []
    const resumes: Resume[] = []
    const signals: Signal[] = []
    const proofs: Proof[] = []
    const configureRequests: number[] = []
    const malformedGatewayPackets: unknown[] = []
    const awaitingReady = new Map<import("ws").WebSocket, readonly [number, number]>()
    const server = createServer((request, response) => {
        const target = new URL(request.url ?? "/", origin)
        if (target.pathname === "/.well-known/fluxer") {
            expect(request.method).toBe("GET")
            expect(request.headers.authorization).toBeUndefined()
            response.writeHead(200, { "content-type": "application/json" })
            response.end(JSON.stringify(document(origin)))
            return
        }
        if (target.pathname === "/supervisor-proof") {
            expect(request.method).toBe("GET")
            expect(request.headers.authorization).toBeUndefined()
            const at = Number(target.searchParams.get("at"))
            if (!Number.isSafeInteger(at) || at <= 0) {
                response.statusCode = 400
                response.end()
                return
            }
            proofs.push({
                at,
                mode: target.searchParams.get("mode") ?? "",
                state: target.searchParams.get("state") ?? "",
            })
            response.statusCode = 204
            response.end()
            return
        }
        if (target.pathname === "/supervisor-send-proof") {
            expect(request.method).toBe("GET")
            expect(request.headers.authorization).toBeUndefined()
            const at = Number(target.searchParams.get("at"))
            const operation = Number(target.searchParams.get("operation"))
            if (!Number.isSafeInteger(at) || at <= 0 || (operation !== 2 && operation !== 6)) {
                response.statusCode = 400
                response.end()
                return
            }
            signals.push({ at, mode: target.searchParams.get("mode") ?? "", operation })
            response.statusCode = 204
            response.end()
            return
        }
        if (target.pathname === "/supervisor-configure-barrier") {
            expect(request.method).toBe("GET")
            expect(request.headers.authorization).toBeUndefined()
            const shardId = Number(target.searchParams.get("shard"))
            if (shardId !== holdConfigureForShard || configureResponse) {
                response.statusCode = 400
                response.end()
                return
            }
            configureRequests.push(shardId)
            if (configureReleased) {
                response.statusCode = 204
                response.end()
                return
            }
            configureResponse = response
            return
        }
        response.statusCode = 404
        response.end()
    })
    const gateway = new WebSocketServer({ server })
    const sendReady = (socket: import("ws").WebSocket, shard: readonly [number, number]) => {
        if (socket.readyState !== WebSocket.OPEN) return
        const [shardId, totalShards] = shard
        awaitingReady.delete(socket)
        readySends += 1
        socket.send(
            JSON.stringify({
                op: 0,
                s: 1,
                t: "READY",
                d:
                    totalShards === 1
                        ? { session_id: `loopback-${shardId}` }
                        : { session_id: `loopback-${shardId}`, shard: [shardId, totalShards] },
            }),
        )
        if (closeFirstAfterReady && !firstClosed) {
            firstClosed = true
            setTimeout(() => socket.terminate(), 25)
        }
    }
    gateway.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (raw) => {
            let packet: unknown
            try {
                packet = JSON.parse(raw.toString())
            } catch {
                return
            }
            if (!record(packet)) return
            if (packet.op === 1) {
                socket.send(JSON.stringify({ op: 11, d: null }))
                return
            }
            if (packet.op === 6) {
                resumes.push({ at: performance.now() })
                socket.send(JSON.stringify({ op: 9, d: false }))
                return
            }
            if (packet.op !== 2 || !record(packet.d)) return
            let shardId = 0
            if (totalShards === 1) {
                if (Object.hasOwn(packet.d, "shard")) {
                    malformedGatewayPackets.push(packet)
                    return
                }
            } else {
                if (!Array.isArray(packet.d.shard)) {
                    malformedGatewayPackets.push(packet)
                    return
                }
                const sentShardId = packet.d.shard[0]
                const sentTotalShards = packet.d.shard[1]
                if (
                    typeof sentShardId !== "number" ||
                    typeof sentTotalShards !== "number" ||
                    sentTotalShards !== totalShards
                ) {
                    malformedGatewayPackets.push(packet)
                    return
                }
                shardId = sentShardId
            }
            identifies.push({ at: performance.now(), shardId })
            if (ready) sendReady(socket, [shardId, totalShards])
            else awaitingReady.set(socket, [shardId, totalShards])
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing supervisor loopback address")
    origin = `http://127.0.0.1:${address.port}`
    return {
        origin,
        identifies,
        resumes,
        signals,
        proofs,
        configureRequests,
        malformedGatewayPackets,
        readySends: () => readySends,
        releaseReady() {
            ready = true
            for (const [socket, shard] of awaitingReady) sendReady(socket, shard)
        },
        releaseConfigureBarrier() {
            configureReleased = true
            configureResponse?.end()
            configureResponse = undefined
        },
        async close() {
            if (closed) return
            closed = true
            if (configureResponse) {
                configureResponse.statusCode = 503
                configureResponse.end()
                configureResponse = undefined
            }
            for (const socket of gateway.clients) socket.terminate()
            await new Promise<void>((resolve) => gateway.close(() => resolve()))
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

async function managed(mode: Mode, options: SupervisorOptions): Promise<Managed> {
    if (mode === "default") {
        const created = defaultSupervisor.create(options)
        expect(created.isOk()).toBe(true)
        if (created.isErr()) throw created.error
        const value = created.value
        return {
            start: async () => {
                const result = await value.start()
                if (result.isErr()) throw result.error
            },
            waitForClose: async () => {
                const result = await value.waitForClose()
                if (result.isErr()) throw result.error
            },
            shutdown: async () => {
                const result = await value.shutdown()
                if (result.isErr()) throw result.error
            },
            status: () => value.status(),
        }
    }
    const value = await Effect.runPromise(nativeSupervisor.create(options))
    return {
        start: () => Effect.runPromise(value.start()),
        waitForClose: () => Effect.runPromise(value.waitForClose()),
        shutdown: () => Effect.runPromise(value.shutdown()),
        status: () => value.status(),
    }
}

function options(
    mode: Mode,
    origin: string,
    totalShards: number,
    assignments: readonly SupervisorAssignmentOptions[],
    minimumSpacingMs: number,
    overrides: {
        readonly restart?: SupervisorOptions["restart"]
        readonly shutdownTimeoutMs?: number
        readonly childEnvironment?: Readonly<Record<string, string>>
    } = {},
): SupervisorOptions {
    return {
        entry: entry(mode),
        totalShards,
        assignments,
        identify: { minimumSpacingMs },
        startupTimeoutMs: 10_000,
        ...(overrides.restart === undefined ? {} : { restart: overrides.restart }),
        shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 1_000,
        childEnvironment: {
            FLUXERLY_SUPERVISOR_LOOPBACK: origin,
            FLUXERLY_SUPERVISOR_MODE: mode,
            FLUXERLY_SUPERVISOR_TEST_TOKEN: "supervisor-loopback-token",
            ...overrides.childEnvironment,
        },
    }
}

test.each(["default", "native"] as const)(
    "%s public supervisor starts before gateway READY, spaces two real Identifies and closes helper clients",
    async (mode) => {
        const minimumSpacingMs = 1_000
        const fixture = await loopbackGateway({ totalShards: 2 })
        const owner = await managed(
            mode,
            options(
                mode,
                fixture.origin,
                2,
                [
                    { id: "first", shardIds: [0] },
                    { id: "second", shardIds: [1] },
                ],
                minimumSpacingMs,
            ),
        )
        let cleaned = false
        const cleanup = async () => {
            if (cleaned) return
            cleaned = true
            try {
                await owner.shutdown()
            } finally {
                await fixture.close()
            }
        }
        onTestFinished(cleanup)
        try {
            await owner.start()
            expect(owner.status()).toMatchObject({ state: "running" })
            expect(fixture.readySends()).toBe(0)
            fixture.releaseReady()
            await vi.waitFor(() => expect(fixture.identifies).toHaveLength(2), { interval: 5, timeout: 8_000 })
            expect(fixture.identifies.map((identify) => identify.shardId).sort()).toEqual([0, 1])
            expect(fixture.malformedGatewayPackets).toEqual([])
            await vi.waitFor(() =>
                expect(fixture.signals.filter((signal) => signal.operation === 2 && signal.mode === mode)).toHaveLength(
                    2,
                ),
            )
            const sends = fixture.signals
                .filter((signal) => signal.operation === 2 && signal.mode === mode)
                .sort((left, right) => left.at - right.at)
            expect(sends[1]!.at - sends[0]!.at).toBeGreaterThanOrEqual(minimumSpacingMs)
            await owner.shutdown()
            await owner.waitForClose()
            await vi.waitFor(() => expect(fixture.proofs).toHaveLength(2))
            expect(fixture.proofs).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ mode, state: "Closed" }),
                    expect.objectContaining({ mode, state: "Closed" }),
                ]),
            )
            expect(owner.status()).toMatchObject({
                state: "closed",
                children: [
                    { id: "first", pid: null, state: "closed" },
                    { id: "second", pid: null, state: "closed" },
                ],
            })
        } finally {
            await cleanup()
        }
    },
    15_000,
)

test.each(["default", "native"] as const)(
    "%s public supervisor bypasses its gate for resume and gates the next fresh Identify",
    async (mode) => {
        const minimumSpacingMs = 2_000
        const fixture = await loopbackGateway({ totalShards: 1, closeFirstAfterReady: true })
        const owner = await managed(
            mode,
            options(mode, fixture.origin, 1, [{ id: "only", shardIds: [0] }], minimumSpacingMs),
        )
        let cleaned = false
        const cleanup = async () => {
            if (cleaned) return
            cleaned = true
            try {
                await owner.shutdown()
            } finally {
                await fixture.close()
            }
        }
        onTestFinished(cleanup)
        try {
            await owner.start()
            fixture.releaseReady()
            await vi.waitFor(() => expect(fixture.identifies).toHaveLength(2), { interval: 5, timeout: 10_000 })
            expect(fixture.resumes).toHaveLength(1)
            expect(fixture.resumes[0]!.at - fixture.identifies[0]!.at).toBeLessThan(minimumSpacingMs)
            expect(fixture.malformedGatewayPackets).toEqual([])
            await vi.waitFor(() =>
                expect(fixture.signals.filter((signal) => signal.operation === 2 && signal.mode === mode)).toHaveLength(
                    2,
                ),
            )
            const sends = fixture.signals
                .filter((signal) => signal.operation === 2 && signal.mode === mode)
                .sort((left, right) => left.at - right.at)
            expect(sends[1]!.at - sends[0]!.at).toBeGreaterThanOrEqual(minimumSpacingMs)
            await owner.shutdown()
            await owner.waitForClose()
            await vi.waitFor(() => expect(fixture.proofs).toHaveLength(1))
            expect(fixture.proofs[0]).toMatchObject({ mode, state: "Closed" })
            expect(owner.status()).toMatchObject({
                state: "closed",
                children: [{ id: "only", pid: null, state: "closed", generation: 1 }],
            })
        } finally {
            await cleanup()
        }
    },
    15_000,
)

test.each(["default", "native"] as const)(
    "%s public supervisor reclaims an unacknowledged permit before admitting a healthy sibling",
    async (mode) => {
        const minimumSpacingMs = 1_000
        const fixture = await loopbackGateway({ totalShards: 2, holdConfigureForShard: 1 })
        const owner = await managed(
            mode,
            options(
                mode,
                fixture.origin,
                2,
                [
                    { id: "unacknowledged", shardIds: [0] },
                    { id: "healthy", shardIds: [1] },
                ],
                minimumSpacingMs,
                {
                    restart: { maxAttempts: 1, minDelayMs: 30_000, maxDelayMs: 30_000 },
                    childEnvironment: {
                        FLUXERLY_SUPERVISOR_DROP_SENT_FOR_SHARD: "0",
                        FLUXERLY_SUPERVISOR_HOLD_CONFIGURE_FOR_SHARD: "1",
                    },
                },
            ),
        )
        let cleaned = false
        const cleanup = async () => {
            if (cleaned) return
            cleaned = true
            try {
                await owner.shutdown()
            } finally {
                await fixture.close()
            }
        }
        onTestFinished(cleanup)
        try {
            fixture.releaseReady()
            const starting = owner.start()
            await vi.waitFor(() => expect(fixture.identifies).toHaveLength(1), { interval: 5, timeout: 8_000 })
            expect(fixture.identifies[0]!.shardId).toBe(0)
            await vi.waitFor(() => expect(fixture.configureRequests).toEqual([1]))
            expect(owner.status().children.find((child) => child.id === "unacknowledged")).toMatchObject({
                pid: expect.any(Number),
                state: "running",
            })
            fixture.releaseConfigureBarrier()
            await starting
            await new Promise<void>((resolve) => setTimeout(resolve, 100))
            expect(fixture.identifies).toHaveLength(1)
            await vi.waitFor(
                () =>
                    expect(owner.status().children.find((child) => child.id === "unacknowledged")).toMatchObject({
                        pid: null,
                        restarts: 1,
                        state: "restarting",
                    }),
                { interval: 5, timeout: 8_000 },
            )
            await vi.waitFor(() =>
                expect(fixture.proofs.find((proof) => proof.mode === mode && proof.state === "Closed")).toBeDefined(),
            )
            const unacknowledgedClosed = fixture.proofs.find(
                (proof) => proof.mode === mode && proof.state === "Closed",
            )!
            await vi.waitFor(() => expect(fixture.identifies).toHaveLength(2), { interval: 5, timeout: 8_000 })
            expect(fixture.identifies[1]!.shardId).toBe(1)
            expect(fixture.malformedGatewayPackets).toEqual([])
            await vi.waitFor(() =>
                expect(fixture.signals.filter((signal) => signal.operation === 2 && signal.mode === mode)).toHaveLength(
                    2,
                ),
            )
            const healthyIdentify = fixture.signals.findLast(
                (signal) => signal.operation === 2 && signal.mode === mode,
            )!
            // The child deliberately remains alive for 250 ms after reporting helper closure
            expect(healthyIdentify.at - unacknowledgedClosed.at).toBeGreaterThanOrEqual(minimumSpacingMs + 250)
            await owner.shutdown()
            await owner.waitForClose()
            await vi.waitFor(() => expect(fixture.proofs).toHaveLength(2))
            expect(owner.status()).toMatchObject({
                state: "closed",
                children: [
                    { id: "unacknowledged", pid: null, state: "closed" },
                    { id: "healthy", pid: null, state: "closed" },
                ],
            })
        } finally {
            await cleanup()
        }
    },
    20_000,
)
