import { typedResult } from "../../support/settle.js"
import { setImmediate as turn } from "node:timers/promises"
import { Cause, Clock, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    ChannelType,
    createClient,
    GuildOperationError,
    Permissions,
    type ClientOptions,
    type DefaultGuildOperationOptions,
    type GuildPublicThreadChannel,
    type PermissionInput,
    type PermissionTarget,
} from "../../../src/index.js"
import { fixtures } from "../../../src/testing.js"
import { createClient as createNative, type ClientOptions as NativeClientOptions } from "../../../src/effect.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"

const allPermissions = (1n << 64n) - 1n
const unknownPermission = 1n << 63n

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const guild = (ownerId = "99") => ({ id: "20", ownerId, name: "fixture", features: [], icon: null })
const member = (roleIds: readonly string[] = ["40"], userId = "30") => ({
    guildId: "20",
    userId,
    username: "fixture",
    isBot: true,
    roleIds,
    joinedAt: "2026-09-08T12:00:00Z",
    nickname: null,
    avatar: null,
})
const role = (id: string, permissions: bigint, guildId = "20") => ({
    guildId,
    id,
    name: `role-${id}`,
    color: 0,
    position: 1,
    permissions,
    hoist: false,
    mentionable: false,
})
const channel = (overwrites: NonNullable<PermissionInput["channel"]>["permissionOverwrites"] = []) => ({
    id: "50",
    guildId: "20",
    type: 0 as const,
    permissionOverwrites: overwrites,
})
const input = (overwrites: NonNullable<PermissionInput["channel"]>["permissionOverwrites"] = []): PermissionInput => ({
    guild: guild(),
    member: member(),
    roles: [role("20", 1n << 1n), role("40", (1n << 2n) | unknownPermission)],
    channel: channel(overwrites),
})
const target: PermissionTarget = { guildId: "20", userId: "30", channelId: "50" }

