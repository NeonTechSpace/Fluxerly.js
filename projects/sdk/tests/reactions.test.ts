import { once } from "node:events"
import { Session } from "node:inspector"
import { setImmediate as turn } from "node:timers/promises"
import { Clock, Context, Effect, Exit, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import {
    createClient,
    type EventName,
    type ReactionEmojiInput,
    type ReactionUsersQuery,
    type DefaultMessageOperationOptions,
    type ReactionUsersPage,
    type DefaultReactionCollectorOptions,
    type MessageReference,
    SdkDefect,
} from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const transport = vi.hoisted(() => ({ url: "", sequence: 1, sockets: [] as import("ws").WebSocket[] }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(_url: string, options: import("ws").ClientOptions) {
                super(transport.url, options)
                transport.sockets.push(this)
            }
        },
    }
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    transport.sockets = []
})
const target = { id: "10", channelId: "20" }
const wire = { id: "10", channel_id: "20", content: "preserved", author: { id: "30", username: "fixture" } }
const modes = ["default", "native"] as const
const moderationOperations = ["removeUserReaction", "clearReaction", "clearReactions"] as const

test.each(modes)("%s completed reaction handles release filters and rejected batch snapshots", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    const weak: WeakRef<object>[] = []
    async function tracked() {
        const filter = (reaction: object) => {
            weak.push(new WeakRef(reaction))
            return true
        }
        weak.push(new WeakRef(filter))
        return api.collect({ filter, maxBytes: 1 })
    }
    const collector = await tracked()
    deliverReaction(
        {
            message_id: "10",
            channel_id: "20",
            reactions: [{ user_id: "30", emoji: { name: "✅" } }],
        },
        "MESSAGE_REACTION_ADD_MANY",
    ).deliver()
    await expect(collector.wait()).rejects.toMatchObject({ reason: "overflow" })
    expect(weak).toHaveLength(2)
    const session = new Session()
    session.connect()
    try {
        for (let attempt = 0; attempt < 10; attempt++) {
            await turn()
            await new Promise<void>((resolve, reject) =>
                session.post("HeapProfiler.collectGarbage", (error) => (error ? reject(error) : resolve())),
            )
            if (weak.every((reference) => reference.deref() === undefined)) break
        }
        expect(weak.map((reference) => reference.deref() === undefined)).toEqual([true, true])
    } finally {
        session.disconnect()
    }
    expect(api.state()).toBe("Connected")
    await expect(collector.wait()).rejects.toMatchObject({ reason: "overflow" })
})

const addition = (userId = "30", name = "✅", id = "10", channel = "20") => ({
    message_id: id,
    channel_id: channel,
    user_id: userId,
    emoji: { name },
})
const observed = (userId = "30", name = "✅") => ({ ...target, userId, emoji: { name } })
// Synchronous transport delivery makes pending-queue and deadline boundaries deterministic
function deliverReaction(body: unknown, event = "MESSAGE_REACTION_ADD") {
    const data = Buffer.from(JSON.stringify({ op: 0, s: ++transport.sequence, t: event, d: body }))
    return { bytes: data.length, deliver: () => transport.sockets.at(-1)!.emit("message", data, false) }
}

test.each(modes)("%s reaction collector validates registration without network work", async (mode) => {
    const requests = vi.fn(async () => new Response(null, { status: 204 }))
    mockRest(requests)
    const api = await setup(mode)
    await expect(api.collect()).rejects.toMatchObject({ _tag: "CollectorError", reason: "notConnected" })
    for (const options of [
        null,
        { maxReactions: 0 },
        { maxReactions: 1.5 },
        { maxMessages: 1 },
        { timeoutMs: 2_147_483_648 },
        { maxBytes: Infinity },
        { maxPendingMessages: NaN },
        { maxPendingBytes: "1" },
        { filter: 3 },
        { onReaction: 3 },
        { unknown: true },
        { signal: {} },
    ])
        await expect(api.collect(options as any)).rejects.toMatchObject({ _tag: "ConfigurationError" })
    for (const message of [null, {}, { id: "x", channelId: "20" }, { id: "10", channelId: "020" }])
        await expect(api.collect({}, message as MessageReference)).rejects.toMatchObject({
            _tag: "ConfigurationError",
            field: "message",
        })
    expect(requests).not.toHaveBeenCalled()
    await api.shutdown()
    await expect(api.collect()).rejects.toMatchObject({ _tag: "ClientClosedError" })
})

test("default reaction collection turns an onReaction getter defect into a sanitized SdkDefect", async () => {
    const api = await setup("default")
    const privateBody = "private onReaction getter defect"
    const options = Object.defineProperty({}, "onReaction", {
        get() {
            throw new Error(privateBody)
        },
    })
    let error: unknown
    try {
        api.defaultApi!.messages.collectReactions(target, options as DefaultReactionCollectorOptions)
    } catch (caught) {
        error = caught
    }
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({ operation: "collectReactions", reasons: [{ kind: "Defect" }] })
    expect(JSON.stringify(error)).not.toContain(privateBody)
    expect(String(error)).not.toContain(privateBody)
})

test.each(modes)("%s rejects malformed emoji selectors locally using the shared reaction input rules", async (mode) => {
    const requests = vi.fn(async () => new Response(null, { status: 204 }))
    mockRest(requests)
    const api = await setup(mode)
    for (const emoji of [
        null,
        1,
        "",
        "%F0%9F%91%8D",
        "<:party:50>",
        "\ud800",
        { id: "50" },
        { name: "party", id: "bad" },
        { name: "party", id: "50", extra: true },
    ]) {
        await expect(api.collect({ emoji } as any)).rejects.toMatchObject({
            _tag: "ConfigurationError",
            field: "emoji",
        })
    }
    expect(requests).not.toHaveBeenCalled()
})

test.each(modes.flatMap((mode) => [false, true].map((custom) => ({ mode, custom }))))(
    "$mode emoji selector custom=$custom gates filters and progress across singles and batches",
    async ({ mode, custom }) => {
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        const emoji = custom ? { name: "party", id: "50" } : "👍"
        const selected = custom ? { name: "renamed", id: "50" } : { name: "👍" }
        const excluded = custom
            ? [{ name: "party", id: "51" }, { name: "party" }]
            : [{ name: "👍🏽" }, { name: "👍", id: "50" }, { name: "👍️" }]
        const filterCalls: string[] = [],
            progressCalls: string[] = []
        const callback = (reaction: import("../src/index.js").MessageReaction) => {
            progressCalls.push(reaction.userId)
        }
        const options = {
            emoji,
            maxReactions: 2,
            filter: (reaction: import("../src/index.js").MessageReaction) => {
                filterCalls.push(reaction.userId)
                return reaction.userId === "30"
            },
        }
        const collector = await progress(api, callback, (reaction) => Effect.sync(() => callback(reaction)), options)
        if (typeof emoji !== "string") {
            emoji.id = "99"
            emoji.name = "changed"
        }
        options.emoji = "❌"
        for (const emoji of excluded) deliverReaction({ ...addition(), emoji }).deliver()
        deliverReaction({ ...addition("31"), emoji: selected }).deliver()
        deliverReaction({ ...addition(), emoji: selected }).deliver()
        deliverReaction(
            {
                message_id: "10",
                channel_id: "20",
                reactions: [...excluded.map((emoji) => ({ user_id: "32", emoji })), { user_id: "30", emoji: selected }],
            },
            "MESSAGE_REACTION_ADD_MANY",
        ).deliver()
        const result = await collector.wait()
        expect(result.reason).toBe("limit")
        expect(result.reactions).toEqual([0, 1].map(() => ({ ...target, userId: "30", emoji: selected })))
        expect(filterCalls).toEqual(["31", "30", "30"])
        expect(progressCalls).toEqual(["30", "30"])
    },
)

