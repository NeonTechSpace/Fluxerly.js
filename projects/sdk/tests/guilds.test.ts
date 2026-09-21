import { once } from "node:events"
import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import {
    createClient,
    Permissions,
    type RoleCreate,
    type RoleEdit,
    type RolePosition,
    type RoleHoistPosition,
    type EventMap,
    type EventName,
    type MemberQuery,
    type MemberReference,
    type DefaultGuildOperationOptions,
    type DefaultGuildAuditOperationOptions,
    type DefaultModerationOptions,
    type BanInput,
    type ClientOptions,
} from "../src/index.js"
import { createClient as createNative, type ClientOptions as NativeClientOptions } from "../src/effect.js"
import { InputValidationFailure } from "../src/input-validation.js"
import { memberTimeout } from "../src/internal/moderation.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const transport = vi.hoisted(() => ({ url: "", sockets: [] as import("ws").WebSocket[] }))
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
const modes = ["default", "native"] as const

test.each(modes)("%s sends audit reasons only on supported role and member mutations", async (mode) => {
    const calls: Array<{ method: string; path: string; reason: string | null }> = []
    rest(async (url, init) => {
        const path = new URL(url).pathname
        const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
        calls.push({ method: init.method!, path, reason: new Headers(init.headers).get("X-Audit-Log-Reason") })
        if (init.method === "GET")
            return path.endsWith("/roles") ? Response.json([wireRole()]) : Response.json(member())
        if (path.includes("/members/") && init.method === "PATCH") return Response.json(member())
        if (path.endsWith("/roles") && init.method === "POST") return Response.json(wireRole("51", body))
        if (path.endsWith("/roles/50") && init.method === "PATCH") return Response.json(wireRole("50", body))
        return new Response(null, { status: 204 })
    })
    const api = await setup(mode)
    const options = { auditReason: "  routine audit  " }

    await api.roles.create({ name: "created" }, options)
    await api.roles.edit({ name: "edited" }, "50", options)
    await api.roles.reorder([{ id: "50", position: 1 }], options)
    await api.roles.setHoist([{ id: "50", hoistPosition: 1 }], options)
    await api.roles.resetHoist(options)
    await api.roles.delete("50", options)
    await api.setRoles(["50"], options)
    await api.editSelf(options)
    await api.setNickname(options)
    await api.role(true, "50", options)
    await api.role(false, "50", options)

    expect(calls).toEqual([
        { method: "POST", path: "/v1/guilds/20/roles", reason: "routine audit" },
        { method: "PATCH", path: "/v1/guilds/20/roles/50", reason: "routine audit" },
        { method: "PATCH", path: "/v1/guilds/20/roles", reason: "routine audit" },
        { method: "PATCH", path: "/v1/guilds/20/roles/hoist-positions", reason: "routine audit" },
        { method: "DELETE", path: "/v1/guilds/20/roles/hoist-positions", reason: "routine audit" },
        { method: "DELETE", path: "/v1/guilds/20/roles/50", reason: "routine audit" },
        { method: "PATCH", path: "/v1/guilds/20/members/30", reason: "routine audit" },
        { method: "PATCH", path: "/v1/guilds/20/members/@me", reason: "routine audit" },
        { method: "PATCH", path: "/v1/guilds/20/members/30", reason: "routine audit" },
        { method: "PUT", path: "/v1/guilds/20/members/30/roles/50", reason: "routine audit" },
        { method: "DELETE", path: "/v1/guilds/20/members/30/roles/50", reason: "routine audit" },
    ])

    const readOptions = { auditReason: "not applicable" } as DefaultGuildOperationOptions
    const beforeReads = calls.length
    const rejectedRead = api.defaultApi
        ? (async () => unwrap(await api.defaultApi!.roles.fetchAll("20", readOptions)))()
        : run(api.native!.roles.fetchAll("20", readOptions))
    await expect(rejectedRead).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    expect(calls).toHaveLength(beforeReads)

    const privateReason = "not-for-diagnostics"
    const failure = await api.roles
        .create({ name: "blocked" }, { auditReason: `${privateReason}\n` })
        .catch((error) => error)
    expect(failure).toMatchObject({ reason: "input", outcome: "notDispatched" })
    expect(JSON.stringify(failure)).not.toContain(privateReason)
    expect(calls).toHaveLength(beforeReads)
})

test.each(modes)("%s moderates with explicit defaults, reasons and timeout observations", async (mode) => {
    const calls: { path: string; method: string; body: unknown; reason: string | null }[] = []
    rest(async (url, init) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        calls.push({
            path: new URL(url).pathname,
            method: init.method!,
            body,
            reason: new Headers(init.headers).get("X-Audit-Log-Reason"),
        })
        if (init.method === "PATCH") return Response.json({ ...member(), ...body })
        if (init.method === "GET") return Response.json(member())
        return new Response(null, { status: 204 })
    })
    const api = await setup(mode, { members: true })
    const before = Date.now()
    const timed = await api.timeout(300_000, { auditReason: "  repeated spam  " })
    expect(Date.parse(timed.communicationDisabledUntil!)).toBeGreaterThanOrEqual(before + 300_000)
    expect(Object.isFrozen(timed)).toBe(true)
    expect(await api.getMember()).toEqual(timed)
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/v1/guilds/20/members/30", reason: "repeated spam" })
    expect((await api.clearTimeout()).communicationDisabledUntil).toBeNull()
    expect(calls.at(-1)?.body).toEqual({ communication_disabled_until: null })
    await api.kick()
    expect(await api.getMember()).toBeUndefined()
    await api.ban()
    expect(calls.at(-1)).toMatchObject({
        method: "PUT",
        path: "/v1/guilds/20/bans/30",
        body: { ban_duration_seconds: 0, delete_message_seconds: 0 },
    })
    await api.ban({ durationSeconds: 60, deleteMessageSeconds: 604_800, reason: "違反" }, { auditReason: "spam" })
    expect(calls.at(-1)?.body).toEqual({ ban_duration_seconds: 60, delete_message_seconds: 604_800, reason: "違反" })
    await api.unban()
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/guilds/20/bans/30", body: undefined })
    expect(api.state()).toBe("Disconnected")
})

test.each(modes)("%s validates moderation input before dispatch and rejects malformed observations", async (mode) => {
    let calls = 0
    rest(async () => {
        calls++
        return Response.json(member())
    })
    const api = await setup(mode)
    for (const duration of [0, -1, 0.5, NaN, Infinity, 31_536_000_001, null as unknown as number])
        await expect(api.timeout(duration)).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    for (const input of [
        { durationSeconds: 1 },
        { durationSeconds: 63_072_001 },
        { deleteMessageSeconds: -1 },
        { deleteMessageSeconds: 604_801 },
        { reason: "x".repeat(513) },
        { extra: true },
    ])
        await expect(api.ban(input as BanInput)).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    for (const reason of ["", "   ", "é", "bad\nheader", "x".repeat(513)])
        await expect(api.kick({ auditReason: reason })).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    expect(calls).toBe(0)
    await expect(api.timeout(60_000)).rejects.toMatchObject({ reason: "response", outcome: "unknown" })
    for (const response of [
        { ...member(), communication_disabled_until: 0 },
        { ...member(), communication_disabled_until: "invalid" },
    ]) {
        rest(async () => Response.json(response))
        await expect(api.member()).rejects.toMatchObject({ reason: "response" })
    }
})

test("timeout reasons retain Unicode payloads, allow null, and never project onto members", () => {
    const set = memberTimeout(target, 60_000, { timeoutReason: "  規則違反  " })
    expect(set).not.toBeInstanceOf(InputValidationFailure)
    if (set instanceof InputValidationFailure) throw Error("Expected timeout request")
    expect(JSON.parse(set.json!)).toMatchObject({ timeout_reason: "  規則違反  " })
    expect(
        set.decode({ ...member(), communication_disabled_until: "2026-09-12T12:00:00Z", timeout_reason: "private" }),
    ).toEqual(expect.not.objectContaining({ timeoutReason: expect.anything() }))

    const clear = memberTimeout(target, null, { timeoutReason: null }, true)
    expect(clear).not.toBeInstanceOf(InputValidationFailure)
    if (clear instanceof InputValidationFailure) throw Error("Expected clear-timeout request")
    expect(JSON.parse(clear.json!)).toEqual({ communication_disabled_until: null, timeout_reason: null })
    for (const timeoutReason of ["", " ", "😀".repeat(257)]) {
        const result = memberTimeout(target, 60_000, { timeoutReason })
        expect(result).toBeInstanceOf(InputValidationFailure)
        expect((result as InputValidationFailure).detail.path).toBe("options.timeoutReason")
    }
})

test.each(modes)("%s ban lists are remote, frozen and fail without partial results", async (mode) => {
    const ban = {
        user: { id: "30", username: "fixture" },
        reason: null,
        moderator_id: "31",
        banned_at: "2026-09-09T00:00:00Z",
        expires_at: null,
    }
    let calls = 0
    let payload: unknown = [ban]
    rest(async () => {
        calls++
        return Response.json(payload)
    })
    const api = await setup(mode, { members: true })
    const bans = await api.bans()
    expect(Object.isFrozen(bans) && Object.isFrozen(bans[0])).toBe(true)
    expect(bans[0]).toMatchObject({ guildId: "20", userId: "30", moderatorId: "31", expiresAt: null })
    await api.bans()
    expect(calls).toBe(2)
    expect(await api.getMember()).toBeUndefined()
    for (payload of [
        [ban, ban],
        [ban, { ...ban, user: null }],
        [{ ...ban, expires_at: "invalid" }],
        [{ ...ban, banned_at: "2025-02-29T00:00:00Z" }],
        [{ ...ban, expires_at: "2025-04-31T00:00:00Z" }],
    ])
        await expect(api.bans()).rejects.toMatchObject({ reason: "response" })
    payload = []
    expect(await api.bans()).toEqual([])
})

