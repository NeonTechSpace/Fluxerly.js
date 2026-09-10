import { getEventListeners, once } from "node:events"
import { createServer } from "node:http"
import { Cause, Effect, Exit, Redacted, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import { createClient, type PresenceInput } from "../src/index.js"
import { createClient as createEffectClient } from "../src/effect.js"
import { PresenceOwner, presenceUpdate, validatePresenceInput, type PresenceTimer } from "../src/internal/presence.js"
import { runGateway, type Session } from "../src/internal/gateway.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

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
    vi.useRealTimers()
    transport.url = ""
    transport.sockets = []
})

function timers() {
    let now = 0
    const scheduled = new Set<{ readonly at: number; readonly callback: () => void }>()
    const timer: PresenceTimer = {
        now: () => now,
        set: (callback, delay) => {
            const entry = { at: now + delay, callback }
            scheduled.add(entry)
            return entry
        },
        clear: (handle) => scheduled.delete(handle as { readonly at: number; readonly callback: () => void }),
    }
    return {
        timer,
        advance(milliseconds: number) {
            now += milliseconds
            for (;;) {
                const due = [...scheduled].filter((entry) => entry.at <= now).sort((left, right) => left.at - right.at)
                if (due.length === 0) return
                for (const entry of due) {
                    scheduled.delete(entry)
                    entry.callback()
                }
            }
        },
        get count() {
            return scheduled.size
        },
    }
}

interface GatewayCommand {
    readonly connection: number
    readonly op: number
    readonly d: unknown
}

async function publicGateway() {
    const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(JSON.stringify({ url: "wss://gateway.fluxer.app" }))
    })
    const gateway = new WebSocketServer({ server })
    const commands: GatewayCommand[] = []
    const sockets: WebSocket[] = []
    gateway.on("connection", (socket) => {
        const connection = sockets.push(socket) - 1
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const command = JSON.parse(data.toString()) as { readonly op: number; readonly d: unknown }
            commands.push({ connection, ...command })
            if (command.op === 1) socket.send(JSON.stringify({ op: 11 }))
            if (command.op === 2) {
                socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "presence-public-session" } }))
            }
            if (command.op === 6) socket.send(JSON.stringify({ op: 0, s: 1, t: "RESUMED", d: {} }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected loopback listener")
    transport.url = `ws://127.0.0.1:${address.port}`
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => {
        expect(url).toBe("https://api.fluxer.app/v1/gateway/bot")
        return realFetch(`http://127.0.0.1:${address.port}`, init)
    })
    return {
        commands,
        sockets,
        async close() {
            for (const socket of [...sockets, ...transport.sockets]) socket.terminate()
            await new Promise<void>((resolve) => gateway.close(() => resolve()))
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

type PublicMode = "default" | "native"
const publicModes: readonly PublicMode[] = ["default", "native"]

interface PublicDriver {
    readonly state: () => string
    set(input: PresenceInput): void
    invalid(input: unknown): void
    setMembers(guildId: string, memberIds: readonly string[]): void
    invalidMembers(guildId: unknown, memberIds: unknown, reason: "input" | "limit"): void
    connect(): Promise<void>
    shutdown(): Promise<void>
    closed(): void
}

async function publicDriver(mode: PublicMode): Promise<PublicDriver> {
    if (mode === "default") {
        const client = createClient({ token: "fixture-only" })._unsafeUnwrap()
        return {
            state: () => client.state,
            set: (input) => expect(client.presence.set(input).isOk()).toBe(true),
            invalid: (input) => {
                const result = client.presence.set(input as PresenceInput)
                expect(result).toMatchObject({ error: { _tag: "PresenceError", reason: "input" } })
            },
            setMembers: (guildId, memberIds) =>
                expect(client.presence.setMembers(guildId, memberIds).isOk()).toBe(true),
            invalidMembers: (guildId, memberIds, reason) => {
                const result = client.presence.setMembers(guildId as string, memberIds as readonly string[])
                expect(result).toMatchObject({ error: { _tag: "PresenceError", reason } })
            },
            connect: async () => expect((await client.connect()).isOk()).toBe(true),
            shutdown: async () => expect((await client.shutdown()).isOk()).toBe(true),
            closed: () => {
                const result = client.presence.set({ status: "online" })
                expect(result).toMatchObject({ error: { _tag: "ClientClosedError" } })
            },
        }
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createEffectClient({ token: "fixture-only" }).pipe(Scope.provide(scope)))
    let stopped = false
    return {
        state: () => client.state,
        set: (input) => expect(Effect.runSyncExit(client.presence.set(input))).toMatchObject({ _tag: "Success" }),
        invalid: (input) => {
            const exit = Effect.runSyncExit(client.presence.set(input as PresenceInput))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit))
                expect(exit.cause.reasons).toContainEqual(
                    expect.objectContaining({
                        _tag: "Fail",
                        error: expect.objectContaining({ _tag: "PresenceError", reason: "input" }),
                    }),
                )
        },
        setMembers: (guildId, memberIds) =>
            expect(Effect.runSyncExit(client.presence.setMembers(guildId, memberIds))).toMatchObject({
                _tag: "Success",
            }),
        invalidMembers: (guildId, memberIds, reason) => {
            const exit = Effect.runSyncExit(
                client.presence.setMembers(guildId as string, memberIds as readonly string[]),
            )
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit))
                expect(exit.cause.reasons).toContainEqual(
                    expect.objectContaining({
                        _tag: "Fail",
                        error: expect.objectContaining({ _tag: "PresenceError", reason }),
                    }),
                )
        },
        connect: async () => {
            await Effect.runPromise(client.connect())
        },
        shutdown: async () => {
            if (stopped) return
            stopped = true
            await Effect.runPromise(client.shutdown())
            await Effect.runPromise(Scope.close(scope, Exit.void))
        },
        closed: () => {
            const exit = Effect.runSyncExit(client.presence.set({ status: "online" }))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit))
                expect(exit.cause.reasons).toContainEqual(
                    expect.objectContaining({
                        _tag: "Fail",
                        error: expect.objectContaining({ _tag: "ClientClosedError" }),
                    }),
                )
        },
    }
}

