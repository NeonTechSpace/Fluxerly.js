import { once } from "node:events"
import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import {
    createClient,
    type ClientOptions,
    type EventMap,
    type EventName,
    type DefaultSendOptions,
    type DefaultUserOperationOptions,
    type ReplyInput,
} from "../src/index.js"
import { createClient as createNative, type ClientOptions as NativeClientOptions } from "../src/effect.js"
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
const user = (id = "30", extra: Record<string, unknown> = {}) => ({
    id,
    username: "fixture",
    discriminator: "0001",
    global_name: "Fixture",
    avatar: "avatar-hash",
    avatar_color: 42,
    flags: 7,
    bot: true,
    system: false,
    email: "fixture-private@example.test",
    mfa_enabled: true,
    ...extra,
})
const directMessage = (id = "10", extra: Record<string, unknown> = {}) => ({
    id,
    type: 1,
    recipients: [user("30")],
    ...extra,
})
const group = (id = "11", extra: Record<string, unknown> = {}) => ({
    id,
    type: 3,
    recipients: [user("30"), user("31", { username: "second" })],
    name: "fixture group",
    icon: "group-icon",
    owner_id: "30",
    nicks: { "30": "owner", "31": "member" },
    last_message_id: "70",
    ...extra,
})
const callerOnlyGroup = (id = "12", extra: Record<string, unknown> = {}) => ({
    id,
    type: 3,
    name: "caller-only group",
    icon: null,
    owner_id: "99",
    nicks: {},
    last_message_id: null,
    ...extra,
})
const guildChannel = (id = "10") => ({ id, guild_id: "20", type: 0, name: "guild channel" })
const message = (id = "80", channelId = "10") => ({
    id,
    channel_id: channelId,
    content: "fixture",
    author: { id: "99", username: "fixture" },
})

test.each(modes)("%s projects frozen public users and private conversations without private fields", async (mode) => {
    const calls: string[] = []
    rest(async (url) => {
        const path = new URL(url).pathname
        calls.push(path)
        if (path === "/v1/users/@me")
            return Response.json(user("99", { global_name: null, avatar: null, avatar_color: null }))
        if (path === "/v1/users/30") return Response.json(user())
        if (path === "/v1/channels/10") return Response.json(directMessage())
        if (path === "/v1/channels/11") return Response.json(group())
        if (path === "/v1/users/@me/channels")
            return Response.json([directMessage(), group(), callerOnlyGroup(), { id: "13", type: 999 }])
        throw Error(`Unexpected request ${path}`)
    })
    const api = await setup(mode)

    const fetched = await api.fetchUser("30")
    const self = await api.fetchSelf()
    const dm = await api.fetchDirectMessage()
    const channels = await api.fetchAllDirectMessages()
    expect(fetched).toEqual({
        id: "30",
        username: "fixture",
        discriminator: "0001",
        displayName: "Fixture",
        avatar: "avatar-hash",
        avatarColor: 42,
        isBot: true,
        isSystem: false,
        flags: 7,
    })
    expect(self).toMatchObject({ id: "99", displayName: null, avatar: null, avatarColor: null })
    expect(JSON.stringify({ fetched, self, dm, channels })).not.toContain("fixture-private@example.test")
    expect(dm).toEqual({
        id: "10",
        type: "dm",
        recipients: [fetched],
        name: null,
        icon: null,
        ownerId: null,
        nicknames: {},
        lastMessageId: null,
    })
    expect(channels[1]).toMatchObject({
        id: "11",
        type: "group",
        name: "fixture group",
        ownerId: "30",
        nicknames: { "30": "owner", "31": "member" },
        lastMessageId: "70",
    })
    expect(channels.map((channel) => channel.id)).toEqual(["10", "11", "12"])
    expect(channels[2]).toMatchObject({ id: "12", type: "group", recipients: [] })
    expect(
        Object.isFrozen(fetched) &&
            Object.isFrozen(dm) &&
            Object.isFrozen(dm.recipients) &&
            Object.isFrozen(dm.recipients[0]) &&
            Object.isFrozen(dm.nicknames) &&
            Object.isFrozen(channels),
    ).toBe(true)
    expect(() => Object.assign(fetched, { username: "changed" })).toThrow()
    expect(calls).toEqual(["/v1/users/30", "/v1/users/@me", "/v1/channels/10", "/v1/users/@me/channels"])
})