test.each(modes)(
    "%s emoji selection does not bypass pending limits and preserves timeout and filter failures",
    async (mode) => {
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        const filter = vi.fn(() => {
            throw Error("private filter failure")
        })
        const ignored = await api.collect({ emoji: "👍", filter, timeoutMs: 30 })
        deliverReaction(addition()).deliver()
        expect(await ignored.wait()).toEqual({ reason: "timeout", reactions: [] })
        expect(filter).not.toHaveBeenCalled()
        const failed = await api.collect({ emoji: "👍", filter })
        deliverReaction(addition("30", "👍")).deliver()
        await expect(failed.wait()).rejects.toMatchObject({ reason: "filter" })
        const full = await api.collect({ emoji: "👍", maxPendingMessages: 1 })
        deliverReaction(addition()).deliver()
        deliverReaction(addition()).deliver()
        await expect(full.wait()).rejects.toMatchObject({ reason: "overflow", limit: "maxPendingMessages" })
    },
)

test.each(modes)(
    "%s reaction collector selects message, user and emoji and counts repeated additions",
    async (mode) => {
        const dispatch = await gateway()
        mockRest(async () => Response.json(wire))
        const api = await setup(mode)
        await api.connect()
        deliverReaction(addition()).deliver()
        const calls: string[] = []
        const message = { ...target }
        const options = {
            maxReactions: 2,
            filter: (reaction: import("../src/index.js").MessageReaction) => {
                calls.push(reaction.userId + reaction.emoji.name)
                return reaction.userId === "30" && reaction.emoji.name === "✅"
            },
        }
        const collector = await api.collect(options, message)
        message.id = "999"
        options.maxReactions = 100
        await api.fetch()
        dispatch("MESSAGE_REACTION_ADD", addition("30", "✅", "11"))
        dispatch("MESSAGE_REACTION_ADD", addition("30", "✅", "10", "21"))
        dispatch("MESSAGE_REACTION_ADD", addition("31"))
        dispatch("MESSAGE_REACTION_ADD", addition("30", "👍"))
        dispatch("MESSAGE_REACTION_ADD", addition())
        dispatch("MESSAGE_REACTION_REMOVE", addition())
        dispatch("MESSAGE_REACTION_REMOVE_ALL", { message_id: "10", channel_id: "20" })
        dispatch("MESSAGE_REACTION_REMOVE_EMOJI", { message_id: "10", channel_id: "20", emoji: { name: "✅" } })
        dispatch("MESSAGE_DELETE", { id: "10", channel_id: "20" })
        dispatch("MESSAGE_REACTION_ADD", addition())
        const result = await collector.wait()
        expect(result).toEqual({ reason: "limit", reactions: [observed(), observed()] })
        expect(calls).toEqual(["31✅", "30👍", "30✅", "30✅"])
        expect(
            Object.isFrozen(result) &&
                Object.isFrozen(result.reactions) &&
                result.reactions.every((r) => Object.isFrozen(r) && Object.isFrozen(r.emoji)),
        ).toBe(true)
        await collector.stop()
        deliverReaction(addition()).deliver()
        await turn()
        expect(calls).toHaveLength(4)
        expect(await collector.wait()).toBe(result)
    },
)

test.each(modes)("%s reaction collector flattens batches in order without synthetic single events", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    const single = vi.fn()
    await api.on("messageReactionAdd", single)
    const batch = {
        message_id: "10",
        channel_id: "20",
        guild_id: "40",
        reactions: [
            { user_id: "31", emoji: { name: "✅" } },
            { user_id: "30", emoji: { name: "party", id: "45", animated: true } },
            { user_id: "30", emoji: { name: "party", id: "45" } },
            { user_id: "32", emoji: { name: "✅" } },
        ],
    }
    const frame = deliverReaction(batch, "MESSAGE_REACTION_ADD_MANY")
    const filter = vi.fn((reaction: import("../src/index.js").MessageReaction) => reaction.emoji.id === "45")
    const collector = await api.collect({
        maxReactions: 2,
        maxPendingMessages: 1,
        maxPendingBytes: frame.bytes,
        filter,
    })
    frame.deliver()
    const result = await collector.wait()
    expect(result).toEqual({
        reason: "limit",
        reactions: [
            { ...target, guildId: "40", userId: "30", emoji: { name: "party", id: "45", animated: true } },
            { ...target, guildId: "40", userId: "30", emoji: { name: "party", id: "45" } },
        ],
    })
    expect(filter).toHaveBeenCalledTimes(3)
    expect(single).not.toHaveBeenCalled()
    expect(result.reactions.every((r) => Object.isFrozen(r) && Object.isFrozen(r.emoji))).toBe(true)
    const tooSmall = await api.collect({ maxPendingBytes: frame.bytes - 1 })
    frame.deliver()
    await expect(tooSmall.wait()).rejects.toMatchObject({
        reason: "overflow",
        limit: "maxPendingBytes",
        capacity: frame.bytes - 1,
    })
})

test.each(modes)(
    "%s reaction collector separates admitted pending payloads from retained UTF-8 budgets",
    async (mode) => {
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        const bytes = Buffer.byteLength(JSON.stringify(observed()))
        const exact = await api.collect({ maxBytes: bytes })
        deliverReaction(addition()).deliver()
        expect(await exact.wait()).toEqual({ reason: "limit", reactions: [observed()] })
        const retained = await api.collect({ maxReactions: 2, maxBytes: bytes })
        deliverReaction(addition()).deliver()
        await turn()
        deliverReaction(addition()).deliver()
        await expect(retained.wait()).rejects.toMatchObject({ reason: "overflow", limit: "maxBytes", capacity: bytes })
        const filter = vi.fn(() => true)
        const pending = await api.collect({ maxReactions: 3, maxPendingMessages: 1, filter })
        for (let i = 0; i < 5; i++) deliverReaction(addition("30", "✅", "11")).deliver()
        deliverReaction(addition()).deliver()
        deliverReaction(addition()).deliver()
        await expect(pending.wait()).rejects.toMatchObject({
            reason: "overflow",
            limit: "maxPendingMessages",
            capacity: 1,
        })
        expect(filter).not.toHaveBeenCalled()
        const defaults = await api.collect({ maxReactions: 1000 })
        for (let i = 0; i < 257; i++) deliverReaction(addition()).deliver()
        await expect(defaults.wait()).rejects.toMatchObject({ limit: "maxPendingMessages", capacity: 256 })
    },
)

