import { Effect, Exit, Scope } from "effect"
import { expect, test, vi } from "vitest"
import { AuditLogActions, type AuditLogPage } from "../../../src/audit-logs.js"
import { createClient } from "../../../src/index.js"
import { createClient as createNative } from "../../../src/effect.js"
import { auditLogPage } from "../../../src/internal/audit-logs.js"
import type { GuildRequest } from "../../../src/internal/guilds.js"
import { InputValidationFailure } from "../../../src/input-validation.js"
import { modes } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"

const user = {
    id: "30",
    username: "auditor",
    discriminator: "0001",
    global_name: null,
    avatar: null,
    avatar_color: null,
    flags: 0,
}

const page = (entries: unknown[] = [entry()]) => ({
    audit_log_entries: entries,
    users: [user],
    webhooks: [
        {
            id: "50",
            type: 1,
            guild_id: "20",
            channel_id: null,
            name: "Audit webhook",
            avatar_hash: null,
            token: "must-not-project",
        },
    ],
})

function entry(extra: Record<string, unknown> = {}) {
    return {
        id: "100",
        action_type: AuditLogActions.RoleUpdate,
        user_id: "30",
        target_id: "InviteCode",
        reason: "Updated role",
        options: { channel_id: "40", count: 2, temporary: false },
        changes: [
            { key: "name", old_value: "Before", new_value: "After" },
            {
                key: "permissions_diff",
                new_value: { added: ["MANAGE_ROLES"], removed: ["VIEW_CHANNEL"] },
            },
        ],
        ...extra,
    }
}

const unwrap = <A>(result: { isErr(): boolean; value?: A; error?: unknown }): A => {
    if (result.isErr()) throw result.error
    return result.value!
}

const validRequest = <A>(request: GuildRequest<A> | InputValidationFailure): GuildRequest<A> => {
    if (request instanceof InputValidationFailure) throw request
    return request
}