const unwrap = <A, E>(value: { isErr(): boolean; value?: A; error?: E }): A => {
    if (value.isErr()) throw value.error
    return value.value!
}
async function run<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
    const result = await Effect.runPromise(typedResult(effect), signal ? { signal } : undefined)
    if (result._tag === "Failure") throw result.failure
    return result.success
}
function rest(handler: (url: string, init: RequestInit) => Promise<Response>) {
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => handler(url, init))
}
async function setup(mode: Mode) {
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture", cache: { guilds: true, members: true, roles: true, channels: true } }
    const defaultApi = mode === "default" ? createClient(options as ClientOptions) : undefined
    const native =
        mode === "native"
            ? await run(createNative(options as NativeClientOptions).pipe(Scope.provide(scope)))
            : undefined
    const close = async () => (defaultApi ? unwrap(await defaultApi.shutdown()) : run(native!.shutdown()))
    onTestFinished(async () => {
        await close()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        defaultApi,
        native,
        calculate: (value: PermissionInput): bigint =>
            defaultApi ? defaultApi.permissions.calculate(value) : native!.permissions.calculate(value),
        fetch: async (value: PermissionTarget, options?: DefaultGuildOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.permissions.fetch(value, options))
                : run(native!.permissions.fetch(value, options)),
        shutdown: close,
    }
}

test.each(modes)("%s calculates a bigint with owner/admin bypass and Fluxer overwrite precedence", async (mode) => {
    const api = await setup(mode)
    const overwrites = [
        { id: "20", type: "role" as const, allow: 1n << 3n, deny: 1n << 1n },
        { id: "40", type: "role" as const, allow: 1n << 3n, deny: (1n << 2n) | (1n << 3n) },
        { id: "30", type: "member" as const, allow: 1n << 4n, deny: 1n << 3n },
    ]
    const calculated = api.calculate(input(overwrites))
    expect(typeof calculated).toBe("bigint")
    expect(calculated).toBe(unknownPermission | (1n << 4n))

    const conflictingRoleOverwrites = [
        { id: "40", type: "role" as const, allow: 1n << 5n, deny: 0n },
        { id: "41", type: "role" as const, allow: 0n, deny: 1n << 5n },
    ]
    for (const roleOverwrites of [conflictingRoleOverwrites, [...conflictingRoleOverwrites].reverse()])
        expect(
            api.calculate({
                ...input(),
                member: member(["40", "41"]),
                roles: [role("20", 0n), role("40", 0n), role("41", 0n)],
                channel: channel(roleOverwrites),
            }),
        ).toBe(1n << 5n)

    expect(api.calculate({ ...input(), guild: guild("30") })).toBe(allPermissions)
    expect(
        api.calculate({
            ...input([{ id: "20", type: "role", allow: 0n, deny: allPermissions }]),
            roles: [role("20", 0n), role("40", Permissions.Administrator | unknownPermission)],
        }),
    ).toBe(allPermissions)
})

test.each(modes)(
    "%s ignores overwrites for other members and roles the member lacks, in either order",
    async (mode) => {
        const api = await setup(mode)
        const bit = (position: number) => 1n << BigInt(position)
        const roles = [
            role("20", bit(1) | bit(6) | bit(7)),
            role("40", bit(2) | bit(8) | unknownPermission),
            // A role the member does not hold, whose own permissions must not leak into the result
            role("41", bit(9)),
        ]
        const related = [
            { id: "20", type: "role" as const, allow: bit(10), deny: bit(1) },
            { id: "40", type: "role" as const, allow: bit(11), deny: bit(2) },
            { id: "30", type: "member" as const, allow: bit(12), deny: bit(6) },
        ]
        // Each unrelated overwrite allows a bit that the right answer lacks and denies a bit that the right answer keeps
        const unrelated = [
            { id: "41", type: "role" as const, allow: bit(13), deny: bit(8) },
            { id: "31", type: "member" as const, allow: bit(14), deny: bit(10) },
            { id: "42", type: "role" as const, allow: bit(15), deny: bit(11) },
            { id: "32", type: "member" as const, allow: bit(16), deny: bit(12) },
        ]
        const expected = bit(7) | bit(8) | unknownPermission | bit(10) | bit(11) | bit(12)
        const calculate = (overwrites: typeof related) =>
            api.calculate({ ...input(), roles, channel: channel(overwrites) })

        expect(calculate(related)).toBe(expected)
        expect(calculate([...unrelated, ...related])).toBe(expected)
        expect(calculate([...related, ...unrelated])).toBe(expected)
        expect(calculate([...unrelated.slice(0, 2), ...related, ...unrelated.slice(2)].reverse())).toBe(expected)
        // Only unrelated overwrites leave the guild-level permissions untouched
        expect(calculate(unrelated)).toBe(bit(1) | bit(2) | bit(6) | bit(7) | bit(8) | unknownPermission)
    },
)

test.each(modes)("%s matches overwrites by type as well as ID", async (mode) => {
    const api = await setup(mode)
    const bit = (position: number) => 1n << BigInt(position)
    const roles = [role("20", bit(1) | bit(7)), role("40", bit(2) | unknownPermission)]
    // A member overwrite never acts as the everyone or role overwrite that shares its ID, and the reverse holds too
    const sameIdOtherType = [
        { id: "20", type: "member" as const, allow: bit(10), deny: bit(1) },
        { id: "40", type: "member" as const, allow: bit(11), deny: bit(2) },
        { id: "30", type: "role" as const, allow: bit(12), deny: bit(7) },
    ]
    const base = bit(1) | bit(2) | bit(7) | unknownPermission
    for (const overwrites of [sameIdOtherType, [...sameIdOtherType].reverse()])
        expect(api.calculate({ ...input(), roles, channel: channel(overwrites) })).toBe(base)
})

test.each(modes)(
    "%s throws GuildOperationError for incomplete, inconsistent, and malformed snapshots",
    async (mode) => {
        const api = await setup(mode)
        const incomplete = [
            { ...input(), roles: [role("40", 0n)] },
            { ...input(), member: member(["41"]) },
            { ...input(), roles: [role("20", 0n), role("40", -1n)] },
            { ...input(), channel: { ...channel(), guildId: "21" } },
            { ...input(), channel: { id: "50", guildId: "20", type: 0 } },
            {
                ...input(),
                channel: channel([
                    { id: "20", type: "role", allow: 0n, deny: 0n },
                    { id: "20", type: "role", allow: 0n, deny: 0n },
                ]),
            },
        ]
        // Both API styles throw synchronously rather than returning a failed Result or Effect
        for (const value of incomplete)
            expect(() => api.calculate(value as PermissionInput)).toThrow(
                expect.objectContaining({
                    _tag: "GuildOperationError",
                    operation: "permissions.calculate",
                    reason: "input",
                    outcome: "notDispatched",
                }),
            )
        expect(() => api.calculate(null as never)).toThrow(GuildOperationError)

        const sparse = input()
        // oxlint-disable-next-line typescript/no-array-delete -- the hole is the malformed input under test
        delete (sparse.member.roleIds as string[])[0]
        expect(() => api.calculate(sparse)).toThrow(
            expect.objectContaining({ operation: "permissions.calculate", reason: "input" }),
        )
    },
)

test.each(modes)("%s fetches every permission snapshot remotely without cache suppression", async (mode) => {
    const calls: string[] = []
    rest(async (url) => {
        const path = new URL(url).pathname
        calls.push(path)
        if (path.endsWith("/guilds/20")) return Response.json(wireGuild())
        if (path.endsWith("/members/30")) return Response.json(wireMember())
        if (path.endsWith("/roles")) return Response.json([wireRole("20", 2n), wireRole("40", unknownPermission | 4n)])
        if (path.endsWith("/channels/50"))
            return Response.json(wireChannel([{ id: "30", type: 1, allow: "16", deny: "4" }]))
        throw Error(`Unexpected request ${path}`)
    })
    const api = await setup(mode)
    expect(await api.fetch(target)).toBe(unknownPermission | 2n | 16n)
    expect(await api.fetch(target)).toBe(unknownPermission | 2n | 16n)
    expect(calls).toEqual([
        "/v1/guilds/20",
        "/v1/guilds/20/members/30",
        "/v1/guilds/20/roles",
        "/v1/channels/50",
        "/v1/guilds/20",
        "/v1/guilds/20/members/30",
        "/v1/guilds/20/roles",
        "/v1/channels/50",
    ])
})

test.each(modes)("%s copies the target before remote reads can observe a caller mutation", async (mode) => {
    let entered!: () => void
    let release!: () => void
    const firstRead = new Promise<void>((resolve) => {
        entered = resolve
    })
    const continueRead = new Promise<void>((resolve) => {
        release = resolve
    })
    const calls: string[] = []
    rest(async (url) => {
        const path = new URL(url).pathname
        calls.push(path)
        if (path.endsWith("/guilds/20")) {
            entered()
            await continueRead
            return Response.json(wireGuild())
        }
        if (path.endsWith("/members/30")) return Response.json(wireMember())
        if (path.endsWith("/roles")) return Response.json([wireRole("20", 2n), wireRole("40", 4n)])
        if (path.endsWith("/channels/50")) return Response.json(wireChannel([]))
        throw Error(`Read mutated target ${path}`)
    })
    const api = await setup(mode)
    const mutableTarget = { guildId: "20", userId: "30", channelId: "50" }
    const pending = api.fetch(mutableTarget)
    await firstRead
    mutableTarget.guildId = "21"
    mutableTarget.userId = "31"
    mutableTarget.channelId = "51"
    release()
    expect(await pending).toBe(6n)
    expect(calls).toEqual(["/v1/guilds/20", "/v1/guilds/20/members/30", "/v1/guilds/20/roles", "/v1/channels/50"])
})

test.each(modes)("%s preserves resource failures and rejects cross-guild remote snapshots", async (mode) => {
    const calls: string[] = []
    rest(async (url) => {
        const path = new URL(url).pathname
        calls.push(path)
        if (path.endsWith("/guilds/20")) return Response.json(wireGuild())
        if (path.endsWith("/members/30")) return Response.json(wireMember())
        // A rejection that is not retried keeps the test free of real retry backoff
        return Response.json({ message: "Missing access", code: 50001 }, { status: 403 })
    })
    const api = await setup(mode)
    await expect(api.fetch(target)).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "roles.fetchAll",
        reason: "rejected",
        status: 403,
    })
    // The guild and member were read once and the channel never. The REST layer owns how often roles are retried
    expect(calls.filter((path) => path !== "/v1/guilds/20/roles")).toEqual([
        "/v1/guilds/20",
        "/v1/guilds/20/members/30",
    ])
    expect(calls).toContain("/v1/guilds/20/roles")

    rest(async (url) => {
        const path = new URL(url).pathname
        if (path.endsWith("/guilds/20")) return Response.json(wireGuild())
        if (path.endsWith("/members/30")) return Response.json(wireMember())
        if (path.endsWith("/roles")) return Response.json([wireRole("20", 0n), wireRole("40", 0n)])
        return Response.json(wireChannel([], "21"))
    })
    await expect(api.fetch(target)).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "permissions.fetch",
        reason: "response",
        // The calculation failure stays reachable, so the inconsistent field is still named
        cause: { inputValidation: { path: "input.channel" } },
    })
})

