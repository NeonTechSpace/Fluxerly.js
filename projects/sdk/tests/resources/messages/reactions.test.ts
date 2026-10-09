import { Session } from "node:inspector"
import { setImmediate as turn } from "node:timers/promises"
import { runInNewContext } from "node:vm"
import { Clock, Context, Effect, Exit, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    format,
    type EventName,
    type ReactionEmojiInput,
    type ReactionUsersQuery,
    type DefaultMessageOperationOptions,
    type ReactionUsersPage,
    type DefaultReactionCollectorOptions,
    type MessageReference,
    SdkDefect,
    type FailureReport,
} from "../../../src/index.js"
import { format as nativeFormat } from "../../../src/effect.js"
import { LogicalScheduler } from "../../../src/internal/logical-scheduler.js"
import {
    defaultApi as createDefaultApi,
    modes,
    nativeApi as createNativeApi,
    type Mode,
} from "../../support/both-apis.js"
import { driveSdkTime, sdkClock } from "../../support/client-clock.js"
import { waitUntil } from "../../support/clock.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { settle, typedResult } from "../../support/settle.js"
import { expectDefect, expectThrown } from "../defects.js"
import { startSynchronousGateway, type SynchronousGateway } from "../../support/messages-gateway.js"
import { wsTarget } from "../../support/ws-redirect.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    wsTarget.sockets = []
})
const target = { id: "10", channelId: "20" }
const wire = { id: "10", channel_id: "20", content: "preserved", author: { id: "30", username: "fixture" } }
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
    if (!current) throw new Error("Start the gateway before delivering reactions")
    return current.prepare(event, body)
}

test.each(modes)("%s reaction collector validates registration without network work", async (mode) => {
    const requests = vi.fn(async () => new Response(null, { status: 204 }))
    mockRest(requests)
    const api = await setup(mode)
    await expect((await api.collect()).wait()).rejects.toMatchObject({
        _tag: "CollectorError",
        reason: "notConnected",
    })
    if (api.native)
        expect(
            await expectDefect(
                api.native.messages
                    .collectReactions(target, { maxReactions: 0 })
                    .pipe(Scope.provide(api.collectorScope)),
            ),
        ).toMatchObject({ _tag: "ConfigurationError" })
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
        expect(await api.collectMisuse(options as any)).toMatchObject({ _tag: "ConfigurationError" })
    for (const idleMs of [0, -1, 1.5, NaN, Infinity, "1", null, 2_147_483_648])
        expect(await api.collectMisuse({ idleMs } as any)).toMatchObject({
            _tag: "ConfigurationError",
            field: "idleMs",
        })
    await expect((await api.collect({ idleMs: 2_147_483_647 })).wait()).rejects.toMatchObject({
        reason: "notConnected",
    })
    for (const message of [null, {}, { id: "x", channelId: "20" }, { id: "10", channelId: "020" }])
        expect(await api.collectMisuse({}, message as MessageReference)).toMatchObject({
            _tag: "ConfigurationError",
            field: "message",
        })
    expect(requests).not.toHaveBeenCalled()
    await api.shutdown()
    // Shutdown can race a registering handler, so a closed client returns a handle whose result is ClientClosedError,
    // while an invalid target stays misuse
    await expect((await api.collect()).wait()).rejects.toMatchObject({ _tag: "ClientClosedError" })
    expect(await api.collectMisuse({}, {} as MessageReference)).toMatchObject({ _tag: "ConfigurationError" })
})

// A throwing options getter is application code read by the SDK, so it is classified as an application.defect with
// the thrown value kept as the cause
test("default reaction collection throws an application SdkDefect that keeps the thrown value for an onReaction getter", async () => {
    const api = await setup("default")
    const getterFailure = new Error("fixture onReaction getter failure")
    const options = Object.defineProperty({}, "onReaction", {
        get() {
            throw getterFailure
        },
    })
    const error = expectThrown(() =>
        api.defaultApi!.messages.collectReactions(target, options as DefaultReactionCollectorOptions),
    )
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        _tag: "SdkDefect",
        code: "application.defect",
        operation: "collectReactions",
        reasons: [{ kind: "Defect", origin: "application", defect: getterFailure }],
    })
    expect((error as SdkDefect).cause).toBe(getterFailure)
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
        "<:party:bad>",
        "<a:party:50> trailing",
        "\ud800",
        { id: "50" },
        { name: "party", id: "bad" },
        { name: "party", id: "50", extra: true },
        { name: "party", id: "50", animated: "yes" },
        { name: "👍", animated: true },
    ]) {
        expect(await api.collectMisuse({ emoji } as any)).toMatchObject({
            _tag: "ConfigurationError",
            field: "emoji",
        })
    }
    expect(requests).not.toHaveBeenCalled()
})

