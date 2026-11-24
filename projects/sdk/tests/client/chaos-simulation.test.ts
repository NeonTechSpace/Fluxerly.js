/*
 * Deterministic chaos and fault-simulation tests for both the default and native Effect clients.
 * Drives custom in-memory HTTP and WebSocket transports over a virtual Effect Clock and LogicalScheduler with a
 * seeded Mulberry32 generator, so there is no real network I/O and no real-clock sleeping.
 *
 * FLUXERLY_FUZZ_SEED sets the unsigned 32-bit seed, default 1.
 * FLUXERLY_FUZZ_ITERATIONS sets the trial count per scenario and API mode, default 4.
 */
import { EventEmitter } from "node:events"
import { setImmediate as turn } from "node:timers/promises"
import { Effect, Exit, Fiber, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    ClientClosedError,
    createClient,
    type Client,
    type ClientOptions,
    type ConnectionState,
    type WebSocketLike,
} from "../../src/index.js"
import { createClient as createNativeClient, type Client as NativeClient } from "../../src/effect.js"
import { Opcode } from "../../src/internal/protocol/gateway.js"
import { createFixtures } from "../../src/testing.js"
import { describeBothApis, fixtureToken, type Mode } from "../support/both-apis.js"
import { sdkClock, type SdkClock } from "../support/client-clock.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { captureLogs } from "../support/log-capture.js"
import { settle, typedFailure } from "../support/settle.js"

afterEach(() => {
    vi.restoreAllMocks()
})