test.each(modes)("%s checks fetched IDs and complete private-channel payloads", async (mode) => {
    let response: unknown = user("31")
    rest(async () => Response.json(response))
    const api = await setup(mode)

    await expect(api.fetchUser("30")).rejects.toMatchObject({
        _tag: "UserOperationError",
        operation: "users.fetch",
        reason: "response",
        outcome: "unknown",
    })
    response = guildChannel()
    await expect(api.fetchDirectMessage()).rejects.toMatchObject({
        operation: "directMessages.fetch",
        reason: "response",
    })
    response = directMessage("11")
    await expect(api.fetchDirectMessage()).rejects.toMatchObject({
        operation: "directMessages.fetch",
        reason: "response",
    })
    response = [directMessage(), { ...directMessage("11"), recipients: [user("30"), user("30")] }]
    await expect(api.fetchAllDirectMessages()).rejects.toMatchObject({
        operation: "directMessages.fetchAll",
        reason: "response",
    })
    response = user("30", { global_name: undefined })
    await expect(api.fetchUser("30")).rejects.toMatchObject({ operation: "users.fetch", reason: "response" })
})

test.each(modes)("%s opens conversations and opens the returned channel before sending", async (mode) => {
    const calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = []
    rest(async (url, init) => {
        const path = new URL(url).pathname
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
        calls.push({ method: init.method!, path, body })
        if (path === "/v1/users/@me/channels" && body?.recipient_id === "30") return Response.json(directMessage("77"))
        if (path === "/v1/channels/77/messages") return Response.json(message("80", "77"))
        throw Error(`Unexpected request ${init.method} ${path}`)
    })
    const api = await setup(mode)

    expect((await api.open("30")).id).toBe("77")
    expect((await api.send("30", { content: "@everyone fixture" })).channelId).toBe("77")
    expect(calls.map(({ method, path }) => [method, path])).toEqual([
        ["POST", "/v1/users/@me/channels"],
        ["POST", "/v1/users/@me/channels"],
        ["POST", "/v1/channels/77/messages"],
    ])
    expect(calls[0]?.body).toEqual({ recipient_id: "30" })
    expect(calls[1]?.body).toEqual({ recipient_id: "30" })
    expect(calls[2]?.body).toMatchObject({
        content: "@everyone fixture",
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    })
    expect(calls[2]?.body).not.toHaveProperty("message_reference")

    rest(async () => Response.json(directMessage("77", { recipients: [user("31")] })))
    await expect(api.open("30")).rejects.toMatchObject({ operation: "directMessages.open", reason: "response" })
})

test.each(modes)("%s does not expose group creation", async (mode) => {
    const api = await setup(mode)
    const client = api.defaultApi ?? api.native!
    expect(Object.hasOwn(client.directMessages, "createGroup")).toBe(false)
})

test.each(modes)(
    "%s reads latest explicit private messages without cache admission or ambiguous omissions",
    async (mode) => {
        const calls: { method: string; path: string; body: unknown }[] = []
        rest(async (url, init) => {
            const path = new URL(url).pathname
            calls.push({ method: init.method!, path, body: JSON.parse(String(init.body)) })
            return Response.json({ "10": message("80", "10"), "11": null })
        })
        const api = await setup(mode, { directMessages: true })
        const result = await api.fetchLatestMessages(["10", "11", "12"])
        expect(calls).toEqual([
            { method: "POST", path: "/v1/users/@me/channels/messages/preload", body: { channels: ["10", "11", "12"] } },
        ])
        expect(result.messages["10"]?.id).toBe("80")
        expect(result.messages["11"]).toBeNull()
        expect(result.omittedChannelIds).toEqual(["12"])
        expect(
            Object.isFrozen(result) && Object.isFrozen(result.messages) && Object.isFrozen(result.omittedChannelIds),
        ).toBe(true)
        expect(await api.getDirectMessage("10")).toBeUndefined()
    },
)

test.each(modes)(
    "%s rejects invalid, extra and malformed latest-message batch responses before leaking private bodies",
    async (mode) => {
        let response: unknown = { "99": null }
        const fetch = vi.fn(async () => Response.json(response))
        stubFetchWithHostedDiscovery(fetch)
        const api = await setup(mode)
        for (const ids of [
            [],
            Array(1),
            ["bad"],
            ["10", "10"],
            Array(101)
                .fill("10")
                .map((id, index) => `${id}${index}`),
        ])
            await expect(api.fetchLatestMessages(ids)).rejects.toMatchObject({
                reason: "input",
                outcome: "notDispatched",
            })
        await expect(api.fetchLatestMessages(["10"])).rejects.toMatchObject({ reason: "response", outcome: "unknown" })
        response = { "10": { ...message("80", "11"), private_body: "do not expose" } }
        let failure: unknown
        try {
            await api.fetchLatestMessages(["10"])
        } catch (error) {
            failure = error
        }
        expect(failure).toMatchObject({ reason: "response", outcome: "unknown" })
        expect(JSON.stringify(failure)).not.toContain("do not expose")
    },
)