test.each(modes)("%s dispatched moderation rejection blocks delayed cache restoration without replay", async (mode) => {
    const api = await setup(mode, { members: true })
    rest(async () => Response.json(member()))
    await api.member()
    let release!: () => void
    let started = false
    let writes = 0
    rest(async (_url, init) => {
        if (init.method === "GET") {
            started = true
            await new Promise<void>((resolve) => {
                release = resolve
            })
            return Response.json(member())
        }
        writes++
        return Response.json({ private: "must not escape" }, { status: 400 })
    })
    const reading = api.member()
    await vi.waitFor(() => expect(started).toBe(true))
    await expect(api.kick()).rejects.toMatchObject({ reason: "rejected", outcome: "rejected" })
    release()
    await reading
    expect(writes).toBe(1)
    expect(await api.getMember()).toBeUndefined()
})

test.each(modes)("%s ban events invalidate member observations before delivery and survive recovery", async (mode) => {
    const dispatch = await gateway()
    rest(async () => Response.json(member()))
    const api = await setup(mode, { members: true })
    await api.connect()
    const seen: unknown[] = []
    for (const event of ["guildBanAdd", "guildBanRemove"] as const)
        await api.on(event, (value) => {
            const cached = api.defaultApi
                ? unwrap(api.defaultApi.members.get(value))
                : Effect.runSync(api.native!.members.get(value))
            seen.push({ event, value, cached })
        })
    await api.member()
    dispatch("GUILD_BAN_ADD", { guild_id: "20", user: { id: "30" } })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ event: "guildBanAdd", value: target, cached: undefined })
    transport.sockets[0]!.terminate()
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(2), { timeout: 5_000 })
    await vi.waitFor(() => expect(api.state()).toBe("Connected"))
    await api.member()
    dispatch("GUILD_BAN_REMOVE", { guild_id: "20", user: { id: "30" } })
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]).toEqual({ event: "guildBanRemove", value: target, cached: undefined })
})
const wireRole = (id = "50", extra = {}) => ({
    id,
    name: "fixture",
    color: 0,
    position: 1,
    permissions: "0",
    hoist: false,
    mentionable: false,
    hoist_position: null,
    unicode_emoji: null,
    ...extra,
})

test.each(modes)("%s only requested ban message deletion evicts the author's retained messages", async (mode) => {
    const api = await setup(mode, { messages: { maxEntries: 10 } })
    let status = 204
    rest(async (url, init) => {
        if (init.method !== "GET") return new Response(null, { status })
        const id = url.split("/").at(-1)!
        return Response.json({
            id,
            channel_id: "21",
            content: "fixture",
            author: { id: id === "10" ? "30" : "31", username: "fixture" },
        })
    })
    const first = { channelId: "21", id: "10" }
    const second = { channelId: "21", id: "11" }
    for (const ref of [first, second]) {
        if (api.defaultApi) unwrap(await api.defaultApi.messages.fetch(ref))
        else await run(api.native!.messages.fetch(ref))
    }
    const get = async (ref: typeof first) =>
        api.defaultApi ? unwrap(api.defaultApi.messages.get(ref)) : run(api.native!.messages.get(ref))
    await api.ban()
    expect(await get(first)).toBeDefined()
    status = 400
    await expect(api.ban({ deleteMessageSeconds: 60 })).rejects.toMatchObject({ reason: "rejected" })
    expect(await get(first)).toBeUndefined()
    expect(await get(second)).toBeDefined()
})

test.each(modes)(
    "%s manages roles with lossless grants, explicit defaults and independent observations",
    async (mode) => {
        const calls: { path: string; method: string; body: unknown }[] = []
        rest(async (url, init) => {
            const path = new URL(url).pathname
            const body = init.body ? JSON.parse(String(init.body)) : undefined
            calls.push({ path, method: init.method!, body })
            if (init.method === "DELETE" || Array.isArray(body)) return new Response(null, { status: 204 })
            if (init.method === "GET") return Response.json([wireRole("50"), wireRole("20", { position: 0 })])
            return Response.json(wireRole("50", body))
        })
        const api = await setup(mode)
        const initial = await api.roles.list()
        expect(initial.map((role) => role.id)).toEqual(["50", "20"])
        expect(Object.isFrozen(initial) && Object.isFrozen(initial[0])).toBe(true)
        expect(initial[0]).toMatchObject({ guildId: "20", permissions: 0n, hoistPosition: null, unicodeEmoji: null })
        await api.roles.create({ name: "fixture" })
        expect(calls.at(-1)).toMatchObject({ method: "POST", body: { name: "fixture", permissions: "0", color: 0 } })
        const bits = (1n << 63n) - 1n
        await api.roles.create({ name: "maximum", permissions: bits })
        expect(calls.at(-1)?.body).toEqual({ name: "maximum", color: 0, permissions: bits.toString() })
        expect((await api.roles.edit({ permissions: bits, hoist: true, hoistPosition: null })).permissions).toBe(bits)
        expect(calls.at(-1)?.body).toEqual({ permissions: bits.toString(), hoist: true, hoist_position: null })
        expect(initial[0]!.permissions).toBe(0n)
        await api.roles.reorder([
            { id: "50", position: 2 },
            { id: "51", position: 1 },
        ])
        expect(calls.at(-1)).toMatchObject({
            method: "PATCH",
            body: [
                { id: "50", position: 2 },
                { id: "51", position: 1 },
            ],
        })
        await api.roles.delete()
        expect(calls.at(-1)).toMatchObject({ method: "DELETE" })
        expect(calls.at(-1)?.path).toMatch(/\/guilds\/20\/roles\/50$/)
        expect(Object.isFrozen(Permissions)).toBe(true)
        expect(Permissions.ViewChannelMembers).toBe(1n << 54n)
    },
)

test.each(modes)(
    "%s advertises protected role-permission replacements without changing unrelated requests",
    async (mode) => {
        const calls: { path: string; method: string; body: unknown; features: string | null }[] = []
        let storedPermissions = 0n
        rest(async (url, init) => {
            const path = new URL(url).pathname
            const body = init.body ? JSON.parse(String(init.body)) : undefined
            const features = new Headers(init.headers).get("X-Fluxer-Features")
            calls.push({ path, method: init.method!, body, features })
            if (init.method === "GET") return Response.json([wireRole("50"), wireRole("20", { position: 0 })])
            const requestedPermissions = BigInt((body as { permissions: string }).permissions)
            if (features === "view_channel_members_permission") storedPermissions = requestedPermissions
            return Response.json(wireRole("50", { ...body, permissions: storedPermissions.toString() }))
        })
        const api = await setup(mode)
        const bit = Permissions.ViewChannelMembers

        await api.roles.list()
        expect((await api.roles.create({ name: "enabled", permissions: bit })).permissions).toBe(bit)
        expect((await api.roles.create({ name: "cleared", permissions: 0n })).permissions).toBe(0n)
        expect((await api.roles.edit({ permissions: bit })).permissions).toBe(bit)
        expect((await api.roles.edit({ permissions: 0n })).permissions).toBe(0n)

        expect(calls).toEqual([
            { path: "/v1/guilds/20/roles", method: "GET", body: undefined, features: null },
            {
                path: "/v1/guilds/20/roles",
                method: "POST",
                body: { name: "enabled", color: 0, permissions: bit.toString() },
                features: "view_channel_members_permission",
            },
            {
                path: "/v1/guilds/20/roles",
                method: "POST",
                body: { name: "cleared", color: 0, permissions: "0" },
                features: "view_channel_members_permission",
            },
            {
                path: "/v1/guilds/20/roles/50",
                method: "PATCH",
                body: { permissions: bit.toString() },
                features: "view_channel_members_permission",
            },
            {
                path: "/v1/guilds/20/roles/50",
                method: "PATCH",
                body: { permissions: "0" },
                features: "view_channel_members_permission",
            },
        ])
    },
)

test.each(modes)(
    "%s rejects default-role display patches locally while retaining color and permission patches",
    async (mode) => {
        const calls: { body: unknown }[] = []
        rest(async (_url, init) => {
            calls.push({ body: init.body ? JSON.parse(String(init.body)) : undefined })
            return Response.json(wireRole("20", init.body ? JSON.parse(String(init.body)) : {}))
        })
        const api = await setup(mode)

        for (const input of [
            { name: "renamed" },
            { hoist: true },
            { hoistPosition: 1 },
            { mentionable: true },
            { name: "renamed", color: 1, permissions: Permissions.ViewChannel },
            { hoist: true, color: 1, permissions: Permissions.ViewChannel },
            { hoistPosition: 1, color: 1, permissions: Permissions.ViewChannel },
            { mentionable: true, color: 1, permissions: Permissions.ViewChannel },
        ])
            await expect(api.roles.edit(input, "20")).rejects.toMatchObject({
                reason: "input",
                outcome: "notDispatched",
            })
        expect(calls).toEqual([])

        await api.roles.edit({ color: 1 }, "20")
        await api.roles.edit({ permissions: Permissions.ViewChannel }, "20")
        expect(calls).toEqual([{ body: { color: 1 } }, { body: { permissions: Permissions.ViewChannel.toString() } }])
    },
)

