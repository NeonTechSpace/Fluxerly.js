import { EventEmitter } from "node:events"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { expect, test } from "vitest"
import { createClient, type LogRecord, type WebSocketLike } from "../../src/effect.js"
import { createTestClient } from "../../src/effect-testing.js"
import { createFixtures } from "../../src/testing.js"
import { fixtureToken } from "../support/both-apis.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { hostTurnsUntil } from "../support/client-clock.js"

const cleanup = new Error("cleanup-sentinel")

/**
 * Connect, start one callback that never finishes and whose cancellation finalizer dies, then shut down the client.
 * The callback is either an event handler or a message collector's onMessage
 */
async function scenario(kind: "handler" | "collector") {
    let observed: { shutdownDied: boolean; resultDied: boolean; failedRecords: number; counted: number } | undefined
    // Closing the test scope shuts the client down again and repeats the shared shutdown outcome, so it is not asserted
    await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const test = yield* createTestClient()
                yield* test.ready()
                const started = yield* Deferred.make<void>()
                const callback = () =>
                    Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Effect.never),
                        Effect.onInterrupt(() => Effect.die(cleanup)),
                    )
                const message = test.fixtures.message()
                const collector =
                    kind === "collector"
                        ? yield* test.client.messages.collect(message.channel_id, {
                              maxMessages: 2,
                              onMessage: callback,
                          })
                        : undefined
                if (kind === "handler") yield* test.client.on("messageCreate", callback)
                yield* test.emit("MESSAGE_CREATE", message)
                yield* Deferred.await(started)
                const exit = yield* Effect.exit(test.client.shutdown())
                const result = collector ? yield* Effect.exit(collector.result()) : undefined
                observed = {
                    shutdownDied: Exit.isFailure(exit) && Cause.hasDies(exit.cause),
                    resultDied: result !== undefined && Exit.isFailure(result) && Cause.hasDies(result.cause),
                    failedRecords: test.logs().filter((record) => record.code === "lifecycle.cleanupFailed").length,
                    counted: test.counters().cleanupFailures,
                }
            }),
        ),
    )
    if (!observed) throw new Error("The scenario did not finish")
    return observed
}

test("a collector callback's cancellation defect fails shutdown like a handler's", async () => {
    const collector = await scenario("collector")
    // The collector itself keeps the defect
    expect(collector.resultDied).toBe(true)
    // client.shutdown documents that cleanup faults remain defects in its Cause
    expect(collector.shutdownDied).toBe(true)
})

test("explicit shutdown of a connected client logs and counts the failed cleanup step", async () => {
    const handler = await scenario("handler")
    expect(handler.shutdownDied).toBe(true)
    // client.shutdown documents: Each failed cleanup step is also logged at Error in the lifecycle category and counted
    expect(handler.failedRecords).toBe(1)
    expect(handler.counted).toBe(1)
})

test("a shutdown during the cleanup a connection end started logs and counts the failed step once", async () => {
    let observed: { shutdownDied: boolean; failedRecords: number; counted: number } | undefined
    // Closing the test scope shuts the client down again and repeats the shared shutdown outcome, so it is not asserted
    await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const test = yield* createTestClient()
                yield* test.ready()
                const started = yield* Deferred.make<void>()
                const cleaning = yield* Deferred.make<void>()
                const release = yield* Deferred.make<void>()
                yield* test.client.on("messageCreate", () =>
                    Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Effect.never),
                        Effect.onInterrupt(() =>
                            Deferred.succeed(cleaning, undefined).pipe(
                                Effect.andThen(Deferred.await(release)),
                                Effect.andThen(Effect.die(cleanup)),
                            ),
                        ),
                    ),
                )
                yield* test.emit("MESSAGE_CREATE", test.fixtures.message())
                yield* Deferred.await(started)
                // A fatal close code ends the connection, so the client starts its own cleanup and cancels the handler
                yield* test.disconnect({ code: 4004 })
                yield* Deferred.await(cleaning)
                const shutdown = yield* Effect.forkChild(Effect.exit(test.client.shutdown()))
                // Both shutdowns have logged their start while the handler's cancellation is still held
                const starts = () => test.logs().filter((record) => record.code === "lifecycle.shutdown").length
                yield* Effect.promise(() => hostTurnsUntil(() => starts() === 2))
                yield* Deferred.succeed(release, undefined)
                const exit = yield* Fiber.join(shutdown)
                observed = {
                    shutdownDied: Exit.isFailure(exit) && Cause.hasDies(exit.cause),
                    failedRecords: test.logs().filter((record) => record.code === "lifecycle.cleanupFailed").length,
                    counted: test.counters().cleanupFailures,
                }
            }),
        ),
    )
    if (!observed) throw new Error("The scenario did not finish")
    expect(observed.shutdownDied).toBe(true)
    expect(observed.failedRecords).toBe(1)
    expect(observed.counted).toBe(1)
})

const closeFailure = new Error("socket-close-sentinel")

/** A scripted socket that answers Identify with READY and whose graceful close throws, so only terminate closes it */
class ThrowingCloseSocket extends EventEmitter implements WebSocketLike {
    readyState = 1
    constructor() {
        super()
        queueMicrotask(() => this.deliver({ op: 10, d: { heartbeat_interval: 60_000 } }))
    }
    send(data: string, callback: (error?: Error) => void) {
        const { op } = JSON.parse(data) as { op: number }
        queueMicrotask(() => callback())
        if (op === 1) queueMicrotask(() => this.deliver({ op: 11 }))
        if (op === 2) queueMicrotask(() => this.deliver({ op: 0, s: 1, t: "READY", d: readyData }))
    }
    deliver(frame: unknown) {
        if (this.readyState === 1) this.emit("message", Buffer.from(JSON.stringify(frame)), false)
    }
    close(): never {
        throw closeFailure
    }
    terminate() {
        if (this.readyState === 3) return
        this.readyState = 3
        queueMicrotask(() => this.emit("close", 1006))
    }
}

const readyData = { session_id: "session", shard: [0, 1], user: createFixtures().user(), guilds: [] }

test("explicit shutdown logs and counts a socket close that throws", async () => {
    const records: LogRecord[] = []
    let observed: { shutdownDied: boolean; failedRecords: LogRecord[]; counted: number } | undefined
    // Closing the scope shuts the client down again and repeats the shared shutdown outcome, so it is not asserted
    await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createClient({
                    token: fixtureToken,
                    logging: { level: "error", sink: (record) => void records.push(record) },
                    sharding: { totalShards: 1 },
                    transport: {
                        fetch: async () => Response.json(hostedDiscoveryDocument),
                        webSocket: () => new ThrowingCloseSocket(),
                    },
                })
                yield* client.connect()
                const exit = yield* Effect.exit(client.shutdown())
                observed = {
                    shutdownDied: Exit.isFailure(exit) && Cause.hasDies(exit.cause),
                    failedRecords: records.filter((record) => record.code === "lifecycle.cleanupFailed"),
                    counted: client.diagnostics().counters.cleanupFailures,
                }
            }),
        ),
    )
    if (!observed) throw new Error("The scenario did not finish")
    expect(observed.shutdownDied).toBe(true)
    expect(observed.failedRecords).toHaveLength(1)
    expect(observed.failedRecords[0]?.error).toMatchObject({ message: closeFailure.message })
    expect(observed.counted).toBe(1)
})
