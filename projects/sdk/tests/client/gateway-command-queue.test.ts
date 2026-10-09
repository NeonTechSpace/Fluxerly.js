import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import type { Client } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { Opcode } from "../../src/internal/protocol/gateway.js"
import { describeBothApis, setup, type FixtureClientOptions } from "../support/both-apis.js"
import { outcome, sdkClock } from "../support/client-clock.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { expectErr, settle, typedResult } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

type AnyClient = Client | NativeClient

async function connected(mode: "default" | "native", options?: FixtureClientOptions) {
    const clock = sdkClock()
    const server = await startGatewayServer({ heartbeatIntervalMs: 600_000 })
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const client = await setup(mode, options)
    await settle((client as Client).connect())
    return { clock, server, client }
}

async function saturate(client: AnyClient, server: Awaited<ReturnType<typeof startGatewayServer>>, count = 500) {
    for (let index = 0; index < count; index++) await settle((client as Client).gateway.send(0, 20, index))
    await vi.waitFor(() => expect(server.commandsWithOp(20)).toHaveLength(count), { interval: 5 })
}

async function drained(client: AnyClient, server: Awaited<ReturnType<typeof startGatewayServer>>) {
    await settle((client as Client).gateway.send(0, 20, "drained"))
    await vi.waitFor(() => expect(server.commandsWithOp(20).at(-1)?.d).toBe("drained"), { interval: 5 })
}

function launch<A, E>(operation: Parameters<typeof outcome<A, E>>[0], abort: AbortController) {
    if (Effect.isEffect(operation)) {
        const fiber = Effect.runFork(typedResult(operation))
        return {
            result: Effect.runPromiseExit(Fiber.join(fiber)).then((exit) => {
                if (Exit.isFailure(exit)) {
                    if (Cause.hasInterruptsOnly(exit.cause)) return { interrupted: true }
                    throw Cause.squash(exit.cause)
                }
                const result = exit.value
                return result._tag === "Failure" ? { error: result.failure } : { value: result.success }
            }),
            cancel: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
        }
    }
    return { result: outcome(operation), cancel: async () => abort.abort() }
}