test.each(modes)(
    "%s rejects invalid role writes before dispatch and malformed successes without partial data",
    async (mode) => {
        let calls = 0
        let response: unknown = []
        rest(async () => {
            calls++
            return Response.json(response)
        })
        const api = await setup(mode)
        for (const input of [
            { name: "" },
            { name: " ".repeat(3) },
            { name: "x".repeat(101) },
            { name: "ok", color: -1 },
            { name: "ok", permissions: -1n },
            { name: "ok", permissions: 1n << 63n },
            { name: "ok", permissions: 1n << 64n },
            { name: "ok", permissions: "0" },
            { name: "ok", hoist: true },
        ])
            await expect(api.roles.create(input as RoleCreate)).rejects.toMatchObject({
                reason: "input",
                outcome: "notDispatched",
            })
        for (const input of [
            {},
            { permissions: undefined },
            { permissions: 1n << 63n },
            { hoist: 1 },
            { color: 0x1000000 },
            { hoistPosition: 2 ** 31 },
            { extra: true },
        ])
            await expect(api.roles.edit(input as RoleEdit)).rejects.toMatchObject({ reason: "input" })
        for (const input of [
            [],
            [{ id: "20", position: 1 }],
            [{ id: "50", position: -1 }],
            [
                { id: "50", position: 1 },
                { id: "50", position: 2 },
            ],
        ])
            await expect(api.roles.reorder(input)).rejects.toMatchObject({ reason: "input" })
        await expect(api.roles.delete("20")).rejects.toMatchObject({ reason: "input" })
        expect(calls).toBe(0)
        for (const value of [
            [wireRole(), wireRole()],
            [wireRole(), wireRole("51", { permissions: "18446744073709551616" })],
            [wireRole("50", { permissions: "01" })],
            [wireRole("50", { color: -1 })],
            [wireRole("50", { position: -1 })],
        ]) {
            response = value
            await expect(api.roles.list()).rejects.toMatchObject({ reason: "response", outcome: "unknown" })
        }
        response = [wireRole("51", { color: 0x1000000 })]
        expect((await api.roles.list())[0]?.color).toBe(0x1000000)
        response = wireRole("51")
        await expect(api.roles.edit({ name: "ok" })).rejects.toMatchObject({ reason: "response" })
        expect(calls).toBe(7)
    },
)

test.each(modes)("%s does not replay uncertain role mutations and preserves safe rejection metadata", async (mode) => {
    let calls = 0
    let status = 503
    rest(async () => {
        calls++
        return new Response("private upstream body", { status })
    })
    const api = await setup(mode)
    for (const write of [
        () => api.roles.create({ name: "ok" }),
        () => api.roles.edit({ name: "ok" }),
        () => api.roles.reorder([{ id: "50", position: 1 }]),
        () => api.roles.delete(),
    ]) {
        const before = calls
        await expect(write()).rejects.toMatchObject({ reason: "rejected", outcome: "unknown", status: 503 })
        expect(calls - before).toBe(1)
    }
    status = 403
    const error = await api.roles.edit({ permissions: Permissions.ManageRoles }).catch((error) => error)
    expect(error).toMatchObject({ reason: "rejected", outcome: "rejected", status: 403 })
    expect(String(error)).not.toContain("private upstream")
})

test.each(modes)("%s delivers distinct role events through the gateway without synthetic REST events", async (mode) => {
    const server = await gateway()
    rest(async () => Response.json(wireRole()))
    const api = await setup(mode)
    const seen: unknown[] = []
    for (const event of ["guildRoleCreate", "guildRoleUpdate", "guildRoleUpdateBulk", "guildRoleDelete"] as const)
        await api.on(event, (value) => {
            seen.push({ event, value })
            expect(Object.isFrozen(value)).toBe(true)
        })
    await api.connect()
    await api.roles.edit({ name: "fixture" })
    expect(seen).toEqual([])
    // The fixture sends real protocol frames; source order is asserted only within each subscription
    for (const [t, d] of [
        ["GUILD_ROLE_CREATE", { guild_id: "20", role: wireRole() }],
        ["GUILD_ROLE_UPDATE", { guild_id: "20", role: wireRole("50", { permissions: "18014398509481984" }) }],
        ["GUILD_ROLE_UPDATE_BULK", { guild_id: "20", roles: [wireRole()] }],
        ["GUILD_ROLE_DELETE", { guild_id: "20", role_id: "50" }],
    ] as const)
        server(t, d)
    await vi.waitFor(() => expect(seen).toHaveLength(4))
    expect(seen).toEqual(
        expect.arrayContaining([
            { event: "guildRoleUpdate", value: expect.objectContaining({ permissions: 1n << 54n }) },
            {
                event: "guildRoleUpdateBulk",
                value: expect.objectContaining({ roles: [expect.objectContaining({ id: "50" })] }),
            },
            { event: "guildRoleDelete", value: { guildId: "20", id: "50" } },
        ]),
    )
})
test.each(modes)("%s rejects a malformed bulk role event without partial delivery", async (mode) => {
    const dispatch = await gateway()
    rest(async () => Response.json(guild))
    const api = await setup(mode)
    await api.connect()
    const handler = vi.fn()
    await api.on("guildRoleUpdateBulk", handler)
    dispatch("GUILD_ROLE_UPDATE_BULK", {
        guild_id: "20",
        roles: [wireRole(), wireRole("51", { permissions: "invalid" })],
    })
    const closed = api.defaultApi
        ? (async () => unwrap(await api.defaultApi!.waitForClose()))()
        : run(api.native!.waitForClose())
    await expect(closed).rejects.toMatchObject({ reason: "protocol" })
    expect(handler).not.toHaveBeenCalled()
})

test.each(modes)("%s delivers provider-shaped guild lifecycle observations after cache updates", async (mode) => {
    const dispatch = await gateway()
    cacheRest()
    const api = await setup(mode, resourceCache)
    const seen: { event: EventName; value: unknown; cached: unknown }[] = []
    const cachedGuild = () =>
        api.defaultApi ? unwrap(api.defaultApi.guilds.get("20")) : Effect.runSync(api.native!.guilds.get("20"))
    for (const event of ["guildCreate", "guildUpdate", "guildDelete"] as const)
        await api.on(event, (value) => {
            seen.push({ event, value, cached: cachedGuild() })
        })
    await api.connect()
    dispatch("GUILD_CREATE", {
        id: "20",
        properties: guild,
        roles: [],
        channels: [],
        emojis: [],
        members: [],
        member_count: 1,
        joined_at: null,
    })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({
        event: "guildCreate",
        value: expect.objectContaining({ id: "20", name: "fixture" }),
        cached: expect.objectContaining({ id: "20", name: "fixture" }),
    })
    expect(Object.isFrozen(seen[0]!.value)).toBe(true)
    dispatch("GUILD_UPDATE", { ...guild, guild_id: "20", name: "changed" })
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]).toEqual({
        event: "guildUpdate",
        value: expect.objectContaining({ id: "20", name: "changed" }),
        cached: expect.objectContaining({ id: "20", name: "changed" }),
    })
    dispatch("GUILD_DELETE", { id: "20", guild_id: "20", unavailable: true, unavailable_hidden: true })
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    expect(seen[2]).toEqual({
        event: "guildDelete",
        value: { id: "20", unavailable: true, unavailableHidden: true },
        cached: undefined,
    })
    expect(Object.isFrozen(seen[2]!.value)).toBe(true)
    dispatch("GUILD_CREATE", guildCreate("20", false))
    await vi.waitFor(() => expect(seen).toHaveLength(4))
    expect(seen[3]).toEqual({
        event: "guildCreate",
        value: expect.objectContaining({ id: "20", name: "fixture", isNewJoin: false }),
        cached: expect.objectContaining({ id: "20", name: "fixture" }),
    })
    expect(Object.isFrozen(seen[3]!.value)).toBe(true)
})

test.each(modes)("%s projects guild creation availability without polluting guild caches", async (mode) => {
    const dispatch = await gateway()
    const { calls } = cacheRest()
    const api = await setup(mode, resourceCache)
    let seen: { value: EventMap["guildCreate"]; cached: unknown } | undefined
    await api.on("guildCreate", (value) => {
        const cached = api.defaultApi
            ? unwrap(api.defaultApi.guilds.get(value.id))
            : Effect.runSync(api.native!.guilds.get(value.id))
        seen = { value, cached }
    })
    await api.connect()
    dispatch("GUILD_CREATE", {
        id: "20",
        unavailable: false,
        properties: guild,
        roles: [],
        channels: [],
        emojis: [],
        members: [],
        member_count: 1,
        joined_at: null,
    })
    await vi.waitFor(() => expect(seen).toBeDefined())
    expect(seen!.value.isNewJoin).toBe(false)
    expect(seen!.cached).toEqual(expect.objectContaining({ id: "20", name: "fixture" }))
    expect(seen!.cached).not.toHaveProperty("isNewJoin")
    expect(calls).toHaveLength(0)
    expect(Object.isFrozen(seen!.value)).toBe(true)
})

