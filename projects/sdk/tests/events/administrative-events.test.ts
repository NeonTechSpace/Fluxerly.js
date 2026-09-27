import { Effect, Fiber, Stream } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import {
    AuditLogActions,
    type GuildAuditLogEntryCreate,
    type InviteDeleteEvent,
    type InviteMetadata,
    type WebhooksUpdate,
} from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { defaultApi as fixtureClient } from "../support/both-apis.js"
import { startHostedLoopback } from "../support/instance.js"
import { settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
})

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
    const { gateway } = await startHostedLoopback()
    return {
        dispatch: (event: string, body: unknown) => gateway.dispatch(event, body),
    }
}

function defaultApi() {
    return fixtureClient({ gateway: { onMalformedDispatch: "terminate" } })
}

test("default administrative subscriptions project full provider results without cache work", async () => {
    const server = await fixture()
    const client = defaultApi()
    const created: InviteMetadata[] = []
    const webhooks = client.subscribe("webhooksUpdate")
    const deleted = client.subscribe("inviteDelete")
    const audits = client.subscribe("guildAuditLogEntryCreate")
    client.on("inviteCreate", (event) => {
        created.push(event)
    })
    await settle(client.connect())
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
                delete_message_seconds: "60",
            },
        }),
    )
    await vi.waitFor(() => expect(created).toHaveLength(2))

    const webhook = (await settle(webhooks.next()))!
    const deletion = (await settle(deleted.next()))!
    const entry = (await settle(audits.next()))!
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
            deleteMessagesMs: 60_000,
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

test("native administrative callbacks and streams preserve provider data", async () => {
    const server = await fixture()
    const received: InviteDeleteEvent[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    gateway: { onMalformedDispatch: "terminate" as const },
                })
                const subscription = yield* client.on("inviteDelete", (event) =>
                    Effect.sync(() => {
                        received.push(event)
                    }),
                )
                const audits = yield* Effect.forkScoped(
                    Stream.runCollect(client.subscribe("guildAuditLogEntryCreate").pipe(Stream.take(1))),
                )
                yield* client.connect()
                server.dispatch("INVITE_DELETE", { code: "fixture-invite" })
                server.dispatch(
                    "GUILD_AUDIT_LOG_ENTRY_CREATE",
                    audit({
                        target_id: null,
                        reason: undefined,
                        options: { temporary: "1", count: "", max_uses: "invalid", delete_message_seconds: "60" },
                        changes: undefined,
                    }),
                )
                expect(yield* Fiber.join(audits)).toEqual([
                    expect.objectContaining({
                        guildId: "10",
                        userId: "30",
                        targetId: null,
                        options: { temporary: true, count: 0, deleteMessagesMs: 60_000 },
                    }),
                ])
                yield* Effect.promise(() => vi.waitFor(() => expect(received).toEqual([{ code: "fixture-invite" }])))
                yield* subscription.close()
                yield* subscription.waitForClose()
            }),
        ),
    )
})

test("partial delete notices stay distinct from malformed provider payloads", async () => {
    const server = await fixture()
    const client = defaultApi()
    const deletes = client.subscribe("inviteDelete")
    const closed = client.waitForClose()
    await settle(client.connect())
    server.dispatch("INVITE_DELETE", { code: "fixture-invite" })
    expect(await settle(deletes.next())).toEqual({ code: "fixture-invite" })
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
    ["GUILD_AUDIT_LOG_ENTRY_CREATE", audit({ options: { delete_message_seconds: [] } })],
    ["GUILD_AUDIT_LOG_ENTRY_CREATE", audit({ options: { temporary: [] } })],
] as const)("malformed %s closes without projecting a partial administrative event", async (event, body) => {
    const server = await fixture()
    const client = defaultApi()
    await settle(client.connect())
    server.dispatch(event, body)
    const result = await client.waitForClose()
    expect(result.isErr() && result.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
})
