import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    createClient,
    Permissions,
    type ClientOptions,
    type DefaultGuildOperationOptions,
    type PermissionInput,
    type PermissionTarget,
} from "../src/index.js"
import { createClient as createNative, type ClientOptions as NativeClientOptions } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
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
    type: 0,
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
    const result = await Effect.runPromise(Effect.result(effect), signal ? { signal } : undefined)
    if (result._tag === "Failure") throw result.failure
    return result.success
}
function rest(handler: (url: string, init: RequestInit) => Promise<Response>) {
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => handler(url, init))
}
async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture", cache: { guilds: true, members: true, roles: true, channels: true } }
    const defaultApi = mode === "default" ? unwrap(createClient(options as ClientOptions)) : undefined
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
        calculate: async (value: PermissionInput) =>
            defaultApi ? unwrap(defaultApi.permissions.calculate(value)) : run(native!.permissions.calculate(value)),
        fetch: async (value: PermissionTarget, options?: DefaultGuildOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.permissions.fetch(value, options))
                : run(native!.permissions.fetch(value, options)),
        shutdown: close,
    }
}

test.each(modes)("%s calculates owner/admin bypass and Fluxer overwrite precedence", async (mode) => {
    const api = await setup(mode)
    const overwrites = [
        { id: "20", type: "role" as const, allow: 1n << 3n, deny: 1n << 1n },
        { id: "40", type: "role" as const, allow: 1n << 3n, deny: (1n << 2n) | (1n << 3n) },
        { id: "30", type: "member" as const, allow: 1n << 4n, deny: 1n << 3n },
    ]
    expect(await api.calculate(input(overwrites))).toBe(unknownPermission | (1n << 4n))

    const conflictingRoleOverwrites = [
        { id: "40", type: "role" as const, allow: 1n << 5n, deny: 0n },
        { id: "41", type: "role" as const, allow: 0n, deny: 1n << 5n },
    ]
    for (const roleOverwrites of [conflictingRoleOverwrites, [...conflictingRoleOverwrites].reverse()])
        expect(
            await api.calculate({
                ...input(),
                member: member(["40", "41"]),
                roles: [role("20", 0n), role("40", 0n), role("41", 0n)],
                channel: channel(roleOverwrites),
            }),
        ).toBe(1n << 5n)

    expect(await api.calculate({ ...input(), guild: guild("30") })).toBe(allPermissions)
    expect(
        await api.calculate({
            ...input([{ id: "20", type: "role", allow: 0n, deny: allPermissions }]),
            roles: [role("20", 0n), role("40", Permissions.Administrator | unknownPermission)],
        }),
    ).toBe(allPermissions)
})

test.each(modes)("%s rejects incomplete, inconsistent, and malformed snapshots", async (mode) => {
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
    for (const value of incomplete)
        await expect(api.calculate(value as PermissionInput)).rejects.toMatchObject({
            _tag: "GuildOperationError",
            operation: "permissions.calculate",
            reason: "input",
            outcome: "notDispatched",
        })

    const sparse = input()
    delete (sparse.member.roleIds as string[])[0]
    await expect(api.calculate(sparse)).rejects.toMatchObject({ operation: "permissions.calculate", reason: "input" })
})

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
        return Response.json({ message: "unavailable" }, { status: 503 })
    })
    const api = await setup(mode)
    await expect(api.fetch(target)).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "roles.fetchAll",
        reason: "rejected",
        status: 503,
    })
    expect(calls).toEqual([
        "/v1/guilds/20",
        "/v1/guilds/20/members/30",
        "/v1/guilds/20/roles",
        "/v1/guilds/20/roles",
        "/v1/guilds/20/roles",
    ])

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
    })
})

test.each(modes)("%s gives later permission reads only the shared deadline remainder", async (mode) => {
    vi.useFakeTimers({ now: 0, toFake: ["Date", "performance", "setTimeout", "clearTimeout"] })
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
    rest(
        async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
                active++
                ;(init.signal as AbortSignal).addEventListener(
                    "abort",
                    () =>
                        setTimeout(() => {
                            active--
                            reject(new DOMException("Aborted", "AbortError"))
                        }, 20),
                    { once: true },
                )
            }),
    )
    const api = await setup(mode)
    const controller = new AbortController()
    if (api.native) {
        const pending = Effect.runPromiseExit(api.native.permissions.fetch(target), { signal: controller.signal })
        await vi.waitFor(() => expect(active).toBe(1))
        controller.abort()
        const failure = await pending
        expect(Exit.isFailure(failure) && Cause.hasInterruptsOnly(failure.cause)).toBe(true)
    } else {
        const pending = (async () => {
            const result = await api.defaultApi!.permissions.fetch(target, { signal: controller.signal })
            return result.isErr() ? result.error : undefined
        })()
        await vi.waitFor(() => expect(active).toBe(1))
        controller.abort()
        expect(await pending).toMatchObject({ _tag: "CancelledError" })
    }
    expect(active).toBe(0)
})

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