test.each(modes)("%s connects from READY across paired cache and hydration states", async (mode) => {
    for (const { cache, ready } of [
        { cache: {}, ready: { guilds: [] } },
        { cache: resourceCache, ready: { guilds: [{ id: "20", unavailable: true }] } },
    ]) {
        let releaseHydration!: () => void
        let hydrationStarted = false
        const dispatch = await gateway({
            ready,
            afterReady: () =>
                new Promise<void>((resolve) => {
                    hydrationStarted = true
                    releaseHydration = resolve
                }),
        })
        let restCalls = 0
        rest(async () => {
            restCalls++
            return Response.json(guild)
        })
        const api = await setup(mode, cache)
        const seen: { value: EventMap["guildCreate"]; cached: unknown }[] = []
        await api.on("guildCreate", (value) => {
            const cached = api.defaultApi
                ? unwrap(api.defaultApi.guilds.get(value.id))
                : Effect.runSync(api.native!.guilds.get(value.id))
            seen.push({ value, cached })
        })
        const joined = api.defaultApi
            ? (async () =>
                  unwrap(
                      await api.defaultApi!.waitFor("guildCreate", {
                          filter: (value) => value.isNewJoin,
                          timeoutMs: 1_000,
                      }),
                  ))()
            : run(
                  api.native!.waitFor("guildCreate", {
                      filter: (value) => value.isNewJoin,
                      timeoutMs: 1_000,
                  }),
              )
        try {
            const connecting = api.connect()
            await vi.waitFor(() => expect(hydrationStarted).toBe(true))
            await connecting

            dispatch("GUILD_CREATE", guildCreate("20", false))
            await vi.waitFor(() => expect(seen).toHaveLength(1))
            expect(seen[0]!.value.isNewJoin).toBe(false)

            // A join can arrive while the provider's initial snapshots are still delayed
            dispatch("GUILD_CREATE", guildCreate("21"))
            await vi.waitFor(() => expect(seen).toHaveLength(2))
            expect((await joined).id).toBe("21")

            releaseHydration()
            dispatch("GUILD_DELETE", { id: "22", unavailable: true })
            dispatch("GUILD_CREATE", guildCreate("22"))
            await vi.waitFor(() => expect(seen).toHaveLength(3))
            expect(seen.map(({ value }) => value.isNewJoin)).toEqual([false, true, true])
            expect(seen.every(({ value }) => Object.isFrozen(value))).toBe(true)
            expect(restCalls).toBe(0)

            for (const { value, cached } of seen) {
                if (cache === resourceCache) {
                    expect(cached).toEqual(expect.objectContaining({ id: value.id, name: "fixture" }))
                    expect(cached).not.toHaveProperty("isNewJoin")
                } else expect(cached).toBeUndefined()
            }

            const fetched = await api.fetchGuild("20")
            expect(fetched).not.toHaveProperty("isNewJoin")
            expect(restCalls).toBe(1)
        } finally {
            releaseHydration?.()
            await api.close()
        }
    }
})

test.each(modes)(
    "%s classifies joined replay and fresh Identify guild availability",
    async (mode) => {
        const dispatch = await gateway({
            rejectResume: (attempt) => attempt === 2,
            beforeResume: async (replay, attempt) => {
                if (attempt === 1) replay("GUILD_CREATE", guildCreate("21"))
            },
        })
        rest(async () => Response.json(guild))
        const api = await setup(mode)
        const seen: EventMap["guildCreate"][] = []
        await api.on("guildCreate", (value) => seen.push(value))
        const random = vi.spyOn(Math, "random").mockReturnValue(0)
        try {
            await api.connect()
            dispatch("GUILD_CREATE", guildCreate("20", false))
            await vi.waitFor(() => expect(seen).toHaveLength(1))

            transport.sockets[0]!.terminate()
            await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 5_000 })
            await vi.waitFor(() => expect(api.state()).toBe("Connected"), { timeout: 5_000 })

            transport.sockets.at(-1)!.terminate()
            await vi.waitFor(
                () => expect(dispatch.authenticationModes).toEqual(["identify", "resume", "resume", "identify"]),
                {
                    timeout: 5_000,
                },
            )
            await vi.waitFor(() => expect(api.state()).toBe("Connected"), { timeout: 5_000 })

            dispatch("GUILD_CREATE", guildCreate("22", false))
            await vi.waitFor(() => expect(seen).toHaveLength(3))
            expect(seen.map((value) => value.isNewJoin)).toEqual([false, true, false])
        } finally {
            random.mockRestore()
        }
    },
    12_000,
)

test.each(modes)("%s rejects non-false guild availability markers before lifecycle delivery", async (mode) => {
    for (const unavailable of [true, null, "false", 1]) {
        const dispatch = await gateway()
        rest(async () => Response.json(guild))
        const api = await setup(mode, resourceCache)
        const handler = vi.fn()
        await api.on("guildCreate", handler)
        await api.connect()
        dispatch("GUILD_CREATE", guildCreate("20", unavailable))
        const closed = api.defaultApi
            ? (async () => unwrap(await api.defaultApi!.waitForClose()))()
            : run(api.native!.waitForClose())
        await expect(closed).rejects.toMatchObject({ reason: "protocol" })
        expect(handler).not.toHaveBeenCalled()
    }
})

test.each(modes)("%s defaults omitted guild deletion availability flags without inferring a cause", async (mode) => {
    const dispatch = await gateway()
    rest(async () => Response.json(guild))
    const api = await setup(mode)
    let seen: unknown
    await api.on("guildDelete", (value) => {
        seen = value
    })
    await api.connect()
    dispatch("GUILD_DELETE", { id: "20" })
    await vi.waitFor(() => expect(seen).toBeDefined())
    expect(seen).toEqual({ id: "20", unavailable: false, unavailableHidden: false })
})

test.each(modes)("%s rejects incomplete guild updates and mismatched guild lifecycle IDs", async (mode) => {
    const dispatch = await gateway()
    rest(async () => Response.json(guild))
    const api = await setup(mode)
    const update = vi.fn()
    await api.on("guildUpdate", update)
    await api.connect()
    dispatch("GUILD_UPDATE", { id: "20" })
    const closed = api.defaultApi
        ? (async () => unwrap(await api.defaultApi!.waitForClose()))()
        : run(api.native!.waitForClose())
    await expect(closed).rejects.toMatchObject({ reason: "protocol" })
    expect(update).not.toHaveBeenCalled()
})

test.each(modes)("%s rejects a guild deletion with unequal duplicate IDs", async (mode) => {
    const dispatch = await gateway()
    rest(async () => Response.json(guild))
    const api = await setup(mode)
    const deleted = vi.fn()
    await api.on("guildDelete", deleted)
    await api.connect()
    dispatch("GUILD_DELETE", { id: "20", guild_id: "21" })
    const closed = api.defaultApi
        ? (async () => unwrap(await api.defaultApi!.waitForClose()))()
        : run(api.native!.waitForClose())
    await expect(closed).rejects.toMatchObject({ reason: "protocol" })
    expect(deleted).not.toHaveBeenCalled()
})

test.each(modes)("%s rejects a hidden guild deletion without unavailable", async (mode) => {
    const dispatch = await gateway()
    rest(async () => Response.json(guild))
    const api = await setup(mode)
    const deleted = vi.fn()
    await api.on("guildDelete", deleted)
    await api.connect()
    dispatch("GUILD_DELETE", { id: "20", unavailable_hidden: true })
    const closed = api.defaultApi
        ? (async () => unwrap(await api.defaultApi!.waitForClose()))()
        : run(api.native!.waitForClose())
    await expect(closed).rejects.toMatchObject({ reason: "protocol" })
    expect(deleted).not.toHaveBeenCalled()
})

test.each(modes)("%s rejects a guild update with unequal duplicate IDs", async (mode) => {
    const dispatch = await gateway()
    rest(async () => Response.json(guild))
    const api = await setup(mode)
    const updated = vi.fn()
    await api.on("guildUpdate", updated)
    await api.connect()
    dispatch("GUILD_UPDATE", { ...guild, guild_id: "21" })
    const closed = api.defaultApi
        ? (async () => unwrap(await api.defaultApi!.waitForClose()))()
        : run(api.native!.waitForClose())
    await expect(closed).rejects.toMatchObject({ reason: "protocol" })
    expect(updated).not.toHaveBeenCalled()
})

test.each(modes)(
    "%s clears retained and pending message observations on guild deletion without a guild index",
    async (mode) => {
        const dispatch = await gateway()
        let release!: () => void
        let pendingStarted = false
        const pendingResponse = new Promise<void>((resolve) => {
            release = resolve
        })
        rest(async (url) => {
            const id = url.split("/").at(-1)!
            if (id === "12") {
                pendingStarted = true
                await pendingResponse
            }
            return Response.json({
                id,
                channel_id: "21",
                ...(id === "10" ? { guild_id: "20" } : {}),
                content: "fixture",
                author: { id: "30", username: "fixture" },
            })
        })
        const api = await setup(mode, { messages: { maxEntries: 10 } })
        const first = { id: "10", channelId: "21" }
        const second = { id: "11", channelId: "21" }
        const pending = { id: "12", channelId: "21" }
        const fetch = async (reference: typeof first) =>
            api.defaultApi
                ? unwrap(await api.defaultApi.messages.fetch(reference))
                : await run(api.native!.messages.fetch(reference))
        const get = (reference: typeof first) =>
            api.defaultApi
                ? unwrap(api.defaultApi.messages.get(reference))
                : Effect.runSync(api.native!.messages.get(reference))
        await api.connect()
        await fetch(first)
        await fetch(second)
        const delayed = fetch(pending)
        await vi.waitFor(() => expect(pendingStarted).toBe(true))
        dispatch("GUILD_DELETE", { id: "20", unavailable: true })
        await vi.waitFor(() => expect(get(first)).toBeUndefined())
        expect(get(second)).toBeUndefined()
        release()
        await delayed
        expect(get(pending)).toBeUndefined()
    },
)

const target = { guildId: "20", userId: "30" }

const resourceCache = { guilds: true, members: true, roles: true }
function cacheRest() {
    const calls: { url: string; init: RequestInit }[] = []
    const control = { status: 200, roles: [wireRole(), wireRole("51")], name: "fixture" }
    rest(async (url, init) => {
        calls.push({ url, init })
        if (control.status !== 200) return Response.json({}, { status: control.status })
        const path = new URL(url).pathname
        if (init.method !== "GET") {
            if (path.endsWith("/roles/50") && init.method === "PATCH")
                return Response.json(wireRole("50", JSON.parse(String(init.body))))
            if (init.method === "POST") return Response.json(wireRole("52"))
            return new Response(null, { status: 204 })
        }
        if (path.endsWith("/roles")) return Response.json(control.roles)
        if (path.endsWith("/members")) return Response.json([member("30"), member("31")])
        if (path.includes("/members/"))
            return Response.json(member(path.endsWith("/@me") ? "30" : path.split("/").at(-1)!))
        return Response.json({ ...guild, id: path.split("/").at(-1), name: control.name })
    })
    return { calls, control }
}