test.each(modes)("%s snapshots bounded latest-message channel IDs from indexed values", async (mode) => {
    const calls: unknown[] = []
    rest(async (_url, init) => {
        calls.push(JSON.parse(String(init.body)))
        return Response.json({ "10": null })
    })
    const api = await setup(mode)
    const channelIds = ["10"]
    Object.defineProperty(channelIds, Symbol.iterator, {
        value: () => {
            throw Error("Latest-message reads must not consume caller iterators")
        },
    })

    await api.fetchLatestMessages(channelIds)
    expect(calls).toEqual([{ channels: ["10"] }])

    let indexedReads = 0
    const invalid = ["10"]
    Object.defineProperty(invalid, "0", {
        get: () => {
            indexedReads++
            return "invalid"
        },
    })
    Object.defineProperty(invalid, Symbol.iterator, {
        value: () => {
            throw Error("Latest-message reads must reject indexed invalid values without iterating")
        },
    })
    await expect(api.fetchLatestMessages(invalid)).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    expect(indexedReads).toBe(1)
    expect(calls).toHaveLength(1)
})

test.each(modes)("%s cancels an admitted latest-message batch and releases its private read slot", async (mode) => {
    let aborted = false
    rest(
        (_url, init) =>
            new Promise((_resolve, reject) => {
                const abort = () => {
                    aborted = true
                    reject(init.signal?.reason)
                }
                if (init.signal?.aborted) abort()
                else init.signal?.addEventListener("abort", abort, { once: true })
            }),
    )
    const api = await setup(mode)
    await expect(api.fetchLatestMessages(["10"], { timeoutMs: 25 })).rejects.toMatchObject({ reason: "timeout" })
    expect(aborted).toBe(true)
    rest(async () => Response.json({ "10": null }))
    expect(await api.fetchLatestMessages(["10"])).toEqual({ messages: { "10": null }, omittedChannelIds: [] })
})