test("presence input is validated, copied and encoded without caller-owned fields", () => {
    const input = {
        status: "idle",
        customStatus: {
            text: "reviewing",
            emoji: { id: "42" },
            expiresAt: "2030-01-01T00:00:00.000Z",
        },
    }
    const frozen = validatePresenceInput(input)
    expect(frozen).toEqual(input)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen?.customStatus)).toBe(true)
    input.customStatus.text = "mutated after acceptance"
    input.customStatus.emoji.id = "43"
    expect(presenceUpdate(frozen!)).toEqual({
        status: "idle",
        afk: false,
        mobile: false,
        custom_status: { text: "reviewing", emoji_id: "42", expires_at: "2030-01-01T00:00:00.000Z" },
    })
    expect(validatePresenceInput({ status: "offline" })).toBeUndefined()
    expect(validatePresenceInput({ status: "online", customStatus: { emoji: { id: "not-an-id" } } })).toBeUndefined()
    expect(validatePresenceInput({ status: "online", customStatus: { emoji: { id: "1", name: "x" } } })).toBeUndefined()
    expect(validatePresenceInput({ status: "online", customStatus: { expiresAt: "2030-01-01" } })).toBeUndefined()
})

test("presence owner coalesces one latest intent, spaces writes and cancels detached work", () => {
    const clock = timers()
    const sent: unknown[] = []
    const owner = new PresenceOwner(clock.timer)
    expect(owner.set({ status: "online", customStatus: { text: "retained" } })).toBe(true)
    owner.attach((update) => sent.push(update))
    clock.advance(0)
    expect(sent).toEqual([{ status: "online", afk: false, mobile: false, custom_status: { text: "retained" } }])

    expect(owner.set({ status: "idle" })).toBe(true)
    clock.advance(3_999)
    expect(sent).toHaveLength(1)
    clock.advance(1)
    expect(sent).toEqual([
        { status: "online", afk: false, mobile: false, custom_status: { text: "retained" } },
        { status: "idle", afk: false, mobile: false, custom_status: { text: "retained" } },
    ])

    expect(owner.set({ status: "dnd", customStatus: { text: "first" } })).toBe(true)
    expect(owner.set({ status: "invisible", customStatus: null })).toBe(true)
    clock.advance(4_000)
    expect(sent.at(-1)).toEqual({ status: "invisible", afk: false, mobile: false, custom_status: null })

    expect(owner.set({ status: "online" })).toBe(true)
    owner.detach()
    clock.advance(4_000)
    expect(sent).toHaveLength(3)
    owner.attach((update) => sent.push(update))
    clock.advance(0)
    expect(sent.at(-1)).toEqual({ status: "online", afk: false, mobile: false, custom_status: null })

    expect(owner.set({ status: "dnd" })).toBe(true)
    owner.close()
    clock.advance(4_000)
    expect(sent).toHaveLength(4)
    expect(owner.set({ status: "online" })).toBe(false)
    expect(clock.count).toBe(0)
})