test.each(modes)("%s captures custom emoji identity before reaction dispatch", async (mode) => {
    const calls: string[] = []
    mockRest(async (url, init) => {
        calls.push(`${init.method} ${new URL(url).pathname}`)
        return new Response(null, { status: 204 })
    })
    const api = await setup(mode)
    let nameReads = 0
    let idReads = 0
    const changingEmoji = {
        get name() {
            return ++nameReads === 1 ? "party" : "renamed"
        },
        get id() {
            return ++idReads === 1 ? "50" : "51"
        },
    }
    await api.add(changingEmoji)
    expect([nameReads, idReads]).toEqual([1, 1])
    expect(calls).toEqual(["PUT /v1/channels/20/messages/10/reactions/party%3A50/@me"])

    const firstInvalid = {
        get name() {
            return "party"
        },
        get id() {
            return "not-an-id"
        },
    }
    await expect(api.add(firstInvalid)).rejects.toMatchObject({
        operation: "addReaction",
        reason: "input",
        outcome: "notDispatched",
    })
    expect(calls).toHaveLength(1)
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
        const callback = (reaction: import("../../../src/index.js").MessageReaction) => {
            progressCalls.push(reaction.userId)
        }
        const options = {
            emoji,
            maxReactions: 2,
            filter: (reaction: import("../../../src/index.js").MessageReaction) => {
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
        const clock = sdkClock()
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        const filter = vi.fn(() => {
            throw Error("private filter failure")
        })
        const ignored = await api.collect({ emoji: "👍", filter, timeoutMs: 30 })
        deliverReaction(addition()).deliver()
        await clock.waiting(30)
        await clock.advance(30)
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
            filter: (reaction: import("../../../src/index.js").MessageReaction) => {
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
        await collector.close()
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
    const filter = vi.fn((reaction: import("../../../src/index.js").MessageReaction) => reaction.emoji.id === "45")
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
        // Sleeps wake only when the test says so, while the collector reads the manual time below
        const clock = sdkClock()
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
        await clock.waiting(5)
        await clock.advance(5)
        expect(await empty.wait()).toEqual({ reason: "timeout", reactions: [] })
        const stopped = await api.collect({ maxReactions: 5 })
        deliverReaction(addition()).deliver()
        await turn()
        const first = stopped.wait()
        const second = stopped.wait()
        await stopped.close()
        await stopped.close()
        expect(await first).toEqual({ reason: "stopped", reactions: [observed()] })
        expect(await second).toBe(await first)
    },
)

test.each(modes)("%s reaction idle renews accepted batch additions but not excluded input", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    let now = 0
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    const filter = vi.fn((reaction: import("../../../src/index.js").MessageReaction) => reaction.userId === "30")
    const options = { idleMs: 100, timeoutMs: 1_000, maxReactions: 5, emoji: "✅", filter }
    const collector = await api.collect(options)
    options.idleMs = 1
    now = 50
    deliverReaction(addition()).deliver()
    await turn()
    now = 149
    deliverReaction(
        { message_id: "10", channel_id: "20", reactions: [{ user_id: "30", emoji: { name: "✅" } }] },
        "MESSAGE_REACTION_ADD_MANY",
    ).deliver()
    await turn()
    now = 248
    deliverReaction(addition("30", "❌")).deliver()
    deliverReaction(addition("31")).deliver()
    deliverReaction(addition("30", "✅", "11")).deliver()
    await turn()
    expect(filter.mock.calls.map(([reaction]) => reaction.userId)).toEqual(["30", "30", "31"])
    now = 249
    deliverReaction(addition()).deliver()
    const result = await collector.wait()
    expect(result).toEqual({ reason: "idle", reactions: [observed(), observed()] })
    await collector.close()
    deliverReaction(addition()).deliver()
    await turn()
    expect(filter).toHaveBeenCalledTimes(3)
    expect(await collector.wait()).toBe(result)
})

test.each(modes)("%s reaction idle timer handles empty collection and an early wakeup after renewal", async (mode) => {
    const clock = sdkClock()
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    const empty = await api.collect({ idleMs: 1 })
    await clock.waiting(1)
    await clock.advance(1)
    expect(await empty.wait()).toEqual({ reason: "idle", reactions: [] })
    const schedule = vi.spyOn(LogicalScheduler.prototype, "set")
    const collectorTimers = () => schedule.mock.calls.filter(([, , owner]) => owner === "reaction collector").length
    const collector = await api.collect({ idleMs: 10, maxReactions: 5 })
    const scheduled = collectorTimers()
    await clock.waiting(10)
    await clock.advance(9)
    deliverReaction(addition()).deliver()
    await turn()
    let closed = false
    const result = collector.wait().then((value) => {
        closed = true
        return value
    })
    // The original deadline wakes before the renewed idle deadline and must reschedule rather than close
    await clock.advance(1)
    await waitUntil(() => collectorTimers() > scheduled, { message: "The early idle wakeup was not rescheduled" })
    expect(closed).toBe(false)
    await clock.advance(9)
    expect(await result).toEqual({ reason: "idle", reactions: [observed()] })
})

test.each(modes)("%s reaction idle preserves earliest deadlines, hard limits and slow-filter checks", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    let now = 0
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    for (const [idleMs, timeoutMs, reason] of [
        [50, 100, "idle"],
        [100, 50, "timeout"],
        [50, 50, "timeout"],
    ] as const) {
        const collector = await api.collect({ idleMs, timeoutMs })
        now += 120
        deliverReaction(addition()).deliver()
        expect(await collector.wait()).toEqual({ reason, reactions: [] })
    }
    const collector = await api.collect({ idleMs: 60, timeoutMs: 100, maxReactions: 5 })
    now += 50
    deliverReaction(addition()).deliver()
    await turn()
    now += 49
    deliverReaction(addition()).deliver()
    await turn()
    now += 1
    deliverReaction(addition()).deliver()
    expect(await collector.wait()).toEqual({ reason: "timeout", reactions: [observed(), observed()] })
    const slow = await api.collect({
        idleMs: 50,
        filter: () => {
            now += 50
            return true
        },
    })
    deliverReaction(addition()).deliver()
    expect(await slow.wait()).toEqual({ reason: "idle", reactions: [] })
})

test.each(modes)(
    "%s reaction collector isolates invalid filters and keeps failures free of private data",
    async (mode) => {
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        for (const [filter, keepsCause] of [
            [
                () => {
                    throw Error("private-filter")
                },
                true,
            ],
            [() => undefined, false],
            [
                async () => {
                    throw Error("private-filter")
                },
                false,
            ],
        ] as const) {
            const collector = await api.collect({ filter: filter as any })
            deliverReaction(addition()).deliver()
            const error = await collector.wait().catch((e) => e)
            expect(error).toMatchObject({ _tag: "CollectorError", reason: "filter" })
            expect(error).not.toHaveProperty("reactions")
            // Only a synchronously thrown filter error is kept as the cause
            if (keepsCause) expect((error as Error).cause).toMatchObject({ message: "private-filter" })
            else expect((error as Error).cause).toBeUndefined()
            expect(api.state()).toBe("Connected")
        }
    },
)

test.each(modes)("%s reaction filters contain rejected promises from every realm", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    const rejections: [unknown, Promise<unknown>][] = []
    const observe = (reason: unknown, promise: Promise<unknown>) => rejections.push([reason, promise])
    process.on("unhandledRejection", observe)
    onTestFinished(() => {
        process.off("unhandledRejection", observe)
    })

    const localReason = new Error("local rejected filter")
    const local = await api.collect({ filter: () => Promise.reject(localReason) as never })
    deliverReaction(addition()).deliver()
    await expect(local.wait()).rejects.toMatchObject({ _tag: "CollectorError", reason: "filter" })
    await turn()
    expect(rejections).toEqual([])

    const foreignReason = new Error("foreign rejected filter")
    const remote = await api.collect({
        filter: (() => runInNewContext("Promise.reject(reason)", { reason: foreignReason }) as Promise<never>) as never,
    })
    deliverReaction(addition()).deliver()
    await expect(remote.wait()).rejects.toMatchObject({ _tag: "CollectorError", reason: "filter" })
    await turn()
    expect(rejections).toEqual([])
})

