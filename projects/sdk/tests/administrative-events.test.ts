import { createServer } from "node:http"
import { once } from "node:events"
import { Effect, Fiber, References, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import {
    AuditLogActions,
    createClient,
    type GuildAuditLogEntryCreate,
    type InviteDeleteEvent,
    type InviteMetadata,
    type WebhooksUpdate,
} from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const transport = vi.hoisted(() => ({ url: "" }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(url: string, options: import("ws").ClientOptions) {
                expect(url).toBe("wss://gateway.fluxer.app/?v=1&encoding=json")
                super(transport.url, options)
            }
        },
    }
})
const realFetch = globalThis.fetch
afterEach(() => vi.unstubAllGlobals())

const invite = (extra: Record<string, unknown> = {}) => ({
    code: "fixture-invite",
    type: 0,
    guild: { id: "10", name: "Fixture guild" },
    channel: { id: "20", type: 0, name: "admin" },
    inviter: { id: "30" },
    member_count: 2,
    presence_count: 1,
    expires_at: "2026-09-10T12:00:00.000Z",
    temporary: false,
    created_at: "2026-09-09T12:00:00.000Z",
    uses: 0,
    max_uses: 0,
    max_age: 86_400,
    ...extra,
})

const audit = (extra: Record<string, unknown> = {}) => ({
    id: "70",
    guild_id: "10",
    action_type: AuditLogActions.WebhookCreate,
    user_id: "30",
    target_id: "40",
    reason: "Fixture maintenance",
    options: { channel_id: "20" },
    changes: [{ key: "name", old_value: "before", new_value: "after" }],
    ...extra,
})

async function fixture() {
    const sockets: import("ws").WebSocket[] = []
    let sequence = 1
    const server = createServer((request, response) => {
        if (request.url?.endsWith("/gateway/bot")) {
            response.end(JSON.stringify({ url: "wss://gateway.fluxer.app" }))
            return
        }
        response.writeHead(404).end()
    })
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const packet = JSON.parse(data.toString())
            if (packet.op === 2)
                socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fixture-session" } }))
            if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture port")
    transport.url = `ws://127.0.0.1:${address.port}`
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) =>
        realFetch(url.replace("https://api.fluxer.app", `http://127.0.0.1:${address.port}`), init),
    )
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
        dispatch(event: string, body: unknown) {
            for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: event, d: body }))
        },
    }
}

function value<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

function defaultApi() {
    const client = value(createClient({ token: "fixture-only-not-a-credential" }))
    onTestFinished(async () => {
        await client.shutdown()
    })
    return client
}

test("default administrative subscriptions project full provider results without cache work", async () => {
    const server = await fixture()
    const client = defaultApi()
    const created: InviteMetadata[] = []
    const webhooks = value(client.events("webhooksUpdate"))
    const deleted = value(client.events("inviteDelete"))
    const audits = value(client.events("guildAuditLogEntryCreate"))
    value(
        client.on("inviteCreate", (event) => {
            created.push(event)
        }),
    )
    value(await client.connect())
    server.dispatch("WEBHOOKS_UPDATE", { guild_id: "10", channel_id: "20" })
    server.dispatch("INVITE_CREATE", invite())
    server.dispatch(
        "INVITE_CREATE",
        invite({ code: "group-invite", type: 1, guild: undefined, presence_count: undefined, max_age: undefined }),
    )
    server.dispatch("INVITE_DELETE", { code: "fixture-invite", guild_id: "10", channel_id: "20" })
    server.dispatch(
        "GUILD_AUDIT_LOG_ENTRY_CREATE",
        audit({
            options: {
                channel_id: "20",
                count: "0",
                integration_type: "1",
                members_removed: "2",
                type: "0",
                max_age: "86400",
                max_uses: "0",
                temporary: "false",
                uses: "3",
                delete_message_days: "2",
            },
        }),
    )
    await vi.waitFor(() => expect(created).toHaveLength(2))

    const webhook = value(await webhooks.next())!
    const deletion = value(await deleted.next())!
    const entry = value(await audits.next())!
    expect(webhook).toEqual({ guildId: "10", channelId: "20" } satisfies WebhooksUpdate)
    expect(created[0]).toMatchObject({
        code: "fixture-invite",
        url: "https://fluxer.gg/fixture-invite",
        guild: { id: "10" },
        channel: { id: "20" },
        maxAgeSeconds: 86_400,
    })
    expect(created[1]).toMatchObject({ code: "group-invite", type: "group", channel: { id: "20" } })
    expect(created[1]).not.toHaveProperty("guild")
    expect(created[1]).not.toHaveProperty("maxAgeSeconds")
    expect(deletion).toEqual({ code: "fixture-invite", guildId: "10", channelId: "20" } satisfies InviteDeleteEvent)
    expect(entry).toMatchObject({
        guildId: "10",
        id: "70",
        actionType: AuditLogActions.WebhookCreate,
        userId: "30",
        targetId: "40",
        reason: "Fixture maintenance",
        options: {
            channelId: "20",
            count: 0,
            integrationType: 1,
            membersRemoved: 2,
            type: 0,
            maxAgeSeconds: 86400,
            maxUses: 0,
            temporary: false,
            uses: 3,
            deleteMemberDays: "2",
        },
        changes: [{ key: "name", oldValue: "before", newValue: "after" }],
    } satisfies GuildAuditLogEntryCreate)
    expect(
        Object.isFrozen(webhook) &&
            Object.isFrozen(created[0]) &&
            Object.isFrozen(created[0]!.guild) &&
            Object.isFrozen(deletion) &&
            Object.isFrozen(entry) &&
            Object.isFrozen(entry.options) &&
            Object.isFrozen(entry.changes) &&
            Object.isFrozen(entry.changes?.[0]),
    ).toBe(true)
})