test.each(modes)("%s rejects invalid user and conversation operations before dispatch", async (mode) => {
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    const api = await setup(mode)
    for (const operation of [
        () => api.fetchUser("bad"),
        () => api.fetchSelf({ timeoutMs: 0 }),
        () => api.getUser("bad"),
        () => api.open("bad"),
        () => api.fetchDirectMessage("bad"),
        () => api.getDirectMessage("bad"),
        () => api.editGroup("10", {}),
        () => api.editGroup("10", { icon: "https://example.test/icon.png" }),
        () => api.editGroup("10", { nicknames: { bad: "name" } }),
        () => api.closeDirectMessage("bad"),
        () => api.removeRecipient("10", "bad"),
    ])
        await expect(operation()).rejects.toMatchObject({ outcome: "notDispatched" })
    await expect(api.send("bad", { content: "fixture" })).rejects.toMatchObject({
        _tag: "MessageError",
        delivery: "notSent",
    })
    await expect(
        api.send("30", { content: "fixture", messageReference: { id: "80", channelId: "10" } } as never),
    ).rejects.toMatchObject({ _tag: "MessageError", delivery: "notSent" })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)(
    "%s preflights group mutations and never writes a guild channel or wrong conversation type",
    async (mode) => {
        const calls: { method: string; path: string; body: unknown }[] = []
        let channel: unknown = group("10")
        rest(async (url, init) => {
            const path = new URL(url).pathname
            calls.push({ method: init.method!, path, body: init.body ? JSON.parse(String(init.body)) : undefined })
            if (init.method === "GET") return Response.json(channel)
            if (init.method === "PATCH")
                return Response.json(group("10", { name: "edited", owner_id: "31", nicks: { "30": "owner" } }))
            return new Response(null, { status: 204 })
        })
        const api = await setup(mode, { directMessages: true })

        await api.fetchDirectMessage()
        await api.editGroup("10", { name: "edited", ownerId: "31", nicknames: { "31": null } })
        await api.closeDirectMessage("10")
        await api.removeRecipient("10", "31")
        expect(calls.map(({ method, path }) => [method, path])).toEqual([
            ["GET", "/v1/channels/10"],
            ["GET", "/v1/channels/10"],
            ["PATCH", "/v1/channels/10"],
            ["GET", "/v1/channels/10"],
            ["DELETE", "/v1/channels/10"],
            ["GET", "/v1/channels/10"],
            ["DELETE", "/v1/channels/10/recipients/31"],
        ])
        expect(calls[2]?.body).toEqual({ name: "edited", owner_id: "31", nicks: { "31": null } })
        expect(await api.getDirectMessage()).toBeUndefined()

        calls.length = 0
        channel = guildChannel()
        await expect(api.closeDirectMessage()).rejects.toMatchObject({
            operation: "directMessages.close",
            reason: "response",
            outcome: "unknown",
        })
        expect(calls).toEqual([{ method: "GET", path: "/v1/channels/10", body: undefined }])
        channel = directMessage()
        await expect(api.editGroup("10", { name: "edited" })).rejects.toMatchObject({
            operation: "directMessages.editGroup",
            reason: "input",
        })
        await expect(api.removeRecipient("10", "30")).rejects.toMatchObject({
            operation: "directMessages.removeRecipient",
            reason: "input",
            outcome: "notDispatched",
        })
        expect(calls.map(({ method, path }) => [method, path])).toEqual([
            ["GET", "/v1/channels/10"],
            ["GET", "/v1/channels/10"],
            ["GET", "/v1/channels/10"],
        ])
    },
)

test.each(modes)("%s sets, clears and omits a group name without other group changes", async (mode) => {
    const bodies: Record<string, unknown>[] = []
    let name: string | null = "fixture group"
    rest(async (url, init) => {
        const path = new URL(url).pathname
        if (init.method === "GET") return Response.json(group("10", { name }))
        if (init.method === "PATCH") {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>
            bodies.push(body)
            if (Object.hasOwn(body, "name")) name = body.name as string | null
            return Response.json(group("10", { name, ...(body.icon === undefined ? {} : { icon: body.icon }) }))
        }
        throw Error(`Unexpected request ${init.method} ${path}`)
    })
    const api = await setup(mode)

    expect((await api.editGroup("10", { name: "renamed" })).name).toBe("renamed")
    expect(bodies.at(-1)).toEqual({ name: "renamed" })
    expect((await api.editGroup("10", { name: null })).name).toBeNull()
    expect(bodies.at(-1)).toEqual({ name: null })
    expect((await api.editGroup("10", { icon: null })).name).toBeNull()
    expect(bodies.at(-1)).toEqual({ icon: null })
})

test.each(modes)("%s uses one deadline across mutation preflight and write", async (mode) => {
    const calls: string[] = []
    rest(async (url, init) => {
        calls.push(`${init.method} ${new URL(url).pathname}`)
        if (init.method === "GET") {
            await new Promise((resolve) => setTimeout(resolve, 20))
            return Response.json(group())
        }
        return Response.json(group())
    })
    const api = await setup(mode)
    await expect(api.editGroup("10", { name: "edited" }, { timeoutMs: 10 })).rejects.toMatchObject({
        operation: "directMessages.editGroup",
        reason: "timeout",
    })
    expect(calls).toEqual(["GET /v1/channels/10"])
})

test.each(modes)("%s keeps user and direct-message caches opt-in, bounded and expiring", async (mode) => {
    rest(async (url) => {
        const path = new URL(url).pathname
        if (path.startsWith("/v1/users/")) return Response.json(user(path.split("/").at(-1)!))
        return Response.json(directMessage(path.split("/").at(-1)!))
    })
    const disabled = await setup(mode)
    await disabled.fetchUser("30")
    await disabled.fetchDirectMessage()
    expect(await disabled.getUser()).toBeUndefined()
    expect(await disabled.getDirectMessage()).toBeUndefined()

    const settings = { maxEntries: 1, maxBytes: 4_194_304 }
    const cached = await setup(mode, { users: settings, directMessages: settings })
    settings.maxEntries = 99
    const first = await cached.fetchUser("30")
    await cached.fetchUser("31")
    expect(await cached.getUser("30")).toBeUndefined()
    expect(await cached.getUser("31")).toBeDefined()
    const firstDm = await cached.fetchDirectMessage("10")
    await cached.fetchDirectMessage("11")
    expect(await cached.getDirectMessage("10")).toBeUndefined()
    expect(await cached.getDirectMessage("11")).toBeDefined()
    expect(first.id).toBe("30")
    expect(firstDm.id).toBe("10")

    const expiring = await setup(mode, { users: { maxAgeMs: 40 }, directMessages: { maxAgeMs: 0 } })
    await expiring.fetchUser("30")
    await expiring.fetchDirectMessage()
    expect(await expiring.getDirectMessage()).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await expiring.getUser()).toBeUndefined()
})