test.each(modes)("%s gives later permission reads only the shared deadline remainder", async (mode) => {
    vi.useFakeTimers({ now: 0, toFake: ["Date", "performance", "setTimeout", "clearTimeout"] })
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() =>
        BigInt(Math.floor(performance.now() * 1_000_000)),
    )
    let enteredGuild!: () => void
    let enteredMember!: () => void
    let memberAborted = false
    const guildRead = new Promise<void>((resolve) => {
        enteredGuild = resolve
    })
    const memberRead = new Promise<void>((resolve) => {
        enteredMember = resolve
    })
    rest(async (url, init) => {
        const path = new URL(url).pathname
        if (path.endsWith("/guilds/20")) {
            enteredGuild()
            await new Promise((resolve) => setTimeout(resolve, 40))
            return Response.json(wireGuild())
        }
        if (!path.endsWith("/members/30")) throw Error(`Unexpected request ${path}`)
        enteredMember()
        return new Promise<Response>((_resolve, reject) => {
            const signal = init.signal as AbortSignal
            signal.addEventListener(
                "abort",
                () => {
                    memberAborted = true
                    reject(new DOMException("Timed out", "AbortError"))
                },
                { once: true },
            )
        })
    })
    const api = await setup(mode)
    const pending = api.fetch(target, { timeoutMs: 50 }).then(
        () => undefined,
        (error) => error,
    )
    await guildRead
    await vi.advanceTimersByTimeAsync(40)
    await memberRead
    await vi.advanceTimersByTimeAsync(11)
    expect(memberAborted).toBe(true)
    expect(await pending).toMatchObject({
        _tag: "GuildOperationError",
        operation: "members.fetch",
        reason: "timeout",
    })
})