test.each(modes)(
    "%s reaction collector timeout is total, checks slow filters and stop preserves partial results",
    async (mode) => {
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        let now = 0
        vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(
            () => BigInt(now) * 1_000_000n,
        )
        const collector = await api.collect({ maxReactions: 5 })
        now = 29_999
        deliverReaction(addition()).deliver()
        await turn()
        now = 30_000
        deliverReaction(addition()).deliver()
        expect(await collector.wait()).toEqual({ reason: "timeout", reactions: [observed()] })
        const slow = await api.collect({
            timeoutMs: 100,
            filter: () => {
                now += 100
                return true
            },
        })
        deliverReaction(addition()).deliver()
        expect(await slow.wait()).toEqual({ reason: "timeout", reactions: [] })
        const empty = await api.collect({ timeoutMs: 5 })
        now += 5
        expect(await empty.wait()).toEqual({ reason: "timeout", reactions: [] })
        const stopped = await api.collect({ maxReactions: 5 })
        deliverReaction(addition()).deliver()
        await turn()
        const first = stopped.wait()
        const second = stopped.wait()
        await stopped.stop()
        await stopped.stop()
        expect(await first).toEqual({ reason: "stopped", reactions: [observed()] })
        expect(await second).toBe(await first)
    },
)

test.each(modes)(
    "%s reaction collector isolates invalid filters and keeps failures free of private data",
    async (mode) => {
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        for (const filter of [
            () => {
                throw Error("private-filter")
            },
            () => undefined,
            async () => {
                throw Error("private-filter")
            },
        ]) {
            const collector = await api.collect({ filter: filter as any })
            deliverReaction(addition()).deliver()
            const error = await collector.wait().catch((e) => e)
            expect(error).toMatchObject({ _tag: "CollectorError", reason: "filter" })
            expect(error).not.toHaveProperty("reactions")
            expect(JSON.stringify(error)).not.toContain("private-")
            expect(api.state()).toBe("Connected")
        }
    },
)

test.each(modes)(
    "%s reaction collector waiter cancellation leaves other observers and collection running",
    async (mode) => {
        const dispatch = await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        const collector = await api.collect()
        const controller = new AbortController()
        const cancelled = collector.wait(controller.signal).catch(() => "cancelled")
        const other = collector.wait()
        controller.abort()
        expect(await cancelled).toBe("cancelled")
        dispatch("MESSAGE_REACTION_ADD", addition())
        expect(await other).toEqual({ reason: "limit", reactions: [observed()] })
    },
)

test.each(modes)(
    "%s reaction collector fails across a real gap and can be registered again after resume",
    async (mode) => {
        const dispatch = await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        vi.spyOn(Math, "random").mockReturnValue(0)
        const collector = await api.collect({ maxReactions: 5 })
        deliverReaction(addition()).deliver()
        await turn()
        transport.sockets.at(-1)!.close(4000)
        await expect(collector.wait()).rejects.toMatchObject({ _tag: "CollectorError", reason: "connectionLost" })
        await vi.waitFor(() => expect(transport.sockets).toHaveLength(2), { interval: 5 })
        await vi.waitFor(() => expect(api.state()).toBe("Connected"), { interval: 5 })
        const resumed = await api.collect()
        dispatch("MESSAGE_REACTION_ADD", addition())
        expect(await resumed.wait()).toMatchObject({ reason: "limit" })
    },
)

test.each(modes)("%s shutdown releases reaction collector timers and pending filters", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    const clearTimer = vi.spyOn(globalThis, "clearTimeout")
    const clearWork = vi.spyOn(globalThis, "clearImmediate")
    const filter = vi.fn(() => true)
    const collector = await api.collect({ filter })
    deliverReaction(addition()).deliver()
    await api.shutdown()
    await expect(collector.wait()).rejects.toMatchObject({ _tag: "ClientClosedError" })
    expect(filter).not.toHaveBeenCalled()
    expect(clearTimer).toHaveBeenCalled()
    expect(clearWork).toHaveBeenCalled()
    expect(transport.sockets.every((s) => s.readyState === 3 && s.listenerCount("message") === 0)).toBe(true)
})

test("default reaction collection abort and reentrant stop release intake and preserve first completion", async () => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup("default")
    await api.connect()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    const collector = await api.collect({ maxReactions: 5, signal: controller.signal })
    deliverReaction(addition()).deliver()
    await turn()
    controller.abort()
    await expect(collector.wait()).rejects.toMatchObject({ _tag: "CancelledError" })
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
    await expect(api.collect({ signal: controller.signal })).rejects.toMatchObject({ _tag: "CancelledError" })
    const filter = vi.fn(() => {
        source.stop()
        return true
    })
    const source = unwrap(api.defaultApi!.messages.collectReactions(target, { filter }))
    deliverReaction(addition()).deliver()
    expect(unwrap(await source.waitForClose())).toEqual({ reason: "stopped", reactions: [] })
    deliverReaction(addition()).deliver()
    await turn()
    expect(filter).toHaveBeenCalledTimes(1)
})

test("native reaction registration is lazy, retains caller clock and releases its own scope", async () => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup("native")
    await api.connect()
    const filter = vi.fn(() => true)
    const effect = api.native!.messages.collectReactions(target, { maxReactions: 5, filter })
    deliverReaction(addition()).deliver()
    await turn()
    expect(filter).not.toHaveBeenCalled()
    let now = 0
    const clock = { ...Effect.runSync(Clock.Clock), monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n }
    const collector = await Effect.runPromise(
        effect.pipe(Scope.provide(api.collectorScope), Effect.provideService(Clock.Clock, clock)),
    )
    deliverReaction(addition()).deliver()
    await turn()
    await Effect.runPromise(Scope.close(api.collectorScope, Exit.void))
    expect(await Effect.runPromise(collector.waitForClose())).toEqual({ reason: "stopped", reactions: [observed()] })
    expect(api.state()).toBe("Connected")
    const scope = Scope.makeUnsafe()
    const timed = await Effect.runPromise(effect.pipe(Scope.provide(scope), Effect.provideService(Clock.Clock, clock)))
    now = 30_000
    deliverReaction(addition()).deliver()
    expect(await Effect.runPromise(timed.waitForClose())).toEqual({ reason: "timeout", reactions: [] })
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await expect(api.collect({ signal: new AbortController().signal })).rejects.toMatchObject({
        _tag: "ConfigurationError",
    })
})

test.each(modes)("%s reaction collector keeps unexpected defects in its entry-point boundary", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    const original = Buffer.byteLength
    const collector = await api.collect({
        filter: () => {
            vi.spyOn(Buffer, "byteLength").mockImplementation((input, encoding) => {
                if (typeof input === "string" && input.includes('"channelId"')) throw Error("private-defect")
                return original(input, encoding)
            })
            return true
        },
    })
    deliverReaction(addition()).deliver()
    const error = await collector.wait().catch((e) => e)
    if (mode === "default") {
        expect(error).toBeInstanceOf(SdkDefect)
        expect(error.operation).toBe("reactionCollector.waitForClose")
        expect(JSON.stringify(error)).not.toContain("private-")
    } else expect(error).toBeInstanceOf(Error)
    expect(api.state()).toBe("Connected")
})