test("member presence selections are frozen, replayed on resume and released on fresh identify", () => {
    const clock = timers()
    const memberFrames: unknown[] = []
    const owner = new PresenceOwner(clock.timer)
    const selected = ["30"]
    expect(owner.setMembers("40", selected)).toBeUndefined()
    selected[0] = "31"
    owner.attach(
        () => undefined,
        (frame) => memberFrames.push(frame),
    )
    clock.advance(0)
    expect(memberFrames).toEqual([{ subscriptions: { "40": { members: ["30"] } } }])

    owner.guildCreate("40")
    clock.advance(124)
    expect(memberFrames).toHaveLength(1)
    clock.advance(1)
    expect(memberFrames).toEqual([
        { subscriptions: { "40": { members: ["30"] } } },
        { subscriptions: { "40": { members: ["30"] } } },
    ])

    owner.detach()
    expect(owner.setMembers("40", [])).toBeUndefined()
    owner.attach(
        () => undefined,
        (frame) => memberFrames.push(frame),
        "resume",
    )
    clock.advance(0)
    expect(memberFrames.at(-1)).toEqual({ subscriptions: { "40": { members: [] } } })
    owner.guildCreate("40")
    clock.advance(125)
    expect(memberFrames.at(-1)).toEqual({ subscriptions: { "40": { members: [] } } })
    expect(memberFrames).toHaveLength(4)
    owner.detach()
    owner.attach(
        () => undefined,
        (frame) => memberFrames.push(frame),
        "resume",
    )
    clock.advance(0)
    expect(memberFrames.at(-1)).toEqual({ subscriptions: { "40": { members: [] } } })
    owner.detach()
    owner.attach(
        () => undefined,
        (frame) => memberFrames.push(frame),
        "identify",
    )
    clock.advance(0)
    expect(memberFrames).toHaveLength(5)
})

test("member presence clear before its first send retains no session tombstone", () => {
    const clock = timers()
    const memberFrames: unknown[] = []
    const owner = new PresenceOwner(clock.timer)
    expect(owner.setMembers("40", ["30"])).toBeUndefined()
    expect(owner.setMembers("40", [])).toBeUndefined()
    owner.attach(
        () => undefined,
        (frame) => memberFrames.push(frame),
        "resume",
    )
    clock.advance(0)
    expect(memberFrames).toEqual([])
})

test("member presence validates identifier, per-client capacity and the complete Op14 byte budget before changing state", () => {
    const clock = timers()
    const sent: unknown[] = []
    const owner = new PresenceOwner(clock.timer)
    expect(owner.setMembers("invalid", ["30"])).toBe("input")
    expect(owner.setMembers("40", ["30", "30"])).toBe("input")
    expect(
        owner.setMembers(
            "40",
            Array.from({ length: 1_001 }, (_, index) => String(index + 1)),
        ),
    ).toBe("limit")

    const id = (index: number) => "900000000000000" + String(index).padStart(5, "0")
    let largest = 0
    while (
        Buffer.byteLength(
            JSON.stringify({
                op: 14,
                d: {
                    subscriptions: { "40": { members: Array.from({ length: largest + 1 }, (_, index) => id(index)) } },
                },
            }),
        ) <= 4_096
    )
        largest += 1
    const fitting = Array.from({ length: largest }, (_, index) => id(index))
    const frameBytes = (guildId: string) =>
        Buffer.byteLength(JSON.stringify({ op: 14, d: { subscriptions: { [guildId]: { members: fitting } } } }))
    const exactGuildId = "9".repeat(2 + 4_096 - frameBytes("40"))
    const overLimitGuildId = exactGuildId + "9"
    expect(frameBytes(exactGuildId)).toBe(4_096)
    expect(frameBytes(overLimitGuildId)).toBe(4_097)
    expect(owner.setMembers(exactGuildId, fitting)).toBeUndefined()
    expect(owner.setMembers(overLimitGuildId, fitting)).toBe("limit")
    owner.attach(
        () => undefined,
        (frame) => sent.push(frame),
    )
    clock.advance(0)
    expect(sent).toEqual([{ subscriptions: { [exactGuildId]: { members: fitting } } }])
    owner.detach()

    for (let index = 1; index <= 99; index += 1) expect(owner.setMembers(String(index + 100), ["30"])).toBeUndefined()
    expect(owner.setMembers("200", ["30"])).toBe("limit")

    const totalOwner = new PresenceOwner()
    const hundred = Array.from({ length: 100 }, (_, index) => String(index + 1))
    for (let guild = 1; guild <= 100; guild += 1) expect(totalOwner.setMembers(String(guild), hundred)).toBeUndefined()
    expect(totalOwner.setMembers("100", [...hundred, "101"])).toBe("limit")
})

