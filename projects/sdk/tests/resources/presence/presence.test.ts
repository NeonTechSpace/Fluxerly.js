import { getEventListeners } from "node:events"
import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { WebSocket } from "ws"
import { createClient, type PresenceInput } from "../../../src/index.js"
import { createClient as createEffectClient } from "../../../src/effect.js"
import {
    decodePresenceUpdate,
    decodePresenceUpdateBulk,
    PresenceOwner,
    presenceUpdate,
    validatePresenceInput,
    type PresenceTimer,
} from "../../../src/internal/presence.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { startHostedLoopback } from "../../support/instance.js"
import { wsTarget } from "../../support/ws-redirect.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    wsTarget.url = ""
    wsTarget.sockets = []
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

async function publicGateway() {
    const { gateway } = await startHostedLoopback()
    return gateway
}

interface PublicDriver {
    readonly state: () => string
    set(input: PresenceInput): void
    invalid(input: unknown): unknown
    setMembers(guildId: string, memberIds: readonly string[]): void
    invalidMembers(guildId: unknown, memberIds: unknown, reason: "input" | "limit"): unknown
    connect(): Promise<void>
    shutdown(): Promise<void>
    closed(): void
}

async function publicDriver(mode: Mode): Promise<PublicDriver> {
    if (mode === "default") {
        const client = createClient({ token: "fixture-only" })
        return {
            state: () => client.state,
            set: (input) => expect(client.presence.set(input).isOk()).toBe(true),
            invalid: (input) => {
                const result = client.presence.set(input as PresenceInput)
                expect(result).toMatchObject({ error: { _tag: "PresenceError", reason: "input" } })
                if (!result.isErr()) throw new Error("Expected PresenceError")
                return result.error
            },
            setMembers: (guildId, memberIds) =>
                expect(client.presence.setMembers(guildId, memberIds).isOk()).toBe(true),
            invalidMembers: (guildId, memberIds, reason) => {
                const result = client.presence.setMembers(guildId as string, memberIds as readonly string[])
                expect(result).toMatchObject({ error: { _tag: "PresenceError", reason } })
                if (!result.isErr()) throw new Error("Expected PresenceError")
                return result.error
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
            if (Exit.isFailure(exit)) {
                expect(exit.cause.reasons).toContainEqual(
                    expect.objectContaining({
                        _tag: "Fail",
                        error: expect.objectContaining({ _tag: "PresenceError", reason: "input" }),
                    }),
                )
                const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                if (failure?._tag === "Fail") return failure.error
            }
            throw new Error("Expected PresenceError")
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
            if (Exit.isFailure(exit)) {
                expect(exit.cause.reasons).toContainEqual(
                    expect.objectContaining({
                        _tag: "Fail",
                        error: expect.objectContaining({ _tag: "PresenceError", reason }),
                    }),
                )
                const failure = exit.cause.reasons.find((entry) => entry._tag === "Fail")
                if (failure?._tag === "Fail") return failure.error
            }
            throw new Error("Expected PresenceError")
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

test("observed presence keeps a recognized status and reports an unrecognized provider status as unknown", () => {
    const observed = (status: string) =>
        decodePresenceUpdate({ user: { id: "30" }, status, mobile: false, afk: false, guild_id: "20" })?.status
    for (const status of ["online", "idle", "dnd", "offline", "invisible"]) expect(observed(status)).toBe(status)
    for (const status of ["streaming", "ONLINE", "away", " online"]) expect(observed(status)).toBe("unknown")
    expect(
        decodePresenceUpdateBulk({
            guild_id: "20",
            presences: [
                { user: { id: "30" }, status: "idle", mobile: true, afk: false },
                { user: { id: "31" }, status: "future-status", mobile: false, afk: true },
            ],
        })?.presences.map((presence) => presence.status),
    ).toEqual(["idle", "unknown"])
})

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
    expect(owner.set({ status: "online", customStatus: { text: "retained" } })).toBeUndefined()
    owner.attach((update) => void sent.push(update))
    clock.advance(0)
    expect(sent).toEqual([{ status: "online", afk: false, mobile: false, custom_status: { text: "retained" } }])

    expect(owner.set({ status: "idle" })).toBeUndefined()
    clock.advance(3_999)
    expect(sent).toHaveLength(1)
    clock.advance(1)
    expect(sent).toEqual([
        { status: "online", afk: false, mobile: false, custom_status: { text: "retained" } },
        { status: "idle", afk: false, mobile: false, custom_status: { text: "retained" } },
    ])

    expect(owner.set({ status: "dnd", customStatus: { text: "first" } })).toBeUndefined()
    expect(owner.set({ status: "invisible", customStatus: null })).toBeUndefined()
    clock.advance(4_000)
    expect(sent.at(-1)).toEqual({ status: "invisible", afk: false, mobile: false, custom_status: null })

    expect(owner.set({ status: "online" })).toBeUndefined()
    owner.detach()
    clock.advance(4_000)
    expect(sent).toHaveLength(3)
    owner.attach((update) => void sent.push(update))
    clock.advance(0)
    expect(sent.at(-1)).toEqual({ status: "online", afk: false, mobile: false, custom_status: null })

    expect(owner.set({ status: "dnd" })).toBeUndefined()
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
        (frame) => void memberFrames.push(frame),
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
        (frame) => void memberFrames.push(frame),
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
        (frame) => void memberFrames.push(frame),
        "resume",
    )
    clock.advance(0)
    expect(memberFrames.at(-1)).toEqual({ subscriptions: { "40": { members: [] } } })
    owner.detach()
    owner.attach(
        () => undefined,
        (frame) => void memberFrames.push(frame),
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
        (frame) => void memberFrames.push(frame),
        "resume",
    )
    clock.advance(0)
    expect(memberFrames).toEqual([])
})

test("member presence validates identifier, per-client capacity and the complete Op14 byte budget before changing state", () => {
    const clock = timers()
    const sent: unknown[] = []
    const owner = new PresenceOwner(clock.timer)
    expect(owner.setMembers("invalid", ["30"])).toMatchObject({ detail: { path: "guildId", constraint: "format" } })
    expect(owner.setMembers("40", ["30", "30"])).toMatchObject({ detail: { path: "memberIds", constraint: "unique" } })
    expect(
        owner.setMembers(
            "40",
            Array.from({ length: 1_001 }, (_, index) => String(index + 1)),
        ),
    ).toBe("limit")

    const id = (index: number) => String(9_000_000_000_000_000_000n + BigInt(index))
    const frameBytes = (members: readonly string[]) =>
        Buffer.byteLength(JSON.stringify({ op: 14, d: { subscriptions: { "40": { members } } } }))
    let largest = 0
    while (frameBytes(Array.from({ length: largest + 1 }, (_, index) => id(index))) <= 4_096) largest += 1
    const fitting = Array.from({ length: largest }, (_, index) => id(index))
    // A shorter final ID fills the byte budget without exceeding the gateway snowflake bound
    fitting.push("1".repeat(4_096 - frameBytes(fitting) - 3))
    const exceeding = [...fitting.slice(0, -1), fitting.at(-1)! + "1"]
    expect(frameBytes(fitting)).toBe(4_096)
    expect(frameBytes(exceeding)).toBe(4_097)
    expect(owner.setMembers("40", fitting)).toBeUndefined()
    expect(owner.setMembers("40", exceeding)).toBe("limit")
    owner.attach(
        () => undefined,
        (frame) => void sent.push(frame),
    )
    clock.advance(0)
    expect(sent).toEqual([{ subscriptions: { "40": { members: fitting } } }])
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
    ).toBeUndefined()
    vi.setSystemTime(10_000)
    owner.attach((update) => void sent.push(update))
    clock.advance(0)
    expect(sent).toEqual([{ status: "online", afk: false, mobile: false }])
})