test.each(modes)(
    "%s targets moderation exactly and preserves unrelated reactors, emoji and cached messages",
    async (mode) => {
        const state = new Map([
            ["👍", ["30", "31", "32"]],
            ["party:45", ["30", "31"]],
        ])
        const paths: string[] = []
        mockRest(async (url, init) => {
            const path = new URL(url).pathname
            if (!path.includes("/reactions")) return Response.json(wire)
            const parts = path.split("/").slice(7).map(decodeURIComponent)
            if (init.method === "GET")
                return Response.json({
                    items: (state.get(parts[0]!) ?? []).map((id) => ({ id, username: `user${id}` })),
                    has_more: false,
                    next_after: null,
                })
            expect(init.method).toBe("DELETE")
            expect(init.body).toBeUndefined()
            paths.push(path)
            if (parts.length === 0) state.clear()
            else if (parts.length === 1) state.delete(parts[0]!)
            else
                state.set(
                    parts[0]!,
                    (state.get(parts[0]!) ?? []).filter((id) => id !== parts[1]),
                )
            return new Response(null, { status: 204 })
        })
        const api = await setup(mode)
        const cached = await api.fetch()
        await api.moderate("removeUserReaction")
        expect((await api.users()).items.map((user) => user.id)).toEqual(["30", "32"])
        const custom = { name: "party", id: "45" }
        expect((await api.users(custom)).items.map((user) => user.id)).toEqual(["30", "31"])
        await api.moderate("clearReaction", custom)
        expect((await api.users(custom)).items).toEqual([])
        expect((await api.users()).items.map((user) => user.id)).toEqual(["30", "32"])
        await api.moderate("clearReactions")
        expect((await api.users()).items).toEqual([])
        expect(await api.get()).toBe(cached)
        expect(paths).toEqual([
            `/v1/channels/20/messages/10/reactions/${encodeURIComponent("👍")}/31`,
            "/v1/channels/20/messages/10/reactions/party%3A45",
            "/v1/channels/20/messages/10/reactions",
        ])
    },
)

test.each(modes)("%s validates destructive targets and never replays uncertain moderation", async (mode) => {
    let calls = 0,
        status = 204
    mockRest(async () => {
        calls++
        return new Response(null, { status })
    })
    const api = await setup(mode)
    for (const userId of ["", "@me", "31/32", "01", null])
        await expect(api.moderate("removeUserReaction", "👍", userId as string)).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    for (const emoji of [null, "", "a/b"])
        await expect(api.moderate("clearReaction", emoji as ReactionEmojiInput)).rejects.toMatchObject({
            operation: "clearReaction",
            reason: "input",
        })
    expect(calls).toBe(0)
    for (const operation of moderationOperations) {
        for (const [code, reason, outcome] of [
            [403, "rejected", "rejected"],
            [404, "notFound", "rejected"],
            [500, "rejected", "unknown"],
            [200, "response", "unknown"],
        ] as const) {
            status = code
            await expect(api.moderate(operation)).rejects.toMatchObject({ operation, reason, outcome, status })
        }
    }
    expect(calls).toBe(12)
})

test.each(modes)("%s bounds moderation rate waits and awaits cancellation and shutdown", async (mode) => {
    for (const operation of moderationOperations) {
        const api = await setup(mode)
        let calls = 0
        mockRest(async () =>
            ++calls === 1 ? Response.json({ retry_after: 0.01 }, { status: 429 }) : new Response(null, { status: 204 }),
        )
        await api.moderate(operation)
        expect(calls).toBe(2)
        let active = 0
        mockRest(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    active++
                    init.signal!.addEventListener(
                        "abort",
                        () => {
                            active--
                            reject(Error("private"))
                        },
                        { once: true },
                    )
                }),
        )
        const controller = new AbortController()
        const cancelled = api.moderate(operation, "👍", "31", { signal: controller.signal }).catch(() => "cancelled")
        await vi.waitFor(() => expect(active).toBe(1))
        controller.abort()
        expect(await cancelled).toBe("cancelled")
        expect(active).toBe(0)
        const pending = api.moderate(operation).catch((error: unknown) => error)
        await vi.waitFor(() => expect(active).toBe(1))
        await api.shutdown()
        expect(await pending).toMatchObject({ _tag: "ClientClosedError" })
        expect(active).toBe(0)
    }
})

test.each(modes)(
    "%s fetches explicit frozen reactor pages without cache changes or automatic traversal",
    async (mode) => {
        const pages = [
            {
                items: [
                    { id: "9007199254740993", username: "one", bot: true, private: "discard" },
                    { id: "9007199254740994", username: "two" },
                ],
                has_more: true,
                next_after: "9007199254740994",
            },
            { items: [{ id: "9007199254740995", username: "three" }], has_more: false, next_after: null },
            { items: [], has_more: false, next_after: null },
        ]
        const calls: string[] = []
        mockRest(async (url, init) => {
            if (!url.includes("/reactions/")) return Response.json(wire)
            expect(init.method).toBe("GET")
            expect(init.body).toBeUndefined()
            calls.push(url)
            return Response.json(pages[calls.length - 1])
        })
        const api = await setup(mode)
        const cached = await api.fetch()
        const first = await api.users("👍", { limit: 2 })
        expect(calls).toHaveLength(1)
        expect(first).toEqual({
            items: [
                { id: "9007199254740993", username: "one", isBot: true },
                { id: "9007199254740994", username: "two", isBot: false },
            ],
            hasMore: true,
            nextAfter: "9007199254740994",
        })
        expect(Object.isFrozen(first) && Object.isFrozen(first.items) && first.items.every(Object.isFrozen)).toBe(true)
        const last = await api.users({ name: "party", id: "45" }, { limit: 100, after: first.nextAfter! })
        expect(last.hasMore).toBe(false)
        expect(last.nextAfter).toBeNull()
        expect(calls[1]).toBe(
            "https://api.fluxer.app/v1/channels/20/messages/10/reactions/party%3A45/users?limit=100&after=9007199254740994",
        )
        expect(await api.users()).toEqual({ items: [], hasMore: false, nextAfter: null })
        expect(calls[2]).toContain("limit=25")
        expect(await api.get()).toBe(cached)
    },
)

