import { once } from "node:events"
import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import { ChannelType, createClient, type ClientOptions, type EventName } from "../src/index.js"
import { createClient as createNative, type ClientOptions as NativeClientOptions } from "../src/effect.js"

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
const channel = (id = "10", extra: Record<string, unknown> = {}) => ({
    id,
    guild_id: "20",
    type: 0,
    name: "fixture",
    position: 1,
    parent_id: "12",
    topic: null,
    last_message_id: "9",
    last_pin_timestamp: "2026-09-08T12:00:00.000Z",
    rate_limit_per_user: 0,
    nsfw: false,
    nsfw_override: true,
    content_warning_level: 1,
    content_warning_text: "notice",
    permission_overwrites: [{ id: "50", type: 0, allow: "1", deny: "18446744073709551615" }],
    ...extra,
})
const voiceChannel = (id = "11", extra: Record<string, unknown> = {}) =>
    channel(id, {
        type: 2,
        name: "voice",
        bitrate: 64_000,
        user_limit: 5,
        voice_connection_limit: 10,
        rtc_region: null,
        ...extra,
    })
const category = (id = "12", extra: Record<string, unknown> = {}) =>
    channel(id, { type: 4, name: "category", parent_id: null, ...extra })
const message = (id = "10", channelId = "20", content = "fixture") => ({
    id,
    channel_id: channelId,
    content,
    author: { id: "30", username: "fixture" },
})

test.each(modes)("%s manages guild channels through exact routes with frozen, lossless projections", async (mode) => {
    const calls: { path: string; method: string; body: unknown }[] = []
    rest(async (url, init) => {
        const path = new URL(url).pathname
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ path, method: init.method!, body })
        if (init.method === "DELETE" || Array.isArray(body) || path.includes("/permissions/"))
            return new Response(null, { status: 204 })
        if (init.method === "GET" && path.endsWith("/channels"))
            return Response.json([channel(), voiceChannel(), category()])
        if (init.method === "GET") return Response.json(path.endsWith("/11") ? voiceChannel() : channel())
        if (init.method === "POST") return Response.json(channel("13", body as Record<string, unknown>))
        return Response.json(channel("10", body as Record<string, unknown>))
    })
    const api = await setup(mode, { channels: true })

    const fetched = await api.fetch()
    expect(fetched).toMatchObject({
        id: "10",
        guildId: "20",
        type: ChannelType.Text,
        name: "fixture",
        position: 1,
        parentId: "12",
        topic: null,
        lastMessageId: "9",
        lastPinTimestamp: "2026-09-08T12:00:00.000Z",
        rateLimitPerUser: 0,
        nsfw: false,
        nsfwOverride: true,
        contentWarningLevel: 1,
        contentWarningText: "notice",
        permissionOverwrites: [{ id: "50", type: "role", allow: 1n, deny: (1n << 64n) - 1n }],
    })
    expect(
        Object.isFrozen(fetched) &&
            Object.isFrozen(fetched.permissionOverwrites) &&
            Object.isFrozen(fetched.permissionOverwrites?.[0]),
    ).toBe(true)
    expect(() => Object.assign(fetched, { name: "changed" })).toThrow()
    const listed = await api.fetchAll()
    expect(listed.map((value) => value.id)).toEqual(["10", "11", "12"])
    expect(listed[1]).toMatchObject({
        type: ChannelType.Voice,
        bitrate: 64_000,
        userLimit: 5,
        voiceConnectionLimit: 10,
    })
    expect(Object.isFrozen(listed) && Object.isFrozen(listed[2])).toBe(true)

    await api.create("20", { type: ChannelType.Text, name: "inherited", parentId: "12" })
    expect(calls.at(-1)).toMatchObject({
        path: "/v1/guilds/20/channels",
        method: "POST",
        body: { type: 0, name: "inherited", parent_id: "12" },
    })
    expect((calls.at(-1)?.body as Record<string, unknown>).permission_overwrites).toBeUndefined()
    await api.create("20", {
        type: ChannelType.Voice,
        name: "cleared",
        bitrate: 64_000,
        userLimit: 5,
        voiceConnectionLimit: 10,
        permissionOverwrites: [],
    })
    expect(calls.at(-1)).toMatchObject({
        body: {
            type: 2,
            name: "cleared",
            bitrate: 64_000,
            user_limit: 5,
            voice_connection_limit: 10,
            permission_overwrites: [],
        },
    })
    await api.edit("10", { name: "edited", topic: "current", rateLimitPerUser: 15 })
    expect(calls.at(-1)).toMatchObject({
        path: "/v1/channels/10",
        method: "PATCH",
        body: { name: "edited", topic: "current", rate_limit_per_user: 15 },
    })
    await api.reorder("20", [
        {
            id: "10",
            position: 2,
            parentId: "12",
            precedingSiblingId: "11",
            syncPermissionsOnMove: true,
        },
    ])
    expect(calls.at(-1)).toMatchObject({
        path: "/v1/guilds/20/channels",
        method: "PATCH",
        body: [
            {
                id: "10",
                position: 2,
                parent_id: "12",
                preceding_sibling_id: "11",
                lock_permissions: true,
            },
        ],
    })
    await api.setPermissionOverwrite("10", {
        id: "51",
        type: "member",
        allow: 1n << 63n,
        deny: 0n,
    })
    expect(calls.at(-1)).toMatchObject({
        path: "/v1/channels/10/permissions/51",
        method: "PUT",
        body: { type: 1, allow: "9223372036854775808", deny: "0" },
    })
    await api.removePermissionOverwrite("10", "51")
    expect(calls.at(-1)).toMatchObject({ path: "/v1/channels/10/permissions/51", method: "DELETE" })
    await api.delete("10")
    expect(calls.at(-1)).toMatchObject({ path: "/v1/channels/10", method: "DELETE" })
})