test.each(modes)(
    "%s presence accepts disconnected intent, rejects invalid input and releases it on close",
    async (mode) => {
        const api = await publicDriver(mode)
        try {
            expect(api.state()).toBe("Disconnected")
            api.set({ status: "idle", customStatus: { text: "queued while disconnected" } })
            const invalid = api.invalid({ status: "offline", callerSecret: "private rejected value" })
            expect(invalid).toMatchObject({
                inputValidation: { path: "input", constraint: "allowedFields" },
            })
            expect(Object.isFrozen((invalid as { readonly inputValidation: unknown }).inputValidation)).toBe(true)
            // The unsupported key is named so a misspelling can be found, but its value is never copied
            expect(
                (invalid as { readonly inputValidation: { readonly explanation: string } }).inputValidation.explanation,
            ).toContain('"callerSecret"')
            expect(JSON.stringify(invalid)).not.toContain("private rejected value")
            const limit = api.invalidMembers(
                "40",
                Array.from({ length: 1_001 }, (_, index) => String(index + 1)),
                "limit",
            )
            expect(limit).toMatchObject({ inputValidation: null })
            expect(wsTarget.sockets).toEqual([])
            await api.shutdown()
            expect(api.state()).toBe("Closed")
            api.closed()
            expect(wsTarget.sockets).toEqual([])
        } finally {
            await api.shutdown()
        }
    },
)