test.each(modes)(
    "%s rejects invalid reactor queries before dispatch and malformed pages without partial results",
    async (mode) => {
        let calls = 0
        let body: unknown = null
        mockRest(async () => {
            calls++
            return Response.json(body)
        })
        const api = await setup(mode)
        for (const query of [
            null,
            { limit: 0 },
            { limit: 101 },
            { limit: 1.5 },
            { after: "01" },
            { after: 42 },
            { before: "1" },
        ])
            await expect(api.users("👍", query as ReactionUsersQuery)).rejects.toMatchObject({
                operation: "fetchReactionUsers",
                reason: "input",
                outcome: "notDispatched",
            })
        await expect(api.users("%invalid")).rejects.toMatchObject({ reason: "input" })
        expect(calls).toBe(0)
        const user = { id: "31", username: "one" }
        for (const invalid of [
            null,
            [],
            { items: [], has_more: true, next_after: "31" },
            { items: [user], has_more: true, next_after: "32" },
            { items: [user], has_more: false, next_after: "31" },
            { items: [user], has_more: false },
            { items: [user, user], has_more: false, next_after: null },
            { items: [{ ...user, id: "30" }], has_more: false, next_after: null },
            { items: [{ ...user, bot: null }], has_more: false, next_after: null },
            { items: [{ ...user, username: null }], has_more: false, next_after: null },
            { items: [user, { ...user, id: "32" }, { ...user, id: "33" }], has_more: false, next_after: null },
        ]) {
            body = invalid
            await expect(api.users("👍", { limit: 2, after: "30" })).rejects.toMatchObject({
                operation: "fetchReactionUsers",
                reason: "response",
                status: 200,
            })
        }
    },
)

test.each(modes)("%s classifies reactor read failures and shares reaction rate limits", async (mode) => {
    let calls = 0,
        status = 403
    mockRest(async () => {
        calls++
        return new Response(null, { status })
    })
    const api = await setup(mode)
    for (const [code, reason] of [
        [403, "rejected"],
        [404, "notFound"],
        [500, "rejected"],
        [204, "response"],
    ] as const) {
        status = code
        const before = calls
        await expect(api.users()).rejects.toMatchObject({ operation: "fetchReactionUsers", reason, status })
        expect(calls - before).toBe(code === 500 ? 3 : 1)
    }
    calls = 0
    mockRest(async () =>
        ++calls === 1
            ? Response.json({ retry_after: 0.01 }, { status: 429 })
            : Response.json({ items: [], has_more: false, next_after: null }),
    )
    await api.users()
    expect(calls).toBe(2)
    mockRest(async () => {
        calls++
        return Response.json({ retry_after: 60 }, { status: 429 })
    })
    await expect(api.add("👍", 30)).rejects.toMatchObject({ reason: "rateLimit" })
    const before = calls
    await expect(api.users("👍", undefined, { timeoutMs: 30 })).rejects.toMatchObject({
        operation: "fetchReactionUsers",
    })
    expect(calls).toBe(before)
})

test.each(modes)("%s releases active reactor reads on cancellation and shutdown", async (mode) => {
    let active = 0
    mockRest(
        (_url, init) =>
            new Promise((_resolve, reject) => {
                active++
                init.signal!.addEventListener(
                    "abort",
                    () => {
                        active--
                        reject(new Error("private"))
                    },
                    { once: true },
                )
            }),
    )
    const api = await setup(mode)
    const controller = new AbortController()
    const cancelled = api.cancelledUsers(controller.signal)
    await vi.waitFor(() => expect(active).toBe(1))
    controller.abort()
    expect(await cancelled).toBe(true)
    expect(active).toBe(0)
    const pending = api.users().catch((error: unknown) => error)
    await vi.waitFor(() => expect(active).toBe(1))
    await api.shutdown()
    expect(await pending).toMatchObject({ _tag: "ClientClosedError" })
    expect(active).toBe(0)
    await expect(api.users()).rejects.toMatchObject({ _tag: "ClientClosedError" })
})
function unwrap<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}
async function progress(
    api: Awaited<ReturnType<typeof setup>>,
    defaultApi: NonNullable<DefaultReactionCollectorOptions["onReaction"]>,
    native: NonNullable<import("../src/effect.js").ReactionCollectorOptions<unknown>["onReaction"]>,
    options: import("../src/collectors.js").ReactionCollectorOptions = {},
) {
    if (api.defaultApi) {
        const collector = unwrap(
            api.defaultApi.messages.collectReactions(target, { ...options, onReaction: defaultApi }),
        )
        return { stop: async () => collector.stop(), wait: async () => unwrap(await collector.waitForClose()) }
    }
    const collector = await Effect.runPromise(
        api
            .native!.messages.collectReactions(target, { ...options, onReaction: native })
            .pipe(Scope.provide(api.collectorScope)),
    )
    return {
        stop: () => Effect.runPromise(collector.stop()),
        wait: () =>
            Effect.runPromise(Effect.result(collector.waitForClose())).then((r) => {
                if (r._tag === "Failure") throw r.failure
                return r.success
            }),
    }
}

test.each(modes)(
    "%s delivers accepted progress sequentially before the terminal result, including batches",
    async (mode) => {
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        let release!: () => void
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        const calls: string[] = []
        const handler = async (reaction: import("../src/index.js").MessageReaction) => {
            calls.push(reaction.userId)
            expect(Object.isFrozen(reaction)).toBe(true)
            if (calls.length === 1) await held
        }
        const collector = await progress(api, handler, (reaction) => Effect.promise(() => handler(reaction)), {
            maxReactions: 2,
            filter: (r) => r.userId !== "29",
        })
        let closed = false
        const result = collector.wait().then((r) => {
            closed = true
            return r
        })
        deliverReaction(
            {
                message_id: "10",
                channel_id: "20",
                reactions: ["29", "30", "31", "32"].map((user_id) => ({ user_id, emoji: { name: "✅" } })),
            },
            "MESSAGE_REACTION_ADD_MANY",
        ).deliver()
        await vi.waitFor(() => expect(calls).toEqual(["30"]))
        expect(closed).toBe(false)
        release()
        expect(await result).toEqual({ reason: "limit", reactions: [observed("30"), observed("31")] })
        expect(calls).toEqual(["30", "31"])
    },
)

test.each(modes)("%s progress failure is sanitized and collector-local, without retry", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    let calls = 0
    const fail = () => {
        calls++
        throw new Error("private callback body")
    }
    const collector = await progress(api, fail, () => Effect.sync(fail), { maxReactions: 3 })
    deliverReaction(addition()).deliver()
    const error = await collector.wait().catch((e) => e)
    expect(error).toMatchObject({ _tag: "CollectorError", reason: "handler" })
    expect(JSON.stringify(error)).not.toContain("private callback body")
    deliverReaction(addition()).deliver()
    await turn()
    expect(calls).toBe(1)
    expect(api.state()).toBe("Connected")
    const next = await api.collect()
    deliverReaction(addition()).deliver()
    expect(await next.wait()).toMatchObject({ reason: "limit" })
})