test.each(modes)("%s rejects invalid writes before dispatch and whole malformed channel responses", async (mode) => {
    let calls = 0
    let response: unknown = channel()
    rest(async () => {
        calls++
        return Response.json(response)
    })
    const api = await setup(mode)
    for (const input of [
        { type: ChannelType.Text, name: "" },
        { type: ChannelType.Text, name: "  " },
        { type: -1, name: "valid" },
        { type: ChannelType.Text, name: "valid", topic: "" },
        { type: ChannelType.Text, name: "valid", rateLimitPerUser: 21_601 },
        { type: ChannelType.Voice, name: "valid", bitrate: 7_999 },
        { type: ChannelType.Voice, name: "valid", userLimit: 100 },
        { type: ChannelType.Voice, name: "valid", voiceConnectionLimit: 101 },
        {
            type: ChannelType.Text,
            name: "valid",
            permissionOverwrites: [
                { id: "50", type: "role", allow: 0n, deny: 0n },
                { id: "50", type: "member", allow: 0n, deny: 0n },
            ],
        },
    ])
        await expect(api.create("20", input)).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    for (const input of [
        {},
        { type: ChannelType.Text },
        { parentId: "12" },
        { name: undefined },
        { rateLimitPerUser: -1 },
        { extra: true },
    ])
        await expect(api.edit("10", input)).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    for (const positions of [
        [],
        [{ id: "10", position: -1 }],
        [{ id: "10" }, { id: "10" }],
        [{ id: "10", precedingSiblingId: "invalid" }],
        [{ id: "10", syncPermissionsOnMove: "yes" }],
    ])
        await expect(api.reorder("20", positions)).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    for (const overwrite of [
        { id: "50", type: "user", allow: 0n, deny: 0n },
        { id: "50", type: "role", allow: -1n, deny: 0n },
        { id: "50", type: "role", allow: 1n << 64n, deny: 0n },
    ])
        await expect(api.setPermissionOverwrite("10", overwrite)).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    await expect(api.fetch("invalid")).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    await expect(api.removePermissionOverwrite("10", "invalid")).rejects.toMatchObject({
        reason: "input",
        outcome: "notDispatched",
    })
    for (const options of [{ timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }, { unexpected: true }])
        await expect(api.fetch("10", options as never)).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    expect(calls).toBe(0)

    for (response of [
        { ...channel(), id: "11" },
        { ...channel(), guild_id: undefined },
        { ...channel(), type: -1 },
        { ...channel(), permission_overwrites: [{ id: "50", type: 0, allow: "01", deny: "0" }] },
        { ...channel(), permission_overwrites: [{ id: "50", type: 2, allow: "0", deny: "0" }] },
    ])
        await expect(api.fetch()).rejects.toMatchObject({ reason: "response", outcome: "unknown", status: 200 })
    response = [channel(), { ...voiceChannel(), guild_id: undefined }]
    await expect(api.fetchAll()).rejects.toMatchObject({ reason: "response", outcome: "unknown", status: 200 })
    response = channel("10", { type: 999 })
    expect((await api.fetch()).type).toBe(999)
})