test.each(modes)("%s resource caching is opt-in, local-only and validates lookups even when disabled", async (mode) => {
    const { calls } = cacheRest()
    const api = await setup(mode, {})
    await api.guild()
    await api.member()
    await api.roles.list()
    expect(await api.getGuild()).toBeUndefined()
    expect(await api.getMember()).toBeUndefined()
    expect(await api.getRole()).toBeUndefined()
    expect(calls).toHaveLength(3)
    await expect(api.getGuild("bad")).rejects.toMatchObject({ operation: "guilds.get", reason: "input" })
    await expect(api.getMember({ guildId: "20", userId: "bad" })).rejects.toMatchObject({
        operation: "members.get",
        reason: "input",
    })
    await expect(api.getRole("bad")).rejects.toMatchObject({ operation: "roles.get", reason: "input" })
    await api.close()
    await expect(api.getGuild()).rejects.toMatchObject({ _tag: "ClientClosedError" })
    await expect(api.getMember()).rejects.toMatchObject({ _tag: "ClientClosedError" })
    await expect(api.getRole()).rejects.toMatchObject({ _tag: "ClientClosedError" })
})

test.each(modes)("%s repeated resource lookups reuse frozen snapshots but fetch stays remote", async (mode) => {
    const { calls, control } = cacheRest()
    control.roles = [wireRole("50", { permissions: "18446744073709551615" }), wireRole("40", { name: "Readers" })]
    const api = await setup(mode, resourceCache)
    const g = await api.guild(),
        m = await api.self(),
        roles = await api.roles.list()
    for (let i = 0; i < 20; i++) {
        expect(await api.getGuild()).toBe(g)
        expect(await api.getMember()).toBe(m)
        expect(await api.getRole()).toBe(roles[0])
        const names = await Promise.all(m.roleIds.map(async (id) => (await api.getRole(id))?.name ?? id))
        expect(names).toEqual(["Readers"])
    }
    expect(calls).toHaveLength(3)
    expect(Object.isFrozen(m.roleIds)).toBe(true)
    expect(Object.isFrozen(g.features)).toBe(true)
    expect(Object.isFrozen(roles[0])).toBe(true)
    expect((await api.getRole())?.permissions).toBe((1n << 64n) - 1n)
    const page = await api.page()
    expect(await api.getMember({ ...target, userId: "31" })).toBe(page[1])
    control.name = "remote change"
    expect((await api.guild()).name).toBe("remote change")
    expect(calls).toHaveLength(5)
    expect(g.name).toBe("fixture")
    await api.member({ guildId: "21", userId: "30" })
    expect((await api.getMember({ guildId: "21", userId: "30" }))?.guildId).toBe("21")
    expect((await api.getMember())?.guildId).toBe("20")
})

test.each(modes)("%s global resource LRU and byte limits do not multiply by guild count", async (mode) => {
    cacheRest()
    const options = { maxEntries: 2, maxBytes: 4_194_304 }
    const api = await setup(mode, { guilds: options, members: options, roles: options })
    options.maxEntries = 99
    await api.fetchGuild("20")
    await api.fetchGuild("21")
    await api.getGuild("20")
    await api.fetchGuild("22")
    expect(await api.getGuild("21")).toBeUndefined()
    expect(await api.getGuild("20")).toBeDefined()
    await api.member()
    await api.member({ guildId: "21", userId: "30" })
    await api.getMember()
    await api.member({ guildId: "22", userId: "30" })
    expect(await api.getMember({ guildId: "21", userId: "30" })).toBeUndefined()
    await api.fetchRoles("20")
    await api.fetchRoles("21")
    expect(await api.getRole()).toBeUndefined()
    expect(await api.getRole("50", "21")).toBeDefined()
    const tiny = await setup(mode, { guilds: { maxBytes: 1 }, members: { maxBytes: 1 }, roles: { maxBytes: 1 } })
    await tiny.guild()
    await tiny.member()
    await tiny.roles.list()
    expect(await tiny.getGuild()).toBeUndefined()
    expect(await tiny.getMember()).toBeUndefined()
    expect(await tiny.getRole()).toBeUndefined()
})

test.each(modes)("%s resource expiry does not renew on lookup and zero age retains nothing", async (mode) => {
    cacheRest()
    const options = { maxAgeMs: 120 }
    const api = await setup(mode, { guilds: options, members: options, roles: options })
    await api.guild()
    await api.member()
    await api.roles.list()
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(await api.getGuild()).toBeDefined()
    expect(await api.getMember()).toBeDefined()
    expect(await api.getRole()).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(await api.getGuild()).toBeUndefined()
    expect(await api.getMember()).toBeUndefined()
    expect(await api.getRole()).toBeUndefined()
    const zero = await setup(mode, { guilds: { maxAgeMs: 0 }, members: { maxAgeMs: 0 }, roles: { maxAgeMs: 0 } })
    await zero.guild()
    await zero.member()
    await zero.roles.list()
    expect(await zero.getGuild()).toBeUndefined()
    expect(await zero.getMember()).toBeUndefined()
    expect(await zero.getRole()).toBeUndefined()
})

test.each(modes)("%s resource mutations invalidate related state without suppressing writes", async (mode) => {
    const { calls, control } = cacheRest()
    const api = await setup(mode, resourceCache)
    const previous = await api.member()
    await api.roles.list()
    await api.fetchRoles("21")
    await api.member({ guildId: "21", userId: "30" })
    await api.role(true)
    await api.role(true)
    expect(calls.filter((c) => c.init.method === "PUT")).toHaveLength(2)
    expect(await api.getMember()).toBeUndefined()
    expect(await api.getRole()).toBeDefined()
    expect(previous.roleIds).toEqual(["40"])
    await api.member()
    control.status = 403
    await expect(api.role(true)).rejects.toMatchObject({ outcome: "rejected" })
    expect(await api.getMember()).toBeDefined()
    control.status = 200
    await api.roles.edit({ name: "edited" })
    expect((await api.getRole())?.name).toBe("edited")
    expect(await api.getRole("51")).toBeDefined()
    await api.roles.reorder([{ id: "50", position: 2 }])
    expect(await api.getRole()).toBeUndefined()
    expect(await api.getRole("51")).toBeUndefined()
    await api.roles.list()
    await api.roles.create({ name: "new" })
    expect(await api.getRole()).toBeUndefined()
    expect(await api.getRole("52")).toBeDefined()
    await api.roles.list()
    control.status = 503
    await expect(api.roles.delete()).rejects.toMatchObject({ outcome: "unknown" })
    expect(await api.getMember()).toBeUndefined()
    expect(await api.getRole()).toBeUndefined()
    expect(await api.getMember({ guildId: "21", userId: "30" })).toBeDefined()
    expect(await api.getRole("50", "21")).toBeDefined()
})

test.each(modes)(
    "%s full role reads reconcile absence; malformed results and rejected writes do not replace snapshots",
    async (mode) => {
        const { control } = cacheRest()
        const api = await setup(mode, resourceCache)
        await api.roles.list()
        control.roles = [wireRole()]
        await api.roles.list()
        expect(await api.getRole("51")).toBeUndefined()
        control.roles = [wireRole(), wireRole("51", { permissions: "bad" })]
        await expect(api.roles.list()).rejects.toMatchObject({ reason: "response" })
        expect(await api.getRole()).toBeDefined()
        expect(await api.getRole("51")).toBeUndefined()
        control.status = 404
        await expect(api.roles.list()).rejects.toMatchObject({ reason: "notFound" })
        expect(await api.getRole()).toBeUndefined()
    },
)

test.each(modes)(
    "%s guild events update caches before handlers and removal invalidates dependent snapshots",
    async (mode) => {
        const dispatch = await gateway()
        cacheRest()
        const api = await setup(mode, resourceCache)
        await api.connect()
        await api.guild()
        await api.member()
        await api.roles.list()
        let seen: unknown
        await api.on("guildMemberUpdate", (value) => {
            seen = api.defaultApi
                ? unwrap(api.defaultApi.members.get(value))
                : Effect.runSync(api.native!.members.get(value))
        })
        dispatch("GUILD_MEMBER_UPDATE", { ...member("30", ["50"]), guild_id: "20" })
        await vi.waitFor(() => expect(seen).toMatchObject({ roleIds: ["50"] }))
        dispatch("GUILD_ROLE_UPDATE_BULK", { guild_id: "20", roles: [wireRole("50", { position: 7 })] })
        await vi.waitFor(async () => expect((await api.getRole())?.position).toBe(7))
        expect(await api.getRole("51")).toBeDefined()
        dispatch("GUILD_UPDATE", { ...guild, name: "changed" })
        await vi.waitFor(async () => expect((await api.getGuild())?.name).toBe("changed"))
        dispatch("GUILD_ROLE_DELETE", { guild_id: "20", role_id: "50" })
        await vi.waitFor(async () => expect(await api.getRole()).toBeUndefined())
        expect(await api.getMember()).toBeUndefined()
        expect(await api.getRole("51")).toBeUndefined()
        expect(await api.getGuild()).toBeDefined()
        await api.member()
        await api.roles.list()
        dispatch("GUILD_DELETE", { id: "20", unavailable: true })
        await vi.waitFor(async () => expect(await api.getGuild()).toBeUndefined())
        expect(await api.getMember()).toBeUndefined()
        expect(await api.getRole()).toBeUndefined()
        expect(api.state()).toBe("Connected")
    },
)