test("an expiry that elapsed while disconnected is not restored", () => {
    vi.useFakeTimers({ now: 0 })
    const clock = timers()
    const sent: unknown[] = []
    const owner = new PresenceOwner(clock.timer)
    expect(
        owner.set({ status: "online", customStatus: { text: "temporary", expiresAt: "1970-01-01T00:00:10Z" } }),
    ).toBe(true)
    vi.setSystemTime(10_000)
    owner.attach((update) => sent.push(update))
    clock.advance(0)
    expect(sent).toEqual([{ status: "online", afk: false, mobile: false }])
})

test.each(publicModes)(
    "%s presence accepts disconnected intent, rejects invalid input and releases it on close",
    async (mode) => {
        const api = await publicDriver(mode)
        try {
            expect(api.state()).toBe("Disconnected")
            api.set({ status: "idle", customStatus: { text: "queued while disconnected" } })
            api.invalid({ status: "offline" })
            expect(transport.sockets).toEqual([])
            await api.shutdown()
            expect(api.state()).toBe("Closed")
            api.closed()
            expect(transport.sockets).toEqual([])
        } finally {
            await api.shutdown()
        }
    },
)

test.each(publicModes)(
    "%s member selection refreshes unchanged input and reconciles a clear after RESUMED and guild availability",
    async (mode) => {
        const fixture = await publicGateway()
        const api = await publicDriver(mode)
        try {
            api.setMembers("40", ["30"])
            api.invalidMembers("invalid", ["30"], "input")
            api.invalidMembers(
                "40",
                Array.from({ length: 1_001 }, (_, index) => String(index + 1)),
                "limit",
            )
            expect(transport.sockets).toEqual([])
            await api.connect()
            await vi.waitFor(() => expect(fixture.commands.filter((command) => command.op === 14)).toHaveLength(1), {
                interval: 5,
            })
            expect(fixture.commands.find((command) => command.op === 14)).toEqual({
                connection: 0,
                op: 14,
                d: { subscriptions: { "40": { members: ["30"] } } },
            })
            api.setMembers("40", ["30"])
            await vi.waitFor(() => expect(fixture.commands.filter((command) => command.op === 14)).toHaveLength(2))
            expect(fixture.commands.filter((command) => command.op === 14).at(-1)?.d).toEqual({
                subscriptions: { "40": { members: ["30"] } },
            })
            fixture.sockets[0]!.close(4000)
            api.setMembers("40", [])
            await vi.waitFor(
                () =>
                    expect(fixture.commands.some((command) => command.connection === 1 && command.op === 14)).toBe(
                        true,
                    ),
                { timeout: 5_000 },
            )
            const resumed = () => fixture.commands.filter((command) => command.connection === 1 && command.op === 14)
            expect(resumed().map((command) => command.d)).toEqual([{ subscriptions: { "40": { members: [] } } }])
            fixture.sockets[1]!.send(
                JSON.stringify({
                    op: 0,
                    t: "GUILD_CREATE",
                    s: 2,
                    d: { id: "40", properties: { id: "40", name: "fixture", owner_id: "90", features: [] } },
                }),
            )
            await vi.waitFor(() => expect(resumed()).toHaveLength(2))
            expect(resumed().at(-1)?.d).toEqual({ subscriptions: { "40": { members: [] } } })
        } finally {
            await api.shutdown()
            await fixture.close()
        }
    },
    10_000,
)