test.each(modes)(
    "%s promotes user and direct-message cache lookups without promoting diagnostics or enumeration",
    async (mode) => {
        rest(async (url) => {
            const path = new URL(url).pathname
            if (path.startsWith("/v1/users/")) return Response.json(user(path.split("/").at(-1)!))
            return Response.json(directMessage(path.split("/").at(-1)!))
        })
        const settings = { maxEntries: 2, maxBytes: 4_194_304 }
        const lru = await setup(mode, { users: settings, directMessages: settings })

        await lru.fetchUser("30")
        await lru.fetchUser("31")
        expect((await lru.getUser("30"))?.id).toBe("30")
        await lru.fetchUser("32")
        expect(await lru.getUser("31")).toBeUndefined()
        expect((await lru.getUser("30"))?.id).toBe("30")
        expect((await lru.getUser("32"))?.id).toBe("32")
        expect(lru.diagnostics().caches.users).toMatchObject({
            retainedEntries: 2,
            maxEntries: 2,
            maxBytes: 4_194_304,
        })

        await lru.fetchDirectMessage("10")
        await lru.fetchDirectMessage("11")
        expect((await lru.getDirectMessage("10"))?.id).toBe("10")
        await lru.fetchDirectMessage("12")
        expect(await lru.getDirectMessage("11")).toBeUndefined()
        expect((await lru.getDirectMessage("10"))?.id).toBe("10")
        expect((await lru.getDirectMessage("12"))?.id).toBe("12")
        expect(lru.diagnostics().caches.directMessages).toMatchObject({
            retainedEntries: 2,
            maxEntries: 2,
            maxBytes: 4_194_304,
        })

        const observed = await setup(mode, { users: settings, directMessages: settings })
        await observed.fetchUser("40")
        await observed.fetchUser("41")
        expect((await observed.cacheEntries("users")).map((entry) => entry.id)).toEqual(["40", "41"])
        expect(observed.diagnostics().caches.users.retainedEntries).toBe(2)
        await observed.fetchUser("42")
        expect(await observed.getUser("40")).toBeUndefined()
        expect((await observed.getUser("41"))?.id).toBe("41")

        await observed.fetchDirectMessage("20")
        await observed.fetchDirectMessage("21")
        expect((await observed.cacheEntries("directMessages")).map((entry) => entry.id)).toEqual(["20", "21"])
        expect(observed.diagnostics().caches.directMessages.retainedEntries).toBe(2)
        await observed.fetchDirectMessage("22")
        expect(await observed.getDirectMessage("20")).toBeUndefined()
        expect((await observed.getDirectMessage("21"))?.id).toBe("21")
    },
)

test.each(modes)("%s prevents an overlapping stale user read from replacing a gateway observation", async (mode) => {
    const dispatch = await gateway()
    let delayed = false
    let started = false
    let release!: () => void
    rest(async () => {
        if (!delayed) return Response.json(user())
        started = true
        await new Promise<void>((resolve) => {
            release = resolve
        })
        return Response.json(user("30", { username: "stale read" }))
    })
    const api = await setup(mode, { users: true })
    await api.connect()
    await api.fetchUser()
    delayed = true
    const reading = api.fetchUser()
    await vi.waitFor(() => expect(started).toBe(true))
    dispatch("USER_UPDATE", user("30", { username: "gateway observation" }))
    await vi.waitFor(async () => expect((await api.getUser())?.username).toBe("gateway observation"))
    release()
    await reading
    expect((await api.getUser())?.username).toBe("gateway observation")
})

test.each(modes)("%s prevents group-edit cache races from retaining stale reads", async (mode) => {
    for (const clear of [false, true])
        for (const completion of ["readFirst", "writeFirst"] as const) {
            let patchStarted = false
            let readStarted = false
            let completedConflictingRead = false
            let releasePatch: (() => void) | undefined
            let releaseRead: (() => void) | undefined
            rest(async (url, init) => {
                const path = new URL(url).pathname
                if (path !== "/v1/channels/10") throw Error(`Unexpected request ${init.method} ${path}`)
                if (init.method === "PATCH") {
                    patchStarted = true
                    await new Promise<void>((resolve) => {
                        releasePatch = resolve
                    })
                    return Response.json(group("10", { name: "after" }))
                }
                if (!patchStarted) return Response.json(group("10", { name: "before" }))
                if (!completedConflictingRead) {
                    completedConflictingRead = true
                    readStarted = true
                    await new Promise<void>((resolve) => {
                        releaseRead = resolve
                    })
                    return Response.json(group("10", { name: "before" }))
                }
                return Response.json(group("10", { name: "after" }))
            })
            const api = await setup(mode, { directMessages: true })
            const editing = api.editGroup("10", { name: "after" })
            void editing.catch(() => {})
            let reading: ReturnType<typeof api.fetchDirectMessage> | undefined
            try {
                await vi.waitFor(() => expect(patchStarted).toBe(true))
                if (clear) api.clearCache()
                reading = api.fetchDirectMessage("10")
                void reading.catch(() => {})
                await vi.waitFor(() => expect(readStarted).toBe(true))

                if (completion === "readFirst") {
                    releaseRead!()
                    expect((await reading).name).toBe("before")
                    releasePatch!()
                    expect((await editing).name).toBe("after")
                } else {
                    releasePatch!()
                    expect((await editing).name).toBe("after")
                    releaseRead!()
                    expect((await reading).name).toBe("before")
                }
                const cached = await api.getDirectMessage()
                expect(cached === undefined || cached.name === "after").toBe(true)
                expect((await api.fetchDirectMessage("10")).name).toBe("after")
                expect((await api.getDirectMessage())?.name).toBe("after")
            } finally {
                releaseRead?.()
                releasePatch?.()
                await Promise.allSettled([editing, ...(reading ? [reading] : [])])
            }
        }
})