test.each(modes.flatMap((mode) => [false, true].map((foreign) => ({ mode, foreign }))))(
    "$mode reaction filters contain hostile rejected promise access, foreign=$foreign",
    async ({ mode, foreign }) => {
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        const privateDetail = "private rejected promise getter"
        const rejections: [unknown, Promise<unknown>][] = []
        const observe = (reason: unknown, promise: Promise<unknown>) => rejections.push([reason, promise])
        process.on("unhandledRejection", observe)
        onTestFinished(() => {
            process.off("unhandledRejection", observe)
        })
        const collector = await api.collect({
            filter: () => {
                const rejected = foreign
                    ? (runInNewContext("Promise.reject(reason)", {
                          reason: new Error(privateDetail),
                      }) as Promise<never>)
                    : Promise.reject(new Error(privateDetail))
                for (const key of ["then", "catch"])
                    // oxlint-disable-next-line typescript/no-floating-promises -- defineProperty returns the rejected promise, which the filter returns below
                    Object.defineProperty(rejected, key, {
                        get() {
                            throw new Error(privateDetail)
                        },
                    })
                return rejected as never
            },
        })
        deliverReaction(addition()).deliver()
        const error = await collector.wait().catch((cause) => cause)
        expect(error).toMatchObject({ _tag: "CollectorError", reason: "filter" })
        expect(JSON.stringify(error)).not.toContain(privateDetail)
        await turn()
        expect(rejections).toEqual([])
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
        wsTarget.sockets.at(-1)!.close(4000)
        await expect(collector.wait()).rejects.toMatchObject({ _tag: "CollectorError", reason: "connectionLost" })
        await vi.waitFor(() => expect(wsTarget.sockets).toHaveLength(2), { interval: 5 })
        await vi.waitFor(() => expect(api.state()).toBe("Connected"), { interval: 5 })
        const resumed = await api.collect()
        dispatch("MESSAGE_REACTION_ADD", addition())
        expect(await resumed.wait()).toMatchObject({ reason: "limit" })
    },
)