test.each(modes)(
    "%s a queued read and a retried read cannot rebuild resource caches across a gateway gap",
    async (mode) => {
        const dispatch = await gateway()
        cacheRest()
        const api = await setup(mode, resourceCache)
        await api.connect()
        await api.guild()
        await api.member()
        await api.roles.list()
        const releases: (() => void)[] = []
        let calls = 0
        rest(async () => {
            calls++
            await new Promise<void>((resolve) => releases.push(resolve))
            return Response.json(member())
        })
        const reads = Array.from({ length: 5 }, () => api.member())
        await vi.waitFor(() => expect(calls).toBe(4))
        transport.sockets.at(-1)!.terminate()
        await vi.waitFor(async () => expect(await api.getGuild()).toBeUndefined())
        releases.splice(0).forEach((release) => release())
        await vi.waitFor(() => expect(calls).toBe(5))
        releases.splice(0).forEach((release) => release())
        await Promise.all(reads)
        expect(await api.getMember()).toBeUndefined()
        expect(await api.getRole()).toBeUndefined()
        await vi.waitFor(() => expect(api.state()).toBe("Connected"))
        let attempts = 0
        rest(async () =>
            ++attempts === 1
                ? Response.json({}, { status: 503, headers: { "Retry-After": "0.3" } })
                : Response.json(member()),
        )
        const retry = api.member()
        await vi.waitFor(() => expect(attempts).toBe(1))
        dispatch("GUILD_DELETE", { id: "20" })
        await retry
        expect(attempts).toBe(2)
        expect(await api.getMember()).toBeUndefined()
    },
)

test.each(modes)(
    "%s conflicting delayed reads cannot overwrite event observations or restore removed members",
    async (mode) => {
        const dispatch = await gateway()
        cacheRest()
        const api = await setup(mode, resourceCache)
        await api.connect()
        let release!: () => void
        let started = false
        rest(async () => {
            started = true
            await new Promise<void>((resolve) => {
                release = resolve
            })
            return Response.json(member())
        })
        const reading = api.member()
        await vi.waitFor(() => expect(started).toBe(true))
        dispatch("GUILD_MEMBER_UPDATE", { guild_id: "20", ...member("30", ["50"]) })
        await vi.waitFor(async () => expect((await api.getMember())?.roleIds).toEqual(["50"]))
        release()
        await reading
        expect(await api.getMember()).toBeUndefined()
        started = false
        const again = api.member()
        await vi.waitFor(() => expect(started).toBe(true))
        dispatch("GUILD_MEMBER_REMOVE", { guild_id: "20", user: { id: "30" } })
        // An observed event handler proves intake happened even when the cache was already empty
        let removed = false
        await api.on("guildMemberRemove", () => {
            removed = true
        })
        dispatch("GUILD_MEMBER_REMOVE", { guild_id: "20", user: { id: "30" } })
        await vi.waitFor(() => expect(removed).toBe(true))
        release()
        await again
        expect(await api.getMember()).toBeUndefined()
    },
)

test.each(modes)(
    "%s late mutations crossing a gap still invalidate newly cached memberships",
    async (mode) => {
        let resume: (() => void) | undefined
        const dispatch = await gateway(
            () =>
                new Promise<void>((resolve) => {
                    resume = resolve
                }),
        )
        cacheRest()
        const api = await setup(mode, resourceCache)
        await api.connect()
        for (const status of [204, 503]) {
            let release!: () => void
            let started = false
            rest(async () => {
                started = true
                await new Promise<void>((resolve) => {
                    release = resolve
                })
                return status === 204 ? new Response(null, { status }) : Response.json({}, { status })
            })
            const writing = api.role(true).then(
                () => "success",
                (error) => error.outcome,
            )
            try {
                await vi.waitFor(() => expect(started).toBe(true))
                transport.sockets.at(-1)!.terminate()
                await vi.waitFor(() => expect(api.state()).toBe("Recovering"))
                // Hold the fixture's RESUMED response until the recovery assertion has observed the gap
                await vi.waitFor(() => expect(resume).toBeDefined(), { timeout: 5_000 })
                resume!()
                resume = undefined
                await vi.waitFor(() => expect(api.state()).toBe("Connected"), { timeout: 5_000 })
                dispatch("GUILD_MEMBER_UPDATE", { guild_id: "20", ...member() })
                await vi.waitFor(async () => expect(await api.getMember()).toBeDefined())
                release()
                expect(await writing).toBe(status === 204 ? "success" : "unknown")
                expect(await api.getMember()).toBeUndefined()
            } finally {
                resume?.()
                release?.()
                await writing
            }
        }
    },
    10_000,
)

test.each(modes)("%s cache eviction after cancellation waits for dispatched write cleanup", async (mode) => {
    cacheRest()
    const api = await setup(mode, resourceCache)
    await api.member()
    const before = new AbortController()
    before.abort()
    if (api.defaultApi)
        await expect(api.role(true, "50", { signal: before.signal })).rejects.toMatchObject({ _tag: "CancelledError" })
    else {
        const exit = await Effect.runPromiseExit(
            Effect.interrupt.pipe(Effect.andThen(api.native!.members.addRole(target, "50"))),
        )
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    }
    expect(await api.getMember()).toBeDefined()
    let started = false,
        cleaned = false
    rest(
        async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
                started = true
                init.signal!.addEventListener(
                    "abort",
                    () =>
                        setTimeout(() => {
                            cleaned = true
                            reject(new Error("fixture cancellation"))
                        }, 30),
                    { once: true },
                )
            }),
    )
    const abort = new AbortController()
    const writing = api.role(true, "50", { signal: abort.signal }).catch(() => undefined)
    await vi.waitFor(() => expect(started).toBe(true))
    abort.abort()
    await writing
    expect(cleaned).toBe(true)
    expect(await api.getMember()).toBeUndefined()
})

test.each(modes)("%s rejects invalid resource settings without running policies", async (mode) => {
    for (const kind of ["guilds", "members", "roles"] as const)
        for (const settings of [
            null,
            1,
            { maxEntries: 0 },
            { maxBytes: NaN },
            { maxAgeMs: -1 },
            { maxAgeMs: () => 100 },
            { onError: () => {} },
        ]) {
            const options = { token: "fixture", cache: { [kind]: settings } } as ClientOptions
            if (mode === "default") expect(createClient(options).isErr()).toBe(true)
            else
                await expect(
                    Effect.runPromise(Effect.scoped(createNative(options as NativeClientOptions))),
                ).rejects.toMatchObject({ _tag: "ConfigurationError" })
        }
})

test.each(modes)("%s keeps hoist display writes separate and invalidates late role reads", async (mode) => {
    const api = await setup(mode, { roles: true })
    const calls: { path: string; method: string; body: unknown }[] = []
    let block = false
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
        entered = resolve
    })
    rest(async (url, init) => {
        calls.push({
            path: new URL(url).pathname,
            method: init.method!,
            body: init.body ? JSON.parse(String(init.body)) : undefined,
        })
        if (init.method === "GET") {
            if (block) {
                entered()
                await new Promise<void>((resolve) => {
                    release = resolve
                })
            }
            return Response.json([wireRole()])
        }
        return new Response(null, { status: 204 })
    })
    await api.roles.list()
    expect(await api.getRole()).toBeDefined()
    block = true
    const late = api.roles.list()
    await started
    await api.roles.setHoist([{ id: "50", hoistPosition: -1 }])
    expect(await api.getRole()).toBeUndefined()
    release()
    await late
    expect(await api.getRole()).toBeUndefined()
    expect(calls.at(-1)).toEqual({
        path: "/v1/guilds/20/roles/hoist-positions",
        method: "PATCH",
        body: [{ id: "50", hoist_position: -1 }],
    })
    block = false
    await api.roles.list()
    await api.roles.resetHoist()
    expect(await api.getRole()).toBeUndefined()
    expect(calls.at(-1)).toEqual({ path: "/v1/guilds/20/roles/hoist-positions", method: "DELETE", body: undefined })
})

test.each(modes)(
    "%s rejects malformed hoist assignments before dispatch and does not replay uncertain writes",
    async (mode) => {
        const api = await setup(mode, { roles: true })
        let calls = 0
        rest(async () => {
            calls++
            return new Response(null, { status: 204 })
        })
        for (const positions of [
            [],
            [{ id: "20", hoistPosition: 0 }],
            [{ id: "bad", hoistPosition: 0 }],
            [
                { id: "50", hoistPosition: 0 },
                { id: "50", hoistPosition: 1 },
            ],
            [{ id: "50", position: 0 }],
            [{ id: "50", hoistPosition: 0, extra: true }],
            ...[NaN, Infinity, 0.5, 2_147_483_648, -2_147_483_649, null].map((hoistPosition) => [
                { id: "50", hoistPosition },
            ]),
        ]) {
            await expect(api.roles.setHoist(positions as readonly RoleHoistPosition[])).rejects.toMatchObject({
                reason: "input",
                outcome: "notDispatched",
            })
        }
        expect(calls).toBe(0)
        rest(async () => {
            calls++
            return new Response(null, { status: 503 })
        })
        await expect(api.roles.setHoist([{ id: "50", hoistPosition: 0 }])).rejects.toMatchObject({ outcome: "unknown" })
        expect(calls).toBe(1)
        await expect(api.roles.resetHoist()).rejects.toMatchObject({ outcome: "unknown" })
        expect(calls).toBe(2)
    },
)

