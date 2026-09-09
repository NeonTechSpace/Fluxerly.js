import { Effect, Exit, Scope } from "effect"
import { expect, test, vi } from "vitest"
import { AuditLogActions, type AuditLogPage } from "../src/audit-logs.js"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { auditLogPage } from "../src/internal/audit-logs.js"

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

test.each(["default", "native"] as const)(
    "%s fetches filtered pages through the public client without retaining them",
    async (mode) => {
        const scope = Scope.makeUnsafe()
        const defaultApi = mode === "default" ? unwrap(createClient({ token: "fixture_only" })) : undefined
        const native =
            mode === "native"
                ? await Effect.runPromise(createNative({ token: "fixture_only" }).pipe(Scope.provide(scope)))
                : undefined
        const requests: URL[] = []
        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
            const parsed = new URL(url)
            requests.push(parsed)
            expect(init.method).toBe("GET")
            return Response.json(page())
        })
        try {
            const fetchPage = async (): Promise<AuditLogPage> =>
                defaultApi
                    ? unwrap(await defaultApi.auditLogs.fetchPage("20", { userId: "30" }))
                    : Effect.runPromise(native!.auditLogs.fetchPage("20", { userId: "30" }))
            const first = await fetchPage()
            const second = await fetchPage()
            expect(first).toEqual(second)
            expect(Object.isFrozen(first) && Object.isFrozen(first.entries[0]!)).toBe(true)
            expect(requests).toHaveLength(2)
            expect(requests.every((request) => request.pathname === "/v1/guilds/20/audit-logs")).toBe(true)
            expect(requests.every((request) => request.search === "?limit=50&user_id=30")).toBe(true)
        } finally {
            vi.unstubAllGlobals()
            if (defaultApi) await defaultApi.shutdown()
            if (native) await Effect.runPromise(native.shutdown())
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    },
)

test("builds a filtered remote audit-log page with source defaults and no cache selection", () => {
    const request = auditLogPage("20", { userId: "30", actionType: AuditLogActions.RoleUpdate })
    expect(request).toMatchObject({
        guildId: "20",
        bucket: "guild:audit-logs",
        path: "/guilds/20/audit-logs?limit=50&user_id=30&action_type=31",
        method: "GET",
        status: 200,
    })
    expect(request).not.toHaveProperty("cache")
})

test("accepts sticker lifecycle actions in user-filtered pages and action filters", () => {
    const actions = [AuditLogActions.StickerCreate, AuditLogActions.StickerUpdate, AuditLogActions.StickerDelete]
    expect(actions).toEqual([90, 91, 92])
    const entries = actions.map((action_type, index) => entry({ id: String(100 - index), action_type }))
    expect(
        auditLogPage("20", { userId: "30" })!
            .decode(page(entries))!
            .entries.map((item) => item.actionType),
    ).toEqual(actions)
    for (const actionType of actions) {
        const request = auditLogPage("20", { actionType })!
        expect(request.path).toContain(`action_type=${actionType}`)
        expect(request.decode(page([entry({ action_type: actionType })]))!.entries[0]!.actionType).toBe(actionType)
    }
})

test("projects complete frozen, token-free audit-log pages and preserves a non-snowflake target", () => {
    const request = auditLogPage("20", { userId: "30" })!
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
    const request = auditLogPage("20", { actionType: AuditLogActions.GuildUpdate })!
    const result = request.decode(
        page([
            entry({
                action_type: AuditLogActions.GuildUpdate,
                options: {
                    channel_id: "40",
                    count: 2,
                    delete_member_days: "7",
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
        expect(auditLogPage("20", query as never)).toBeUndefined()

    const before = auditLogPage("20", { before: "200", actionType: AuditLogActions.RoleUpdate })!
    expect(before.decode(page([entry({ id: "200" })]))).toBeUndefined()
    expect(before.decode(page([entry({ id: "199" }), entry({ id: "199" })]))).toBeUndefined()
    expect(before.decode(page([entry({ action_type: AuditLogActions.GuildUpdate })]))).toBeUndefined()
    expect(
        before.decode(page([entry({ changes: [{ key: "permissions", new_value: { untrusted: true } }] })])),
    ).toBeUndefined()
    expect(before.decode(page([entry({ action_type: 999 })]))).toBeUndefined()
    expect(before.decode({ ...page(), webhooks: [{ id: "50", type: 3, name: "unknown" }] })).toBeUndefined()
})