test.each(modes)("%s permission fetch awaits request cleanup on cancellation", async (mode) => {
    let active = 0
    // The aborted request finishes its cleanup only when the test releases it
    const cleanup = Promise.withResolvers<void>()
    let aborted = false
    rest(
        async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
                active++
                ;(init.signal as AbortSignal).addEventListener(
                    "abort",
                    () => {
                        aborted = true
                        void cleanup.promise.then(() => {
                            active--
                            reject(new DOMException("Aborted", "AbortError"))
                        })
                    },
                    { once: true },
                )
            }),
    )
    // Prove the cancelled operation still waits for the held cleanup, then release it
    const release = async (pending: PromiseLike<unknown>) => {
        let settled = false
        const mark = () => {
            settled = true
        }
        void pending.then(mark, mark)
        await vi.waitFor(() => expect(aborted).toBe(true))
        // One host turn drains the promise jobs that would settle an operation not waiting for its cleanup
        await turn()
        expect(settled).toBe(false)
        cleanup.resolve()
    }
    const api = await setup(mode)
    try {
        const controller = new AbortController()
        if (api.native) {
            const pending = Effect.runPromiseExit(api.native.permissions.fetch(target), { signal: controller.signal })
            await vi.waitFor(() => expect(active).toBe(1))
            controller.abort()
            await release(pending)
            const failure = await pending
            expect(Exit.isFailure(failure) && Cause.hasInterruptsOnly(failure.cause)).toBe(true)
        } else {
            const pending = (async () => {
                const result = await api.defaultApi!.permissions.fetch(target, { signal: controller.signal })
                return result.isErr() ? result.error : undefined
            })()
            await vi.waitFor(() => expect(active).toBe(1))
            controller.abort()
            await release(pending)
            expect(await pending).toMatchObject({ _tag: "CancelledError" })
        }
        expect(active).toBe(0)
    } finally {
        // Release the held cleanup so a failed assertion does not stall client shutdown
        cleanup.resolve()
    }
})

