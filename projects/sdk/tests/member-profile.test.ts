import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { decodeMember, memberEditSelf } from "../src/internal/guilds.js"
import { createClient, type MemberProfileEdit, type MemberReference } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import type { GuildRequest } from "../src/internal/guilds.js"
import { InputValidationFailure } from "../src/input-validation.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const image = "data:image/png;base64,AA=="
const modes = ["default", "native"] as const
const wireMember = (extra: Record<string, unknown> = {}) => ({
    user: { id: "30", username: "profile-bot", bot: true },
    roles: ["40"],
    joined_at: "2026-09-08T12:00:00.000Z",
    nick: "Existing nickname",
    avatar: "avatar-hash",
    banner: "banner-hash",
    accent_color: 0x224466,
    profile_flags: 3,
    mention_flags: 2,
    ...extra,
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const unwrap = <A, E>(result: { isErr(): boolean; value?: A; error?: E }): A => {
    if (result.isErr()) throw result.error
    return result.value!
}

const validRequest = <A>(request: GuildRequest<A> | InputValidationFailure): GuildRequest<A> => {
    if (request instanceof InputValidationFailure) throw request
    return request
}

async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const defaultApi =
        mode === "default" ? unwrap(createClient({ token: "fixture", cache: { members: true } })) : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  createNative({ token: "fixture", cache: { members: true } }).pipe(Scope.provide(scope)),
              )
            : undefined
    const get = (member: MemberReference) =>
        defaultApi ? unwrap(defaultApi.members.get(member)) : Effect.runPromise(native!.members.get(member))
    return {
        fetchSelf: async () =>
            defaultApi
                ? unwrap(await defaultApi.members.fetchSelf("20"))
                : Effect.runPromise(native!.members.fetchSelf("20")),
        fetch: async (userId: string) => {
            const member = { guildId: "20", userId }
            return defaultApi
                ? unwrap(await defaultApi.members.fetch(member))
                : Effect.runPromise(native!.members.fetch(member))
        },
        get,
        edit: (input: MemberProfileEdit) =>
            defaultApi
                ? defaultApi.members.editSelf("20", input).then(unwrap)
                : Effect.runPromise(native!.members.editSelf("20", input)),
        close: async () => {
            try {
                if (defaultApi) unwrap(await defaultApi.shutdown())
                else await Effect.runPromise(native!.shutdown())
            } finally {
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        },
    }
}

test("builds the authenticated member-profile PATCH with a conservative self cache mutation", () => {
    const request = memberEditSelf("20", {
        nickname: "Bot profile",
        avatar: image,
        banner: image,
        bio: "A bot-owned guild profile",
        pronouns: "they/them",
        accentColor: 0x224466,
        profileFlags: 3,
        mentionFlags: 2,
    })

    expect(request).toMatchObject({
        guildId: "20",
        bucket: "guild:member:self:update",
        path: "/guilds/20/members/@me",
        method: "PATCH",
        status: 200,
        cache: { selection: { kind: "members", guildId: "20" }, mutation: true },
    })
    expect(JSON.parse(validRequest(request).json!)).toEqual({
        nick: "Bot profile",
        avatar: image,
        banner: image,
        bio: "A bot-owned guild profile",
        pronouns: "they/them",
        accent_color: 0x224466,
        profile_flags: 3,
        mention_flags: 2,
    })
})

test.each(modes)(
    "%s exposes member-profile edits through the public client and replaces self cache readback",
    async (mode) => {
        const calls: { path: string; method: string; body: Record<string, unknown>; auditReason: string | null }[] = []
        stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
            const path = new URL(url).pathname
            const body: Record<string, unknown> = init.body ? JSON.parse(String(init.body)) : {}
            calls.push({
                path,
                method: init.method!,
                body,
                auditReason: new Headers(init.headers).get("X-Audit-Log-Reason"),
            })
            if (init.method === "PATCH") return Response.json(wireMember(body))
            if (path.endsWith("/members/31"))
                return Response.json(wireMember({ user: { id: "31", username: "other" } }))
            return Response.json(wireMember({ nick: "Before edit" }))
        })
        const api = await setup(mode)
        try {
            const before = await api.fetchSelf()
            await api.fetch("31")
            const result = await api.edit({
                nickname: "After edit",
                bio: "Write only profile bio",
                accentColor: 0x123456,
                profileFlags: 3,
                mentionFlags: 1,
            })

            expect(before.nickname).toBe("Before edit")
            expect(result).toMatchObject({
                guildId: "20",
                userId: "30",
                nickname: "After edit",
                accentColor: 0x123456,
                profileFlags: 3,
                mentionFlags: 1,
            })
            expect(await api.get({ guildId: "20", userId: "30" })).toEqual(result)
            expect(await api.get({ guildId: "20", userId: "31" })).toBeUndefined()
            expect(calls).toEqual([
                { path: "/v1/guilds/20/members/@me", method: "GET", body: {}, auditReason: null },
                { path: "/v1/guilds/20/members/31", method: "GET", body: {}, auditReason: null },
                {
                    path: "/v1/guilds/20/members/@me",
                    method: "PATCH",
                    body: {
                        nick: "After edit",
                        bio: "Write only profile bio",
                        accent_color: 0x123456,
                        profile_flags: 3,
                        mention_flags: 1,
                    },
                    auditReason: null,
                },
            ])
        } finally {
            await api.close()
        }
    },
)