test.each(modes)("%s retries only reads and preserves failure outcome metadata for channel writes", async (mode) => {
    const api = await setup(mode)
    let calls = 0
    rest(async () => {
        if (++calls === 1) return Response.json({}, { status: 503 })
        return Response.json(channel())
    })
    expect((await api.fetch()).id).toBe("10")
    expect(calls).toBe(2)
    for (const write of [
        () => api.create("20", { type: ChannelType.Text, name: "created" }),
        () => api.edit("10", { name: "edited" }),
        () => api.delete("10"),
        () => api.reorder("20", [{ id: "10", position: 2 }]),
        () => api.setPermissionOverwrite("10", { id: "50", type: "role", allow: 0n, deny: 0n }),
        () => api.removePermissionOverwrite("10", "50"),
    ]) {
        calls = 0
        rest(async () => {
            calls++
            return new Response("private upstream body", { status: 503 })
        })
        await expect(write()).rejects.toMatchObject({ reason: "rejected", outcome: "unknown", status: 503 })
        expect(calls).toBe(1)
    }
    calls = 0
    rest(async () => {
        calls++
        return new Response("private upstream body", { status: 403 })
    })
    const rejection = await api.edit("10", { name: "edited" }).catch((error) => error)
    expect(rejection).toMatchObject({ reason: "rejected", outcome: "rejected", status: 403 })
    expect(JSON.stringify(rejection)).not.toContain("private upstream")
    expect(calls).toBe(1)
})

test.each(modes)(
    "%s keeps channel caching opt-in, local-only and conservatively invalidates dispatched writes",
    async (mode) => {
        const calls: string[] = []
        let status = 200
        rest(async (url, init) => {
            calls.push(`${init.method} ${new URL(url).pathname}`)
            if (status !== 200) return Response.json({}, { status })
            if (init.method === "GET" && new URL(url).pathname.endsWith("/channels"))
                return Response.json([channel(), voiceChannel()])
            if (init.method === "GET") return Response.json(channel())
            if (init.method === "POST") return Response.json(channel("13"))
            if (init.method === "PATCH" && !new URL(url).pathname.endsWith("/channels")) return Response.json(channel())
            return new Response(null, { status: 204 })
        })
        const disabled = await setup(mode)
        expect(await disabled.get()).toBeUndefined()
        await disabled.fetch()
        expect(await disabled.get()).toBeUndefined()
        expect(calls).toHaveLength(1)
        await expect(disabled.get("bad")).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })

        const api = await setup(mode, { channels: true })
        expect(await api.get()).toBeUndefined()
        const retained = await api.fetch()
        expect(await api.get()).toBe(retained)
        await api.fetchAll()
        expect(await api.get("11")).toBeDefined()
        for (const mutate of [
            () => api.create("20", { type: ChannelType.Text, name: "created" }),
            () => api.edit("10", { name: "edited" }),
            () => api.delete("10"),
            () => api.setPermissionOverwrite("10", { id: "50", type: "role", allow: 0n, deny: 0n }),
            () => api.removePermissionOverwrite("10", "50"),
            () => api.reorder("20", [{ id: "10", position: 2 }]),
        ]) {
            await mutate()
            expect(await api.get()).toBeUndefined()
            expect(await api.get("11")).toBeUndefined()
            await api.fetchAll()
        }
        status = 400
        await expect(api.reorder("20", [{ id: "10", position: 2 }])).rejects.toMatchObject({
            outcome: "rejected",
            status: 400,
        })
        expect(await api.get()).toBeUndefined()
        expect(await api.get("11")).toBeUndefined()
        status = 200
        await api.fetchAll()
        await expect(api.reorder("20", [])).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
        expect(await api.get()).toBeDefined()
        expect(await api.get("11")).toBeDefined()
        status = 503
        await expect(
            api.setPermissionOverwrite("10", { id: "50", type: "role", allow: 0n, deny: 0n }),
        ).rejects.toMatchObject({
            outcome: "unknown",
        })
        expect(await api.get()).toBeUndefined()
        status = 200
    },
)