test.each(modes)("%s releases failed reaction progress callbacks and snapshots after closure", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    const weak: WeakRef<object>[] = []

    async function trackedFailure() {
        const defaultApi = (reaction: import("../src/index.js").MessageReaction) => {
            weak.push(new WeakRef(reaction))
            throw new Error("fixture failure")
        }
        const native = (reaction: import("../src/index.js").MessageReaction) => Effect.sync(() => defaultApi(reaction))
        weak.push(new WeakRef(defaultApi), new WeakRef(native))
        return progress(api, defaultApi, native, { maxReactions: 2 })
    }

    const failed = await trackedFailure()
    deliverReaction(addition()).deliver()
    await expect(failed.wait()).rejects.toMatchObject({ _tag: "CollectorError", reason: "handler" })

    const session = new Session()
    session.connect()
    try {
        for (let attempt = 0; attempt < 10; attempt++) {
            await turn()
            await new Promise<void>((resolve, reject) =>
                session.post("HeapProfiler.collectGarbage", (error) => (error ? reject(error) : resolve())),
            )
            if (weak.every((reference) => reference.deref() === undefined)) break
        }
        expect(weak.map((reference) => reference.deref() === undefined)).toEqual([true, true, true])
    } finally {
        session.disconnect()
    }
    expect(await failed.wait().catch((error) => error)).toMatchObject({ _tag: "CollectorError", reason: "handler" })
})

test.each(
    modes.flatMap((mode) =>
        ["stop", "timeout", "shutdown", "scope", "recovery", "overflow"]
            .filter((reason) => mode === "native" || reason !== "scope")
            .map((reason) => ({ mode, reason })),
    ),
)("$mode $reason interrupts progress and waits for cleanup", async ({ mode, reason }) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    let started = false,
        cancelled = false,
        cleaned = false,
        closed = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    const collector = await progress(
        api,
        async (_reaction, signal) => {
            started = true
            await new Promise<void>((resolve) => {
                if (signal.aborted) resolve()
                else signal.addEventListener("abort", resolve, { once: true })
            })
            cancelled = true
            await held
            cleaned = true
        },
        () =>
            Effect.sync(() => {
                started = true
            }).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                    Effect.promise(async () => {
                        cancelled = true
                        await held
                        cleaned = true
                    }),
                ),
            ),
        { maxReactions: 10, timeoutMs: reason === "timeout" ? 100 : 10_000, maxPendingMessages: 1 },
    )
    const result = collector.wait().then(
        (r) => {
            closed = true
            return r
        },
        (e) => {
            closed = true
            return e
        },
    )
    deliverReaction(addition()).deliver()
    await vi.waitFor(() => expect(started).toBe(true))
    let operation: Promise<unknown> = Promise.resolve()
    if (reason === "stop") operation = collector.stop()
    if (reason === "shutdown") operation = Promise.resolve(api.shutdown())
    if (reason === "scope") operation = Effect.runPromise(Scope.close(api.collectorScope, Exit.void))
    if (reason === "recovery") transport.sockets.at(-1)!.terminate()
    if (reason === "overflow") {
        deliverReaction(addition("31")).deliver()
        deliverReaction(addition("32")).deliver()
    }
    await vi.waitFor(() => expect(cancelled).toBe(true))
    expect(closed).toBe(false)
    expect(cleaned).toBe(false)
    release()
    await operation
    const outcome = await result
    expect(cleaned).toBe(true)
    expect(outcome).toMatchObject(
        reason === "shutdown"
            ? { _tag: "ClientClosedError" }
            : reason === "recovery"
              ? { reason: "connectionLost" }
              : reason === "overflow"
                ? { reason: "overflow" }
                : { reason: reason === "timeout" ? "timeout" : "stopped" },
    )
})

test.each(modes)("%s progress never runs before retained-byte admission and releases its handler", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    let calls = 0
    const rejected = await progress(
        api,
        () => {
            calls++
        },
        () =>
            Effect.sync(() => {
                calls++
            }),
        { maxBytes: 1 },
    )
    deliverReaction(addition()).deliver()
    await expect(rejected.wait()).rejects.toMatchObject({ reason: "overflow", limit: "maxBytes" })
    expect(calls).toBe(0)
    const weak: WeakRef<object>[] = []
    async function tracked() {
        const defaultApi = () => {
            calls++
        }
        const native = () => Effect.sync(defaultApi)
        weak.push(new WeakRef(defaultApi), new WeakRef(native))
        return progress(api, defaultApi, native)
    }
    const collector = await tracked()
    deliverReaction(addition()).deliver()
    expect(await collector.wait()).toMatchObject({ reason: "limit" })
    const session = new Session()
    session.connect()
    try {
        for (let attempt = 0; attempt < 10; attempt++) {
            await turn()
            await new Promise<void>((resolve, reject) =>
                session.post("HeapProfiler.collectGarbage", (error) => (error ? reject(error) : resolve())),
            )
            if (weak.every((reference) => reference.deref() === undefined)) break
        }
        expect(weak.map((reference) => reference.deref() === undefined)).toEqual([true, true])
    } finally {
        session.disconnect()
    }
    expect(await collector.wait()).toMatchObject({ reason: "limit" })
})

test("default collection abort waits for the active progress promise", async () => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup("default")
    await api.connect()
    const controller = new AbortController()
    let started = false,
        cleaned = false
    const collector = unwrap(
        api.defaultApi!.messages.collectReactions(target, {
            signal: controller.signal,
            onReaction: async (_reaction, signal) => {
                started = true
                await new Promise<void>((resolve) => signal.addEventListener("abort", resolve, { once: true }))
                await turn()
                cleaned = true
            },
        }),
    )
    deliverReaction(addition()).deliver()
    await vi.waitFor(() => expect(started).toBe(true))
    controller.abort()
    const result = await collector.waitForClose()
    expect(result.isErr() && result.error._tag).toBe("CancelledError")
    expect(cleaned).toBe(true)
})

test.each(modes)("%s slow final progress cannot turn an expired deadline into limit success", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    let now = 0
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    const advance = () => {
        now = 100
    }
    const collector = await progress(api, advance, () => Effect.sync(advance), { timeoutMs: 100 })
    deliverReaction(addition()).deliver()
    expect(await collector.wait()).toEqual({ reason: "timeout", reactions: [observed()] })
})

test("native progress can request client shutdown without joining itself", async () => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup("native")
    await api.connect()
    const collector = await Effect.runPromise(
        api
            .native!.messages.collectReactions(target, {
                onReaction: () => api.native!.shutdown(),
            })
            .pipe(Scope.provide(api.collectorScope)),
    )
    deliverReaction(addition()).deliver()
    const outcome = await Effect.runPromise(Effect.result(collector.waitForClose()))
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "ClientClosedError" } })
    await api.shutdown()
    expect(api.state()).toBe("Closed")
})

test("native progress preserves defects raised during terminal cleanup", async () => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup("native")
    await api.connect()
    let started = false
    const collector = await Effect.runPromise(
        api
            .native!.messages.collectReactions(target, {
                onReaction: () =>
                    Effect.sync(() => {
                        started = true
                    }).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.die("fixture cleanup defect"))),
            })
            .pipe(Scope.provide(api.collectorScope)),
    )
    deliverReaction(addition()).deliver()
    await vi.waitFor(() => expect(started).toBe(true))
    await Effect.runPromise(collector.stop())
    const exit = await Effect.runPromiseExit(collector.waitForClose())
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
})