// Fluxer 4749eb7f: threadViewPermissions in packages/constants/src/ThreadPermissionUtils.ts calculates a thread in its
// parent channel, then sets SendMessages exactly when SendMessagesInThreads is set. The gateway's
// guild_thread_permissions:alias_permissions applies the same rule
const thread = (overrides: Partial<GuildPublicThreadChannel> = {}): GuildPublicThreadChannel => ({
    id: "60",
    guildId: "20",
    type: ChannelType.PublicThread,
    parentId: "50",
    ownerId: "30",
    name: "fixture-thread",
    archived: false,
    locked: false,
    autoArchiveMinutes: 4320,
    archiveTimestamp: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
})
const { ViewChannel, SendMessages, SendMessagesInThreads } = Permissions

test.each(modes)(
    "%s calculates a thread in its parent channel with SendMessages following SendMessagesInThreads",
    async (mode) => {
        const api = await setup(mode)
        const community = (roleBits: bigint) => ({
            guild: guild(),
            member: member(),
            roles: [role("20", ViewChannel), role("40", roleBits)],
        })
        const inThread = (roleBits: bigint, overwrites: Parameters<typeof channel>[0] = []): PermissionInput => ({
            ...community(roleBits),
            channel: thread(),
            parentChannel: channel(overwrites),
        })

        // SendMessagesInThreads alone lets the member send in the thread, though not in the parent channel itself
        expect(api.calculate(inThread(SendMessagesInThreads))).toBe(ViewChannel | SendMessagesInThreads | SendMessages)
        // A parent that denies SendMessagesInThreads removes sending in its threads, while the parent keeps SendMessages
        const sender = SendMessages | SendMessagesInThreads
        const denyInThreads = [{ id: "40", type: "role" as const, allow: 0n, deny: SendMessagesInThreads }]
        expect(api.calculate(inThread(sender, denyInThreads))).toBe(ViewChannel)
        expect(api.calculate({ ...community(sender), channel: channel(denyInThreads) })).toBe(
            ViewChannel | SendMessages,
        )
        // Fluxer ignores any overwrites on the thread itself, so only the parent's apply
        const hiding = [{ id: "20", type: "role" as const, allow: 0n, deny: ViewChannel }]
        expect(api.calculate({ ...inThread(sender), channel: thread({ permissionOverwrites: hiding }) })).toBe(
            ViewChannel | sender,
        )

        // The owner and Administrator keep every bit, even where the parent denies everything
        const denyAll = [{ id: "20", type: "role" as const, allow: 0n, deny: allPermissions }]
        expect(api.calculate({ ...inThread(0n, denyAll), guild: guild("30") })).toBe(allPermissions)
        expect(api.calculate(inThread(Permissions.Administrator, denyAll))).toBe(allPermissions)
    },
)

test.each(modes)("%s rejects a thread without its own parent channel", async (mode) => {
    const api = await setup(mode)
    const { channel: _channel, ...community } = input()
    const base = { ...community, channel: thread(), parentChannel: channel() }
    const failures: [unknown, string, string][] = [
        [{ ...community, channel: thread() }, "input.parentChannel", "required"],
        [{ ...base, parentChannel: { ...channel(), id: "51" } }, "input.parentChannel", "relationship"],
        [{ ...base, parentChannel: { ...channel(), guildId: "21" } }, "input.parentChannel", "format"],
        [{ ...base, parentChannel: { id: "50", guildId: "20", type: 0 } }, "input.parentChannel", "format"],
        [{ ...base, channel: thread({ guildId: "21" }) }, "input.channel", "format"],
        // A parent channel beside a channel that is not a thread, or without any channel, would be silently ignored
        [{ ...base, channel: channel() }, "input.parentChannel", "relationship"],
        [{ ...community, parentChannel: channel() }, "input.parentChannel", "relationship"],
    ]
    for (const [value, path, constraint] of failures)
        expect(() => api.calculate(value as PermissionInput)).toThrow(
            expect.objectContaining({
                operation: "permissions.calculate",
                reason: "input",
                inputValidation: expect.objectContaining({ path, constraint }),
            }),
        )
})