function envSetting(name: string, fallback: number, minimum: number, maximum: number): number {
    const raw = process.env[name]
    if (raw === undefined || raw === "") return fallback
    const parsed = Number(raw)
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
        throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`)
    return parsed
}

const baseSeed = envSetting("FLUXERLY_FUZZ_SEED", 1, 0, 0xffff_ffff)
const iterations = envSetting("FLUXERLY_FUZZ_ITERATIONS", 4, 1, 1_000)

/** FNV-1a mix so each scenario and trial gets a reproducible independent stream */
function streamSeed(label: string): number {
    let hash = (0x811c9dc5 ^ baseSeed) >>> 0
    for (const char of label) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0
    return hash
}

/** Deterministic Mulberry32 generator */
function prng(seed: number) {
    let state = seed >>> 0
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0
        let value = state
        value = Math.imul(value ^ (value >>> 15), value | 1)
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
    }
    const below = (count: number) => Math.floor(next() * count)
    return {
        next,
        below,
        chance: (probability: number) => next() < probability,
        pick: <T>(items: readonly T[]): T => items[below(items.length)]!,
    }
}

const discoveryUrl = "https://fluxer.com/.well-known/fluxer"
const fixtures = createFixtures()

/** Yield several macro/microtask turns without advancing virtual time */
async function flushTurns(count = 6): Promise<void> {
    for (let index = 0; index < count; index++) await turn()
}

/** Jump virtual time to the next due SDK timer, bounded by maxJumpMs */
async function advanceToNextTimer(clock: SdkClock, maxJumpMs = 60_000): Promise<number> {
    let earliest = Infinity
    for (const item of clock.pending) earliest = Math.min(earliest, item.at)
    const step = earliest === Infinity ? 25 : Math.max(1, Math.min(maxJumpMs, earliest - clock.now()))
    await clock.advance(step)
    return step
}

/** Drive virtual time until predicate holds, failing deterministically if virtual time exceeds limitMs */
async function driveUntil(
    clock: SdkClock,
    predicate: () => boolean,
    label: string,
    { limitMs = 600_000, maxSteps = 2_000 }: { limitMs?: number; maxSteps?: number } = {},
): Promise<void> {
    await flushTurns()
    const start = clock.now()
    for (let step = 0; !predicate(); step++) {
        const elapsed = clock.now() - start
        if (elapsed >= limitMs || step >= maxSteps)
            throw new Error(
                `${label} did not reach expected state (elapsed=${elapsed}ms, steps=${step}, pending=${clock.pending.size})`,
            )
        await advanceToNextTimer(clock)
    }
}

/** Drive virtual time until a promise settles, returning its resolution or throwing its rejection */
async function drivePromise<T>(
    clock: SdkClock,
    promise: PromiseLike<T>,
    label: string,
    options?: { limitMs?: number; maxSteps?: number },
): Promise<T> {
    let done = false
    const tracked = Promise.resolve(promise).finally(() => {
        done = true
    })
    // Keep settlement attached while stepping the clock so no rejection looks unhandled mid-loop
    tracked.catch(() => undefined)
    await driveUntil(clock, () => done, label, options)
    return tracked
}

/** Track unhandled rejections during a test and assert zero occurred */
function guardUnhandledRejections(): { readonly rejections: unknown[] } {
    const rejections: unknown[] = []
    const listener = (reason: unknown) => {
        rejections.push(reason)
    }
    process.on("unhandledRejection", listener)
    onTestFinished(() => {
        process.off("unhandledRejection", listener)
    })
    return { rejections }
}

/** Monotonic client state lattice: Closed is strictly terminal and live states never regress to Disconnected or Connecting once established */
const allowedStateTransitions: Readonly<Record<ConnectionState, readonly ConnectionState[]>> = {
    Disconnected: ["Connecting", "Connected", "Recovering", "Closing", "Closed"],
    Connecting: ["Connected", "Recovering", "Disconnected", "Closing", "Closed"],
    Connected: ["Recovering", "Closing", "Closed"],
    Recovering: ["Connected", "Closing", "Closed"],
    Closing: ["Closed"],
    Closed: [],
}

function assertMonotonicTransitions(states: readonly ConnectionState[], label: string) {
    expect(states.length, `${label}: expected at least one state observation`).toBeGreaterThan(0)
    for (let index = 1; index < states.length; index++) {
        const previous = states[index - 1]!
        const next = states[index]!
        expect(next, `${label}: duplicate consecutive state ${next} at index ${index}`).not.toBe(previous)
        expect(
            allowedStateTransitions[previous],
            `${label}: illegal transition ${previous} -> ${next} in [${states.join(" -> ")}]`,
        ).toContain(next)
    }
}

interface AnyClientHandle {
    readonly mode: Mode
    readonly client: Client | NativeClient
    readonly connect: () => Promise<void>
    readonly shutdown: (drainMs?: number) => Promise<void>
    readonly startShutdown: (drainMs?: number) => Promise<{ readonly ok: boolean; readonly error?: unknown }>
    readonly observeStates: () => Promise<readonly ConnectionState[]>
    readonly onTyping: (handler: (timestamp: number, signal?: AbortSignal) => Promise<void>) => Promise<void>
    readonly scheduleTask: (
        run: (signal?: AbortSignal) => Promise<void>,
        options: { readonly delayMs?: number; readonly intervalMs?: number },
    ) => Promise<void>
    readonly restGet: (
        path: string,
        options?: { readonly timeoutMs?: number; readonly controller?: AbortController },
    ) => {
        readonly promise: Promise<{ readonly ok: boolean; readonly status?: number; readonly error?: unknown }>
        readonly cancel: () => Promise<void>
    }
    readonly restPost: (
        path: string,
        options?: { readonly timeoutMs?: number; readonly controller?: AbortController },
    ) => {
        readonly promise: Promise<{ readonly ok: boolean; readonly status?: number; readonly error?: unknown }>
        readonly cancel: () => Promise<void>
    }
    readonly closeScope: () => Promise<void>
}

async function openChaosClient(mode: Mode, options: Omit<ClientOptions, "token">): Promise<AnyClientHandle> {
    if (mode === "default") {
        const client = createClient({ token: fixtureToken, ...options })
        const states: ConnectionState[] = []
        const observer = client.observeState((state) => {
            states.push(state)
        })
        onTestFinished(async () => {
            observer.close()
            const closed = await client.shutdown()
            if (closed.isErr()) throw closed.error
        })
        return {
            mode,
            client,
            connect: async () => {
                await settle(client.connect())
            },
            shutdown: async (drainMs) => {
                const res = await client.shutdown(drainMs === undefined ? undefined : { drainMs })
                if (res.isErr()) throw res.error
            },
            startShutdown: async (drainMs) => {
                const res = await client.shutdown(drainMs === undefined ? undefined : { drainMs })
                return res.isOk() ? { ok: true } : { ok: false, error: res.error }
            },
            observeStates: async () => {
                await flushTurns()
                return [...states]
            },
            onTyping: async (handler) => {
                client.on("typingStart", (event, signal) => handler(event.timestamp, signal), { concurrency: 2 })
            },
            scheduleTask: async (run, scheduleOptions) => {
                client.schedule((signal) => run(signal), scheduleOptions)
            },
            restGet: (path, reqOptions) => {
                const controller = reqOptions?.controller ?? new AbortController()
                const result = client.rest.request({
                    method: "GET",
                    path,
                    ...(reqOptions?.timeoutMs === undefined ? {} : { timeoutMs: reqOptions.timeoutMs }),
                    signal: controller.signal,
                })
                const promise = Promise.resolve(result).then((outcome) =>
                    outcome.isOk() ? { ok: true, status: outcome.value.status } : { ok: false, error: outcome.error },
                )
                return {
                    promise,
                    cancel: async () => {
                        controller.abort()
                    },
                }
            },
            restPost: (path, reqOptions) => {
                const controller = reqOptions?.controller ?? new AbortController()
                const result = client.rest.request({
                    method: "POST",
                    path,
                    body: { ping: true },
                    ...(reqOptions?.timeoutMs === undefined ? {} : { timeoutMs: reqOptions.timeoutMs }),
                    signal: controller.signal,
                })
                const promise = Promise.resolve(result).then((outcome) =>
                    outcome.isOk() ? { ok: true, status: outcome.value.status } : { ok: false, error: outcome.error },
                )
                return {
                    promise,
                    cancel: async () => {
                        controller.abort()
                    },
                }
            },
            closeScope: async () => {
                observer.close()
            },
        }
    }

    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createNativeClient({ token: fixtureToken, ...options } as never).pipe(Scope.provide(scope)),
    )
    const states: ConnectionState[] = []
    const stateFiber = Effect.runFork(
        Stream.runForEach(client.observeState(), (state) =>
            Effect.sync(() => {
                states.push(state)
            }),
        ),
    )
    onTestFinished(async () => {
        await Effect.runPromise(client.shutdown())
        await Effect.runPromiseExit(Fiber.interrupt(stateFiber))
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })

    const runRequest = (method: "GET" | "POST", path: string, timeoutMs?: number) => {
        const fiber = Effect.runFork(
            client.rest.request({
                method,
                path,
                ...(method === "POST" ? { body: { ping: true } } : {}),
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }),
        )
        const promise = Effect.runPromiseExit(Fiber.await(fiber)).then((outer) => {
            if (Exit.isFailure(outer)) return { ok: false, error: typedFailure(outer.cause) }
            const inner = outer.value
            if (Exit.isSuccess(inner)) return { ok: true, status: inner.value.status }
            if (inner.cause.reasons.every((reason) => reason._tag === "Interrupt"))
                return { ok: false, error: { _tag: "Cancelled" } }
            return { ok: false, error: typedFailure(inner.cause) }
        })
        return {
            promise,
            cancel: async () => {
                await Effect.runPromiseExit(Fiber.interrupt(fiber))
            },
        }
    }

    return {
        mode,
        client,
        connect: async () => {
            await Effect.runPromise(client.connect())
        },
        shutdown: async (drainMs) => {
            await Effect.runPromise(client.shutdown(drainMs === undefined ? undefined : { drainMs }))
        },
        startShutdown: async (drainMs) => {
            const exit = await Effect.runPromiseExit(client.shutdown(drainMs === undefined ? undefined : { drainMs }))
            return Exit.isSuccess(exit) ? { ok: true } : { ok: false, error: typedFailure(exit.cause) }
        },
        observeStates: async () => {
            await flushTurns()
            return [...states]
        },
        onTyping: async (handler) => {
            await Effect.runPromise(
                client
                    .on(
                        "typingStart",
                        (event) =>
                            Effect.callback<void>((resume) => {
                                const controller = new AbortController()
                                let settled = false
                                void handler(event.timestamp, controller.signal).then(
                                    () => {
                                        if (!settled) {
                                            settled = true
                                            resume(Effect.void)
                                        }
                                    },
                                    (error) => {
                                        if (!settled) {
                                            settled = true
                                            resume(Effect.die(error))
                                        }
                                    },
                                )
                                return Effect.sync(() => {
                                    settled = true
                                    controller.abort()
                                })
                            }),
                        { concurrency: 2 },
                    )
                    .pipe(Scope.provide(scope)),
            )
        },
        scheduleTask: async (run, scheduleOptions) => {
            await Effect.runPromise(
                client
                    .schedule(
                        Effect.callback<void>((resume) => {
                            const controller = new AbortController()
                            let settled = false
                            void run(controller.signal).then(
                                () => {
                                    if (!settled) {
                                        settled = true
                                        resume(Effect.void)
                                    }
                                },
                                (error) => {
                                    if (!settled) {
                                        settled = true
                                        resume(Effect.die(error))
                                    }
                                },
                            )
                            return Effect.sync(() => {
                                settled = true
                                controller.abort()
                            })
                        }),
                        scheduleOptions,
                    )
                    .pipe(Scope.provide(scope)),
            )
        },
        restGet: (path, reqOptions) => runRequest("GET", path, reqOptions?.timeoutMs),
        restPost: (path, reqOptions) => runRequest("POST", path, reqOptions?.timeoutMs),
        closeScope: async () => {
            await Effect.runPromiseExit(Fiber.interrupt(stateFiber))
        },
    }
}

interface RecordedCommand {
    readonly op: number
    readonly d: Record<string, unknown> | null
    readonly shardId: number
    readonly socketIndex: number
}

/** Fully in-memory fault-injectable WebSocket implementing WebSocketLike */
class ChaosSocket extends EventEmitter implements WebSocketLike {
    readyState = 1
    closeCalls = 0
    shardId = 0
    sessionId: string | undefined
    ackHeartbeats = true
    readonly sent: { readonly op: number; readonly d: unknown }[] = []

    constructor(
        readonly index: number,
        private readonly onSend: (socket: ChaosSocket, frame: { readonly op: number; readonly d?: unknown }) => void,
    ) {
        super()
    }

    send(data: string, callback: (error?: Error) => void): void {
        if (this.readyState !== 1) {
            queueMicrotask(() => callback(new Error("ChaosSocket is not open")))
            return
        }
        const frame = JSON.parse(data) as { readonly op: number; readonly d?: unknown }
        this.sent.push({ op: frame.op, d: frame.d })
        queueMicrotask(() => callback())
        this.onSend(this, frame)
    }

    deliver(frame: unknown): void {
        if (this.readyState !== 1) return
        this.emit("message", Buffer.from(JSON.stringify(frame)), false)
    }

    injectError(message = "ECONNRESET"): void {
        if (this.readyState !== 1) return
        const error = Object.assign(new Error(message), { code: "ECONNRESET" })
        this.emit("error", error)
        this.close(1006)
    }

    close(code: number): void {
        if (this.readyState === 3) return
        this.closeCalls += 1
        this.readyState = 3
        queueMicrotask(() => this.emit("close", code, Buffer.alloc(0)))
    }

    terminate(): void {
        this.close(1006)
    }
}

/** In-memory gateway simulator supporting multi-shard Identify, Resume, fault injection and 4011 resharding */
class ChaosGateway {
    readonly sockets: ChaosSocket[] = []
    readonly commands: RecordedCommand[] = []
    readonly activeByShard = new Map<number, ChaosSocket>()
    readonly sessions = new Map<string, { shardId: number; sequence: number }>()
    heartbeatIntervalMs = 2_000
    /** Number of upcoming sockets to fail with a transient error during startup/handshake */
    transientSocketErrorsRemaining = 0
    #nextSessionNumber = 1

    readonly webSocket = (): WebSocketLike => {
        const socket = new ChaosSocket(this.sockets.length, (current, frame) => this.#handleFrame(current, frame))
        this.sockets.push(socket)
        queueMicrotask(() => {
            if (socket.readyState !== 1) return
            if (this.transientSocketErrorsRemaining > 0) {
                this.transientSocketErrorsRemaining -= 1
                socket.injectError("transient handshake reset")
                return
            }
            socket.deliver({ op: Opcode.hello, d: { heartbeat_interval: this.heartbeatIntervalMs } })
        })
        return socket
    }

    #handleFrame(socket: ChaosSocket, frame: { readonly op: number; readonly d?: unknown }) {
        if (frame.op === Opcode.heartbeat) {
            if (socket.ackHeartbeats) queueMicrotask(() => socket.deliver({ op: Opcode.heartbeatAck }))
            return
        }
        if (frame.op === Opcode.identify) {
            const data = (frame.d ?? {}) as { shard?: [number, number] }
            const shard = data.shard
            const shardId = shard ? shard[0] : 0
            socket.shardId = shardId
            this.activeByShard.set(shardId, socket)
            this.commands.push({ op: Opcode.identify, d: data, shardId, socketIndex: socket.index })
            const sessionId = `chaos-session-${this.#nextSessionNumber++}`
            socket.sessionId = sessionId
            const session = { shardId, sequence: 1 }
            this.sessions.set(sessionId, session)
            queueMicrotask(() => {
                socket.deliver({
                    op: Opcode.dispatch,
                    s: session.sequence,
                    t: "READY",
                    d: {
                        session_id: sessionId,
                        ...(shard ? { shard } : {}),
                        user: fixtures.botUser(),
                        guilds: [],
                    },
                })
            })
            return
        }
        if (frame.op === Opcode.resume) {
            const data = (frame.d ?? {}) as { session_id?: string; seq?: number }
            const stored = typeof data.session_id === "string" ? this.sessions.get(data.session_id) : undefined
            const shardId = stored?.shardId ?? 0
            socket.shardId = shardId
            socket.sessionId = typeof data.session_id === "string" ? data.session_id : undefined
            this.activeByShard.set(shardId, socket)
            this.commands.push({ op: Opcode.resume, d: data, shardId, socketIndex: socket.index })
            if (!stored) {
                queueMicrotask(() => socket.deliver({ op: Opcode.invalidSession, d: false }))
                return
            }
            stored.sequence += 1
            queueMicrotask(() => {
                socket.deliver({ op: Opcode.dispatch, s: stored.sequence, t: "RESUMED", d: {} })
            })
        }
    }

    dispatchTyping(shardId: number, timestamp: number): boolean {
        const socket = this.activeByShard.get(shardId)
        if (!socket || socket.readyState !== 1 || socket.sessionId === undefined) return false
        const entry = this.sessions.get(socket.sessionId)
        if (!entry) return false
        entry.sequence += 1
        socket.deliver({
            op: Opcode.dispatch,
            s: entry.sequence,
            t: "TYPING_START",
            d: { channel_id: "20", user_id: "30", timestamp },
        })
        return true
    }
}