test("native reaction progress retains registration services and releases its scope", async () => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup("native")
    await api.connect()
    const Label = Context.Service<string>("reaction-progress-label")
    const labels: string[] = []
    const collector = await Effect.runPromise(
        api
            .native!.messages.collectReactions(target, {
                onReaction: () =>
                    Effect.gen(function* () {
                        labels.push(yield* Label)
                    }),
            })
            .pipe(Effect.provideService(Label, "registration"), Scope.provide(api.collectorScope)),
    )
    deliverReaction(addition()).deliver()
    await Effect.runPromise(collector.waitForClose())
    expect(labels).toEqual(["registration"])
})

async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const collectorScope = Scope.makeUnsafe()
    const run = async <A, E>(effect: Effect.Effect<A, E>) => {
        const result = await Effect.runPromise(Effect.result(effect))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const defaultApi =
        mode === "default"
            ? unwrap(createClient({ token: "fixture", cache: { messages: { maxEntries: 10 } } }))
            : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  createNative({ token: "fixture", cache: { messages: { maxEntries: 10 } } }).pipe(
                      Effect.provideService(Scope.Scope, scope),
                  ),
              )
            : undefined
    const shutdown = () => (defaultApi ? defaultApi.shutdown().then(unwrap) : run(native!.shutdown()))
    onTestFinished(async () => {
        await shutdown()
        await Effect.runPromise(Scope.close(collectorScope, Exit.void))
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        defaultApi,
        native,
        collectorScope,
        state: () => (defaultApi ?? native)!.state,
        collect: async (
            options?: Omit<DefaultReactionCollectorOptions, "onReaction">,
            message: MessageReference = target,
        ) => {
            if (defaultApi) {
                const source = unwrap(defaultApi.messages.collectReactions(message, options))
                return {
                    stop: async () => source.stop(),
                    wait: async (signal?: AbortSignal) =>
                        unwrap(await source.waitForClose(signal ? { signal } : undefined)),
                }
            }
            const source = await run(
                native!.messages.collectReactions(message, options).pipe(Scope.provide(collectorScope)),
            )
            return {
                stop: () => run(source.stop()),
                wait: (signal?: AbortSignal) =>
                    Effect.runPromise(source.waitForClose().pipe(Effect.result), signal ? { signal } : undefined).then(
                        (result) => {
                            if (result._tag === "Failure") throw result.failure
                            return result.success
                        },
                    ),
            }
        },
        shutdown,
        connect: () => (defaultApi ? defaultApi.connect().then(unwrap) : run(native!.connect())),
        get: () =>
            defaultApi ? Promise.resolve(unwrap(defaultApi.messages.get(target))) : run(native!.messages.get(target)),
        fetch: () =>
            defaultApi ? defaultApi.messages.fetch(target).then(unwrap) : run(native!.messages.fetch(target)),
        add: (emoji: ReactionEmojiInput, timeoutMs = 1_000) =>
            defaultApi
                ? defaultApi.messages.addReaction(target, emoji, { timeoutMs }).then(unwrap)
                : run(native!.messages.addReaction(target, emoji, { timeoutMs })),
        remove: (emoji: ReactionEmojiInput) =>
            defaultApi
                ? defaultApi.messages.removeReaction(target, emoji).then(unwrap)
                : run(native!.messages.removeReaction(target, emoji)),
        moderate: async (
            operation: (typeof moderationOperations)[number],
            emoji: ReactionEmojiInput = "👍",
            userId = "31",
            options?: Omit<DefaultMessageOperationOptions, "signal"> & { signal?: AbortSignal },
        ) => {
            if (defaultApi)
                return unwrap(
                    await (operation === "removeUserReaction"
                        ? defaultApi.messages.removeUserReaction(target, emoji, userId, options)
                        : operation === "clearReaction"
                          ? defaultApi.messages.clearReaction(target, emoji, options)
                          : defaultApi.messages.clearReactions(target, options)),
                )
            const effect =
                operation === "removeUserReaction"
                    ? native!.messages.removeUserReaction(target, emoji, userId, options)
                    : operation === "clearReaction"
                      ? native!.messages.clearReaction(target, emoji, options)
                      : native!.messages.clearReactions(target, options)
            return Effect.runPromise(effect, options?.signal ? { signal: options.signal } : undefined)
        },
        users: async (
            emoji: ReactionEmojiInput = "👍",
            query?: ReactionUsersQuery,
            options?: DefaultMessageOperationOptions,
        ) =>
            defaultApi
                ? unwrap<ReactionUsersPage, unknown>(
                      await defaultApi.messages.fetchReactionUsers(target, emoji, query, options),
                  )
                : run(native!.messages.fetchReactionUsers(target, emoji, query, options)),
        cancelledUsers: (signal: AbortSignal) =>
            defaultApi
                ? defaultApi.messages.fetchReactionUsers(target, "👍", undefined, { signal }).then((r) => r.isErr())
                : Effect.runPromiseExit(native!.messages.fetchReactionUsers(target, "👍"), { signal }).then(
                      Exit.isFailure,
                  ),
        cancelled: (signal: AbortSignal) =>
            defaultApi
                ? defaultApi.messages.addReaction(target, "👍", { signal }).then((r) => r.isErr())
                : Effect.runPromiseExit(native!.messages.addReaction(target, "👍"), { signal }).then(Exit.isFailure),
        on: async (event: EventName, handler: (value: unknown) => void, maxPendingMessages = 256) => {
            if (defaultApi) return unwrap(defaultApi.on(event, handler, { maxPendingMessages }))
            return run(
                native!
                    .on(event, (value) => Effect.sync(() => handler(value)), { maxPendingMessages })
                    .pipe(Effect.provideService(Scope.Scope, scope)),
            )
        },
        readOne: async (event: EventName) => {
            if (defaultApi) {
                const source = unwrap(defaultApi.events(event))
                try {
                    return unwrap(await source.next())
                } finally {
                    source.unsubscribe()
                }
            }
            const values = await run(Stream.runCollect(native!.events(event).pipe(Stream.take(1))))
            return values[0]
        },
        closed: () => (defaultApi ? defaultApi.waitForClose().then(unwrap) : run(native!.waitForClose())),
    }
}

function mockRest(handler: (url: string, init: RequestInit) => Promise<Response>) {
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) =>
        url.endsWith("/gateway/bot")
            ? Promise.resolve(Response.json({ url: "wss://gateway.fluxer.app" }))
            : handler(url, init),
    )
}