test.each(modes)(
    "%s fetches a thread's parent channel after the thread and calculates the thread rule",
    async (mode) => {
        const calls: string[] = []
        rest(async (url) => {
            const path = new URL(url).pathname
            calls.push(path)
            if (path.endsWith("/guilds/20")) return Response.json(wireGuild())
            if (path.endsWith("/members/30")) return Response.json(wireMember())
            if (path.endsWith("/roles"))
                return Response.json([
                    wireRole("20", ViewChannel),
                    wireRole("40", SendMessages | SendMessagesInThreads),
                ])
            if (path.endsWith("/channels/60")) return Response.json(wireThread())
            if (path.endsWith("/channels/50"))
                return Response.json(
                    wireChannel([{ id: "40", type: 0, allow: "0", deny: String(SendMessagesInThreads) }]),
                )
            throw Error(`Unexpected request ${path}`)
        })
        const api = await setup(mode)
        expect(await api.fetch({ ...target, channelId: "60" })).toBe(ViewChannel)
        expect(calls).toEqual([
            "/v1/guilds/20",
            "/v1/guilds/20/members/30",
            "/v1/guilds/20/roles",
            "/v1/channels/60",
            "/v1/channels/50",
        ])
    },
)

test.each(modes)("%s gives a thread's parent read only the shared deadline remainder", async (mode) => {
    vi.useFakeTimers({ now: 0, toFake: ["Date", "performance", "setTimeout", "clearTimeout"] })
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() =>
        BigInt(Math.floor(performance.now() * 1_000_000)),
    )
    const threadRead = Promise.withResolvers<void>()
    const parentRead = Promise.withResolvers<void>()
    let parentAborted = false
    rest(async (url, init) => {
        const path = new URL(url).pathname
        if (path.endsWith("/guilds/20")) return Response.json(wireGuild())
        if (path.endsWith("/members/30")) return Response.json(wireMember())
        if (path.endsWith("/roles")) return Response.json([wireRole("20", 0n), wireRole("40", 0n)])
        if (path.endsWith("/channels/60")) {
            threadRead.resolve()
            await new Promise((resolve) => setTimeout(resolve, 40))
            return Response.json(wireThread())
        }
        if (!path.endsWith("/channels/50")) throw Error(`Unexpected request ${path}`)
        parentRead.resolve()
        return new Promise<Response>((_resolve, reject) => {
            ;(init.signal as AbortSignal).addEventListener(
                "abort",
                () => {
                    parentAborted = true
                    reject(new DOMException("Timed out", "AbortError"))
                },
                { once: true },
            )
        })
    })
    const api = await setup(mode)
    const pending = api.fetch({ ...target, channelId: "60" }, { timeoutMs: 50 }).then(
        () => undefined,
        (error) => error,
    )
    await threadRead.promise
    await vi.advanceTimersByTimeAsync(40)
    await parentRead.promise
    // The parent read has 10 ms left of the 50 ms deadline, not a deadline of its own
    await vi.advanceTimersByTimeAsync(11)
    expect(parentAborted).toBe(true)
    expect(await pending).toMatchObject({
        _tag: "ChannelOperationError",
        operation: "channels.fetch",
        reason: "timeout",
    })
})

const wireThread = () => fixtures.thread({ id: "60", guild_id: "20", parent_id: "50", owner_id: "30" })
const wireGuild = () => ({ id: "20", owner_id: "99", name: "fixture", features: [], icon: null })
const wireMember = () => ({
    user: { id: "30", username: "fixture", bot: true },
    roles: ["40"],
    joined_at: "2026-09-08T12:00:00Z",
    nick: null,
    avatar: null,
})
const wireRole = (id: string, permissions: bigint) => ({
    id,
    name: `role-${id}`,
    color: 0,
    position: 1,
    permissions: String(permissions),
    hoist: false,
    mentionable: false,
})
const wireChannel = (permissionOverwrites: readonly unknown[], guildId = "20") => ({
    id: "50",
    guild_id: guildId,
    type: 0,
    permission_overwrites: permissionOverwrites,
})