test("native administrative callbacks retain caller context and streams preserve provider data", async () => {
    const server = await fixture()
    const received: InviteDeleteEvent[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const subscription = yield* client.on("inviteDelete", (event) =>
                    Effect.gen(function* () {
                        expect((yield* References.CurrentLogAnnotations).fixture).toBe("administrative-events")
                        received.push(event)
                    }),
                )
                const audits = yield* Effect.forkScoped(
                    Stream.runCollect(client.events("guildAuditLogEntryCreate").pipe(Stream.take(1))),
                )
                yield* client.connect()
                server.dispatch("INVITE_DELETE", { code: "fixture-invite" })
                server.dispatch(
                    "GUILD_AUDIT_LOG_ENTRY_CREATE",
                    audit({
                        target_id: null,
                        reason: undefined,
                        options: { temporary: "1", count: "", max_uses: "invalid" },
                        changes: undefined,
                    }),
                )
                expect(yield* Fiber.join(audits)).toEqual([
                    expect.objectContaining({
                        guildId: "10",
                        userId: "30",
                        targetId: null,
                        options: { temporary: true, count: 0 },
                    }),
                ])
                yield* Effect.promise(() => vi.waitFor(() => expect(received).toEqual([{ code: "fixture-invite" }])))
                yield* subscription.unsubscribe()
                yield* subscription.waitForClose()
            }),
        ).pipe(Effect.annotateLogs("fixture", "administrative-events")),
    )
})

test("partial delete notices stay distinct from malformed provider payloads", async () => {
    const server = await fixture()
    const client = defaultApi()
    const deletes = value(client.events("inviteDelete"))
    const closed = client.waitForClose()
    value(await client.connect())
    server.dispatch("INVITE_DELETE", { code: "fixture-invite" })
    expect(value(await deletes.next())).toEqual({ code: "fixture-invite" })
    server.dispatch("INVITE_DELETE", { code: "fixture-invite", guild_id: 10 })
    const result = await closed
    expect(result.isErr() && result.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
})

test.each([
    ["WEBHOOKS_UPDATE", { guild_id: "10" }],
    ["INVITE_CREATE", invite({ created_at: undefined })],
    ["GUILD_AUDIT_LOG_ENTRY_CREATE", audit({ user_id: undefined })],
    ["GUILD_AUDIT_LOG_ENTRY_CREATE", audit({ target_id: undefined })],
    ["GUILD_AUDIT_LOG_ENTRY_CREATE", audit({ options: { max_age: "Infinity" } })],
    ["GUILD_AUDIT_LOG_ENTRY_CREATE", audit({ options: { temporary: [] } })],
] as const)("malformed %s closes without projecting a partial administrative event", async (event, body) => {
    const server = await fixture()
    const client = defaultApi()
    value(await client.connect())
    server.dispatch(event, body)
    const result = await client.waitForClose()
    expect(result.isErr() && result.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
})

test("administrative sources use the existing independent message and byte budgets", async () => {
    const server = await fixture()
    const client = defaultApi()
    const messages = value(client.events("webhooksUpdate", { maxPendingMessages: 1 }))
    const bytes = value(client.events("webhooksUpdate", { maxPendingBytes: 1 }))
    const other = value(client.events("inviteDelete"))
    value(await client.connect())
    server.dispatch("WEBHOOKS_UPDATE", { guild_id: "10", channel_id: "20" })
    const byteFailure = await bytes.waitForClose()
    expect(byteFailure.isErr() && byteFailure.error).toMatchObject({ _tag: "EventOverflowError", limit: "bytes" })
    server.dispatch("WEBHOOKS_UPDATE", { guild_id: "10", channel_id: "21" })
    const messageFailure = await messages.waitForClose()
    expect(messageFailure.isErr() && messageFailure.error).toMatchObject({
        _tag: "EventOverflowError",
        limit: "messages",
        capacity: 1,
    })
    server.dispatch("INVITE_DELETE", { code: "fixture-invite" })
    expect(value(await other.next())).toEqual({ code: "fixture-invite" })
    expect(client.state).toBe("Connected")
})