/** The error and its cause chain, so a wrapped callback failure can be found by identity */
function errorChain(error: unknown): unknown[] {
    const chain: unknown[] = []
    let current = error
    while (current !== undefined && !chain.includes(current)) {
        chain.push(current)
        current = (current as { cause?: unknown } | null)?.cause
    }
    return chain
}

/** Long-lived handles opened since before, leaving out the Immediate callbacks the runner queues between turns */
function openedSince(before: readonly string[]): string[] {
    const remaining = [...before]
    return process.getActiveResourcesInfo().filter((kind) => {
        if (kind === "Immediate") return false
        const index = remaining.indexOf(kind)
        if (index < 0) return true
        remaining.splice(index, 1)
        return false
    })
}

test.each(modes)("%s shutdown releases reaction collector handles and never runs pending filters", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const before = process.getActiveResourcesInfo()
    const api = await setup(mode)
    await api.connect()
    const filter = vi.fn(() => true)
    const collector = await api.collect({ filter })
    deliverReaction(addition()).deliver()
    // The connected client holds its gateway socket, so the final check has something to release
    expect(openedSince(before)).not.toEqual([])
    await api.shutdown()
    await expect(collector.wait()).rejects.toMatchObject({ _tag: "ClientClosedError" })
    // A pending drain that shutdown left scheduled would run its filter on this turn
    await turn()
    expect(filter).not.toHaveBeenCalled()
    await expect.poll(() => openedSince(before)).toEqual([])
    expect(wsTarget.sockets.every((s) => s.readyState === 3 && s.listenerCount("message") === 0)).toBe(true)
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
    await expect((await api.collect({ signal: controller.signal })).wait()).rejects.toMatchObject({
        _tag: "CancelledError",
    })
    const filter = vi.fn(() => {
        source.close()
        return true
    })
    const source = await settle(api.defaultApi!.messages.collectReactions(target, { filter }))
    deliverReaction(addition()).deliver()
    expect(await settle(source.result())).toEqual({ reason: "stopped", reactions: [] })
    deliverReaction(addition()).deliver()
    await turn()
    expect(filter).toHaveBeenCalledTimes(1)
})