describeBothApis("public gateway command queue", (mode) => {
    test("reports busy at capacity and releases a cancelled command's capacity immediately", async () => {
        const { clock, server, client } = await connected(mode)
        await saturate(client, server)
        const waiting = Array.from({ length: 500 }, (_, index) => {
            const abort = new AbortController()
            return launch((client as Client).gateway.send(0, 20, { waiting: index }, { signal: abort.signal }), abort)
        })
        await clock.waiting(60_000)
        await clock.advance(0)
        expect(await expectErr((client as Client).gateway.send(0, 20, "overflow"))).toMatchObject({
            _tag: "GatewaySendError",
            reason: "busy",
            code: "gateway.send.busy",
            shardId: 0,
            opcode: 20,
        })
        await waiting[0]!.cancel()
        expect(await waiting[0]!.result).toMatchObject(
            mode === "default" ? { error: { _tag: "CancelledError" } } : { interrupted: true },
        )
        let replacementSettled = false
        const replacement = outcome((client as Client).gateway.send(0, 20, "replacement")).then((result) => {
            replacementSettled = true
            return result
        })
        await clock.advance(0)
        expect(replacementSettled).toBe(false)
        await clock.advance(60_000)
        expect(await replacement).toEqual({ value: undefined })
        await Promise.all(waiting.slice(1).map((item) => item.result))
        await vi.waitFor(() => expect(server.commandsWithOp(20)).toHaveLength(1_000), { interval: 5 })
        expect(server.commandsWithOp(20).some((frame) => frame.d?.waiting === 0)).toBe(false)
    })

    test("fails queued work as notReady on disconnect and never replays it on the resumed connection", async () => {
        const { clock, server, client } = await connected(mode)
        await saturate(client, server)
        const queued = outcome((client as Client).gateway.send(0, 20, "not replayed"))
        await clock.waiting(60_000)
        server.closeCurrent(4000)
        expect(await queued).toMatchObject({
            error: { _tag: "GatewaySendError", reason: "notReady", code: "gateway.send.notReady" },
        })
        await clock.waiting(500)
        await clock.advance(500)
        await vi.waitFor(() => expect(client.state).toBe("Connected"), { interval: 5 })
        expect(server.commandsWithOp(Opcode.resume)).toHaveLength(1)
        await clock.advance(60_000)
        await drained(client, server)
        expect(server.commandsWithOp(20).some((frame) => frame.d === "not replayed")).toBe(false)
    })

    test("retains the remaining send budget across Resume and resets it for a fresh Identify", async () => {
        const { clock, server, client } = await connected(mode)
        await saturate(client, server, 499)
        server.closeCurrent(4000)
        await clock.waiting(500)
        await clock.advance(500)
        await vi.waitFor(() => expect(client.state).toBe("Connected"), { interval: 5 })
        await settle((client as Client).gateway.send(0, 20, "last slot"))
        let completed = false
        const queued = outcome((client as Client).gateway.send(0, 20, "next window")).then((result) => {
            completed = true
            return result
        })
        await clock.advance(0)
        expect(completed).toBe(false)
        await clock.waiting(59_500)
        await clock.advance(59_499)
        expect(completed).toBe(false)
        await clock.advance(1)
        expect(await queued).toEqual({ value: undefined })
        // A rejected resumable session must start a new Identify budget, not inherit the old session's history
        server.send({ op: Opcode.invalidSession, d: false })
        await clock.waiting(1_000)
        await clock.advance(1_000)
        await vi.waitFor(() => expect(client.state).toBe("Connected"), { interval: 5 })
        await saturate(client, {
            ...server,
            commandsWithOp: (op) => server.commandsWithOp(op).filter((frame) => frame.connection === 2),
        })
        expect(server.commandsWithOp(Opcode.identify)).toHaveLength(2)
    })

    for (const operation of ["guilds", "channels"] as const) {
        for (const ending of ["cancellation", "deadline"] as const) {
            test(`withdraws unsent ${operation} count commands after ${ending}`, async () => {
                const { clock, server, client } = await connected(mode)
                await saturate(client, server)
                const abort = new AbortController()
                const options = { timeoutMs: 1_000, signal: abort.signal }
                const request = launch<unknown, unknown>(
                    operation === "guilds"
                        ? (client as Client).guilds.fetchCounts(["40"], options)
                        : (client as Client).channels.fetchMemberCounts("40", ["50"], options),
                    abort,
                )
                await clock.waiting(60_000)
                if (ending === "cancellation") await request.cancel()
                else await clock.advance(1_000)
                const result = await request.result
                if (ending === "deadline")
                    expect(result).toMatchObject({ error: { _tag: "CountOperationError", reason: "timeout" } })
                else
                    expect(result).toMatchObject(
                        mode === "default" ? { error: { _tag: "CancelledError" } } : { interrupted: true },
                    )
                await clock.advance(60_000)
                await drained(client, server)
                expect(
                    server.commandsWithOp(
                        operation === "guilds" ? Opcode.requestGuildCounts : Opcode.requestChannelMemberCounts,
                    ),
                ).toEqual([])
            })
        }
    }

    /** Start one member stream and settle its first pull into a value, typed error or interruption */
    function memberStream(
        client: AnyClient,
        timeoutMs: number,
    ): { result: Promise<unknown>; cancel: () => Promise<void> } {
        if (mode === "default") {
            const abort = new AbortController()
            const iterator = (client as Client).members
                .iterateChunks("40", { all: true }, { timeoutMs, signal: abort.signal })
                [Symbol.asyncIterator]()
            return {
                result: iterator
                    .next()
                    .then((entry) =>
                        !entry.done && entry.value.isErr() ? { error: entry.value.error } : { value: entry },
                    ),
                cancel: async () => abort.abort(),
            }
        }
        return launch(
            Stream.runDrain((client as NativeClient).members.iterateChunks("40", { all: true }, { timeoutMs })),
            new AbortController(),
        )
    }

    for (const ending of ["cancellation", "deadline"] as const) {
        test(`withdraws unsent member chunk commands after ${ending}`, async () => {
            const { clock, server, client } = await connected(mode)
            await saturate(client, server)
            const { result, cancel } = memberStream(client, 1_000)
            await clock.waiting(60_000)
            if (ending === "cancellation") await cancel()
            else await clock.advance(1_000)
            const ended = await result
            if (ending === "deadline")
                expect(ended).toMatchObject({ error: { _tag: "MemberChunkError", reason: "timeout" } })
            else
                expect(ended).toMatchObject(
                    mode === "default" ? { error: { _tag: "CancelledError" } } : { interrupted: true },
                )
            await clock.advance(60_000)
            await drained(client, server)
            expect(server.commandsWithOp(Opcode.requestGuildMembers)).toEqual([])
        })
    }

    test("counts only member requests that reached the socket toward Fluxer's member request limit", async () => {
        // Catches: Counting requests withdrawn before Fluxer saw them refused the 13th with rateLimit although none was sent
        const { clock, server, client } = await connected(mode)
        await saturate(client, server)
        for (let index = 0; index < 13; index++) {
            const { result } = memberStream(client, 100)
            // A timeout proves the stream was admitted and queued, and expiry withdraws its unsent request.
            // A refused stream settles at once rather than starting its deadline
            await Promise.race([result, clock.waiting(100)])
            await clock.advance(100)
            expect(await result).toMatchObject({ error: { _tag: "MemberChunkError", reason: "timeout" } })
        }
        await clock.advance(60_000)
        await drained(client, server)
        expect(server.commandsWithOp(Opcode.requestGuildMembers)).toEqual([])
    })

    test("counts a raw member request cancelled after the socket took it toward Fluxer's member request limit", async () => {
        // Catches: A raw member request from gateway.send was counted only once its caller resumed, so a send cancelled
        // between transmission and that resumption went uncounted and a later member stream past Fluxer's limit was sent
        const cancels: (() => unknown)[] = []
        const { clock, server, client } = await connected(mode, {
            logging: {
                categories: { gateway: "debug" },
                // Cancel each raw member request at the moment the socket took it, before its caller resumes
                sink: (record) => {
                    if (record.code === "gateway.commandSent" && record.fields?.opcode === Opcode.requestGuildMembers)
                        void cancels.shift()?.()
                },
            },
        })
        await saturate(client, server)
        const sends = Array.from({ length: 12 }, (_, index) => {
            const abort = new AbortController()
            const data = { guild_id: "40", query: "", limit: 0, nonce: `raw${index}` }
            const send = launch<unknown, unknown>(
                (client as Client).gateway.send(
                    0,
                    Opcode.requestGuildMembers,
                    data,
                    mode === "default" ? { signal: abort.signal } : undefined,
                ),
                abort,
            )
            cancels.push(send.cancel)
            return send.result
        })
        await clock.waiting(60_000)
        await clock.advance(60_000)
        for (const result of await Promise.all(sends))
            expect(result).toMatchObject(
                mode === "default" ? { error: { _tag: "CancelledError" } } : { interrupted: true },
            )
        expect(server.commandsWithOp(Opcode.requestGuildMembers)).toHaveLength(12)
        const { result } = memberStream(client, 100)
        // A refused stream settles at once, and an admitted one starts its deadline instead
        await Promise.race([result, clock.waiting(100)])
        await clock.advance(100)
        expect(await result).toMatchObject({ error: { _tag: "MemberChunkError", reason: "rateLimit" } })
    })

    test("withdraws a cleared member presence selection before it reaches the socket", async () => {
        const { clock, server, client } = await connected(mode)
        await saturate(client, server)
        await settle((client as Client).presence.setMembers("40", ["50"]))
        await clock.advance(0)
        await clock.waiting(60_000)
        await settle((client as Client).presence.setMembers("40", []))
        await clock.advance(60_000)
        await drained(client, server)
        expect(server.commandsWithOp(Opcode.memberSubscriptions)).toEqual([])
    })

    test("replaces an unsent member presence selection with the latest member IDs", async () => {
        const { clock, server, client } = await connected(mode)
        await saturate(client, server)
        await settle((client as Client).presence.setMembers("40", ["50"]))
        await clock.advance(0)
        await clock.waiting(60_000)
        await settle((client as Client).presence.setMembers("40", ["51"]))
        await clock.advance(60_000)
        await vi.waitFor(() => expect(server.commandsWithOp(Opcode.memberSubscriptions)).toHaveLength(1), {
            interval: 5,
        })
        expect(server.commandsWithOp(Opcode.memberSubscriptions)[0]!.d).toEqual({
            subscriptions: { "40": { members: ["51"] } },
        })
    })

    test("coalesces presence behind a saturated send budget and spaces later updates from actual transmission", async () => {
        const { clock, server, client } = await connected(mode)
        await saturate(client, server)
        for (let index = 0; index < 7; index++) {
            await settle((client as Client).presence.set({ status: "idle", customStatus: { text: `intent-${index}` } }))
            await clock.advance(4_000)
        }
        expect(server.commandsWithOp(Opcode.presenceUpdate)).toEqual([])
        await clock.advance(32_000)
        await vi.waitFor(() => expect(server.commandsWithOp(Opcode.presenceUpdate)).toHaveLength(1), { interval: 5 })
        expect(server.commandsWithOp(Opcode.presenceUpdate)[0]!.d).toMatchObject({
            custom_status: { text: "intent-6" },
        })
        await settle((client as Client).presence.set({ status: "online", customStatus: { text: "after send" } }))
        await clock.waiting(4_000)
        await clock.advance(3_999)
        expect(server.commandsWithOp(Opcode.presenceUpdate)).toHaveLength(1)
        await clock.advance(1)
        await vi.waitFor(() => expect(server.commandsWithOp(Opcode.presenceUpdate)).toHaveLength(2), { interval: 5 })
    })
})
