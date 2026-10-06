import { Effect } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { commands, type CommandCooldownRequest, type PrefixCommandRejection } from "../../../src/index.js"
import { commands as nativeCommands } from "../../../src/effect.js"
import { modes } from "../../support/both-apis.js"
import {
    act,
    attach,
    commandFixture,
    configurationError,
    connect,
    createRouter,
    type EitherRouter,
} from "./command-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe.each(modes)("%s command cooldowns", (mode) => {
    /** A command that records executions and cooldown rejections as `name:message id` */
    const tracked = (outcomes: string[], cooldown: object) => ({
        cooldown,
        onReject: ({ name, message }: { name: string; message: { id: string } }, rejection: PrefixCommandRejection) =>
            act(mode, () => void outcomes.push(`${name}:${message.id}:${rejection._tag}`)),
        execute: ({ name, message }: { name: string; message: { id: string } }) =>
            act(mode, () => void outcomes.push(`${name}:${message.id}`)),
    })

    test("without a store, the router's own store shares a cooldown per user, channel or guild", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const outcomes: string[] = []
        const router = createRouter(mode, { prefix: "!" }).registerMany({
            user: tracked(outcomes, { durationMs: 60_000 }),
            channel: tracked(outcomes, { durationMs: 60_000, per: "channel" }),
            guild: tracked(outcomes, { durationMs: 60_000, per: "guild" }),
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        remote.deliver("!user", { authorId: "30" })
        remote.deliver("!user", { authorId: "30", channelId: "21" })
        remote.deliver("!user", { authorId: "31" })
        remote.deliver("!channel", { channelId: "20", authorId: "30" })
        remote.deliver("!channel", { channelId: "20", authorId: "31" })
        remote.deliver("!channel", { channelId: "21", authorId: "30" })
        remote.deliver("!guild", { guildId: "40", channelId: "20" })
        remote.deliver("!guild", { guildId: "40", channelId: "21", authorId: "31" })
        remote.deliver("!guild", { guildId: "41", channelId: "22" })
        // A direct message has no guild, so a guild cooldown applies to that conversation
        remote.deliver("!guild", { channelId: "23" })
        remote.deliver("!guild", { channelId: "23", authorId: "31" })
        remote.deliver("!guild", { channelId: "24" })
        await vi.waitFor(() => expect(outcomes).toHaveLength(12))

        expect(outcomes).toEqual([
            "user:101",
            "user:102:CommandCooldownActive",
            "user:103",
            "channel:104",
            "channel:105:CommandCooldownActive",
            "channel:106",
            "guild:107",
            "guild:108:CommandCooldownActive",
            "guild:109",
            "guild:110",
            "guild:111:CommandCooldownActive",
            "guild:112",
        ])
        expect(reports).toEqual([])
    })

    test("a supplied store is still used instead of the router's store", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const outcomes: string[] = []
        const requests: CommandCooldownRequest[] = []
        const store = {
            claim: (request: CommandCooldownRequest) => {
                requests.push(request)
                const claim = { _tag: "CooldownAcquired" as const, retryAtMs: Date.now() + request.durationMs }
                return mode === "default" ? claim : Effect.succeed(claim)
            },
        }
        const router = createRouter(mode, { prefix: "!" }).registerMany({
            ping: tracked(outcomes, { durationMs: 60_000, store }),
            pong: tracked(outcomes, { durationMs: 60_000, store }),
        })
        await attach(connected, router, { concurrency: 1 })
        remote.deliver("!ping", { authorId: "30" })
        remote.deliver("!ping", { authorId: "30" })
        remote.deliver("!ping", { authorId: "31" })
        remote.deliver("!pong", { authorId: "30" })
        await vi.waitFor(() => expect(outcomes).toHaveLength(4))
        // The store allows the repeat, which the router's own store would not
        expect(outcomes).toEqual(["ping:101", "ping:102", "ping:103", "pong:104"])
        expect(requests.map((request) => request.durationMs)).toEqual([60_000, 60_000, 60_000, 60_000])
        // Keys are opaque, so only their identity is checked: one key per user and command
        const [first, repeat, otherUser, otherCommand] = requests.map((request) => request.key)
        expect(repeat).toBe(first)
        expect(otherUser).not.toBe(first)
        expect(otherCommand).not.toBe(first)
    })

    test("routers derived from one create share the router store, while separate creates do not", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const outcomes: string[] = []
        const register = (router: EitherRouter) =>
            router.register({ name: "ping", ...tracked(outcomes, { durationMs: 60_000 }) })
        const base = createRouter(mode, { prefix: "!" })
        const first = register(base)
        const derived = first.registerGroup({ name: "tools" })
        await attach(connected, first)
        await attach(connected, derived)
        remote.deliver("!ping")
        await vi.waitFor(() => expect(outcomes).toHaveLength(2))
        expect(outcomes.sort()).toEqual(["ping:101", "ping:101:CommandCooldownActive"])

        const separate: string[] = []
        const own = () =>
            createRouter(mode, { prefix: "?" }).register({ name: "ping", ...tracked(separate, { durationMs: 60_000 }) })
        await attach(connected, own())
        await attach(connected, own())
        remote.deliver("?ping")
        await vi.waitFor(() => expect(separate).toHaveLength(2))
        expect(separate).toEqual(["ping:102", "ping:102"])
    })

    test("a full router store runs a first use by evicting the reservation that expires soonest", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const outcomes: string[] = []
        const router = createRouter(mode, { prefix: "!", cooldowns: { maxEntries: 2 } }).register({
            name: "ping",
            ...tracked(outcomes, { durationMs: 60_000 }),
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        for (const authorId of ["30", "31", "32"]) remote.deliver("!ping", { authorId })
        await vi.waitFor(() => expect(outcomes).toHaveLength(3))
        // The third user evicted the first user's reservation, which expired soonest, so the first user runs again
        remote.deliver("!ping", { authorId: "30" })
        remote.deliver("!ping", { authorId: "32" })
        await vi.waitFor(() => expect(outcomes).toHaveLength(5))

        expect(outcomes).toEqual(["ping:101", "ping:102", "ping:103", "ping:104", "ping:105:CommandCooldownActive"])
        expect(reports).toEqual([])
    })

    test("router cooldown options are validated when the router is created", () => {
        for (const cooldowns of [{ maxEntries: 0 }, { maxEntries: 1.5 }, { maxEntries: 2, extra: true }, 5])
            expect(configurationError(() => createRouter(mode, { prefix: "!", cooldowns })).field).toBe("maxEntries")
    })

    test("memory stores hold 10,000 keys by default and make room by evicting the soonest expiry", async () => {
        /** A memory store of this mode, with claims resolved to their tag */
        const memoryStore = (options?: { readonly maxEntries: number }) => {
            if (mode === "default") {
                const store = commands.memoryCooldowns(options)
                return {
                    store,
                    claim: async (key: string, durationMs: number) => store.claim({ key, durationMs })._tag,
                }
            }
            const store = nativeCommands.memoryCooldowns(options)
            return {
                store,
                claim: async (key: string, durationMs: number) =>
                    (await Effect.runPromise(store.claim({ key, durationMs })))._tag,
            }
        }
        // Wall time stays frozen, so every reservation stays active and only eviction frees a key
        vi.spyOn(Date, "now").mockReturnValue(Date.now())
        const large = memoryStore()
        expect(large.store.maxEntries).toBe(10_000)
        // The 1,025th distinct user is not refused, and the first user's reservation is still active
        for (let user = 0; user < 1_025; user += 1)
            expect(await large.claim(`user:${user}`, 60_000)).toBe("CooldownAcquired")
        expect(await large.claim("user:0", 60_000)).toBe("CooldownActive")

        const small = memoryStore({ maxEntries: 2 })
        expect(await small.claim("short", 30_000)).toBe("CooldownAcquired")
        expect(await small.claim("long", 60_000)).toBe("CooldownAcquired")
        expect(await small.claim("new", 60_000)).toBe("CooldownAcquired")
        expect(small.store.size).toBe(2)
        expect(await small.claim("long", 60_000)).toBe("CooldownActive")
        expect(await small.claim("new", 60_000)).toBe("CooldownActive")
        // The reservation that expired soonest made room, so its key can claim again
        expect(await small.claim("short", 30_000)).toBe("CooldownAcquired")
    })

    test("cooldown settings are validated at registration", () => {
        const router = createRouter(mode, { prefix: "!" })
        const execute = () => act(mode, () => undefined)
        for (const cooldown of [
            { durationMs: 60_000, per: "server" },
            { durationMs: 0 },
            { durationMs: 60_000, store: {} },
            { durationMs: 60_000, key: "user" },
        ])
            expect(configurationError(() => router.register({ name: "ping", cooldown, execute })).field).toBe(
                "cooldown",
            )
    })
})