test("native reaction registration is lazy, retains its owner clock and releases its own scope", async () => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    let now = 0
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    const api = await setup("native")
    await api.connect()
    const filter = vi.fn(() => true)
    const effect = api.native!.messages.collectReactions(target, { maxReactions: 5, filter })
    deliverReaction(addition()).deliver()
    await turn()
    expect(filter).not.toHaveBeenCalled()
    const collector = await Effect.runPromise(effect.pipe(Scope.provide(api.collectorScope)))
    deliverReaction(addition()).deliver()
    await turn()
    await Effect.runPromise(Scope.close(api.collectorScope, Exit.void))
    expect(await Effect.runPromise(collector.result())).toEqual({ reason: "stopped", reactions: [observed()] })
    expect(api.state()).toBe("Connected")
    const scope = Scope.makeUnsafe()
    const timed = await Effect.runPromise(effect.pipe(Scope.provide(scope)))
    now = 30_000
    deliverReaction(addition()).deliver()
    expect(await Effect.runPromise(timed.result())).toEqual({ reason: "timeout", reactions: [] })
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(await api.collectMisuse({ signal: new AbortController().signal })).toMatchObject({
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
        expect(error.operation).toBe("reactionCollector.result")
        expect(JSON.stringify(error)).toContain("private-")
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
        let afterReads = 0
        const changingAfter = {
            get after() {
                return ++afterReads === 1 ? "30" : "bad"
            },
        }
        body = { items: [], has_more: false, next_after: null }
        expect(await api.users("👍", changingAfter)).toEqual({ items: [], hasMore: false, nextAfter: null })
        expect(afterReads).toBe(1)
        const firstInvalid = {
            get after() {
                return "bad"
            },
        }
        await expect(api.users("👍", firstInvalid)).rejects.toMatchObject({
            operation: "fetchReactionUsers",
            reason: "input",
            outcome: "notDispatched",
        })
        expect(calls).toBe(1)
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
    const clock = sdkClock()
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
        await driveSdkTime(
            clock,
            expect(api.users()).rejects.toMatchObject({ operation: "fetchReactionUsers", reason, status }),
        )
        expect(calls - before).toBe(code === 500 ? 3 : 1)
    }
    calls = 0
    mockRest(async () =>
        ++calls === 1
            ? Response.json({ retry_after: 0.01 }, { status: 429 })
            : Response.json({ items: [], has_more: false, next_after: null }),
    )
    await driveSdkTime(clock, api.users())
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

async function progress(
    api: Awaited<ReturnType<typeof setup>>,
    defaultApi: NonNullable<DefaultReactionCollectorOptions["onReaction"]>,
    native: NonNullable<import("../../../src/effect.js").ReactionCollectorOptions<unknown>["onReaction"]>,
    options: import("../../../src/collectors.js").ReactionCollectorOptions = {},
) {
    if (api.defaultApi) {
        const collector = await settle(
            api.defaultApi.messages.collectReactions(target, { ...options, onReaction: defaultApi }),
        )
        return { close: async () => collector.close(), wait: async () => settle(collector.result()) }
    }
    const collector = await Effect.runPromise(
        api
            .native!.messages.collectReactions(target, { ...options, onReaction: native })
            .pipe(Scope.provide(api.collectorScope)),
    )
    return {
        close: () => Effect.runPromise(collector.close()),
        wait: () => settle(collector.result()),
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
        const handler = async (reaction: import("../../../src/index.js").MessageReaction) => {
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

test.each(modes)(
    "%s progress failure keeps the callback error, stays collector-local and is not retried",
    async (mode) => {
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        let calls = 0
        const callbackFailure = new Error("fixture callback failure")
        const fail = () => {
            calls++
            throw callbackFailure
        }
        const collector = await progress(api, fail, () => Effect.sync(fail), { maxReactions: 3 })
        deliverReaction(addition()).deliver()
        const error = await collector.wait().catch((e) => e)
        expect(error).toMatchObject({ _tag: "CollectorError", reason: "handler" })
        expect(errorChain(error)).toContain(callbackFailure)
        deliverReaction(addition()).deliver()
        await turn()
        expect(calls).toBe(1)
        expect(api.state()).toBe("Connected")
        const next = await api.collect()
        deliverReaction(addition()).deliver()
        expect(await next.wait()).toMatchObject({ reason: "limit" })
    },
)

test.each(modes)("%s releases failed reaction progress callbacks and snapshots after closure", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const api = await setup(mode)
    await api.connect()
    const weak: WeakRef<object>[] = []

    async function trackedFailure() {
        const defaultApi = (reaction: import("../../../src/index.js").MessageReaction) => {
            weak.push(new WeakRef(reaction))
            throw new Error("fixture failure")
        }
        const native = (reaction: import("../../../src/index.js").MessageReaction) =>
            Effect.sync(() => defaultApi(reaction))
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
        ["stop", "timeout", "idle", "shutdown", "scope", "recovery", "overflow"]
            .filter((reason) => mode === "native" || reason !== "scope")
            .map((reason) => ({ mode, reason })),
    ),
)("$mode $reason interrupts progress and waits for cleanup", async ({ mode, reason }) => {
    const clock = reason === "timeout" || reason === "idle" ? sdkClock() : undefined
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
                else signal.addEventListener("abort", () => resolve(), { once: true })
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
        {
            maxReactions: 10,
            timeoutMs: reason === "timeout" ? 100 : 10_000,
            idleMs: reason === "idle" ? 100 : 5_000,
            maxPendingMessages: 1,
        },
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
    if (reason === "stop") operation = collector.close()
    if (reason === "shutdown") operation = Promise.resolve(api.shutdown())
    if (reason === "scope") operation = Effect.runPromise(Scope.close(api.collectorScope, Exit.void))
    if (reason === "recovery") wsTarget.sockets.at(-1)!.terminate()
    if (reason === "overflow") {
        deliverReaction(addition("31")).deliver()
        deliverReaction(addition("32")).deliver()
    }
    if (clock) {
        // The collector's own timer ends the wait, so SDK time moves to its 100 ms deadline
        await clock.waiting(100)
        await clock.advance(100)
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
                : { reason: reason === "timeout" || reason === "idle" ? reason : "stopped" },
    )
})

test.each(modes)(
    "%s queued reactions and remaining batch entries cannot postpone idle during a callback",
    async (mode) => {
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        let now = 0
        vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(
            () => BigInt(now) * 1_000_000n,
        )
        const started = Promise.withResolvers<void>()
        const calls: string[] = []
        const accept = (reaction: import("../../../src/index.js").MessageReaction) => {
            calls.push(reaction.userId)
            started.resolve()
        }
        const collector = await progress(
            api,
            async (reaction, signal) => {
                accept(reaction)
                await new Promise<void>((resolve) => {
                    if (signal.aborted) resolve()
                    else signal.addEventListener("abort", () => resolve(), { once: true })
                })
            },
            (reaction) => Effect.sync(() => accept(reaction)).pipe(Effect.andThen(Effect.never)),
            { idleMs: 100, maxReactions: 5 },
        )
        deliverReaction(
            {
                message_id: "10",
                channel_id: "20",
                reactions: ["30", "31"].map((user_id) => ({ user_id, emoji: { name: "✅" } })),
            },
            "MESSAGE_REACTION_ADD_MANY",
        ).deliver()
        await started.promise
        now = 99
        deliverReaction(addition("32")).deliver()
        await turn()
        now = 100
        deliverReaction(addition("33")).deliver()
        expect(await collector.wait()).toEqual({ reason: "idle", reactions: [observed()] })
        expect(calls).toEqual(["30"])
    },
)

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
    const collector = await settle(
        api.defaultApi!.messages.collectReactions(target, {
            signal: controller.signal,
            onReaction: async (_reaction, signal) => {
                started = true
                await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
                await turn()
                cleaned = true
            },
        }),
    )
    deliverReaction(addition()).deliver()
    await vi.waitFor(() => expect(started).toBe(true))
    controller.abort()
    const result = await collector.result()
    expect(result.isErr() && result.error._tag).toBe("CancelledError")
    expect(cleaned).toBe(true)
})

test.each(modes.flatMap((mode) => ["timeout", "idle"].map((reason) => ({ mode, reason }))))(
    "$mode slow final progress cannot turn expired $reason into limit success",
    async ({ mode, reason }) => {
        await gateway()
        mockRest(async () => new Response(null, { status: 204 }))
        const api = await setup(mode)
        await api.connect()
        let now = 0
        vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(
            () => BigInt(now) * 1_000_000n,
        )
        const advance = () => {
            now = 100
        }
        const collector = await progress(
            api,
            advance,
            () => Effect.sync(advance),
            reason === "idle" ? { idleMs: 100 } : { timeoutMs: 100 },
        )
        deliverReaction(addition()).deliver()
        expect(await collector.wait()).toEqual({ reason, reactions: [observed()] })
    },
)

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
    const outcome = await Effect.runPromise(typedResult(collector.result()))
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
    await Effect.runPromise(collector.close())
    const exit = await Effect.runPromiseExit(collector.result())
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
    await Effect.runPromise(collector.result())
    expect(labels).toEqual(["registration"])
})

async function setup(mode: Mode) {
    // Registered before the client so its shutdown runs first, then this closes collectors and native subscriptions
    const scope = Scope.makeUnsafe()
    const collectorScope = Scope.makeUnsafe()
    onTestFinished(async () => {
        await Effect.runPromise(Scope.close(collectorScope, Exit.void))
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const options = {
        gateway: { onMalformedDispatch: "terminate" as const },
        cache: { messages: { maxEntries: 10 } },
    }
    const defaultApi = mode === "default" ? createDefaultApi(options) : undefined
    const native = mode === "native" ? await createNativeApi(options) : undefined
    const shutdown = () => (defaultApi ? settle(defaultApi.shutdown()) : settle(native!.shutdown()))
    return {
        defaultApi,
        native,
        collectorScope,
        state: () => (defaultApi ?? native)!.state,
        collectMisuse: async (
            options?: Omit<DefaultReactionCollectorOptions, "onReaction">,
            message: MessageReference = target,
        ) => {
            if (defaultApi) return expectThrown(() => defaultApi.messages.collectReactions(message, options))
            return expectDefect(native!.messages.collectReactions(message, options).pipe(Scope.provide(collectorScope)))
        },
        collect: async (
            options?: Omit<DefaultReactionCollectorOptions, "onReaction">,
            message: MessageReference = target,
        ) => {
            if (defaultApi) {
                const source = await settle(defaultApi.messages.collectReactions(message, options))
                return {
                    close: async () => source.close(),
                    wait: async (signal?: AbortSignal) => settle(source.result(signal ? { signal } : undefined)),
                }
            }
            const source = await settle(
                native!.messages.collectReactions(message, options).pipe(Scope.provide(collectorScope)),
            )
            return {
                close: () => settle(source.close()),
                wait: (signal?: AbortSignal) =>
                    Effect.runPromise(source.result().pipe(typedResult), signal ? { signal } : undefined).then(
                        (result) => {
                            if (result._tag === "Failure") throw result.failure
                            return result.success
                        },
                    ),
            }
        },
        shutdown,
        connect: () => (defaultApi ? settle(defaultApi.connect()) : settle(native!.connect())),
        get: () => (defaultApi ? settle(defaultApi.messages.get(target)) : settle(native!.messages.get(target))),
        fetch: () => (defaultApi ? settle(defaultApi.messages.fetch(target)) : settle(native!.messages.fetch(target))),
        add: (emoji: ReactionEmojiInput, timeoutMs = 1_000) =>
            defaultApi
                ? settle(defaultApi.messages.addReaction(target, emoji, { timeoutMs }))
                : settle(native!.messages.addReaction(target, emoji, { timeoutMs })),
        remove: (emoji: ReactionEmojiInput) =>
            defaultApi
                ? settle(defaultApi.messages.removeReaction(target, emoji))
                : settle(native!.messages.removeReaction(target, emoji)),
        moderate: async (
            operation: (typeof moderationOperations)[number],
            emoji: ReactionEmojiInput = "👍",
            userId = "31",
            options?: Omit<DefaultMessageOperationOptions, "signal"> & { signal?: AbortSignal },
        ) => {
            if (defaultApi)
                return settle(
                    operation === "removeUserReaction"
                        ? defaultApi.messages.removeUserReaction(target, emoji, userId, options)
                        : operation === "clearReaction"
                          ? defaultApi.messages.clearReaction(target, emoji, options)
                          : defaultApi.messages.clearReactions(target, options),
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
        ): Promise<ReactionUsersPage> =>
            defaultApi
                ? settle(defaultApi.messages.fetchReactionUsers(target, emoji, query, options))
                : settle(native!.messages.fetchReactionUsers(target, emoji, query, options)),
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
            if (defaultApi) return settle(defaultApi.on(event, handler, { maxPendingMessages }))
            return settle(
                native!
                    .on(event, (value) => Effect.sync(() => handler(value)), { maxPendingMessages })
                    .pipe(Effect.provideService(Scope.Scope, scope)),
            )
        },
        readOne: async (event: EventName) => {
            if (defaultApi) {
                const source = await settle(defaultApi.subscribe(event))
                try {
                    return await settle(source.next())
                } finally {
                    source.close()
                }
            }
            const values = await settle(Stream.runCollect(native!.subscribe(event).pipe(Stream.take(1))))
            return values[0]
        },
        closed: () => (defaultApi ? settle(defaultApi.waitForClose()) : settle(native!.waitForClose())),
    }
}

function mockRest(handler: (url: string, init: RequestInit) => Promise<Response>) {
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) =>
        url.endsWith("/gateway/bot")
            ? Promise.resolve(Response.json({ url: "wss://gateway.fluxer.app" }))
            : handler(url, init),
    )
}

/** The current test's gateway, whose network dispatches and prepared deliveries share one sequence */
let current: SynchronousGateway | undefined
async function gateway() {
    const server = await startSynchronousGateway()
    current = server
    return (event: string, body: unknown) => server.dispatch(event, body)
}

test.each(modes)("%s reuses emoji markup, parsed values and snapshots across reaction workflows", async (mode) => {
    await gateway()
    const calls: [string, string][] = []
    mockRest(async (url, init) => {
        if (url.endsWith("/guilds/40/emojis")) return Response.json([{ id: "50", name: "party", animated: true }])
        if (url.endsWith("/emojis/50/metadata"))
            return Response.json({ guild_id: "40", id: "50", name: "party", animated: true, allow_cloning: false })
        calls.push([new URL(url).pathname, init.method!])
        return init.method === "GET"
            ? Response.json({ items: [], has_more: false, next_after: null })
            : new Response(null, { status: 204 })
    })
    const api = await setup(mode)
    await api.connect()
    const fetched = api.defaultApi
        ? (await settle(api.defaultApi.emojis.fetchAll("40")))[0]!
        : (await Effect.runPromise(api.native!.emojis.fetchAll("40")))[0]!
    const parsed = api.defaultApi
        ? format.parseCustomEmoji("<a:party:50>")
        : nativeFormat.parseCustomEmoji("<a:party:50>")
    const metadata = api.defaultApi
        ? await settle(api.defaultApi.emojis.fetchMetadata("50"))
        : await Effect.runPromise(api.native!.emojis.fetchMetadata("50"))
    const incoming = await api.collect()
    deliverReaction({ ...addition(), emoji: { name: "party", id: "50", animated: true } }).deliver()
    const received = (await incoming.wait()).reactions[0]!.emoji
    const inputs: readonly ReactionEmojiInput[] = [
        "<:party:50>",
        "<a:party:50>",
        parsed,
        fetched,
        metadata,
        received,
        { name: "👍" },
    ]
    for (const emoji of inputs) {
        const unicode = typeof emoji === "object" && emoji.id === undefined
        const encoded = encodeURIComponent(unicode ? "👍" : "party:50")
        const path = `/v1/channels/20/messages/10/reactions/${encoded}`
        calls.length = 0
        await api.add(emoji)
        await api.remove(emoji)
        await api.moderate("removeUserReaction", emoji)
        await api.moderate("clearReaction", emoji)
        expect((await api.users(emoji)).items).toEqual([])
        const users: unknown[] = []
        if (api.defaultApi) {
            for await (const user of api.defaultApi.messages.iterateReactionUsers(target, emoji, { maxItems: 10 }))
                users.push(user)
        } else {
            users.push(
                ...(await Effect.runPromise(
                    Stream.runCollect(api.native!.messages.iterateReactionUsers(target, emoji, { maxItems: 10 })),
                )),
            )
        }
        expect(users).toEqual([])
        expect(calls).toEqual([
            [path + "/@me", "PUT"],
            [path + "/@me", "DELETE"],
            [path + "/31", "DELETE"],
            [path, "DELETE"],
            [path + "/users", "GET"],
            [path + "/users", "GET"],
        ])
        const collector = await api.collect({ emoji })
        deliverReaction({ ...addition(), emoji: { name: "party", id: "51" } }).deliver()
        const selected = unicode ? { name: "👍" } : { name: "renamed", id: "50" }
        deliverReaction({ ...addition(), emoji: selected }).deliver()
        expect((await collector.wait()).reactions.map((reaction) => reaction.emoji)).toEqual([selected])
    }
})

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
    for (const invalid of ["", "%F0%9F%91%8D", "<:party:bad>", "a/b", "\ud800", { name: "party", id: "bad" }, null])
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

test.each(modes)("%s a failing reaction filter is reported with its message IDs", async (mode) => {
    await gateway()
    mockRest(async () => new Response(null, { status: 204 }))
    const reports: FailureReport[] = []
    const filterFailure = new Error("reaction filter detail")
    const filter = () => {
        throw filterFailure
    }
    let closed: Promise<unknown>
    if (mode === "default") {
        const client = createDefaultApi({ onError: (report: FailureReport) => void reports.push(report) })
        await settle(client.connect())
        const collector = await settle(client.messages.collectReactions(target, { filter }))
        closed = (async () => collector.result())()
    } else {
        const client = await createNativeApi({
            onError: (report: FailureReport) => Effect.sync(() => void reports.push(report)),
        } as never)
        await settle(client.connect())
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const collector = await Effect.runPromise(
            client.messages.collectReactions(target, { filter }).pipe(Scope.provide(scope)),
        )
        closed = Effect.runPromise(Effect.exit(collector.result()))
    }
    deliverReaction(addition()).deliver()
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    await closed
    expect(reports[0]).toMatchObject({ kind: "filter", error: filterFailure, message: target })
})
