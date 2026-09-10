import { once } from "node:events"
import { createServer } from "node:http"
import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, expect, test, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import { createClient } from "../src/index.js"
import { createClient as createEffectClient } from "../src/effect.js"

const transport = vi.hoisted(() => ({ url: "", sockets: [] as import("ws").WebSocket[] }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(url: string, options: import("ws").ClientOptions) {
                super(transport.url || url, options)
                transport.sockets.push(this)
            }
        },
    }
})

const realFetch = globalThis.fetch
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    transport.url = ""
    transport.sockets = []
})

interface GatewayCommand {
    readonly connection: number
    readonly op: number
    readonly d: unknown
}

async function gatewayFixture() {
    const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(JSON.stringify({ url: "wss://gateway.fluxer.app" }))
    })
    const gateway = new WebSocketServer({ server })
    const commands: GatewayCommand[] = []
    const sockets: WebSocket[] = []
    const sequences = new Map<WebSocket, number>()
    const dispatch = (event: string, data: unknown, socket = sockets.at(-1)) => {
        if (!socket) throw new Error("Expected a gateway socket")
        const sequence = (sequences.get(socket) ?? 1) + 1
        sequences.set(socket, sequence)
        socket.send(JSON.stringify({ op: 0, s: sequence, t: event, d: data }))
    }
    gateway.on("connection", (socket) => {
        const connection = sockets.push(socket) - 1
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const command = JSON.parse(data.toString()) as { readonly op: number; readonly d: unknown }
            commands.push({ connection, ...command })
            if (command.op === 1) socket.send(JSON.stringify({ op: 11 }))
            if (command.op === 2) {
                sequences.set(socket, 1)
                socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: `counts-${connection}` } }))
            }
            if (command.op === 6) {
                const sequence =
                    typeof command.d === "object" &&
                    command.d !== null &&
                    "seq" in command.d &&
                    typeof command.d.seq === "number"
                        ? command.d.seq
                        : 1
                sequences.set(socket, sequence)
                socket.send(JSON.stringify({ op: 0, s: sequence, t: "RESUMED", d: {} }))
            }
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected a loopback gateway address")
    transport.url = `ws://127.0.0.1:${address.port}`
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.fluxer.app/v1/gateway/bot")
        return realFetch(`http://127.0.0.1:${address.port}`, init)
    })
    return {
        commands,
        sockets,
        dispatch,
        async close() {
            for (const socket of [...sockets, ...transport.sockets]) socket.terminate()
            await new Promise<void>((resolve) => gateway.close(() => resolve()))
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

type Mode = "default" | "native"
type Outcome<A> =
    | { readonly kind: "success"; readonly value: A }
    | { readonly kind: "failure"; readonly error: { readonly _tag: string; readonly reason?: string } }
    | { readonly kind: "interrupted" }

function nativeOutcome<A>(effect: Effect.Effect<A, unknown>): Promise<Outcome<A>> {
    return Effect.runPromiseExit(effect).then(outcomeFromExit)
}

function outcomeFromExit<A>(exit: Exit.Exit<A, unknown>): Outcome<A> {
    if (Exit.isSuccess(exit)) return { kind: "success", value: exit.value }
    if (Cause.hasInterruptsOnly(exit.cause)) return { kind: "interrupted" }
    const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (reason?._tag === "Fail")
        return { kind: "failure", error: reason.error as { readonly _tag: string; readonly reason?: string } }
    throw new Error("Expected a typed count failure")
}

async function defaultOutcome<A>(operation: ResultAsync<A, unknown>): Promise<Outcome<A>> {
    const result = await operation
    return result.isOk()
        ? { kind: "success", value: result.value }
        : { kind: "failure", error: result.error as { readonly _tag: string; readonly reason?: string } }
}

interface Driver {
    readonly state: () => string
    getGuild(id: string): Promise<unknown>
    getChannel(id: string): Promise<unknown>
    guild(ids: readonly string[], options?: unknown): Promise<Outcome<import("../src/counts.js").GuildCountsResult>>
    channels(
        guildId: string,
        ids: readonly string[],
        options?: unknown,
    ): Promise<Outcome<import("../src/counts.js").ChannelMemberCountsResult>>
    startChannels(
        guildId: string,
        ids: readonly string[],
    ): {
        readonly outcome: Promise<Outcome<import("../src/counts.js").ChannelMemberCountsResult>>
        readonly cancel: () => Promise<void>
    }
    connect(): Promise<void>
    shutdown(): Promise<void>
}

async function driver(
    mode: Mode,
    options: { readonly cache?: { readonly guilds?: boolean; readonly channels?: boolean } } = {},
): Promise<Driver> {
    if (mode === "default") {
        const client = createClient({ token: "fixture-only", ...options })._unsafeUnwrap()
        return {
            state: () => client.state,
            getGuild: async (id) => {
                const result = client.guilds.get(id)
                return result.isOk() ? result.value : result.error
            },
            getChannel: async (id) => {
                const result = client.channels.get(id)
                return result.isOk() ? result.value : result.error
            },
            guild: (ids, options) =>
                defaultOutcome(
                    client.guilds.fetchCounts(ids, options as import("../src/counts.js").DefaultCountOperationOptions),
                ),
            channels: (guildId, ids, options) =>
                defaultOutcome(
                    client.channels.fetchMemberCounts(
                        guildId,
                        ids,
                        options as import("../src/counts.js").DefaultCountOperationOptions,
                    ),
                ),
            startChannels: (guildId, ids) => {
                const controller = new AbortController()
                return {
                    outcome: defaultOutcome(
                        client.channels.fetchMemberCounts(guildId, ids, { signal: controller.signal }),
                    ),
                    cancel: async () => controller.abort(),
                }
            },
            connect: async () => expect((await client.connect()).isOk()).toBe(true),
            shutdown: async () => expect((await client.shutdown()).isOk()).toBe(true),
        }
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createEffectClient({ token: "fixture-only", ...options }).pipe(Scope.provide(scope)),
    )
    let stopped = false
    return {
        state: () => client.state,
        getGuild: (id) => Effect.runPromise(client.guilds.get(id)),
        getChannel: (id) => Effect.runPromise(client.channels.get(id)),
        guild: (ids, options) =>
            nativeOutcome(client.guilds.fetchCounts(ids, options as import("../src/counts.js").CountOperationOptions)),
        channels: (guildId, ids, options) =>
            nativeOutcome(
                client.channels.fetchMemberCounts(
                    guildId,
                    ids,
                    options as import("../src/counts.js").CountOperationOptions,
                ),
            ),
        startChannels: (guildId, ids) => {
            const fiber = Effect.runFork(client.channels.fetchMemberCounts(guildId, ids))
            return {
                outcome: Effect.runPromiseExit(Fiber.join(fiber)).then(outcomeFromExit),
                cancel: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
            }
        },
        connect: () => Effect.runPromise(client.connect()),
        shutdown: async () => {
            if (stopped) return
            stopped = true
            await Effect.runPromise(client.shutdown())
            await Effect.runPromise(Scope.close(scope, Exit.void))
        },
    }
}

async function connected(fixture: Awaited<ReturnType<typeof gatewayFixture>>, client: Driver) {
    await client.connect()
    await vi.waitFor(() => expect(client.state()).toBe("Connected"), { interval: 5 })
    expect(fixture.commands.filter((command) => command.op === 2)).toHaveLength(1)
}

function command(fixture: Awaited<ReturnType<typeof gatewayFixture>>, op: 15 | 16, index = -1) {
    const found = fixture.commands.filter((entry) => entry.op === op).at(index)
    if (!found || typeof found.d !== "object" || found.d === null) throw new Error(`Expected Op${op} gateway command`)
    return found.d as Record<string, unknown>
}

for (const mode of ["default", "native"] as const) {
    test(`${mode} returns ordered partial and empty count results without caching`, async () => {
        const fixture = await gatewayFixture()
        const client = await driver(mode, { cache: { guilds: true, channels: true } })
        try {
            await connected(fixture, client)
            const guilds = client.guild(["3", "2", "1"])
            await vi.waitFor(() => expect(fixture.commands.some((entry) => entry.op === 15)).toBe(true), {
                interval: 5,
            })
            const guildFrame = command(fixture, 15)
            expect(Object.keys(guildFrame).sort()).toEqual(["guild_ids", "nonce"])
            expect(guildFrame.guild_ids).toEqual(["3", "2", "1"])
            expect(guildFrame.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
            fixture.dispatch("GUILD_COUNTS_UPDATE", {
                nonce: guildFrame.nonce,
                counts: [{ guild_id: "2", member_count: 9, online_count: 4 }],
            })
            const partial = await guilds
            expect(partial).toEqual({
                kind: "success",
                value: {
                    counts: [{ guildId: "2", memberCount: 9, onlineCount: 4 }],
                    omittedGuildIds: ["3", "1"],
                },
            })
            if (partial.kind !== "success") throw new Error("Expected a count result")
            expect(Object.isFrozen(partial.value)).toBe(true)
            expect(Object.isFrozen(partial.value.counts)).toBe(true)
            expect(Object.isFrozen(partial.value.counts[0])).toBe(true)
            expect(Object.isFrozen(partial.value.omittedGuildIds)).toBe(true)
            await expect(client.getGuild("2")).resolves.toBeUndefined()

            const channels = client.channels("2", ["12", "11"])
            await vi.waitFor(() => expect(fixture.commands.some((entry) => entry.op === 16)).toBe(true), {
                interval: 5,
            })
            const channelFrame = command(fixture, 16)
            expect(Object.keys(channelFrame).sort()).toEqual(["channel_ids", "guild_id", "nonce"])
            expect(channelFrame.guild_id).toBe("2")
            expect(channelFrame.channel_ids).toEqual(["12", "11"])
            fixture.dispatch("CHANNEL_MEMBER_COUNTS_UPDATE", { nonce: channelFrame.nonce, counts: [] })
            const empty = await channels
            expect(empty).toEqual({
                kind: "success",
                value: { counts: [], omittedChannelIds: ["12", "11"] },
            })
            if (empty.kind !== "success") throw new Error("Expected a count result")
            expect(Object.isFrozen(empty.value)).toBe(true)
            expect(Object.isFrozen(empty.value.counts)).toBe(true)
            expect(Object.isFrozen(empty.value.omittedChannelIds)).toBe(true)
            await expect(client.getChannel("12")).resolves.toBeUndefined()
        } finally {
            await client.shutdown()
            await fixture.close()
        }
    })

    test(`${mode} rejects strict count input locally without a gateway frame`, async () => {
        const fixture = await gatewayFixture()
        const client = await driver(mode)
        try {
            await connected(fixture, client)
            for (const ids of [
                [],
                ["0"],
                ["01"],
                ["id"],
                ["1", "1"],
                ["18446744073709551616"],
                ["9".repeat(10_000)],
                Array.from({ length: 101 }, (_, index) => String(index + 1)),
            ]) {
                await expect(client.guild(ids)).resolves.toMatchObject({ kind: "failure", error: { reason: "input" } })
            }
            for (const [guildId, ids] of [
                ["0", ["1"]],
                ["1", []],
                ["1", ["1", "1"]],
                ["1", Array.from({ length: 26 }, (_, index) => String(index + 1))],
            ] as const)
                await expect(client.channels(guildId, ids)).resolves.toMatchObject({
                    kind: "failure",
                    error: { reason: "input" },
                })
            await expect(client.guild(["1"], { timeoutMs: 0 })).resolves.toMatchObject({
                kind: "failure",
                error: { reason: "input" },
            })
            await expect(client.guild(["1"], { timeoutMs: 2, unexpected: true })).resolves.toMatchObject({
                kind: "failure",
                error: { reason: "input" },
            })
            await expect(client.channels(undefined as unknown as string, ["1"])).resolves.toMatchObject({
                kind: "failure",
                error: { reason: "input" },
            })
            expect(fixture.commands.filter((entry) => entry.op === 15 || entry.op === 16)).toEqual([])
        } finally {
            await client.shutdown()
            await fixture.close()
        }
    })

    test(`${mode} shares four local requests, correlates nonces, and ignores unmatched frames`, async () => {
        const fixture = await gatewayFixture()
        const client = await driver(mode)
        try {
            await connected(fixture, client)
            const pending = [
                client.guild(["1"]),
                client.channels("2", ["3"]),
                client.guild(["4"]),
                client.channels("5", ["6"]),
            ]
            await vi.waitFor(
                () => expect(fixture.commands.filter((entry) => entry.op === 15 || entry.op === 16)).toHaveLength(4),
                {
                    interval: 5,
                },
            )
            await expect(client.guild(["7"])).resolves.toMatchObject({ kind: "failure", error: { reason: "busy" } })
            const guildFrame = command(fixture, 15, 0)
            fixture.dispatch("GUILD_COUNTS_UPDATE", {
                nonce: "unmatched",
                counts: [{ guild_id: "1", member_count: 1, online_count: 1 }],
            })
            fixture.dispatch("GUILD_COUNTS_UPDATE", { counts: [{ guild_id: "1", member_count: 1, online_count: 1 }] })
            await new Promise((resolve) => setTimeout(resolve, 5))
            fixture.dispatch("GUILD_COUNTS_UPDATE", {
                nonce: guildFrame.nonce,
                counts: [{ guild_id: "1", member_count: 1, online_count: 1 }],
            })
            for (const entry of fixture.commands.filter((entry) => entry.op === 15 || entry.op === 16).slice(1)) {
                const frame = entry.d as {
                    readonly nonce: string
                    readonly guild_ids?: readonly string[]
                    readonly guild_id?: string
                    readonly channel_ids?: readonly string[]
                }
                fixture.dispatch(
                    entry.op === 15 ? "GUILD_COUNTS_UPDATE" : "CHANNEL_MEMBER_COUNTS_UPDATE",
                    entry.op === 15
                        ? {
                              nonce: frame.nonce,
                              counts: [{ guild_id: frame.guild_ids![0], member_count: 2, online_count: 1 }],
                          }
                        : {
                              nonce: frame.nonce,
                              counts: [
                                  {
                                      guild_id: frame.guild_id,
                                      channel_id: frame.channel_ids![0],
                                      member_count: 2,
                                      online_count: 1,
                                  },
                              ],
                          },
                )
            }
            for (const result of await Promise.all(pending)) expect(result.kind).toBe("success")
            fixture.dispatch("GUILD_COUNTS_UPDATE", {
                nonce: guildFrame.nonce,
                counts: [{ guild_id: "1", member_count: 99, online_count: 99 }],
            })
            expect(client.state()).toBe("Connected")
        } finally {
            await client.shutdown()
            await fixture.close()
        }
    })

    test(`${mode} fails matched malformed replies without terminating unrelated gateway work`, async () => {
        const fixture = await gatewayFixture()
        const client = await driver(mode)
        try {
            await connected(fixture, client)
            const missingCounts = client.guild(["1"])
            await vi.waitFor(() => expect(fixture.commands.some((entry) => entry.op === 15)).toBe(true), {
                interval: 5,
            })
            fixture.dispatch("GUILD_COUNTS_UPDATE", { nonce: command(fixture, 15).nonce })
            await expect(missingCounts).resolves.toMatchObject({ kind: "failure", error: { reason: "response" } })

            const malformed = client.guild(["1"])
            await vi.waitFor(() => expect(fixture.commands.filter((entry) => entry.op === 15)).toHaveLength(2), {
                interval: 5,
            })
            fixture.dispatch("GUILD_COUNTS_UPDATE", {
                nonce: command(fixture, 15).nonce,
                counts: [{ guild_id: "9", member_count: 1, online_count: 1 }],
            })
            await expect(malformed).resolves.toMatchObject({ kind: "failure", error: { reason: "response" } })
            expect(client.state()).toBe("Connected")
            const valid = client.channels("1", ["2"])
            await vi.waitFor(() => expect(fixture.commands.some((entry) => entry.op === 16)).toBe(true), {
                interval: 5,
            })
            fixture.dispatch("CHANNEL_MEMBER_COUNTS_UPDATE", {
                nonce: command(fixture, 16).nonce,
                counts: [{ guild_id: "1", channel_id: "2", member_count: 2, online_count: 1 }],
            })
            await expect(valid).resolves.toMatchObject({ kind: "success" })
        } finally {
            await client.shutdown()
            await fixture.close()
        }
    })
}

for (const mode of ["default", "native"] as const) {
    test(`${mode} keeps a synchronous gateway sender defect distinct from connection loss`, async () => {
        const fixture = await gatewayFixture()
        try {
            if (mode === "default") {
                const client = createClient({ token: "fixture-only" })._unsafeUnwrap()
                try {
                    expect((await client.connect()).isOk()).toBe(true)
                    await vi.waitFor(() => expect(transport.sockets).toHaveLength(1), { interval: 5 })
                    vi.spyOn(transport.sockets[0]!, "send").mockImplementationOnce(() => {
                        throw new Error("fixture sender defect")
                    })
                    await expect(client.guilds.fetchCounts(["1"])).rejects.toEqual(
                        expect.objectContaining({
                            name: "SdkDefect",
                            operation: "guilds.fetchCounts",
                            reasons: [{ kind: "Defect" }],
                        }),
                    )
                    const next = client.guilds.fetchCounts(["1"])
                    await vi.waitFor(() => expect(fixture.commands.some((entry) => entry.op === 15)).toBe(true), {
                        interval: 5,
                    })
                    fixture.dispatch("GUILD_COUNTS_UPDATE", {
                        nonce: command(fixture, 15).nonce,
                        counts: [{ guild_id: "1", member_count: 1, online_count: 1 }],
                    })
                    expect((await next).isOk()).toBe(true)
                } finally {
                    await client.shutdown()
                }
                return
            }
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(
                createEffectClient({ token: "fixture-only" }).pipe(Scope.provide(scope)),
            )
            try {
                await Effect.runPromise(client.connect())
                await vi.waitFor(() => expect(transport.sockets).toHaveLength(1), { interval: 5 })
                vi.spyOn(transport.sockets[0]!, "send").mockImplementationOnce(() => {
                    throw new Error("fixture sender defect")
                })
                const exit = await Effect.runPromiseExit(client.guilds.fetchCounts(["1"]))
                expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
                expect(client.state).toBe("Connected")
            } finally {
                await Effect.runPromise(client.shutdown())
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        } finally {
            await fixture.close()
        }
    })
}

test("native gateway counts copy IDs at execution rather than Effect construction", async () => {
    const fixture = await gatewayFixture()
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createEffectClient({ token: "fixture-only" }).pipe(Scope.provide(scope)))
    try {
        await Effect.runPromise(client.connect())
        const ids = ["1"]
        const request = client.guilds.fetchCounts(ids)
        ids[0] = "2"
        const result = nativeOutcome(request)
        await vi.waitFor(() => expect(fixture.commands.some((entry) => entry.op === 15)).toBe(true), { interval: 5 })
        expect(command(fixture, 15).guild_ids).toEqual(["2"])
        fixture.dispatch("GUILD_COUNTS_UPDATE", {
            nonce: command(fixture, 15).nonce,
            counts: [{ guild_id: "2", member_count: 1, online_count: 0 }],
        })
        await expect(result).resolves.toMatchObject({ kind: "success" })
    } finally {
        await Effect.runPromise(client.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
        await fixture.close()
    }
})

for (const mode of ["default", "native"] as const) {
    test(`${mode} times out or cancels locally without resend, and recovery/closure release pending counts`, async () => {
        const fixture = await gatewayFixture()
        const client = await driver(mode)
        try {
            await connected(fixture, client)
            const timedOut = client.guild(["1"], { timeoutMs: 10 })
            await vi.waitFor(() => expect(fixture.commands.some((entry) => entry.op === 15)).toBe(true), {
                interval: 5,
            })
            const timeoutNonce = command(fixture, 15).nonce
            await expect(timedOut).resolves.toMatchObject({ kind: "failure", error: { reason: "timeout" } })
            fixture.dispatch("GUILD_COUNTS_UPDATE", {
                nonce: timeoutNonce,
                counts: [{ guild_id: "1", member_count: 1, online_count: 1 }],
            })
            expect(fixture.commands.filter((entry) => entry.op === 15)).toHaveLength(1)

            const cancelled = client.startChannels("1", ["2"])
            await vi.waitFor(() => expect(fixture.commands.some((entry) => entry.op === 16)).toBe(true), {
                interval: 5,
            })
            const cancelledNonce = command(fixture, 16).nonce
            await cancelled.cancel()
            await expect(cancelled.outcome).resolves.toMatchObject({
                kind: mode === "default" ? "failure" : "interrupted",
                ...(mode === "default" ? { error: { _tag: "CancelledError" } } : {}),
            })
            fixture.dispatch("CHANNEL_MEMBER_COUNTS_UPDATE", {
                nonce: cancelledNonce,
                counts: [{ guild_id: "1", channel_id: "2", member_count: 1, online_count: 1 }],
            })

            const lost = client.guild(["3"])
            await vi.waitFor(() => expect(fixture.commands.filter((entry) => entry.op === 15)).toHaveLength(2), {
                interval: 5,
            })
            const lostNonce = command(fixture, 15).nonce
            vi.spyOn(Math, "random").mockReturnValue(0)
            fixture.sockets[0]!.close(4000)
            await expect(lost).resolves.toMatchObject({ kind: "failure", error: { reason: "connectionLost" } })
            await vi.waitFor(() => expect(client.state()).toBe("Connected"), { interval: 5 })
            expect(fixture.commands.filter((entry) => entry.op === 15)).toHaveLength(2)
            fixture.dispatch("GUILD_COUNTS_UPDATE", {
                nonce: lostNonce,
                counts: [{ guild_id: "3", member_count: 1, online_count: 1 }],
            })

            const closing = client.guild(["4"])
            await vi.waitFor(() => expect(fixture.commands.filter((entry) => entry.op === 15)).toHaveLength(3), {
                interval: 5,
            })
            await client.shutdown()
            await expect(closing).resolves.toMatchObject({ kind: "failure", error: { _tag: "ClientClosedError" } })
            await expect(client.guild([])).resolves.toMatchObject({
                kind: "failure",
                error: { _tag: "ClientClosedError" },
            })
        } finally {
            await client.shutdown()
            await fixture.close()
        }
    })
}