test.each(modes)("%s keeps successful close and recipient removal from retaining overlapping reads", async (mode) => {
    for (const mutation of ["close", "removeRecipient"] as const) {
        let deleteStarted = false
        let readStarted = false
        let requests = 0
        let releaseDelete: (() => void) | undefined
        let releaseRead: (() => void) | undefined
        const snapshot = mutation === "close" ? directMessage() : group("10")
        rest(async (url, init) => {
            const path = new URL(url).pathname
            if (++requests === 1) {
                if (path !== "/v1/channels/10") throw Error(`Unexpected request ${init.method} ${path}`)
                return Response.json(snapshot)
            }
            if (requests === 2) {
                const expected = mutation === "close" ? "/v1/channels/10" : "/v1/channels/10/recipients/31"
                if (path !== expected) throw Error(`Unexpected request ${init.method} ${path}`)
                deleteStarted = true
                await new Promise<void>((resolve) => {
                    releaseDelete = resolve
                })
                return new Response(null, { status: 204 })
            }
            if (requests !== 3 || path !== "/v1/channels/10") throw Error(`Unexpected request ${init.method} ${path}`)
            readStarted = true
            await new Promise<void>((resolve) => {
                releaseRead = resolve
            })
            return Response.json(snapshot)
        })
        const api = await setup(mode, { directMessages: true })
        const closing = mutation === "close" ? api.closeDirectMessage() : api.removeRecipient("10", "31")
        void closing.catch(() => {})
        let reading: ReturnType<typeof api.fetchDirectMessage> | undefined
        try {
            await vi.waitFor(() => expect(deleteStarted).toBe(true))
            reading = api.fetchDirectMessage()
            void reading.catch(() => {})
            await vi.waitFor(() => expect(readStarted).toBe(true))
            releaseDelete!()
            await expect(closing).resolves.toBeUndefined()
            expect(await api.getDirectMessage()).toBeUndefined()
            releaseRead!()
            expect((await reading).id).toBe("10")
            expect(await api.getDirectMessage()).toBeUndefined()
        } finally {
            releaseRead?.()
            releaseDelete?.()
            await Promise.allSettled([closing, ...(reading ? [reading] : [])])
        }
    }
})

test.each(modes)("%s invalidates direct-message cache races around nested send opening", async (mode) => {
    let opening = "success" as "success" | "failure"
    let openStarted = false
    let readStarted = false
    let completedConflictingRead = false
    let releaseOpen: (() => void) | undefined
    let releaseRead: (() => void) | undefined
    rest(async (url, init) => {
        const path = new URL(url).pathname
        if (path === "/v1/users/@me/channels") {
            if (opening === "failure") throw Error("fixture opening failure")
            openStarted = true
            await new Promise<void>((resolve) => {
                releaseOpen = resolve
            })
            return Response.json(directMessage("10", { last_message_id: "71" }))
        }
        if (path === "/v1/channels/10") {
            if (!completedConflictingRead) {
                completedConflictingRead = true
                readStarted = true
                await new Promise<void>((resolve) => {
                    releaseRead = resolve
                })
                return Response.json(directMessage("10", { last_message_id: "70" }))
            }
            return Response.json(directMessage("10", { last_message_id: "71" }))
        }
        if (path === "/v1/channels/10/messages") return Response.json(message("80", "10"))
        throw Error(`Unexpected request ${init.method} ${path}`)
    })
    const api = await setup(mode, { directMessages: true })
    const sending = api.send("30", { content: "fixture" })
    void sending.catch(() => {})
    let reading: ReturnType<typeof api.fetchDirectMessage> | undefined
    try {
        await vi.waitFor(() => expect(openStarted).toBe(true))
        reading = api.fetchDirectMessage("10")
        void reading.catch(() => {})
        await vi.waitFor(() => expect(readStarted).toBe(true))
        releaseRead!()
        expect((await reading).lastMessageId).toBe("70")
        releaseOpen!()
        expect((await sending).channelId).toBe("10")
        expect(await api.getDirectMessage("10")).toBeUndefined()
        expect((await api.fetchDirectMessage("10")).lastMessageId).toBe("71")

        opening = "failure"
        await expect(api.send("30", { content: "fixture" })).rejects.toMatchObject({
            _tag: "MessageError",
            reason: "network",
            delivery: "notSent",
        })
        expect(await api.getDirectMessage("10")).toBeUndefined()
    } finally {
        releaseRead?.()
        releaseOpen?.()
        await Promise.allSettled([sending, ...(reading ? [reading] : [])])
    }
})