test.each(modes)("%s fetches filtered pages through the public client without retaining them", async (mode) => {
    const scope = Scope.makeUnsafe()
    const defaultApi = mode === "default" ? createClient({ token: "fixture_only" }) : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(createNative({ token: "fixture_only" }).pipe(Scope.provide(scope)))
            : undefined
    const requests: { url: URL; method: string | undefined }[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        requests.push({ url: new URL(url), method: init.method })
        return Response.json(
            page([
                entry({
                    action_type: AuditLogActions.MemberBanAdd,
                    options: { delete_message_seconds: 60 },
                }),
            ]),
        )
    })
    try {
        const fetchPage = async (): Promise<AuditLogPage> =>
            defaultApi
                ? unwrap(await defaultApi.auditLogs.fetchPage("20", { userId: "30" }))
                : Effect.runPromise(native!.auditLogs.fetchPage("20", { userId: "30" }))
        const first = await fetchPage()
        const second = await fetchPage()
        expect(first).toEqual(second)
        expect(first.entries[0]!.options).toEqual({ deleteMessagesMs: 60_000 })
        expect(Object.isFrozen(first) && Object.isFrozen(first.entries[0]!)).toBe(true)
        expect(requests).toHaveLength(2)
        for (const request of requests) {
            expect(request.method).toBe("GET")
            expect(request.url.pathname).toBe("/v1/guilds/20/audit-logs")
            expect(Object.fromEntries(request.url.searchParams)).toEqual({ limit: "50", user_id: "30" })
        }
    } finally {
        vi.unstubAllGlobals()
        if (defaultApi) await defaultApi.shutdown()
        if (native) await Effect.runPromise(native.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
})

test("accepts sticker lifecycle actions in user-filtered pages and action filters", () => {
    const actions = [AuditLogActions.StickerCreate, AuditLogActions.StickerUpdate, AuditLogActions.StickerDelete]
    expect(actions).toEqual([90, 91, 92])
    const entries = actions.map((action_type, index) => entry({ id: String(100 - index), action_type }))
    expect(
        validRequest(auditLogPage("20", { userId: "30" }))
            .decode(page(entries))!
            .entries.map((item) => item.actionType),
    ).toEqual(actions)
    for (const actionType of actions) {
        const request = validRequest(auditLogPage("20", { actionType }))
        expect(request.path).toContain(`action_type=${actionType}`)
        expect(request.decode(page([entry({ action_type: actionType })]))!.entries[0]!.actionType).toBe(actionType)
    }
})

test("keeps thread and later-added action numbers in user-filtered pages, and filters by thread actions", () => {
    const actions = [AuditLogActions.ThreadCreate, AuditLogActions.ThreadUpdate, AuditLogActions.ThreadDelete]
    expect(actions).toEqual([110, 111, 112])
    const recorded = [...actions, 999]
    const entries = recorded.map((action_type, index) => entry({ id: String(100 - index), action_type }))
    expect(
        validRequest(auditLogPage("20", { userId: "30" }))
            .decode(page(entries))!
            .entries.map((item) => item.actionType),
    ).toEqual(recorded)
    for (const actionType of actions) {
        const request = validRequest(auditLogPage("20", { actionType }))
        expect(request.path).toContain(`action_type=${actionType}`)
        expect(request.decode(page([entry({ action_type: actionType })]))!.entries[0]!.actionType).toBe(actionType)
    }
})

// Fluxer 4749eb7f: serializeThreadParentForAudit records available_tags and default_reaction_emoji as objects, which
// once failed the whole page, and GuildAuditLogListResponse lists the targeted threads beside the entries
const forumChanges = [
    {
        key: "available_tags",
        new_value: [
            { id: "60", name: "solved", moderated: false, emoji_id: null, emoji_name: "✅" },
            { id: "61", name: "staff", moderated: true, emoji_id: "62", emoji_name: null },
        ],
    },
    { key: "default_reaction_emoji", new_value: { emoji_id: null, emoji_name: "👍" } },
    { key: "default_tag_setting", new_value: "match_some" },
]
const auditThread = (extra: Record<string, unknown> = {}) => ({
    id: "70",
    type: 12,
    guild_id: "20",
    parent_id: "40",
    owner_id: "30",
    name: "moderation",
    thread_metadata: {
        archived: true,
        auto_archive_duration: 60,
        archive_timestamp: "2026-10-02T00:00:00.000Z",
        locked: true,
        invitable: false,
        create_timestamp: "2026-10-01T00:00:00.000Z",
    },
    ...extra,
})

test("reads forum change values and the targeted threads of a page", () => {
    const request = validRequest(auditLogPage("20", { userId: "30" }))
    const forumEntry = entry({ action_type: AuditLogActions.ChannelCreate, options: undefined, changes: forumChanges })
    const result = request.decode({ ...page([forumEntry]), threads: [auditThread()] })!
    expect(result.entries[0]!.changes).toEqual([
        {
            key: "available_tags",
            newValue: [
                { id: "60", name: "solved", moderated: false, emojiId: null, emojiName: "✅" },
                { id: "61", name: "staff", moderated: true, emojiId: "62", emojiName: null },
            ],
        },
        { key: "default_reaction_emoji", newValue: { emojiId: null, emojiName: "👍" } },
        { key: "default_tag_setting", newValue: "match_some" },
    ])
    expect(result.threads).toEqual([
        expect.objectContaining({ id: "70", type: 12, parentId: "40", archived: true, locked: true, invitable: false }),
    ])
    expect(Object.isFrozen(result.threads) && Object.isFrozen(result.threads[0])).toBe(true)
    // Fluxer leaves the list out for callers that cannot see threads
    expect(request.decode(page())!.threads).toEqual([])
    for (const malformed of [
        { ...page(), threads: [auditThread({ guild_id: "21" })] },
        { ...page(), threads: [auditThread(), auditThread()] },
        { ...page(), threads: [auditThread({ owner_id: undefined })] },
        page([entry({ changes: [{ key: "available_tags", new_value: [{ id: "60", name: "solved" }] }] })]),
        page([entry({ changes: [{ key: "default_reaction_emoji", new_value: { emoji_id: 5, emoji_name: null } }] })]),
    ])
        expect(request.decode(malformed)).toBeUndefined()
})

test("projects complete frozen, token-free audit-log pages and preserves a non-snowflake target", () => {
    const request = validRequest(auditLogPage("20", { userId: "30" }))
    const result = request.decode(page())!
    expect(result).toMatchObject({
        entries: [
            {
                id: "100",
                actionType: AuditLogActions.RoleUpdate,
                targetId: "InviteCode",
                options: { channelId: "40", count: 2, temporary: false },
                changes: [
                    { key: "name", oldValue: "Before", newValue: "After" },
                    { key: "permissions_diff", newValue: { added: ["MANAGE_ROLES"], removed: ["VIEW_CHANNEL"] } },
                ],
            },
        ],
        users: [{ id: "30", username: "auditor" }],
        webhooks: [{ id: "50", type: 1, guildId: "20", channelId: null, avatarHash: null }],
    })
    expect(result.webhooks[0]).not.toHaveProperty("token")
    expect(
        Object.isFrozen(result) &&
            Object.isFrozen(result.entries) &&
            Object.isFrozen(result.entries[0]!) &&
            Object.isFrozen(result.entries[0]!.changes) &&
            Object.isFrozen(result.entries[0]!.changes![1]!.newValue) &&
            Object.isFrozen(result.entries[0]!.changes![1]!.newValue as object) &&
            Object.isFrozen(result.webhooks),
    ).toBe(true)
})

test("projects every published option and change-value shape from a GuildUpdate entry", () => {
    const request = validRequest(auditLogPage("20", { actionType: AuditLogActions.GuildUpdate }))
    const result = request.decode(
        page([
            entry({
                action_type: AuditLogActions.GuildUpdate,
                options: {
                    channel_id: "40",
                    count: 2,
                    delete_member_days: "7",
                    delete_message_seconds: 86_400,
                    id: "41",
                    integration_type: 3,
                    message_id: "42",
                    members_removed: 4,
                    role_name: "Moderators",
                    type: 5,
                    inviter_id: "43",
                    max_age: 86_400,
                    max_uses: 10,
                    temporary: true,
                    uses: 6,
                    future_option: "dropped",
                },
                changes: [
                    { key: "name", old_value: "Before", new_value: "After" },
                    { key: "position", old_value: 1, new_value: 2 },
                    { key: "nsfw", old_value: false, new_value: true },
                    { key: "banner_hash", old_value: null },
                    { key: "features", new_value: ["ALPHA"] },
                    { key: "positions", new_value: [1, 2] },
                    { key: "permissions_diff", new_value: { added: ["MANAGE_ROLES"], removed: ["VIEW_CHANNEL"] } },
                ],
            }),
        ]),
    )!
    expect(result.entries[0]).toMatchObject({
        actionType: AuditLogActions.GuildUpdate,
        options: {
            channelId: "40",
            count: 2,
            deleteMemberDays: "7",
            deleteMessagesMs: 86_400_000,
            id: "41",
            integrationType: 3,
            messageId: "42",
            membersRemoved: 4,
            roleName: "Moderators",
            type: 5,
            inviterId: "43",
            maxAgeSeconds: 86_400,
            maxUses: 10,
            temporary: true,
            uses: 6,
        },
        changes: [
            { key: "name", oldValue: "Before", newValue: "After" },
            { key: "position", oldValue: 1, newValue: 2 },
            { key: "nsfw", oldValue: false, newValue: true },
            { key: "banner_hash", oldValue: null },
            { key: "features", newValue: ["ALPHA"] },
            { key: "positions", newValue: [1, 2] },
            { key: "permissions_diff", newValue: { added: ["MANAGE_ROLES"], removed: ["VIEW_CHANNEL"] } },
        ],
    })
    expect(result.entries[0]!.options).not.toHaveProperty("futureOption")
})

test("rejects unfiltered, malformed, ambiguous, and non-descending audit-log pages before dispatch or projection", () => {
    for (const query of [
        undefined,
        {},
        { limit: 0, userId: "30" },
        { before: "100", after: "99", userId: "30" },
        { userId: "invalid" },
        { actionType: 999 },
        { userId: "30", extra: true },
    ])
        expect(auditLogPage("20", query as never)).toBeInstanceOf(InputValidationFailure)

    const before = validRequest(auditLogPage("20", { before: "200", actionType: AuditLogActions.RoleUpdate }))
    expect(before.decode(page([entry({ id: "200" })]))).toBeUndefined()
    expect(before.decode(page([entry({ id: "199" }), entry({ id: "199" })]))).toBeUndefined()
    expect(before.decode(page([entry({ action_type: AuditLogActions.GuildUpdate })]))).toBeUndefined()
    expect(before.decode(page([entry({ options: { delete_message_seconds: "60" } })]))).toBeUndefined()
    expect(
        before.decode(page([entry({ changes: [{ key: "permissions", new_value: { untrusted: true } }] })])),
    ).toBeUndefined()
    for (const action_type of [-1, 1.5, "31"]) expect(before.decode(page([entry({ action_type })]))).toBeUndefined()
    expect(before.decode({ ...page(), webhooks: [{ id: "50", type: 3, name: "unknown" }] })).toBeUndefined()
})
