import { Effect } from "effect"
import { err } from "neverthrow"
import { afterEach, describe, expect, test, vi } from "vitest"
import { guards, Permissions, type PrefixCommandRejection } from "../../../src/index.js"
import { guards as nativeGuards } from "../../../src/effect.js"
import { guardDenials } from "../../../src/internal/command-guards.js"
import { modes } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"
import {
    act,
    attach,
    commandFixture,
    configurationError,
    connect,
    createRouter,
    type RecordedCall,
} from "./command-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const guildId = "40"
const moderator = String(Permissions.ManageMessages | Permissions.SendMessages)
const guildWire = { id: guildId, owner_id: "99", name: "fixture", features: [], icon: null }
const channelWire = {
    id: "20",
    guild_id: guildId,
    type: 0,
    name: "general",
    position: 0,
    parent_id: null,
    topic: null,
    last_message_id: null,
    last_pin_timestamp: null,
    rate_limit_per_user: 0,
    nsfw: false,
    permission_overwrites: [],
}
const roleWire = (id: string, permissions: string) => ({
    id,
    name: `role-${id}`,
    color: 0,
    position: 1,
    permissions,
    hoist: false,
    mentionable: false,
    hoist_position: null,
    unicode_emoji: null,
})
const memberWire = {
    user: { id: "30", username: "fixture", bot: false },
    roles: ["41"],
    joined_at: "2026-09-08T12:00:00Z",
    nick: null,
    avatar: null,
}

/** Answer the four permission reads for guild 40, where member 30 holds ManageMessages through role 41 */
function permissionRoutes(call: RecordedCall): Response | undefined {
    if (call.method !== "GET") return undefined
    if (call.path === `/v1/guilds/${guildId}`) return Response.json(guildWire)
    if (call.path === `/v1/guilds/${guildId}/members/30`) return Response.json(memberWire)
    if (call.path === `/v1/guilds/${guildId}/roles`)
        return Response.json([roleWire(guildId, "0"), roleWire("41", moderator)])
    if (call.path === "/v1/channels/20") return Response.json(channelWire)
    return undefined
}

/** A one-to-one conversation between the bot and member 30 */
const directMessageWire = (id: string) => ({
    id,
    type: 1,
    recipients: [
        {
            id: "30",
            username: "fixture",
            discriminator: "0001",
            global_name: null,
            avatar: null,
            avatar_color: null,
            flags: 0,
        },
    ],
    last_message_id: null,
})

/** A current-application response owned by the given user */
const applicationWire = (ownerId: string) => ({
    id: "1750000000000000000",
    name: "Fixture bot",
    icon: null,
    description: null,
    bot_public: true,
    bot_require_code_grant: false,
    owner: { id: ownerId, username: "owner" },
})

/** A guild text channel whose wire data carries no permission_overwrites field */
const { permission_overwrites: _omitted, ...channelWithoutOverwrites } = channelWire

/** Answer a channel read with a private conversation, a guild channel or a failure, by channel ID */
function channelKinds(call: RecordedCall): Response | undefined {
    if (call.method !== "GET") return undefined
    for (const id of ["20", "21"]) if (call.path === `/v1/channels/${id}`) return Response.json(directMessageWire(id))
    for (const id of ["22", "23"]) if (call.path === `/v1/channels/${id}`) return Response.json({ ...channelWire, id })
    if (call.path === "/v1/channels/24") return Response.json({ message: "Internal", code: 0 }, { status: 400 })
    return undefined
}