describeBothApis("chaos simulation", (mode) => {
    test("Scenario 1: gateway fault storm preserves monotonic transitions, resume/reset invariants and clean shutdown", async () => {
        const { rejections } = guardUnhandledRejections()

        for (let trial = 0; trial < iterations; trial++) {
            const seed = streamSeed(`gateway-storm:${mode}:${trial}`)
            const rng = prng(seed)
            const clock = sdkClock()
            const gateway = new ChaosGateway()
            // Inject 1 transient error during startup on alternating trials to test startup retry recovery
            gateway.transientSocketErrorsRemaining = trial % 2 === 0 ? 1 : 0
            let guildListCount = 1

            const api = await openChaosClient(mode, {
                logging: { level: "silent" },
                connection: {
                    maxStartupAttempts: 5,
                    recovery: { minDelayMs: 100, maxDelayMs: 500, healthyResetMs: 5_000 },
                },
                transport: {
                    fetch: async (url) => {
                        if (url === discoveryUrl) return Response.json(hostedDiscoveryDocument)
                        if (url.includes("/users/@me/guilds")) {
                            const guilds = Array.from({ length: guildListCount }, (_, index) =>
                                fixtures.guild({ id: String(1_000 + index) }),
                            )
                            return Response.json(guilds)
                        }
                        return Response.json({})
                    },
                    webSocket: gateway.webSocket,
                },
            })

            const receivedTimestamps: number[] = []
            await api.onTyping(async (timestamp) => {
                receivedTimestamps.push(timestamp)
            })

            const tag = `mode=${mode} seed=${seed} trial=${trial}`
            await drivePromise(clock, api.connect(), `${tag}: initial connect`)
            expect(api.client.state, `${tag}: connected after startup`).toBe("Connected")
            expect(api.client.shards.length, `${tag}: initial shard count`).toBe(1)

            let expectedShards = 1
            let reshardCount = 0
            let nextTimestamp = 1

            // Run a deterministic seeded storm of 10 gateway faults covering every required failure class
            const forcedOrder = [
                "close4000",
                "op7",
                "op9False",
                "heartbeatTimeout",
                "socketError",
                "reshard4011",
            ] as const
            const faultSteps = 10
            for (let step = 0; step < faultSteps; step++) {
                const fault =
                    step < forcedOrder.length
                        ? forcedOrder[step]!
                        : rng.pick([
                              "close4000",
                              "op7",
                              "op9False",
                              "heartbeatTimeout",
                              "socketError",
                              ...(reshardCount < 2 ? (["reshard4011"] as const) : []),
                          ])
                const stepTag = `${tag} step=${step} fault=${fault}`
                const targetShard = rng.below(expectedShards)
                const socket = gateway.activeByShard.get(targetShard)
                expect(socket, `${stepTag}: active socket exists`).toBeDefined()
                const priorEpochs = new Map(api.client.shards.map((shard) => [shard.shardId, shard.sessionEpoch]))
                const commandsBefore = gateway.commands.length

                // Optionally inject a transient socket error on the very first reconnect attempt
                if (rng.chance(0.25) && fault !== "reshard4011") gateway.transientSocketErrorsRemaining = 1

                if (fault === "close4000") {
                    socket!.close(4000)
                } else if (fault === "op7") {
                    socket!.deliver({ op: Opcode.reconnect })
                } else if (fault === "op9False") {
                    socket!.deliver({ op: Opcode.invalidSession, d: false })
                } else if (fault === "heartbeatTimeout") {
                    socket!.ackHeartbeats = false
                } else if (fault === "socketError") {
                    socket!.injectError("steady-state socket drop")
                } else if (fault === "reshard4011") {
                    reshardCount += 1
                    expectedShards += 1
                    guildListCount = expectedShards
                    socket!.close(4011)
                }

                // Wait until the client observes the outage (Recovering) and recovers back to Connected
                await driveUntil(clock, () => api.client.state === "Recovering", `${stepTag}: enter Recovering`)
                await driveUntil(clock, () => api.client.state === "Connected", `${stepTag}: recover to Connected`)

                const newCommands = gateway.commands.slice(commandsBefore)
                if (fault === "reshard4011") {
                    expect(api.client.shards.length, `${stepTag}: reshard increased shard count`).toBe(expectedShards)
                    const identifies = newCommands.filter((command) => command.op === Opcode.identify)
                    expect(identifies.length, `${stepTag}: every shard identified after 4011`).toBeGreaterThanOrEqual(
                        expectedShards,
                    )
                    const maxPreviousEpoch = Math.max(...priorEpochs.values())
                    for (const shard of api.client.shards) {
                        expect(shard.sessionEpoch, `${stepTag}: new epoch after reshard`).toBeGreaterThan(
                            maxPreviousEpoch,
                        )
                    }
                } else if (fault === "op9False") {
                    const shardCommands = newCommands.filter((command) => command.shardId === targetShard)
                    expect(
                        shardCommands.some((command) => command.op === Opcode.identify),
                        `${stepTag}: op 9 d:false reset session to Identify`,
                    ).toBe(true)
                    expect(
                        shardCommands.some((command) => command.op === Opcode.resume),
                        `${stepTag}: op 9 d:false must not Resume`,
                    ).toBe(false)
                    const afterEpoch = api.client.shards.find((shard) => shard.shardId === targetShard)!.sessionEpoch
                    expect(afterEpoch, `${stepTag}: sessionEpoch increased after op 9`).toBeGreaterThan(
                        priorEpochs.get(targetShard)!,
                    )
                } else {
                    const shardCommands = newCommands.filter((command) => command.shardId === targetShard)
                    expect(
                        shardCommands.some((command) => command.op === Opcode.resume),
                        `${stepTag}: resumable fault must attempt Resume`,
                    ).toBe(true)
                    const afterEpoch = api.client.shards.find((shard) => shard.shardId === targetShard)!.sessionEpoch
                    expect(afterEpoch, `${stepTag}: sessionEpoch unchanged across Resume`).toBe(
                        priorEpochs.get(targetShard)!,
                    )
                }

                // Verify live dispatch delivery still works cleanly after recovery
                const sentTs = nextTimestamp++
                expect(gateway.dispatchTyping(targetShard, sentTs), `${stepTag}: dispatch on active shard`).toBe(true)
                await driveUntil(clock, () => receivedTimestamps.includes(sentTs), `${stepTag}: deliver post-recovery`)
            }

            await drivePromise(clock, api.shutdown(), `${tag}: clean shutdown`)
            expect(api.client.state, `${tag}: final Closed state`).toBe("Closed")
            const states = await api.observeStates()
            assertMonotonicTransitions(states, tag)
            expect(states.at(-1), `${tag}: state stream ended at Closed`).toBe("Closed")
            vi.restoreAllMocks()
        }

        expect(rejections).toEqual([])
    })

    test("Scenario 2: REST 429 and failure storm honors retry-after holds, avoids stuck admissions and settles cleanly on mid-storm shutdown", async () => {
        const { rejections } = guardUnhandledRejections()

        for (let trial = 0; trial < iterations; trial++) {
            const seed = streamSeed(`rest-storm:${mode}:${trial}`)
            const rng = prng(seed)
            const clock = sdkClock()
            const tag = `mode=${mode} seed=${seed} trial=${trial}`

            const concurrency = 2
            const routeKeyFor = (method: string, path: string) =>
                `${method}:${path.includes("/channels/10") ? "ch-10" : "ch-20"}`
            const bucketForPath = (path: string) => (path.includes("/channels/10") ? "bucket-ch-10" : "bucket-ch-20")
            const retryAfterViolations: string[] = []
            // Track both the tick a pause was emitted and its expiry: requests already admitted at that same tick
            // before the 429 response finishes its microtask observation may enter fetch on that tick, while any
            // request admitted at a later tick for a known bucket or global/proxy pause must wait until retry-after
            let globalPause = { setAt: -1, until: 0, sameTickCount: 0 }
            let proxyPause = { setAt: -1, until: 0, sameTickCount: 0 }
            const bucketPauses = new Map<string, { setAt: number; until: number; sameTickCount: number }>()
            // A route cannot know its server bucket until it has received at least one response carrying that bucket
            const learnedRouteBuckets = new Map<string, string>()
            let holdFetches = false
            const heldFetchResolvers: (() => void)[] = []
            const counters = { global429: 0, bucket429: 0, proxy429: 0, server5xx: 0, ok: 0 }

            const checkPause = (
                label: string,
                pause: { setAt: number; until: number; sameTickCount: number },
                now: number,
            ) => {
                if (now >= pause.until) return
                if (now === pause.setAt) {
                    pause.sameTickCount += 1
                    if (pause.sameTickCount > concurrency)
                        retryAfterViolations.push(
                            `${label} admitted extra request #${pause.sameTickCount} at tick ${now} < ${pause.until}`,
                        )
                    return
                }
                retryAfterViolations.push(`${label} violated at ${now} < ${pause.until}`)
            }

            const api = await openChaosClient(mode, {
                logging: { level: "silent" },
                rest: { concurrency, defaultTimeoutMs: 120_000 },
                transport: {
                    fetch: async (url, init) => {
                        if (url === discoveryUrl) return Response.json(hostedDiscoveryDocument)
                        const now = clock.now()
                        const method = (init.method ?? "GET").toUpperCase()
                        const path = new URL(url).pathname
                        const routeKey = routeKeyFor(method, path)
                        const bucket = bucketForPath(path)

                        // Verify retry-after compliance across global, proxy and learned per-bucket limiters
                        checkPause("global429", globalPause, now)
                        checkPause("proxy429", proxyPause, now)
                        const learnedBucket = learnedRouteBuckets.get(routeKey)
                        const activeBucketPause = learnedBucket ? bucketPauses.get(learnedBucket) : undefined
                        if (activeBucketPause) checkPause(`bucket(${learnedBucket})`, activeBucketPause, now)

                        if (holdFetches) {
                            return await new Promise<Response>((resolve, reject) => {
                                const onAbort = () =>
                                    reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))
                                if (init.signal?.aborted) {
                                    onAbort()
                                    return
                                }
                                init.signal?.addEventListener("abort", onAbort, { once: true })
                                heldFetchResolvers.push(() => {
                                    init.signal?.removeEventListener("abort", onAbort)
                                    resolve(Response.json({ ok: true }))
                                })
                            })
                        }

                        const roll = rng.below(100)
                        if (counters.global429 === 0 || roll < 14) {
                            counters.global429 += 1
                            const waitSeconds = 1
                            const until = now + waitSeconds * 1_000
                            if (until > globalPause.until) globalPause = { setAt: now, until, sameTickCount: 1 }
                            return new Response(
                                JSON.stringify({
                                    message: "Global rate limit",
                                    retry_after: waitSeconds,
                                    global: true,
                                }),
                                {
                                    status: 429,
                                    headers: {
                                        "content-type": "application/json",
                                        "x-ratelimit-global": "true",
                                        "retry-after": String(waitSeconds),
                                    },
                                },
                            )
                        }
                        if (counters.bucket429 === 0 || roll < 32) {
                            counters.bucket429 += 1
                            const waitSeconds = 1
                            const until = now + waitSeconds * 1_000
                            learnedRouteBuckets.set(routeKey, bucket)
                            const existing = bucketPauses.get(bucket)
                            if (!existing || until > existing.until)
                                bucketPauses.set(bucket, { setAt: now, until, sameTickCount: 1 })
                            return new Response(
                                JSON.stringify({
                                    message: "Bucket rate limit",
                                    retry_after: waitSeconds,
                                    global: false,
                                }),
                                {
                                    status: 429,
                                    headers: {
                                        "content-type": "application/json",
                                        "x-ratelimit-bucket": bucket,
                                        "x-ratelimit-limit": "5",
                                        "x-ratelimit-remaining": "0",
                                        "x-ratelimit-reset-after": String(waitSeconds),
                                        "retry-after": String(waitSeconds),
                                    },
                                },
                            )
                        }
                        if (counters.proxy429 === 0 || roll < 44) {
                            counters.proxy429 += 1
                            const waitSeconds = 1
                            const until = now + waitSeconds * 1_000
                            if (until > proxyPause.until) proxyPause = { setAt: now, until, sameTickCount: 1 }
                            // Plain text proxy 429 with no Fluxer rate-limit headers
                            return new Response("Too Many Requests", {
                                status: 429,
                                headers: {
                                    "content-type": "text/plain",
                                    "retry-after": String(waitSeconds),
                                },
                            })
                        }
                        if (counters.server5xx === 0 || roll < 58) {
                            counters.server5xx += 1
                            const status = rng.chance(0.5) ? 502 : 503
                            return new Response("Bad Gateway", { status })
                        }
                        counters.ok += 1
                        return Response.json({ ok: true, method, path })
                    },
                    webSocket: new ChaosGateway().webSocket,
                },
            })

            // Wave 1: Concurrent GETs and POSTs with mixed 429s, 502/503s and mid-flight abort cancellations
            const routes = [
                "/channels/10/messages/1",
                "/channels/10/messages/2",
                "/channels/20/messages/3",
                "/channels/20/messages/4",
            ]
            const wave1 = Array.from({ length: 14 }, (_, index) => {
                const path = routes[index % routes.length]!
                const isPost = index % 4 === 3
                return {
                    isPost,
                    cancelMidFlight: index % 5 === 2,
                    handle: isPost ? api.restPost(path) : api.restGet(path),
                }
            })

            await flushTurns()
            for (const entry of wave1) {
                if (entry.cancelMidFlight) await entry.handle.cancel()
            }

            const wave1Results = await drivePromise(
                clock,
                Promise.all(wave1.map((entry) => entry.handle.promise)),
                `${tag}: wave 1 settlement`,
            )
            expect(wave1Results, `${tag}: every wave 1 request settled`).toHaveLength(wave1.length)
            expect(retryAfterViolations, `${tag}: retry-after compliance`).toEqual([])
            expect(counters.global429, `${tag}: hit global 429`).toBeGreaterThan(0)
            expect(counters.bucket429, `${tag}: hit bucket 429`).toBeGreaterThan(0)
            expect(counters.proxy429, `${tag}: hit proxy 429`).toBeGreaterThan(0)
            expect(counters.server5xx, `${tag}: hit 502/503`).toBeGreaterThan(0)
            expect(api.client.diagnostics().rest.activeRequests, `${tag}: zero stuck active requests`).toBe(0)
            expect(api.client.diagnostics().rest.queuedRequests, `${tag}: zero stuck queued requests`).toBe(0)

            // Wave 2: Flood requests while transport holds them, then trigger shutdown() mid-storm
            holdFetches = true
            const wave2 = Array.from({ length: 10 }, (_, index) =>
                index % 2 === 0
                    ? api.restGet(routes[index % routes.length]!)
                    : api.restPost(routes[index % routes.length]!),
            )
            await flushTurns()
            expect(
                api.client.diagnostics().rest.activeRequests + api.client.diagnostics().rest.queuedRequests,
                `${tag}: wave 2 requests in flight or queued before shutdown`,
            ).toBeGreaterThan(0)

            const shutdownPromise = api.shutdown()
            const wave2Results = await drivePromise(
                clock,
                Promise.all(wave2.map((entry) => entry.promise)),
                `${tag}: wave 2 settlement on shutdown`,
            )
            await drivePromise(clock, shutdownPromise, `${tag}: shutdown completes`)

            const closedCount = wave2Results.filter(
                (entry) => !entry.ok && entry.error instanceof ClientClosedError,
            ).length
            expect(closedCount, `${tag}: cut-off requests settled with ClientClosedError`).toBe(wave2.length)
            expect(api.client.state, `${tag}: Closed after mid-storm shutdown`).toBe("Closed")
            expect(api.client.diagnostics().rest.activeRequests, `${tag}: zero active requests after shutdown`).toBe(0)
            expect(api.client.diagnostics().rest.queuedRequests, `${tag}: zero queued requests after shutdown`).toBe(0)
            vi.restoreAllMocks()
        }

        expect(rejections).toEqual([])
    })

    test("Scenario 3: simultaneous draining shutdown races with handlers, REST, scheduled tasks and gateway disconnects", async () => {
        const { rejections } = guardUnhandledRejections()

        for (let trial = 0; trial < iterations; trial++) {
            const seed = streamSeed(`drain-race:${mode}:${trial}`)
            const rng = prng(seed)
            const clock = sdkClock()
            const gateway = new ChaosGateway()
            const logs = captureLogs()
            const tag = `mode=${mode} seed=${seed} trial=${trial}`

            const hangRest = trial % 2 === 1
            const hangHandler = trial % 2 === 1
            const drainMs = 200 + rng.below(300)

            const heldRestGates: (() => void)[] = []
            const api = await openChaosClient(mode, {
                logging: logs.logging,
                connection: { recovery: { minDelayMs: 100, maxDelayMs: 400 } },
                transport: {
                    fetch: async (url, init) => {
                        if (url === discoveryUrl) return Response.json(hostedDiscoveryDocument)
                        return await new Promise<Response>((resolve, reject) => {
                            const onAbort = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))
                            if (init.signal?.aborted) {
                                onAbort()
                                return
                            }
                            init.signal?.addEventListener("abort", onAbort, { once: true })
                            const finish = () => {
                                init.signal?.removeEventListener("abort", onAbort)
                                resolve(Response.json({ ok: true }))
                            }
                            if (!hangRest) heldRestGates.push(finish)
                        })
                    },
                    webSocket: gateway.webSocket,
                },
            })

            let handlersStarted = 0
            let handlersFinished = 0
            let handlersAborted = 0
            const handlerGates: (() => void)[] = []
            await api.onTyping(async (_timestamp, signal) => {
                handlersStarted += 1
                await new Promise<void>((resolve) => {
                    const onAbort = () => {
                        handlersAborted += 1
                        resolve()
                    }
                    if (signal?.aborted) {
                        onAbort()
                        return
                    }
                    signal?.addEventListener("abort", onAbort, { once: true })
                    if (!hangHandler) {
                        handlerGates.push(() => {
                            signal?.removeEventListener("abort", onAbort)
                            handlersFinished += 1
                            resolve()
                        })
                    }
                })
            })

            let taskRunsStarted = 0
            let taskRunsAfterDrain = 0
            let drainStarted = false
            const taskGates: (() => void)[] = []
            await api.scheduleTask(
                async (signal) => {
                    taskRunsStarted += 1
                    if (drainStarted) taskRunsAfterDrain += 1
                    await new Promise<void>((resolve) => {
                        const onAbort = () => resolve()
                        if (signal?.aborted) {
                            onAbort()
                            return
                        }
                        signal?.addEventListener("abort", onAbort, { once: true })
                        if (!hangHandler) {
                            taskGates.push(() => {
                                signal?.removeEventListener("abort", onAbort)
                                resolve()
                            })
                        }
                    })
                },
                { delayMs: 10, intervalMs: 50 },
            )

            await drivePromise(clock, api.connect(), `${tag}: connect`)

            // Kick off scheduled task, in-flight handlers and REST requests concurrently
            await clock.advance(15)
            gateway.dispatchTyping(0, 1)
            gateway.dispatchTyping(0, 2)
            const restInFlight = [api.restGet("/channels/10/messages/1"), api.restGet("/channels/10/messages/2")]
            await driveUntil(
                clock,
                () => handlersStarted >= 2 && taskRunsStarted >= 1 && api.client.diagnostics().rest.activeRequests > 0,
                `${tag}: work in flight`,
            )

            // Race three simultaneous shutdown calls with a gateway disconnect
            drainStarted = true
            const shutdownStartClock = clock.now()
            const callers = [api.startShutdown(drainMs), api.startShutdown(drainMs), api.startShutdown(0)]

            // Inject a racing gateway fault during drain (resumable 4000, op 7, or fatal 4004 auth close)
            const raceFault = rng.pick(["close4000", "op7", "fatal4004"] as const)
            const activeSocket = gateway.activeByShard.get(0)
            if (activeSocket) {
                if (raceFault === "close4000") activeSocket.close(4000)
                else if (raceFault === "op7") activeSocket.deliver({ op: Opcode.reconnect })
                else activeSocket.close(4004)
            }

            // When this trial models cooperative completion, release gates well before drainMs expires
            if (!hangHandler && !hangRest) {
                await clock.advance(20)
                for (const release of handlerGates.splice(0)) release()
                for (const release of taskGates.splice(0)) release()
                for (const release of heldRestGates.splice(0)) release()
            }

            const shutdownOutcomes = await drivePromise(clock, Promise.all(callers), `${tag}: simultaneous shutdowns`, {
                limitMs: drainMs + 15_000,
            })
            const restOutcomes = await drivePromise(
                clock,
                Promise.all(restInFlight.map((entry) => entry.promise)),
                `${tag}: in-flight REST settlement`,
            )

            const shutdownElapsedMs = clock.now() - shutdownStartClock
            // Bounded virtual-time completion: never exceeds drain + graceful socket close + small margin
            expect(shutdownElapsedMs, `${tag}: bounded shutdown completion`).toBeLessThanOrEqual(drainMs + 10_000)
            for (const outcome of shutdownOutcomes) expect(outcome.ok, `${tag}: shutdown succeeded`).toBe(true)
            expect(restOutcomes, `${tag}: all REST calls settled`).toHaveLength(restInFlight.length)
            expect(taskRunsAfterDrain, `${tag}: no new scheduled task started during drain`).toBe(0)

            // Verify clean Closed state, no double-close and zero leftover work
            expect(api.client.state, `${tag}: Closed final state`).toBe("Closed")
            expect(api.client.diagnostics().events.activeHandlers, `${tag}: zero active handlers`).toBe(0)
            expect(api.client.diagnostics().rest.activeRequests, `${tag}: zero active REST`).toBe(0)
            expect(api.client.diagnostics().rest.queuedRequests, `${tag}: zero queued REST`).toBe(0)
            for (const socket of gateway.sockets) {
                expect(socket.closeCalls, `${tag}: socket ${socket.index} closed at most once`).toBeLessThanOrEqual(1)
            }

            const shutdownCompleteLogs = logs.withCode("lifecycle.shutdownComplete")
            expect(shutdownCompleteLogs.length, `${tag}: shutdownComplete logged once`).toBeLessThanOrEqual(1)

            // Calling shutdown again after Closed stays a clean no-op
            expect((await api.startShutdown(0)).ok, `${tag}: idempotent post-close shutdown`).toBe(true)
            if (hangHandler)
                expect(handlersAborted + handlersFinished, `${tag}: hung handlers ended`).toBeGreaterThan(0)

            const states = await api.observeStates()
            assertMonotonicTransitions(states, tag)
            expect(states.at(-1), `${tag}: final observed state Closed`).toBe("Closed")
            vi.restoreAllMocks()
        }

        expect(rejections).toEqual([])
    })
})