const member = (id = "30", roles = ["40"]) => ({
    user: { id, username: "fixture", bot: true },
    roles,
    joined_at: "2026-09-08T12:00:00Z",
    nick: null,
    avatar: null,
})
const guild = { id: "20", owner_id: "30", name: "fixture", features: ["FUTURE_FEATURE"], icon: null }
const guildCreate = (id = "20", unavailable?: unknown) => ({
    id,
    ...(unavailable === undefined ? {} : { unavailable }),
    properties: { ...guild, id },
    roles: [],
    channels: [],
    emojis: [],
    members: [],
    member_count: 1,
    joined_at: null,
})
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
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) =>
        url.endsWith("/gateway/bot")
            ? Promise.resolve(Response.json({ url: "wss://gateway.fluxer.app" }))
            : handler(url, init),
    )
}
async function setup(
    mode: (typeof modes)[number],
    cache: Pick<NonNullable<ClientOptions["cache"]>, "guilds" | "members" | "roles"> & {
        messages?: boolean | { maxEntries?: number }
    } = { messages: { maxEntries: 1 } },
) {
    const scope = Scope.makeUnsafe()
    const defaultApi =
        mode === "default"
            ? unwrap(createClient({ token: "fixture", ...(cache === undefined ? {} : { cache }) }))
            : undefined
    const native =
        mode === "native" ? await run(createNative({ token: "fixture", cache }).pipe(Scope.provide(scope))) : undefined
    const close = async () => (defaultApi ? unwrap(await defaultApi.shutdown()) : run(native!.shutdown()))
    onTestFinished(async () => {
        await close()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        defaultApi,
        native,
        timeout: async (duration: number, options?: DefaultModerationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.members.timeout(target, duration, options))
                : run(native!.members.timeout(target, duration, options)),
        clearTimeout: async () =>
            defaultApi
                ? unwrap(await defaultApi.members.clearTimeout(target))
                : run(native!.members.clearTimeout(target)),
        kick: async (options?: DefaultModerationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.members.kick(target, options))
                : run(native!.members.kick(target, options), options?.signal as AbortSignal),
        ban: async (input?: BanInput, options?: DefaultModerationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.guilds.ban(target, input, options))
                : run(native!.guilds.ban(target, input, options)),
        unban: async () =>
            defaultApi ? unwrap(await defaultApi.guilds.unban(target)) : run(native!.guilds.unban(target)),
        bans: async () =>
            defaultApi ? unwrap(await defaultApi.guilds.fetchBans("20")) : run(native!.guilds.fetchBans("20")),
        getGuild: async (id = "20") => (defaultApi ? unwrap(defaultApi.guilds.get(id)) : run(native!.guilds.get(id))),
        getMember: async (ref = target) =>
            defaultApi ? unwrap(defaultApi.members.get(ref)) : run(native!.members.get(ref)),
        getRole: async (id = "50", guildId = "20") =>
            defaultApi ? unwrap(defaultApi.roles.get({ guildId, id })) : run(native!.roles.get({ guildId, id })),
        fetchGuild: async (id: string) =>
            defaultApi ? unwrap(await defaultApi.guilds.fetch(id)) : run(native!.guilds.fetch(id)),
        fetchRoles: async (id: string) =>
            defaultApi ? unwrap(await defaultApi.roles.fetchAll(id)) : run(native!.roles.fetchAll(id)),
        roles: {
            setHoist: async (positions: readonly RoleHoistPosition[], options?: DefaultGuildAuditOperationOptions) =>
                defaultApi
                    ? unwrap(await defaultApi.roles.setHoistPositions("20", positions, options))
                    : run(native!.roles.setHoistPositions("20", positions, options), options?.signal as AbortSignal),
            resetHoist: async (options?: DefaultGuildAuditOperationOptions) =>
                defaultApi
                    ? unwrap(await defaultApi.roles.resetHoistPositions("20", options))
                    : run(native!.roles.resetHoistPositions("20", options), options?.signal as AbortSignal),
            list: async () =>
                defaultApi ? unwrap(await defaultApi.roles.fetchAll("20")) : run(native!.roles.fetchAll("20")),
            create: async (input: RoleCreate, options?: DefaultGuildAuditOperationOptions) =>
                defaultApi
                    ? unwrap(await defaultApi.roles.create("20", input, options))
                    : run(native!.roles.create("20", input, options), options?.signal as AbortSignal),
            edit: async (input: RoleEdit, id = "50", options?: DefaultGuildAuditOperationOptions) =>
                defaultApi
                    ? unwrap(await defaultApi.roles.edit({ guildId: "20", id }, input, options))
                    : run(native!.roles.edit({ guildId: "20", id }, input, options), options?.signal as AbortSignal),
            delete: async (id = "50", options?: DefaultGuildAuditOperationOptions) =>
                defaultApi
                    ? unwrap(await defaultApi.roles.delete({ guildId: "20", id }, options))
                    : run(native!.roles.delete({ guildId: "20", id }, options), options?.signal as AbortSignal),
            reorder: async (positions: readonly RolePosition[], options?: DefaultGuildAuditOperationOptions) =>
                defaultApi
                    ? unwrap(await defaultApi.roles.reorder("20", positions, options))
                    : run(native!.roles.reorder("20", positions, options), options?.signal as AbortSignal),
        },
        close,
        connect: async () => (defaultApi ? unwrap(await defaultApi.connect()) : run(native!.connect())),
        state: () => (defaultApi ?? native)!.state,
        guild: async (options?: DefaultGuildOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.guilds.fetch("20", options))
                : run(native!.guilds.fetch("20", options), options?.signal as AbortSignal),
        member: async (ref: MemberReference = target, options?: DefaultGuildOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.members.fetch(ref, options))
                : run(native!.members.fetch(ref, options), options?.signal as AbortSignal),
        self: async () =>
            defaultApi ? unwrap(await defaultApi.members.fetchSelf("20")) : run(native!.members.fetchSelf("20")),
        page: async (query?: MemberQuery) =>
            defaultApi
                ? unwrap(await defaultApi.members.fetchPage("20", query))
                : run(native!.members.fetchPage("20", query)),
        setRoles: async (ids: readonly string[], options?: DefaultGuildAuditOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.members.setRoles(target, ids, options))
                : run(native!.members.setRoles(target, ids, options), options?.signal as AbortSignal),
        editSelf: async (options?: DefaultGuildAuditOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.members.editSelf("20", { nickname: "self" }, options))
                : run(native!.members.editSelf("20", { nickname: "self" }, options), options?.signal as AbortSignal),
        setNickname: async (options?: DefaultGuildAuditOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.members.setNickname(target, "member", options))
                : run(native!.members.setNickname(target, "member", options), options?.signal as AbortSignal),
        role: async (add: boolean, id = "50", options?: DefaultGuildAuditOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.members[add ? "addRole" : "removeRole"](target, id, options))
                : run(
                      native!.members[add ? "addRole" : "removeRole"](target, id, options),
                      options?.signal as AbortSignal,
                  ),
        on: async <K extends EventName>(event: K, handler: (value: EventMap[K]) => void) =>
            defaultApi
                ? unwrap(defaultApi.on(event, handler))
                : run(native!.on(event, (value) => Effect.sync(() => handler(value))).pipe(Scope.provide(scope))),
    }
}
type GatewayDispatch = ((event: string, d: unknown) => void) & {
    readonly authenticationModes: readonly ("identify" | "resume")[]
}
interface GatewayOptions {
    readonly ready?: Readonly<Record<string, unknown>>
    readonly afterReady?: () => Promise<void>
    readonly beforeResume?: (dispatch: GatewayDispatch, attempt: number) => Promise<void>
    readonly rejectResume?: boolean | ((attempt: number) => boolean)
}
async function gateway(options: GatewayOptions | (() => Promise<void>) = {}): Promise<GatewayDispatch> {
    const controls = typeof options === "function" ? { beforeResume: options } : options
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Fixture port missing")
    transport.url = `ws://127.0.0.1:${address.port}`
    let seq = 0
    let resumeAttempts = 0
    const authenticationModes: ("identify" | "resume")[] = []
    const dispatch = Object.assign(
        (event: string, d: unknown) => {
            for (const socket of server.clients) socket.send(JSON.stringify({ op: 0, s: ++seq, t: event, d }))
        },
        { authenticationModes },
    )
    server.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }))
        socket.on("message", async (data) => {
            const frame = JSON.parse(data.toString())
            if (frame.op === 1) socket.send(JSON.stringify({ op: 11 }))
            if (frame.op === 2) authenticationModes.push("identify")
            if (frame.op === 6) {
                authenticationModes.push("resume")
                resumeAttempts++
                await controls.beforeResume?.(dispatch, resumeAttempts)
                const rejectResume =
                    typeof controls.rejectResume === "function"
                        ? controls.rejectResume(resumeAttempts)
                        : controls.rejectResume
                if (rejectResume) {
                    socket.close(4007)
                    return
                }
            }
            if (frame.op === 2 || frame.op === 6)
                socket.send(
                    JSON.stringify({
                        op: 0,
                        s: ++seq,
                        t: frame.op === 2 ? "READY" : "RESUMED",
                        d: frame.op === 2 ? { ...controls.ready, session_id: "fixture" } : { session_id: "fixture" },
                    }),
                )
            if (frame.op === 2) await controls.afterReady?.()
        })
    })
    onTestFinished(async () => {
        for (const socket of server.clients) socket.terminate()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return dispatch
}

test.each(modes)("%s reads guilds and member pages without connecting or retaining live state", async (mode) => {
    const urls: string[] = []
    rest(async (url) => {
        urls.push(url)
        const parsed = new URL(url)
        if (parsed.pathname.endsWith("/members")) return Response.json([member("31"), member("32")])
        if (parsed.pathname.includes("/members/")) return Response.json(member())
        return Response.json(guild)
    })
    const api = await setup(mode)
    expect(await api.guild()).toEqual({
        id: "20",
        ownerId: "30",
        name: "fixture",
        features: ["FUTURE_FEATURE"],
        icon: null,
    })
    const value = await api.member()
    expect(value).toMatchObject({
        guildId: "20",
        userId: "30",
        username: "fixture",
        isBot: true,
        roleIds: ["40"],
        nickname: null,
    })
    expect(Object.isFrozen(value) && Object.isFrozen(value.roleIds)).toBe(true)
    expect(await api.self()).toEqual(value)
    expect((await api.page({ limit: 2, after: "30" })).map((m) => m.userId)).toEqual(["31", "32"])
    expect(urls.at(-1)).toContain("/guilds/20/members?limit=2&after=30")
    await api.page()
    expect(urls.at(-1)).toContain("limit=100")
    expect(api.state()).toBe("Disconnected")
})

test.each(modes)("%s targeted role requests preserve other roles and do not trust old observations", async (mode) => {
    let roles = ["40"]
    const writes: string[] = []
    rest(async (url, init) => {
        if (init.method === "GET") return Response.json(member("30", roles))
        expect(url).toBe("https://api.fluxer.app/v1/guilds/20/members/30/roles/50")
        expect(init.body).toBeUndefined()
        writes.push(init.method!)
        roles = init.method === "PUT" ? [...new Set([...roles, "50"])] : roles.filter((id) => id !== "50")
        return new Response(null, { status: 204 })
    })
    const api = await setup(mode)
    const before = await api.member()
    await api.role(true)
    await api.role(true)
    expect((await api.member()).roleIds).toEqual(["40", "50"])
    await api.role(false)
    await api.role(false)
    expect((await api.member()).roleIds).toEqual(["40"])
    expect(before.roleIds).toEqual(["40"])
    expect(writes).toEqual(["PUT", "PUT", "DELETE", "DELETE"])
})

test.each(modes)(
    "%s rejects invalid inputs and mismatched or malformed resources without partial pages",
    async (mode) => {
        let calls = 0
        let response: unknown = member()
        rest(async () => {
            calls++
            return Response.json(response)
        })
        const api = await setup(mode)
        for (const invalid of [
            { guildId: "../20", userId: "30" },
            { guildId: "20", userId: "@me" },
        ])
            await expect(api.member(invalid)).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
        for (const query of [{ limit: 0 }, { limit: 1001 }, { after: "invalid" }, { extra: true }])
            await expect(api.page(query as MemberQuery)).rejects.toMatchObject({ reason: "input" })
        await expect(api.role(true, "20")).rejects.toMatchObject({ reason: "input" })
        expect(calls).toBe(0)
        for (response of [
            member("31"),
            { ...member(), roles: ["40", "40"] },
            { ...member(), nick: 2 },
            { ...member(), joined_at: "no" },
            { ...member(), joined_at: "2025-02-29T00:00:00Z" },
            { ...member(), communication_disabled_until: "2025-04-31T00:00:00Z" },
            { ...member(), user: { id: "30" } },
        ])
            await expect(api.member()).rejects.toMatchObject({ reason: "response", status: 200 })
        for (response of [[member("32"), member("31")], [member("30")], [member("31"), member("31")]])
            await expect(api.page({ after: "30", limit: 2 })).rejects.toMatchObject({ reason: "response" })
        response = { ...guild, id: "21" }
        await expect(api.guild()).rejects.toMatchObject({ reason: "response" })
        response = { ...guild, message_history_cutoff: "2025-02-29T00:00:00Z" }
        await expect(api.guild()).rejects.toMatchObject({ reason: "response" })
    },
)

test.each(modes)("%s retains typed failures, shared retry policy and no uncertain write retries", async (mode) => {
    const api = await setup(mode)
    for (const status of [401, 403, 404, 503]) {
        let calls = 0
        rest(async () => {
            calls++
            return new Response("private upstream body", { status })
        })
        const error = await api.member().catch((error) => error)
        expect(error).toMatchObject({
            _tag: "GuildOperationError",
            operation: "members.fetch",
            status,
            reason: status === 404 ? "notFound" : "rejected",
        })
        expect(JSON.stringify(error)).not.toContain("private upstream")
        expect(calls).toBe(status === 503 ? 3 : 1)
        calls = 0
        await expect(api.role(true)).rejects.toMatchObject({ operation: "members.addRole", status })
        expect(calls).toBe(1)
    }
    let calls = 0
    rest(async () => {
        if (++calls === 1) throw Error("private network")
        return Response.json(member())
    })
    expect((await api.member()).userId).toBe("30")
    expect(calls).toBe(2)
    calls = 0
    rest(async () => {
        calls++
        throw Error("private network")
    })
    await expect(api.role(false)).rejects.toMatchObject({ reason: "network", outcome: "unknown" })
    expect(calls).toBe(1)
})

test.each(modes)("%s shares member read rate state without blocking guild reads", async (mode) => {
    let calls = 0
    rest(async (url) => {
        calls++
        if (url.includes("/members")) return Response.json({ retry_after: 60 }, { status: 429 })
        return Response.json(guild)
    })
    const api = await setup(mode)
    await expect(api.member(target, { timeoutMs: 20 })).rejects.toMatchObject({ reason: "rateLimit" })
    await expect(api.member(target, { timeoutMs: 20 })).rejects.toMatchObject({ reason: "timeout" })
    expect(calls).toBe(1)
    expect((await api.guild()).id).toBe("20")
})

test.each(modes)("%s guild/member traffic cannot populate, evict or mutate the message cache", async (mode) => {
    rest(async (url, init) => {
        if (url.includes("/channels/"))
            return Response.json({
                id: "10",
                channel_id: "20",
                content: "retained",
                author: { id: "30", username: "fixture" },
            })
        if (init.method !== "GET") return new Response(null, { status: 204 })
        return Response.json(url.includes("/members") ? member() : guild)
    })
    const api = await setup(mode)
    const message = { id: "10", channelId: "20" }
    const original = api.defaultApi
        ? unwrap(await api.defaultApi.messages.fetch(message))
        : await run(api.native!.messages.fetch(message))
    await api.guild()
    await api.member()
    await api.role(true)
    await api.role(false)
    const cached = api.defaultApi
        ? unwrap(api.defaultApi.messages.get(message))
        : await run(api.native!.messages.get(message))
    expect(cached).toEqual(original)
})

test.each(modes)("%s request input is captured at execution and remains stable while queued", async (mode) => {
    const urls: string[] = []
    let release!: () => void
    const bodies: unknown[] = []
    const waiting = new Promise<void>((resolve) => {
        release = resolve
    })
    rest(async (url, init) => {
        urls.push(url)
        await waiting
        if (init.method === "PATCH") {
            const body = JSON.parse(String(init.body))
            bodies.push(body)
            return Array.isArray(body) ? new Response(null, { status: 204 }) : Response.json(wireRole("50", body))
        }
        return Response.json(member(new URL(url).pathname.split("/").at(-1)!))
    })
    const api = await setup(mode)
    const blockers = Array.from({ length: 4 }, () => api.member())
    await vi.waitFor(() => expect(urls).toHaveLength(4))
    const ref = { ...target }
    const effect = api.native?.members.fetch(ref)
    if (effect) ref.userId = "31"
    const pending = effect ? run(effect) : api.member(ref)
    ref.userId = "99"
    const input = { name: "initial", permissions: 0n }
    const positions = [{ id: "50", position: 1 }]
    const editing = api.roles.edit(input)
    const ordering = api.roles.reorder(positions)
    input.name = "changed"
    input.permissions = Permissions.Administrator
    positions[0]!.position = 99
    release()
    await Promise.all(blockers)
    expect((await pending).userId).toBe(mode === "default" ? "30" : "31")
    expect(urls.some((url) => url.endsWith(`/members/${mode === "default" ? "30" : "31"}`))).toBe(true)
    expect((await editing).name).toBe("initial")
    await ordering
    expect(bodies).toEqual([{ name: "initial", permissions: "0" }, [{ id: "50", position: 1 }]])
})

test.each(modes)("%s cancellation and shutdown await active guild transport cleanup", async (mode) => {
    let active = 0
    rest(
        (_url, init) =>
            new Promise((_resolve, reject) => {
                active++
                init.signal!.addEventListener(
                    "abort",
                    () =>
                        setTimeout(() => {
                            active--
                            reject(Error("aborted"))
                        }, 20),
                    { once: true },
                )
            }),
    )
    const api = await setup(mode)
    const controller = new AbortController()
    const pending = api.native
        ? Effect.runPromiseExit(api.native.members.fetch(target), { signal: controller.signal })
        : api.member(target, { signal: controller.signal }).catch((error) => error)
    await vi.waitFor(() => expect(active).toBe(1))
    controller.abort()
    const error = await pending
    if (api.native) expect(Exit.isFailure(error) && Cause.hasInterruptsOnly(error.cause)).toBe(true)
    else expect(error).toMatchObject({ _tag: "CancelledError" })
    expect(active).toBe(0)
    const closing = api.guild().catch((error) => error)
    await vi.waitFor(() => expect(active).toBe(1))
    await api.close()
    expect(await closing).toMatchObject({ _tag: "ClientClosedError" })
    expect(active).toBe(0)
})

test.each(modes)("%s delivers member events across resume without synthesizing REST events", async (mode) => {
    const dispatch = await gateway()
    rest(async () => Response.json(member()))
    const api = await setup(mode)
    const seen: unknown[] = []
    for (const event of ["guildMemberAdd", "guildMemberUpdate", "guildMemberRemove"] as const)
        await api.on(event, (value) => seen.push({ event, value }))
    await api.connect()
    await api.member()
    expect(seen).toEqual([])
    dispatch("GUILD_MEMBER_ADD", { ...member(), guild_id: "20" })
    dispatch("GUILD_MEMBER_UPDATE", { ...member("30", ["50"]), guild_id: "20" })
    dispatch("GUILD_MEMBER_REMOVE", { guild_id: "20", user: { id: "30" } })
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    expect(seen[2]).toEqual({ event: "guildMemberRemove", value: target })
    transport.sockets[0]!.terminate()
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(2), { timeout: 5_000 })
    await vi.waitFor(() => expect(api.state()).toBe("Connected"))
    dispatch("GUILD_MEMBER_UPDATE", { ...member(), guild_id: "20" })
    await vi.waitFor(() => expect(seen).toHaveLength(4))
    expect((await api.member()).roleIds).toEqual(["40"])
})