test.each(modes)(
    "%s delivers guild-only channel events and invalidates cached bulk observations before handlers",
    async (mode) => {
        const dispatch = await gateway()
        rest(async (url, init) => {
            if (init.method === "GET" && new URL(url).pathname.endsWith("/channels"))
                return Response.json([channel(), voiceChannel()])
            return Response.json(channel())
        })
        const api = await setup(mode, { channels: true })
        await api.connect()
        await api.fetchAll()
        const seen: { event: string; value: unknown }[] = []
        let bulkCache: unknown = "unset"
        for (const event of ["guildChannelCreate", "guildChannelUpdate", "guildChannelDelete"] as const)
            await api.on(event, (value) => {
                seen.push({ event, value })
                expect(Object.isFrozen(value)).toBe(true)
            })
        await api.on("guildChannelUpdateBulk", async (value) => {
            bulkCache = await api.get("10")
            seen.push({ event: "guildChannelUpdateBulk", value })
        })
        dispatch("CHANNEL_CREATE", channel("13", { name: "created" }))
        dispatch("CHANNEL_UPDATE", channel("10", { name: "updated" }))
        dispatch("CHANNEL_DELETE", channel("10"))
        await vi.waitFor(() => expect(seen).toHaveLength(3))
        expect(seen).toEqual(
            expect.arrayContaining([
                { event: "guildChannelUpdate", value: expect.objectContaining({ id: "10", name: "updated" }) },
                { event: "guildChannelDelete", value: expect.objectContaining({ id: "10", guildId: "20" }) },
            ]),
        )
        expect(await api.get("10")).toBeUndefined()
        expect(await api.get("11")).toBeDefined()
        dispatch("CHANNEL_UPDATE_BULK", { guild_id: "20", channels: [channel("11", { position: 7 })] })
        await vi.waitFor(() => expect(seen).toHaveLength(4))
        expect(seen[3]).toEqual({
            event: "guildChannelUpdateBulk",
            value: expect.objectContaining({
                guildId: "20",
                channels: [expect.objectContaining({ id: "11", position: 7 })],
            }),
        })
        expect(bulkCache).toBeUndefined()
        expect(await api.get("11")).toBeUndefined()

        dispatch("CHANNEL_UPDATE", {
            id: "90",
            type: 1,
            recipients: [
                {
                    id: "91",
                    username: "fixture",
                    discriminator: "0001",
                    global_name: null,
                    avatar: null,
                    avatar_color: null,
                    flags: 0,
                },
            ],
            name: "direct message",
            icon: null,
            owner_id: null,
            nicks: {},
            last_message_id: null,
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(seen).toHaveLength(4)
        expect(api.state()).toBe("Connected")
    },
)

test.each(modes)("%s rejects malformed channel gateway payloads without partial public delivery", async (mode) => {
    const dispatch = await gateway()
    rest(async () => Response.json(channel()))
    const api = await setup(mode)
    const handler = vi.fn()
    await api.connect()
    await api.on("guildChannelUpdateBulk", handler)
    dispatch("CHANNEL_UPDATE_BULK", {
        guild_id: "20",
        channels: [
            channel(),
            { ...channel("11"), permission_overwrites: [{ id: "50", type: 0, allow: "bad", deny: "0" }] },
        ],
    })
    const closed = api.defaultApi
        ? (async () => unwrap(await api.defaultApi!.waitForClose()))()
        : run(api.native!.waitForClose())
    await expect(closed).rejects.toMatchObject({ reason: "protocol" })
    expect(handler).not.toHaveBeenCalled()
})

test.each(modes)(
    "%s evicts channel messages for gateway visibility loss and successful or uncertain channel deletion",
    async (mode) => {
        const dispatch = await gateway()
        let delayed = false
        let started = false
        let release!: () => void
        const held: (() => void)[] = []
        let status = 204
        rest(async (url, init) => {
            const path = new URL(url).pathname
            if (init.method === "GET" && /^\/v1\/channels\/21\/messages\/[1-4]$/.test(path)) {
                await new Promise<void>((resolve) => held.push(resolve))
                return Response.json(message(path.at(-1)!, "21"))
            }
            if (init.method === "GET" && path === "/v1/channels/20/messages/10") {
                if (delayed) {
                    started = true
                    await new Promise<void>((resolve) => {
                        release = resolve
                    })
                }
                return Response.json(message())
            }
            if (init.method === "DELETE" && path === "/v1/channels/20")
                return status === 204 ? new Response(null, { status }) : Response.json({}, { status })
            return Response.json(channel())
        })
        const api = await setup(mode, { messages: true, channels: true })
        await api.connect()
        let deletions = 0
        await api.on("guildChannelDelete", () => {
            deletions++
        })
        await api.fetchMessage()
        expect(await api.getMessage()).toBeDefined()
        dispatch("CHANNEL_DELETE", channel("20"))
        await vi.waitFor(() => expect(deletions).toBe(1))
        await vi.waitFor(async () => expect(await api.getMessage()).toBeUndefined())

        delayed = true
        const late = api.fetchMessage()
        await vi.waitFor(() => expect(started).toBe(true))
        dispatch("CHANNEL_DELETE", channel("20"))
        await vi.waitFor(() => expect(deletions).toBe(2))
        release()
        expect((await late).id).toBe("10")
        expect(await api.getMessage()).toBeUndefined()

        delayed = false
        for (const outcome of [204, 503]) {
            status = outcome
            await api.fetchMessage()
            expect(await api.getMessage()).toBeDefined()
            if (outcome === 204) await api.delete("20")
            else await expect(api.delete("20")).rejects.toMatchObject({ outcome: "unknown", status: 503 })
            expect(await api.getMessage()).toBeUndefined()
        }

        const active = Array.from({ length: 4 }, (_, index) =>
            api.fetchMessage({ id: String(index + 1), channelId: "21" }),
        )
        await vi.waitFor(() => expect(held).toHaveLength(4))
        const queued = api.fetchMessage()
        dispatch("CHANNEL_DELETE", channel("20"))
        await vi.waitFor(() => expect(deletions).toBe(3))
        held.splice(0).forEach((continueRequest) => continueRequest())
        expect((await queued).id).toBe("10")
        await Promise.all(active)
        expect(await api.getMessage()).toBeUndefined()
    },
)

test.each(modes)("%s awaits active channel request cleanup on cancellation and shutdown", async (mode) => {
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
                            reject(Error("fixture cancellation"))
                        }, 20),
                    { once: true },
                )
            }),
    )
    const api = await setup(mode)
    const controller = new AbortController()
    const pending = api.native
        ? Effect.runPromiseExit(api.native.channels.fetch("10"), { signal: controller.signal })
        : api.fetch("10", { signal: controller.signal }).catch((error) => error)
    await vi.waitFor(() => expect(active).toBe(1))
    controller.abort()
    const failure = await pending
    if (api.native) expect(Exit.isFailure(failure) && Cause.hasInterruptsOnly(failure.cause)).toBe(true)
    else expect(failure).toMatchObject({ _tag: "CancelledError" })
    expect(active).toBe(0)
    const closing = api.fetch().catch((error) => error)
    await vi.waitFor(() => expect(active).toBe(1))
    await api.close()
    expect(await closing).toMatchObject({ _tag: "ClientClosedError" })
    expect(active).toBe(0)
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
    vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
        url.endsWith("/gateway/bot")
            ? Promise.resolve(Response.json({ url: "wss://gateway.fluxer.app" }))
            : handler(url, init),
    )
}