test.each(modes)("%s accepts only real future calendar dates for custom-status expiration", async (mode) => {
    const api = await publicDriver(mode)
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2029-01-01T00:00:00Z"))
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    try {
        for (const expiresAt of ["2030-02-29T00:00Z", "2030-02-30T00:00:00+02:00", "2031-04-31T00:00:00Z"]) {
            expect(api.invalid({ status: "online", customStatus: { expiresAt } })).toMatchObject({
                inputValidation: { path: "customStatus.expiresAt", constraint: "format" },
            })
        }
        for (const expiresAt of ["2032-02-29T00:00Z", "2030-01-01T24:00Z", "2030-01-01T12:00:00.123456789+02:00"]) {
            api.set({ status: "online", customStatus: { expiresAt } })
        }
        expect(fetch).not.toHaveBeenCalled()
        expect(wsTarget.sockets).toEqual([])
    } finally {
        now.mockRestore()
        await api.shutdown()
    }
})

test.each(modes)(
    "%s member selection refreshes unchanged input and reconciles a clear after RESUMED and guild availability",
    async (mode) => {
        const fixture = await publicGateway()
        const api = await publicDriver(mode)
        try {
            api.invalidMembers("40", new Array(1), "input")
            api.setMembers("40", ["30"])
            api.invalidMembers("invalid", ["30"], "input")
            api.invalidMembers(
                "40",
                Array.from({ length: 1_001 }, (_, index) => String(index + 1)),
                "limit",
            )
            expect(wsTarget.sockets).toEqual([])
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
            // No reconnect jitter, so the replacement connection starts without a real backoff wait
            vi.spyOn(Math, "random").mockReturnValue(0)
            fixture.sockets[0]!.close(4000)
            api.setMembers("40", [])
            await vi.waitFor(
                () =>
                    expect(fixture.commands.some((command) => command.connection === 1 && command.op === 14)).toBe(
                        true,
                    ),
                { interval: 5 },
            )
            const resumed = () => fixture.commands.filter((command) => command.connection === 1 && command.op === 14)
            expect(resumed().map((command) => command.d)).toEqual([{ subscriptions: { "40": { members: [] } } }])
            fixture.dispatch(
                "GUILD_CREATE",
                { id: "40", properties: { id: "40", name: "fixture", owner_id: "90", features: [] } },
                fixture.sockets[1],
            )
            await vi.waitFor(() => expect(resumed()).toHaveLength(2))
            expect(resumed().at(-1)?.d).toEqual({ subscriptions: { "40": { members: [] } } })
        } finally {
            await api.shutdown()
        }
    },
)

test.each(modes)(
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
            // The retained presence is restored with its own opcode 3 after IDENTIFY
            const identify = fixture.commands.findIndex((command) => command.op === 2)
            expect(fixture.commands.findIndex((command) => command.op === 3)).toBeGreaterThan(identify)
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
                () => expect(wsTarget.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true),
                { interval: 5 },
            )
            for (const socket of wsTarget.sockets)
                for (const event of ["open", "message", "error", "close"])
                    expect(getEventListeners(socket, event)).toHaveLength(0)
        } finally {
            await api.shutdown()
        }
    },
)