async function gateway() {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Missing port")
    transport.url = `ws://127.0.0.1:${address.port}`
    transport.sequence = 1
    server.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const packet = JSON.parse(data.toString())
            if (packet.op === 2)
                socket.send(JSON.stringify({ op: 0, s: transport.sequence, t: "READY", d: { session_id: "fixture" } }))
            if (packet.op === 6) socket.send(JSON.stringify({ op: 0, s: ++transport.sequence, t: "RESUMED", d: {} }))
            if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }))
        })
    })
    onTestFinished(async () => {
        for (const socket of server.clients) socket.terminate()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return (event: string, body: unknown) => {
        for (const socket of server.clients)
            socket.send(JSON.stringify({ op: 0, s: ++transport.sequence, t: event, d: body }))
    }
}

test.each(modes)("%s encodes own reactions, leaves message cache intact and synthesizes no events", async (mode) => {
    const calls: [string, string][] = []
    mockRest(async (url, init) => {
        if (init.method === "GET") return Response.json(wire)
        calls.push([url, init.method!])
        expect(init.body).toBeUndefined()
        expect(init.redirect).toBe("error")
        return new Response(null, { status: 204 })
    })
    const api = await setup(mode)
    const cached = await api.fetch()
    const events: unknown[] = []
    await api.on("messageReactionAdd", (event) => events.push(event))
    for (const emoji of ["👍🏽", "👨‍👩‍👧‍👦", "1️⃣", { name: "party", id: "45" }]) {
        await api.add(emoji)
        await api.remove(emoji)
    }
    expect(calls[0]).toEqual([
        `https://api.fluxer.app/v1/channels/20/messages/10/reactions/${encodeURIComponent("👍🏽")}/@me`,
        "PUT",
    ])
    expect(calls.at(-1)).toEqual([
        "https://api.fluxer.app/v1/channels/20/messages/10/reactions/party%3A45/@me",
        "DELETE",
    ])
    expect(await api.get()).toBe(cached)
    expect(events).toEqual([])
    for (const invalid of ["", "%F0%9F%91%8D", "<:party:45>", "a/b", "\ud800", { name: "party", id: "bad" }, null])
        await expect(api.add(invalid as ReactionEmojiInput)).rejects.toMatchObject({
            _tag: "MessageOperationError",
            operation: "addReaction",
            reason: "input",
            outcome: "notDispatched",
        })
    expect(calls).toHaveLength(8)
})

test.each(modes)("%s reports rejection and uncertain outcomes without unsafe replay", async (mode) => {
    let status = 403,
        calls = 0
    mockRest(async () => {
        calls++
        return new Response(null, { status })
    })
    const api = await setup(mode)
    for (const [code, reason, outcome] of [
        [403, "rejected", "rejected"],
        [404, "notFound", "rejected"],
        [500, "rejected", "unknown"],
        [200, "response", "unknown"],
    ] as const) {
        status = code
        await expect(api.remove("👍")).rejects.toMatchObject({ operation: "removeReaction", reason, outcome })
    }
    expect(calls).toBe(4)
})

test.each(modes)("%s retries only confirmed 429 and bounds waits by the original deadline", async (mode) => {
    let calls = 0
    mockRest(async () =>
        ++calls === 1 ? Response.json({ retry_after: 0.01 }, { status: 429 }) : new Response(null, { status: 204 }),
    )
    const api = await setup(mode)
    await api.add("👍")
    expect(calls).toBe(2)
    mockRest(async () => Response.json({ retry_after: 60 }, { status: 429 }))
    await expect(api.add("👍", 30)).rejects.toMatchObject({ reason: "rateLimit" })
})

test.each(modes)("%s awaits cancellation and shutdown of active reaction requests", async (mode) => {
    let active = 0,
        aborted = 0
    mockRest(
        (_url, init) =>
            new Promise((_resolve, reject) => {
                active++
                init.signal!.addEventListener(
                    "abort",
                    () => {
                        active--
                        aborted++
                        reject(new Error("fixture private failure"))
                    },
                    { once: true },
                )
            }),
    )
    const api = await setup(mode)
    const controller = new AbortController()
    const cancelled = api.cancelled(controller.signal)
    await vi.waitFor(() => expect(active).toBe(1))
    controller.abort()
    expect(await cancelled).toBe(true)
    expect(active).toBe(0)
    const pending = Promise.resolve(api.add("👍")).catch((error: unknown) => error)
    await vi.waitFor(() => expect(active).toBe(1))
    await api.shutdown()
    expect(await pending).toMatchObject({ _tag: "ClientClosedError" })
    expect([active, aborted]).toEqual([0, 2])
})

test.each(modes)(
    "%s routes frozen reaction variants through callbacks and reads without cache eviction",
    async (mode) => {
        const dispatch = await gateway()
        mockRest(async () => Response.json(wire))
        const api = await setup(mode)
        const cached = await api.fetch()
        const base = { message_id: "10", channel_id: "20", guild_id: "99", session_id: "private" }
        const entries = [
            [
                "MESSAGE_REACTION_ADD",
                "messageReactionAdd",
                { ...base, user_id: "30", emoji: { name: "party", id: "45", animated: true } },
            ],
            [
                "MESSAGE_REACTION_REMOVE",
                "messageReactionRemove",
                { ...base, user_id: "31", emoji: { name: "party", id: "45" } },
            ],
            ["MESSAGE_REACTION_REMOVE_ALL", "messageReactionRemoveAll", base],
            ["MESSAGE_REACTION_REMOVE_EMOJI", "messageReactionRemoveEmoji", { ...base, emoji: { name: "👍" } }],
            [
                "MESSAGE_REACTION_ADD_MANY",
                "messageReactionAddMany",
                {
                    ...base,
                    reactions: [
                        { user_id: "30", emoji: { name: "👍" } },
                        { user_id: "31", emoji: { name: "party", id: "45" } },
                    ],
                },
            ],
        ] as const
        const received: unknown[] = []
        for (const [, event] of entries) await api.on(event, (value) => received.push(value))
        const read = api.readOne("messageReactionAddMany")
        await api.connect()
        for (const [wireEvent, , body] of entries) dispatch(wireEvent, body)
        await vi.waitFor(() => expect(received).toHaveLength(5))
        const batch = await read
        expect(batch).toEqual({
            ...target,
            guildId: "99",
            reactions: [
                { userId: "30", emoji: { name: "👍" } },
                { userId: "31", emoji: { name: "party", id: "45" } },
            ],
        })
        const checkFrozen = (value: unknown) => {
            if (value && typeof value === "object") {
                expect(Object.isFrozen(value)).toBe(true)
                Object.values(value).forEach(checkFrozen)
            }
        }
        received.forEach(checkFrozen)
        expect(JSON.stringify(received)).not.toContain("private")
        expect(received[1]).toEqual({ ...target, guildId: "99", userId: "31", emoji: { name: "party", id: "45" } })
        expect(await api.get()).toBe(cached)
    },
)

test.each(modes)("%s rejects a malformed reaction as a protocol failure without partial delivery", async (mode) => {
    const dispatch = await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    const received: unknown[] = []
    await api.on("messageReactionAddMany", (event) => received.push(event))
    await api.connect()
    const closed = Promise.resolve(api.closed()).catch((error: unknown) => error)
    dispatch("MESSAGE_REACTION_ADD_MANY", {
        channel_id: "20",
        message_id: "10",
        reactions: [
            { user_id: "30", emoji: { name: "👍" } },
            { user_id: "31", emoji: { name: "party", id: null } },
        ],
    })
    expect(await closed).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
    expect(received).toEqual([])
})