async function setup(mode: (typeof modes)[number], cache: ClientOptions["cache"] = undefined) {
    const scope = Scope.makeUnsafe()
    const options = cache === undefined ? { token: "fixture" } : { token: "fixture", cache }
    const defaultApi = mode === "default" ? unwrap(createClient(options)) : undefined
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
        close,
        state: () => (defaultApi ?? native)!.state,
        connect: async () => (defaultApi ? unwrap(await defaultApi.connect()) : run(native!.connect())),
        get: async (id = "10") => (defaultApi ? unwrap(defaultApi.channels.get(id)) : run(native!.channels.get(id))),
        fetch: async (id = "10", options?: { signal?: AbortSignal; timeoutMs?: number }) =>
            defaultApi
                ? unwrap(await defaultApi.channels.fetch(id, options))
                : run(native!.channels.fetch(id, options), options?.signal),
        fetchAll: async (guildId = "20", options?: { signal?: AbortSignal; timeoutMs?: number }) =>
            defaultApi
                ? unwrap(await defaultApi.channels.fetchAll(guildId, options))
                : run(native!.channels.fetchAll(guildId, options), options?.signal),
        fetchMessage: async (target = { id: "10", channelId: "20" }) =>
            defaultApi ? unwrap(await defaultApi.messages.fetch(target)) : run(native!.messages.fetch(target)),
        getMessage: async (target = { id: "10", channelId: "20" }) =>
            defaultApi ? unwrap(defaultApi.messages.get(target)) : run(native!.messages.get(target)),
        create: async (guildId: string, input: any) =>
            defaultApi
                ? unwrap(await defaultApi.channels.create(guildId, input))
                : run(native!.channels.create(guildId, input)),
        edit: async (id: string, input: any) =>
            defaultApi ? unwrap(await defaultApi.channels.edit(id, input)) : run(native!.channels.edit(id, input)),
        delete: async (id: string) =>
            defaultApi ? unwrap(await defaultApi.channels.delete(id)) : run(native!.channels.delete(id)),
        reorder: async (guildId: string, positions: any) =>
            defaultApi
                ? unwrap(await defaultApi.channels.reorder(guildId, positions))
                : run(native!.channels.reorder(guildId, positions)),
        setPermissionOverwrite: async (id: string, overwrite: any) =>
            defaultApi
                ? unwrap(await defaultApi.channels.setPermissionOverwrite(id, overwrite))
                : run(native!.channels.setPermissionOverwrite(id, overwrite)),
        removePermissionOverwrite: async (id: string, targetId: string) =>
            defaultApi
                ? unwrap(await defaultApi.channels.removePermissionOverwrite(id, targetId))
                : run(native!.channels.removePermissionOverwrite(id, targetId)),
        on: async (event: EventName, handler: (value: any) => void | Promise<void>) =>
            defaultApi
                ? unwrap(defaultApi.on(event, handler))
                : run(
                      native!
                          .on(event, (value) => Effect.promise(() => Promise.resolve(handler(value))))
                          .pipe(Scope.provide(scope)),
                  ),
    }
}

async function gateway() {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Fixture port missing")
    transport.url = `ws://127.0.0.1:${address.port}`
    let seq = 0
    server.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }))
        socket.on("message", (data) => {
            const frame = JSON.parse(data.toString())
            if (frame.op === 1) socket.send(JSON.stringify({ op: 11 }))
            if (frame.op === 2 || frame.op === 6)
                socket.send(
                    JSON.stringify({
                        op: 0,
                        s: ++seq,
                        t: frame.op === 2 ? "READY" : "RESUMED",
                        d: { session_id: "fixture" },
                    }),
                )
        })
    })
    onTestFinished(async () => {
        for (const socket of server.clients) socket.terminate()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return (event: string, d: unknown) => {
        for (const socket of server.clients) socket.send(JSON.stringify({ op: 0, s: ++seq, t: event, d }))
    }
}