describe.each(modes)("%s built-in guards", (mode) => {
    // One untyped view of both guard sets, because a union of their overloaded members is not callable
    const guardSet: typeof guards = mode === "default" ? guards : (nativeGuards as unknown as typeof guards)

    test("guildOnly, dmOnly and ownerOnly deny with their reasons and allow matching messages", async () => {
        const remote = await commandFixture((call) =>
            call.method === "GET" && call.path === "/v1/channels/20"
                ? Response.json(directMessageWire("20"))
                : undefined,
        )
        const connected = await connect(mode)
        const executed: string[] = []
        const rejected: { name: string; rejection: PrefixCommandRejection }[] = []
        const command = (guard: unknown) => ({
            guard,
            onReject: ({ name }: { name: string }, rejection: PrefixCommandRejection) =>
                act(mode, () => void rejected.push({ name, rejection })),
            execute: ({ name, message }: { name: string; message: { id: string } }) =>
                act(mode, () => void executed.push(`${name}:${message.id}`)),
        })
        const router = createRouter(mode, { prefix: "!" }).registerMany({
            server: command(guardSet.guildOnly()),
            private: command(guardSet.dmOnly()),
            owner: command(guardSet.ownerOnly(["30", "31"])),
            other: command(guardSet.ownerOnly("32")),
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        remote.deliver("!server")
        remote.deliver("!server", { guildId })
        remote.deliver("!private", { guildId })
        remote.deliver("!private")
        remote.deliver("!owner")
        remote.deliver("!other")
        await vi.waitFor(() => expect(executed.length + rejected.length).toBe(6))

        expect(executed).toEqual(["server:102", "private:104", "owner:105"])
        expect(rejected.map(({ name, rejection }) => [name, rejection._tag])).toEqual([
            ["server", "CommandGuardRejected"],
            ["private", "CommandGuardRejected"],
            ["other", "CommandGuardRejected"],
        ])
        // Each guard denies with its own reason. The wording is not a contract, so reasons are compared by source
        const reasons = rejected.map(({ rejection }) =>
            rejection._tag === "CommandGuardRejected" ? rejection.reason : undefined,
        )
        expect(reasons).toEqual([guardDenials.guildOnly, guardDenials.dmOnly, guardDenials.ownerOnly])
        expect(reports).toEqual([])
        // Only dmOnly on the guild-less message reads the channel. The guildId decides guildOnly without requests
        expect(remote.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /v1/channels/20"])
    })

    test("dmOnly allows only a confirmed private channel and denies guild channels without a guildId", async () => {
        const remote = await commandFixture(channelKinds)
        const connected = await connect(mode, { cache: { channels: true, directMessages: true } })
        const { client } = connected
        const executed: string[] = []
        const rejected: string[] = []
        const rejections: PrefixCommandRejection[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "private",
            guard: guardSet.dmOnly(),
            onReject: ({ message }: { message: { channelId: string } }, rejection: PrefixCommandRejection) =>
                act(mode, () => {
                    rejections.push(rejection)
                    rejected.push(message.channelId)
                }),
            execute: ({ message }: { message: { channelId: string } }) =>
                act(mode, () => void executed.push(message.channelId)),
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        // Channel 20 is a cached private conversation and channel 22 a cached guild channel
        await settle(client.directMessages.fetch("20"))
        await settle(client.channels.fetch("22"))
        expect(await settle(client.directMessages.get("20"))).toBeDefined()
        expect(await settle(client.channels.get("22"))).toBeDefined()
        remote.calls.length = 0

        remote.deliver("!private", { channelId: "20" })
        remote.deliver("!private", { channelId: "22" })
        await vi.waitFor(() => expect(executed.length + rejected.length).toBe(2))
        // Cached channels decide without requests
        expect(remote.calls).toEqual([])

        // An uncached channel is read once: a private conversation is allowed and then cached, a guild channel is denied
        remote.deliver("!private", { channelId: "21" })
        remote.deliver("!private", { channelId: "23" })
        remote.deliver("!private", { channelId: "21" })
        await vi.waitFor(() => expect(executed.length + rejected.length).toBe(5))
        expect(executed).toEqual(["20", "21", "21"])
        expect(rejected).toEqual(["22", "23"])
        expect(rejections).toEqual(Array(2).fill({ _tag: "CommandGuardRejected", reason: guardDenials.dmOnly }))
        expect(remote.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
            "GET /v1/channels/21",
            "GET /v1/channels/23",
        ])
        expect(reports).toEqual([])
    })

    test("dmOnly fails the command when the channel read fails, without running it", async () => {
        const remote = await commandFixture(channelKinds)
        const connected = await connect(mode)
        const executed: string[] = []
        const rejected: unknown[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "private",
            guard: guardSet.dmOnly(),
            onReject: (_context: unknown, rejection: PrefixCommandRejection) =>
                act(mode, () => void rejected.push(rejection)),
            execute: () => act(mode, () => void executed.push("private")),
        })
        const reports = await attach(connected, router)
        remote.deliver("!private", { channelId: "24" })
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        expect(reports[0]).toMatchObject({
            kind: "handler",
            command: "private",
            error: { _tag: "UserOperationError", operation: "directMessages.fetch" },
        })
        expect(executed).toEqual([])
        expect(rejected).toEqual([])
    })

    test("ownerOnly without IDs reads the application owner once per client and decides from it", async () => {
        const remote = await commandFixture((call) =>
            call.method === "GET" && call.path === "/v1/oauth2/applications/@me"
                ? Response.json(applicationWire("30"))
                : undefined,
        )
        const connected = await connect(mode)
        const executed: string[] = []
        const rejected: PrefixCommandRejection[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "owner",
            guard: guardSet.ownerOnly(),
            onReject: (_context: unknown, rejection: PrefixCommandRejection) =>
                act(mode, () => void rejected.push(rejection)),
            execute: ({ message }: { message: { author: { id: string } } }) =>
                act(mode, () => void executed.push(message.author.id)),
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        remote.deliver("!owner")
        remote.deliver("!owner", { authorId: "31" })
        remote.deliver("!owner")
        await vi.waitFor(() => expect(executed.length + rejected.length).toBe(3))

        expect(executed).toEqual(["30", "30"])
        expect(rejected).toEqual([{ _tag: "CommandGuardRejected", reason: guardDenials.ownerOnly }])
        expect(remote.calls.filter((call) => call.path === "/v1/oauth2/applications/@me")).toHaveLength(1)
        expect(reports).toEqual([])
    })

    test("ownerOnly without IDs fails the command when the owner read fails, and reads again next time", async () => {
        let available = false
        const remote = await commandFixture((call) =>
            call.method === "GET" && call.path === "/v1/oauth2/applications/@me"
                ? available
                    ? Response.json(applicationWire("30"))
                    : Response.json({ message: "Missing access", code: 0 }, { status: 403 })
                : undefined,
        )
        const connected = await connect(mode)
        const executed: string[] = []
        const rejected: unknown[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "owner",
            guard: guardSet.ownerOnly(),
            onReject: (_context: unknown, rejection: PrefixCommandRejection) =>
                act(mode, () => void rejected.push(rejection)),
            execute: () => act(mode, () => void executed.push("owner")),
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        remote.deliver("!owner")
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        expect(reports[0]).toMatchObject({
            kind: "handler",
            command: "owner",
            error: { _tag: "BotApplicationOperationError", operation: "application.fetch", status: 403 },
        })
        expect(executed).toEqual([])

        available = true
        remote.deliver("!owner")
        await vi.waitFor(() => expect(executed).toEqual(["owner"]))
        expect(remote.calls.filter((call) => call.path === "/v1/oauth2/applications/@me")).toHaveLength(2)
        expect(rejected).toEqual([])
        expect(reports).toHaveLength(1)
    })

    test("guard settings are validated when the guard is created", () => {
        for (const owners of [undefined, [], "", "abc", ["01"], [30]])
            expect(configurationError(() => guardSet.ownerOnly(owners as never)).field).toBe("command")
        for (const names of [[], ["NotAPermission"], "BanMembers"])
            expect(configurationError(() => guardSet.requirePermissions(names as never)).field).toBe("command")
    })

    test("requirePermissions fetches only uncached resources, then decides from the cache without requests", async () => {
        const remote = await commandFixture(permissionRoutes)
        const connected = await connect(mode, { cache: { guilds: true, members: true, roles: true, channels: true } })
        const { client } = connected
        const executed: string[] = []
        const rejected: PrefixCommandRejection[] = []
        const router = createRouter(mode, { prefix: "!" }).registerMany({
            purge: {
                guard: guardSet.requirePermissions(["ManageMessages"]),
                execute: () => act(mode, () => void executed.push("purge")),
            },
            ban: {
                guard: guardSet.requirePermissions(["BanMembers", "SendMessages", "KickMembers"]),
                onReject: (_context: unknown, rejection: PrefixCommandRejection) =>
                    act(mode, () => void rejected.push(rejection)),
                execute: () => act(mode, () => void executed.push("ban")),
            },
        })
        const reports = await attach(connected, router, { concurrency: 1 })

        // A guild snapshot caches the guild without its member or roles, so only those reads remain to be fetched
        remote.dispatch("GUILD_CREATE", {
            id: guildId,
            properties: guildWire,
            roles: [],
            channels: [channelWire],
            emojis: [],
            members: [],
            member_count: 1,
            joined_at: null,
        })
        const cached = async (): Promise<Record<string, boolean>> => ({
            [`/v1/guilds/${guildId}`]: (await settle(client.guilds.get(guildId))) !== undefined,
            [`/v1/guilds/${guildId}/members/30`]:
                (await settle(client.members.get({ guildId, userId: "30" }))) !== undefined,
            [`/v1/guilds/${guildId}/roles`]:
                (await settle(client.roles.get({ guildId, id: guildId }))) !== undefined &&
                (await settle(client.roles.get({ guildId, id: "41" }))) !== undefined,
            "/v1/channels/20": (await settle(client.channels.get("20"))) !== undefined,
        })
        await vi.waitFor(async () => expect((await cached())[`/v1/guilds/${guildId}`]).toBe(true))
        const before = await cached()
        const missing = Object.keys(before).filter((path) => !before[path])
        expect(missing).toContain(`/v1/guilds/${guildId}/members/30`)
        expect(missing).not.toContain(`/v1/guilds/${guildId}`)

        remote.deliver("!purge", { guildId })
        await vi.waitFor(() => expect(executed).toEqual(["purge"]))
        expect(remote.calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual(
            missing.map((path) => `GET ${path}`).sort(),
        )
        expect(Object.values(await cached()).every(Boolean)).toBe(true)

        remote.deliver("!ban", { guildId })
        await vi.waitFor(() => expect(rejected).toHaveLength(1))
        expect(remote.calls).toHaveLength(missing.length)
        // The reason lists the missing names in the required order, without the permission the member holds
        expect(rejected).toEqual([
            { _tag: "CommandGuardRejected", reason: guardDenials.missing(["BanMembers", "KickMembers"]) },
        ])
        const reason = rejected[0]!._tag === "CommandGuardRejected" ? rejected[0]!.reason : undefined
        expect(reason).toContain("BanMembers")
        expect(reason).toContain("KickMembers")
        expect(reason).not.toContain("SendMessages")
        expect(executed).toEqual(["purge"])
        expect(reports).toEqual([])
    })

    test("requirePermissions decides from role permissions in a channel whose read has no overwrites", async () => {
        const remote = await commandFixture((call) =>
            call.method === "GET" && call.path === "/v1/channels/20"
                ? Response.json(channelWithoutOverwrites)
                : permissionRoutes(call),
        )
        const connected = await connect(mode)
        const executed: string[] = []
        const rejected: PrefixCommandRejection[] = []
        const router = createRouter(mode, { prefix: "!" }).registerMany({
            purge: {
                guard: guardSet.requirePermissions(["ManageMessages"]),
                execute: () => act(mode, () => void executed.push("purge")),
            },
            ban: {
                guard: guardSet.requirePermissions(["BanMembers"]),
                onReject: (_context: unknown, rejection: PrefixCommandRejection) =>
                    act(mode, () => void rejected.push(rejection)),
                execute: () => act(mode, () => void executed.push("ban")),
            },
        })
        const reports = await attach(connected, router, { concurrency: 1 })
        remote.deliver("!purge", { guildId })
        remote.deliver("!ban", { guildId })
        await vi.waitFor(() => expect(executed.length + rejected.length).toBe(2))
        expect(executed).toEqual(["purge"])
        expect(rejected).toEqual([{ _tag: "CommandGuardRejected", reason: guardDenials.missing(["BanMembers"]) }])
        expect(reports).toEqual([])
    })

    test("requirePermissions denies in an unknown channel type without overwrites, and decides one that has them", async () => {
        // Fluxer reads a thread (type 11) without overwrites, because a thread takes its parent channel's permissions
        const thread = { ...channelWithoutOverwrites, id: "25", type: 11, parent_id: "20" }
        const forum = { ...channelWire, id: "26", type: 15 }
        const remote = await commandFixture((call) => {
            if (call.method === "GET" && call.path === "/v1/channels/25") return Response.json(thread)
            if (call.method === "GET" && call.path === "/v1/channels/26") return Response.json(forum)
            return permissionRoutes(call)
        })
        const connected = await connect(mode)
        const executed: string[] = []
        const rejected: PrefixCommandRejection[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "purge",
            guard: guardSet.requirePermissions(["ManageMessages"]),
            onReject: (_context: unknown, rejection: PrefixCommandRejection) =>
                act(mode, () => void rejected.push(rejection)),
            execute: ({ message }: { message: { channelId: string } }) =>
                act(mode, () => void executed.push(message.channelId)),
        })
        const reports = await attach(connected, router, { concurrency: 1 })
        remote.deliver("!purge", { guildId, channelId: "25" })
        remote.deliver("!purge", { guildId, channelId: "26" })
        await vi.waitFor(() => expect(executed.length + rejected.length).toBe(2))
        expect(rejected).toEqual([{ _tag: "CommandGuardRejected", reason: guardDenials.unconfirmedChannel }])
        expect(executed).toEqual(["26"])
        expect(reports).toEqual([])
    })

    test("requirePermissions reads a cached channel without overwrites again instead of ignoring its overwrites", async () => {
        const denyingChannel = {
            ...channelWire,
            permission_overwrites: [{ id: "41", type: 0, allow: "0", deny: String(Permissions.ManageMessages) }],
        }
        let channelRead: object = channelWithoutOverwrites
        const remote = await commandFixture((call) =>
            call.method === "GET" && call.path === "/v1/channels/20"
                ? Response.json(channelRead)
                : permissionRoutes(call),
        )
        const connected = await connect(mode, { cache: { channels: true } })
        const rejected: PrefixCommandRejection[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "purge",
            guard: guardSet.requirePermissions(["ManageMessages"]),
            onReject: (_context: unknown, rejection: PrefixCommandRejection) =>
                act(mode, () => void rejected.push(rejection)),
            execute: () => act(mode, () => undefined),
        })
        const reports = await attach(connected, router)
        // The cache holds an observation of channel 20 without its overwrite list, and Fluxer now reports a deny
        await settle(connected.client.channels.fetch("20"))
        expect(await settle(connected.client.channels.get("20"))).not.toHaveProperty("permissionOverwrites")
        channelRead = denyingChannel
        remote.calls.length = 0

        remote.deliver("!purge", { guildId })
        await vi.waitFor(() => expect(rejected).toHaveLength(1))
        // The fresh read's role overwrite removes the permission that role 41 grants
        expect(rejected).toEqual([{ _tag: "CommandGuardRejected", reason: guardDenials.missing(["ManageMessages"]) }])
        expect(remote.calls.filter((call) => call.path === "/v1/channels/20")).toHaveLength(1)
        expect(reports).toEqual([])
    })

    test("requirePermissions denies direct messages without reading permissions", async () => {
        const remote = await commandFixture(permissionRoutes)
        const connected = await connect(mode)
        const rejected: PrefixCommandRejection[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "purge",
            guard: guardSet.requirePermissions(["ManageMessages"]),
            onReject: (_context: unknown, rejection: PrefixCommandRejection) =>
                act(mode, () => void rejected.push(rejection)),
            execute: () => act(mode, () => undefined),
        })
        await attach(connected, router)
        remote.deliver("!purge")
        await vi.waitFor(() => expect(rejected).toHaveLength(1))
        expect(rejected).toEqual([{ _tag: "CommandGuardRejected", reason: guardDenials.guildOnly }])
        expect(remote.calls).toEqual([])
    })

    test("a failed permission read fails the command and is reported with its name", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const executed: string[] = []
        const router = createRouter(mode, { prefix: "!" }).register({
            name: "purge",
            guard: guardSet.requirePermissions(["ManageMessages"]),
            execute: () => act(mode, () => void executed.push("purge")),
        })
        const reports = await attach(connected, router)
        remote.deliver("!purge", { guildId })
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        expect(reports[0]).toMatchObject({ kind: "handler", command: "purge" })
        expect(executed).toEqual([])
    })
})

describe.each(modes)("%s guard lists and verdicts", (mode) => {
    test("a guard list runs in order and stops at the first denial, whose reason reaches onReject", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const calls: string[] = []
        const rejected: PrefixCommandRejection[] = []
        const guard = (name: string, verdict: boolean | { deny: string }) => () =>
            act(mode, () => {
                calls.push(name)
                return verdict
            })
        const router = createRouter(mode, { prefix: "!" }).registerMany({
            listed: {
                guard: [guard("first", true), guard("second", { deny: "Only on weekends" }), guard("third", true)],
                onReject: (_context: unknown, rejection: PrefixCommandRejection) =>
                    act(mode, () => void rejected.push(rejection)),
                execute: () => act(mode, () => void calls.push("execute")),
            },
            silent: {
                guard: [guard("silent", false)],
                onReject: (_context: unknown, rejection: PrefixCommandRejection) =>
                    act(mode, () => void rejected.push(rejection)),
                execute: () => act(mode, () => void calls.push("execute")),
            },
        })
        await attach(connected, router, { concurrency: 1 })
        remote.deliver("!listed")
        remote.deliver("!silent")
        await vi.waitFor(() => expect(rejected).toHaveLength(2))
        expect(calls).toEqual(["first", "second", "silent"])
        expect(rejected).toEqual([
            { _tag: "CommandGuardRejected", reason: "Only on weekends" },
            { _tag: "CommandGuardRejected" },
        ])
    })

    test("an invalid guard verdict is reported as a command failure without running the command", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const executed: string[] = []
        const rejected: unknown[] = []
        const verdicts: Record<string, unknown> = { text: "yes", empty: { deny: "" }, number: 1 }
        let router = createRouter(mode, { prefix: "!" })
        for (const [name, verdict] of Object.entries(verdicts))
            router = router.register({
                name,
                guard: () => act(mode, () => verdict),
                onReject: () => act(mode, () => void rejected.push(name)),
                execute: () => act(mode, () => void executed.push(name)),
            })
        const reports = await attach(connected, router)
        for (const name of Object.keys(verdicts)) remote.deliver(`!${name}`)
        await vi.waitFor(() => expect(reports).toHaveLength(3))
        expect(reports.map((report) => report.command).sort()).toEqual(["empty", "number", "text"])
        expect(reports.every((report) => report.kind === "handler")).toBe(true)
        expect(executed).toEqual([])
        expect(rejected).toEqual([])
    })

    test("guard and guard-list shapes are validated at registration", () => {
        const router = createRouter(mode, { prefix: "!" })
        const execute = () => act(mode, () => undefined)
        for (const guard of [true, [true], "reply", [() => true, undefined]])
            expect(configurationError(() => router.register({ name: "ping", guard, execute })).field).toBe("commands")
    })
})

test("a default guard returning an Err result is reported like a thrown error", async () => {
    const remote = await commandFixture()
    const connected = await connect("default")
    const failure = new Error("guard lookup failed")
    const executed: string[] = []
    const router = createRouter("default", { prefix: "!" }).register({
        name: "ping",
        guard: async () => err(failure),
        execute: () => void executed.push("ping"),
    })
    const reports = await attach(connected, router)
    remote.deliver("!ping")
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toMatchObject({ kind: "handler", command: "ping", error: failure })
    expect(executed).toEqual([])
})

test("a native guard failure is reported with the command name", async () => {
    const remote = await commandFixture()
    const connected = await connect("native")
    const failure = new Error("guard lookup failed")
    const router = createRouter("native", { prefix: "!" }).register({
        name: "ping",
        guard: () => Effect.fail(failure),
        execute: () => Effect.void,
    })
    const reports = await attach(connected, router)
    remote.deliver("!ping")
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toMatchObject({ kind: "handler", command: "ping", error: failure })
})