test.each(modes)(
    "%s retains cache on known non-mutations and clears it after an uncertain profile edit",
    async (mode) => {
        let outcome: "success" | "rejected" | "malformed" = "success"
        let calls = 0
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            calls++
            if (init.method === "PATCH" && outcome === "rejected")
                return new Response("private provider response", { status: 403 })
            if (init.method === "PATCH" && outcome === "malformed") return Response.json({})
            return Response.json(wireMember({ nick: "Cached profile" }))
        })
        const api = await setup(mode)
        try {
            const target = { guildId: "20", userId: "30" }
            await api.fetchSelf()
            await expect(api.edit({ nickname: "" })).rejects.toMatchObject({
                _tag: "GuildOperationError",
                operation: "members.editSelf",
                reason: "input",
                outcome: "notDispatched",
            })
            expect(await api.get(target)).toMatchObject({ nickname: "Cached profile" })
            expect(calls).toBe(1)

            outcome = "rejected"
            await expect(api.edit({ nickname: "Rejected" })).rejects.toMatchObject({
                _tag: "GuildOperationError",
                operation: "members.editSelf",
                reason: "rejected",
                outcome: "rejected",
                status: 403,
            })
            expect(await api.get(target)).toMatchObject({ nickname: "Cached profile" })
            expect(calls).toBe(2)

            outcome = "malformed"
            await expect(api.edit({ nickname: "Unknown" })).rejects.toMatchObject({
                _tag: "GuildOperationError",
                operation: "members.editSelf",
                reason: "response",
                outcome: "unknown",
                status: 200,
            })
            expect(await api.get(target)).toBeUndefined()
            expect(calls).toBe(3)
        } finally {
            await api.close()
        }
    },
)

test("preserves omitted profile fields and sends null clears", () => {
    expect(JSON.parse(validRequest(memberEditSelf("20", { nickname: "Only this field" })).json!)).toEqual({
        nick: "Only this field",
    })
    expect(
        JSON.parse(
            validRequest(
                memberEditSelf("20", {
                    nickname: null,
                    avatar: null,
                    banner: null,
                    bio: null,
                    pronouns: null,
                    accentColor: null,
                    profileFlags: null,
                    mentionFlags: null,
                }),
            ).json!,
        ),
    ).toEqual({
        nick: null,
        avatar: null,
        banner: null,
        bio: null,
        pronouns: null,
        accent_color: null,
        profile_flags: null,
        mention_flags: null,
    })
    expect(memberEditSelf("20", {})).toBeInstanceOf(InputValidationFailure)
})

test("projects returned profile metadata without fabricating write-only fields", () => {
    const profile = decodeMember(wireMember({ bio: "The provider does not return this", pronouns: "nor this" }), "20")

    expect(profile).toEqual({
        guildId: "20",
        userId: "30",
        username: "profile-bot",
        isBot: true,
        roleIds: ["40"],
        joinedAt: "2026-09-08T12:00:00.000Z",
        nickname: "Existing nickname",
        avatar: "avatar-hash",
        banner: "banner-hash",
        accentColor: 0x224466,
        profileFlags: 3,
        mentionFlags: 2,
    })
    expect(Object.isFrozen(profile) && Object.isFrozen(profile?.roleIds)).toBe(true)
    expect(profile).not.toHaveProperty("bio")
    expect(profile).not.toHaveProperty("pronouns")
})

test("rejects malformed member-profile requests and profile response fields", () => {
    for (const input of [
        null,
        [],
        { unknown: true },
        { roles: [] },
        { mute: true },
        { communicationDisabledUntil: null },
        { nickname: "" },
        { nickname: "x".repeat(33) },
        { avatar: "data:text/plain;base64,AA==" },
        { banner: "not-a-data-uri" },
        { bio: "" },
        { bio: "x".repeat(321) },
        { pronouns: "" },
        { pronouns: "x".repeat(41) },
        { accentColor: -1 },
        { accentColor: 0x1000000 },
        { accentColor: 1.5 },
        { profileFlags: -1 },
        { profileFlags: 2_147_483_648 },
        { profileFlags: 1.5 },
        { mentionFlags: 3 },
    ])
        expect(memberEditSelf("20", input as never)).toBeInstanceOf(InputValidationFailure)

    expect(memberEditSelf("invalid", {})).toBeInstanceOf(InputValidationFailure)
    expect(validRequest(memberEditSelf("20", { profileFlags: 4 })).json).toBe('{"profile_flags":4}')
    for (const extra of [{ banner: 1 }, { accent_color: -1 }, { profile_flags: -1 }, { mention_flags: 3 }])
        expect(decodeMember(wireMember(extra), "20")).toBeUndefined()
})