test.each(modes)("%s keeps the DM-opening explanation when send cannot reach message creation", async (mode) => {
    const calls: string[] = []
    rest(async (url) => {
        calls.push(new URL(url).pathname)
        return Response.json(
            { code: "CAPTCHA_REQUIRED", message: "private provider explanation", unreviewed: "private extra data" },
            { status: 400 },
        )
    })
    const api = await setup(mode)
    const error = await api.send("30", { content: "private submitted message" }).catch((failure) => failure)
    expect(error).toMatchObject({
        _tag: "MessageError",
        reason: "rejected",
        delivery: "notSent",
        status: 400,
        apiError: { code: "captchaRequired", providerCode: "CAPTCHA_REQUIRED" },
    })
    expect(error.message).toContain(error.apiError.explanation)
    expect(error.message).toContain("400")
    expect(JSON.stringify(error) + error.message).not.toContain("private")
    expect(calls).toEqual(["/v1/users/@me/channels"])
})

test.each(modes)("%s retries reads but never repeats uncertain conversation writes or sends", async (mode) => {
    const api = await setup(mode)
    let calls = 0
    rest(async () => {
        if (++calls === 1) throw Error("private read failure")
        return Response.json(user())
    })
    expect((await api.fetchUser()).id).toBe("30")
    expect(calls).toBe(2)

    calls = 0
    rest(async () => {
        calls++
        throw Error("private open failure")
    })
    await expect(api.open("30")).rejects.toMatchObject({
        _tag: "UserOperationError",
        operation: "directMessages.open",
        reason: "network",
        outcome: "unknown",
    })
    expect(calls).toBe(1)

    const paths: string[] = []
    rest(async (url) => {
        paths.push(new URL(url).pathname)
        if (paths.length === 1) return Response.json(directMessage("77"))
        throw Error("private send failure")
    })
    const error = await api.send("30", { content: "fixture" }).catch((failure) => failure)
    expect(error).toMatchObject({ _tag: "MessageError", reason: "network", delivery: "unknown" })
    expect(JSON.stringify(error)).not.toContain("private send failure")
    expect(paths).toEqual(["/v1/users/@me/channels", "/v1/channels/77/messages"])
})

test.each(modes)(
    "%s waits for direct-message send cancellation cleanup and rejects work after shutdown",
    async (mode) => {
        let active = false
        let cleaned = false
        rest(
            (url, init) =>
                new Promise<Response>((resolve, reject) => {
                    if (new URL(url).pathname === "/v1/users/@me/channels") {
                        resolve(Response.json(directMessage("77")))
                        return
                    }
                    active = true
                    init.signal?.addEventListener(
                        "abort",
                        () =>
                            setTimeout(() => {
                                cleaned = true
                                reject(Error("fixture cancellation"))
                            }, 15),
                        { once: true },
                    )
                }),
        )
        const api = await setup(mode)
        const controller = new AbortController()
        const pending = api.native
            ? Effect.runPromiseExit(api.native.directMessages.send("30", { content: "fixture" }), {
                  signal: controller.signal,
              })
            : api.send("30", { content: "fixture" }, { signal: controller.signal }).catch((error) => error)
        await vi.waitFor(() => expect(active).toBe(true))
        controller.abort()
        const error = await pending
        if (mode === "default") expect(error).toMatchObject({ _tag: "CancelledError" })
        else expect(Exit.isFailure(error) && Cause.hasInterruptsOnly(error.cause)).toBe(true)
        expect(cleaned).toBe(true)

        await api.close()
        await expect(api.fetchUser()).rejects.toMatchObject({ _tag: "ClientClosedError" })
        await expect(api.send("30", { content: "fixture" })).rejects.toMatchObject({ _tag: "ClientClosedError" })
    },
)