test.each(publicModes)(
    "%s presence coalesces frozen local input and restores the retained custom status after READY and RESUMED",
    async (mode) => {
        const fixture = await publicGateway()
        const api = await publicDriver(mode)
        const requested = {
            status: "online" as const,
            customStatus: { text: "frozen at set", emoji: { name: "⌛" } },
        }
        try {
            api.set(requested)
            requested.customStatus.text = "mutated by caller"
            api.set({ status: "idle" })
            api.set({ status: "dnd" })
            await api.connect()
            await vi.waitFor(() => expect(fixture.commands.filter((command) => command.op === 3)).toHaveLength(1), {
                interval: 5,
            })
            expect(
                fixture.commands.filter((command) => command.op === 2 || command.op === 6).map((command) => command.op),
            ).toEqual([2])
            expect(fixture.commands.find((command) => command.op === 3)).toMatchObject({
                connection: 0,
                d: {
                    status: "dnd",
                    afk: false,
                    mobile: false,
                    custom_status: { text: "frozen at set", emoji_name: "⌛" },
                },
            })

            vi.spyOn(Math, "random").mockReturnValue(0)
            fixture.sockets[0]!.close(4000)
            await vi.waitFor(() => expect(fixture.sockets).toHaveLength(2), { interval: 5 })
            await vi.waitFor(() => expect(fixture.commands.filter((command) => command.op === 3)).toHaveLength(2), {
                interval: 5,
            })
            expect(
                fixture.commands.filter((command) => command.op === 2 || command.op === 6).map((command) => command.op),
            ).toEqual([2, 6])
            expect(fixture.commands.filter((command) => command.op === 3).at(-1)).toMatchObject({
                connection: 1,
                d: {
                    status: "dnd",
                    afk: false,
                    mobile: false,
                    custom_status: { text: "frozen at set", emoji_name: "⌛" },
                },
            })

            api.set({ status: "online" })
            await api.shutdown()
            api.closed()
            expect(fixture.commands.filter((command) => command.op === 3)).toHaveLength(2)
            await vi.waitFor(
                () => expect(transport.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true),
                { interval: 5 },
            )
            for (const socket of transport.sockets)
                for (const event of ["open", "message", "error", "close"])
                    expect(getEventListeners(socket, event)).toHaveLength(0)
        } finally {
            await api.shutdown()
            await fixture.close()
        }
    },
)

test("gateway restores the retained presence with opcode 3 only after READY and detaches it during cleanup", async () => {
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    const commands: { readonly op: number; readonly d: unknown }[] = []
    const ready = Promise.withResolvers<void>()
    const peerClosed = Promise.withResolvers<void>()
    const session: Session = { id: undefined, sequence: null }
    const owner = new PresenceOwner()
    owner.set({ status: "idle", customStatus: { emoji: { name: "⌛" } } })
    gateway.on("connection", (socket) => {
        socket.once("close", () => peerClosed.resolve())
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const command = JSON.parse(data.toString()) as { readonly op: number; readonly d: unknown }
            commands.push(command)
            if (command.op === 2) {
                socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "presence-fixture" } }))
                ready.resolve()
            }
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected loopback listener")
    const controller = new AbortController()
    const running = Effect.runPromiseExit(
        runGateway(
            `ws://127.0.0.1:${address.port}`,
            Redacted.make("fixture-only"),
            session,
            10_000,
            () => undefined,
            () => undefined,
            () => undefined,
            () => undefined,
            undefined,
            owner,
        ),
        { signal: controller.signal },
    )
    try {
        await ready.promise
        await vi.waitFor(() => expect(commands.some((command) => command.op === 3)).toBe(true), { interval: 5 })
        expect(commands[0]).toMatchObject({ op: 2 })
        expect(commands[0]?.d).not.toHaveProperty("presence")
        expect(commands.find((command) => command.op === 3)).toEqual({
            op: 3,
            d: { status: "idle", afk: false, mobile: false, custom_status: { emoji_name: "⌛" } },
        })
        expect(session).toEqual({ id: "presence-fixture", sequence: 1 })
    } finally {
        controller.abort()
        const exit = await running
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        await peerClosed.promise
        for (const socket of gateway.clients) expect(socket.readyState).toBe(WebSocket.CLOSED)
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})