test.each(modes)("%s delivers complete private events and resolves cache conflicts before handlers", async (mode) => {
    const dispatch = await gateway()
    rest(async (url) => {
        const path = new URL(url).pathname
        if (path === "/v1/users/30") return Response.json(user())
        if (path === "/v1/channels/10") return Response.json(directMessage())
        throw Error(`Unexpected request ${path}`)
    })
    const api = await setup(mode, { users: true, directMessages: true })
    await api.fetchUser()
    await api.fetchDirectMessage()
    await api.connect()
    const seen: { event: EventName; value: unknown; cached: unknown }[] = []
    for (const event of [
        "userUpdate",
        "directMessageCreate",
        "directMessageUpdate",
        "directMessageRecipientAdd",
        "directMessageRecipientRemove",
        "directMessageDelete",
    ] as const)
        await api.on(event, async (value) => {
            const id = "channelId" in value ? value.channelId : value.id
            const cached = event === "userUpdate" ? await api.getUser(id) : await api.getDirectMessage(id)
            seen.push({ event, value, cached })
        })

    dispatch("USER_UPDATE", user("30", { username: "event user" }))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    dispatch("CHANNEL_CREATE", directMessage("40", { name: "created" }))
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    dispatch("CHANNEL_UPDATE", directMessage("40", { name: "updated" }))
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    dispatch("CHANNEL_RECIPIENT_ADD", { channel_id: "40", user: { id: "31" } })
    await vi.waitFor(() => expect(seen).toHaveLength(4))
    dispatch("CHANNEL_RECIPIENT_REMOVE", { channel_id: "40", user: { id: "31" } })
    await vi.waitFor(() => expect(seen).toHaveLength(5))
    dispatch("CHANNEL_DELETE", directMessage("40"))
    await vi.waitFor(() => expect(seen).toHaveLength(6))
    expect(seen.map(({ event }) => event)).toEqual([
        "userUpdate",
        "directMessageCreate",
        "directMessageUpdate",
        "directMessageRecipientAdd",
        "directMessageRecipientRemove",
        "directMessageDelete",
    ])
    expect(seen[0]?.cached).toMatchObject({ username: "event user" })
    expect(seen[1]?.cached).toMatchObject({ name: "created" })
    expect(seen[2]?.cached).toMatchObject({ name: "updated" })
    expect(seen.slice(3).every(({ cached }) => cached === undefined)).toBe(true)
    expect(Object.isFrozen(seen[0]?.value) && Object.isFrozen(seen[1]?.value)).toBe(true)
    expect(await api.getDirectMessage("10")).toBeUndefined()
    expect(await api.getUser()).toMatchObject({ username: "event user" })
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
        connect: async () => (defaultApi ? unwrap(await defaultApi.connect()) : run(native!.connect())),
        diagnostics: () => (defaultApi ? defaultApi.diagnostics() : native!.diagnostics()),
        clearCache: () => {
            if (defaultApi) defaultApi.cache.clear()
            else native!.cache.clear()
        },
        cacheEntries: async (kind: "users" | "directMessages") =>
            defaultApi ? unwrap(defaultApi.cache.entries(kind)) : run(native!.cache.entries(kind)),
        getUser: async (id = "30") => (defaultApi ? unwrap(defaultApi.users.get(id)) : run(native!.users.get(id))),
        getDirectMessage: async (id = "10") =>
            defaultApi ? unwrap(defaultApi.directMessages.get(id)) : run(native!.directMessages.get(id)),
        fetchUser: async (id = "30", options?: DefaultUserOperationOptions) =>
            defaultApi ? unwrap(await defaultApi.users.fetch(id, options)) : run(native!.users.fetch(id, options)),
        fetchSelf: async (options?: DefaultUserOperationOptions) =>
            defaultApi ? unwrap(await defaultApi.users.fetchSelf(options)) : run(native!.users.fetchSelf(options)),
        open: async (id = "30", options?: DefaultUserOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.directMessages.open(id, options))
                : run(native!.directMessages.open(id, options)),
        fetchDirectMessage: async (id = "10", options?: DefaultUserOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.directMessages.fetch(id, options))
                : run(native!.directMessages.fetch(id, options)),
        fetchAllDirectMessages: async (options?: DefaultUserOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.directMessages.fetchAll(options))
                : run(native!.directMessages.fetchAll(options)),
        fetchLatestMessages: async (ids: readonly string[], options?: DefaultUserOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.directMessages.fetchLatestMessages(ids, options))
                : run(native!.directMessages.fetchLatestMessages(ids, options)),
        editGroup: async (id: string, input: Record<string, unknown>, options?: DefaultUserOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.directMessages.editGroup(id, input, options))
                : run(native!.directMessages.editGroup(id, input, options)),
        closeDirectMessage: async (id = "10", options?: DefaultUserOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.directMessages.close(id, options))
                : run(native!.directMessages.close(id, options)),
        removeRecipient: async (id: string, userId: string, options?: DefaultUserOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.directMessages.removeRecipient(id, userId, options))
                : run(native!.directMessages.removeRecipient(id, userId, options)),
        send: async (id: string, input: ReplyInput, options?: DefaultSendOptions) =>
            defaultApi
                ? unwrap(await defaultApi.directMessages.send(id, input, options))
                : run(native!.directMessages.send(id, input, options)),
        on: async <K extends EventName>(event: K, handler: (value: EventMap[K]) => void | Promise<void>) =>
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
    let sequence = 0
    server.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }))
        socket.on("message", (data) => {
            const frame = JSON.parse(data.toString())
            if (frame.op === 1) socket.send(JSON.stringify({ op: 11 }))
            if (frame.op === 2 || frame.op === 6)
                socket.send(
                    JSON.stringify({
                        op: 0,
                        s: ++sequence,
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
    return (event: string, data: unknown) => {
        for (const socket of server.clients) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: event, d: data }))
    }
}
