import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { memberVoiceFlag, memberVoiceMove } from "../src/internal/moderation.js"
import type { GuildRequest } from "../src/internal/guilds.js"
import {
    createClient,
    type ClientOptions,
    type GuildMember,
    type MemberReference,
    type DefaultModerationOptions,
    type VoiceConnectionReference,
} from "../src/index.js"
import { createClient as createNative, type ClientOptions as NativeClientOptions } from "../src/effect.js"
import { InputValidationFailure } from "../src/input-validation.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
const target: MemberReference = { guildId: "20", userId: "31" }
const connectionTarget: VoiceConnectionReference = { ...target, connectionId: "connection-one" }

const wireMember = (overrides: Record<string, unknown> = {}) => ({
    user: { id: "31", username: "voice-member", bot: false },
    roles: ["40"],
    joined_at: "2026-09-08T12:00:00.000Z",
    mute: false,
    deaf: false,
    ...overrides,
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
    const options = { token: "fixture", cache: { members: true } }
    const defaultApi = mode === "default" ? unwrap(createClient(options as ClientOptions)) : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(createNative(options as NativeClientOptions).pipe(Scope.provide(scope)))
            : undefined
    onTestFinished(async () => {
        try {
            if (defaultApi) unwrap(await defaultApi.shutdown())
            else await Effect.runPromise(native!.shutdown())
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    })
    return {
        fetch: async (): Promise<GuildMember> =>
            defaultApi
                ? unwrap(await defaultApi.members.fetch(target))
                : await Effect.runPromise(native!.members.fetch(target)),
        get: async (): Promise<GuildMember | undefined> =>
            defaultApi ? unwrap(defaultApi.members.get(target)) : await Effect.runPromise(native!.members.get(target)),
        move: async (
            selected: VoiceConnectionReference,
            channelId: string,
            operationOptions?: DefaultModerationOptions,
        ): Promise<GuildMember> =>
            defaultApi
                ? unwrap(await defaultApi.members.move(selected, channelId, operationOptions))
                : await Effect.runPromise(native!.members.move(selected, channelId, operationOptions)),
        disconnect: async (
            selected: VoiceConnectionReference,
            operationOptions?: DefaultModerationOptions,
        ): Promise<GuildMember> =>
            defaultApi
                ? unwrap(await defaultApi.members.disconnect(selected, operationOptions))
                : await Effect.runPromise(native!.members.disconnect(selected, operationOptions)),
        setMute: async (enabled: boolean, operationOptions?: DefaultModerationOptions): Promise<GuildMember> =>
            defaultApi
                ? unwrap(await defaultApi.members.setMute(target, enabled, operationOptions))
                : await Effect.runPromise(native!.members.setMute(target, enabled, operationOptions)),
        setDeaf: async (enabled: boolean, operationOptions?: DefaultModerationOptions): Promise<GuildMember> =>
            defaultApi
                ? unwrap(await defaultApi.members.setDeaf(target, enabled, operationOptions))
                : await Effect.runPromise(native!.members.setDeaf(target, enabled, operationOptions)),
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test("builds connection-targeted and all-connection member voice PATCH requests", () => {
    const move = validRequest(memberVoiceMove(connectionTarget, "50", { auditReason: "  Move one  " }))
    expect(move).toMatchObject({
        guildId: "20",
        bucket: "guild:member:voice:update",
        path: "/guilds/20/members/31",
        method: "PATCH",
        status: 200,
        moderation: true,
        auditReason: "Move one",
        cache: { selection: { kind: "members", guildId: "20", id: "31" }, mutation: true },
    })
    expect(JSON.parse(move.json!)).toEqual({ channel_id: "50", connection_id: "connection-one" })
    expect(JSON.parse(validRequest(memberVoiceMove(target, "50")).json!)).toEqual({ channel_id: "50" })
    expect(JSON.parse(validRequest(memberVoiceMove(target, null)).json!)).toEqual({ channel_id: null })
    expect(JSON.parse(validRequest(memberVoiceFlag(target, "mute", true)).json!)).toEqual({ mute: true })
    expect(JSON.parse(validRequest(memberVoiceFlag(target, "deaf", false)).json!)).toEqual({ deaf: false })
})

test("rejects invalid voice mutation inputs without constructing a request", () => {
    for (const request of [
        memberVoiceMove(null as never, "50"),
        memberVoiceMove({ guildId: "20", userId: "bad" }, "50"),
        memberVoiceMove(target, "0"),
        memberVoiceMove(target, "voice"),
        memberVoiceMove({ ...target, connectionId: "" }, "50"),
        memberVoiceMove({ ...target, connectionId: "x".repeat(33) }, null),
        memberVoiceFlag(target, "mute", undefined as never),
        memberVoiceFlag(target, "deaf", "yes" as never),
        memberVoiceMove(target, "50", { auditReason: "\n" }),
    ])
        expect(request).toBeInstanceOf(InputValidationFailure)
})

test("voice requests retain their admitted target when the caller later mutates its object", () => {
    const mutableTarget: { guildId: string; userId: string; connectionId: string } = {
        guildId: "20",
        userId: "31",
        connectionId: "connection-one",
    }
    const move = validRequest(memberVoiceMove(mutableTarget, "50"))
    const mute = validRequest(memberVoiceFlag(mutableTarget, "mute", true))
    mutableTarget.guildId = "999"
    mutableTarget.userId = "998"
    mutableTarget.connectionId = "replacement"

    expect(move.decode(wireMember())).toMatchObject({ guildId: "20", userId: "31" })
    expect(mute.decode(wireMember({ mute: true }))).toMatchObject({ guildId: "20", userId: "31", isMuted: true })
    expect(move.cache).toEqual({ selection: { kind: "members", guildId: "20", id: "31" }, mutation: true })
    expect(JSON.parse(move.json!)).toEqual({ channel_id: "50", connection_id: "connection-one" })
})

test.each(modes)("%s exposes member voice mutations and REST mute/deaf projections", async (mode) => {
    let muted = false
    let deafened = false
    const calls: { body: Record<string, unknown>; auditReason: string | null }[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
        if (init.method === "PATCH") {
            calls.push({ body, auditReason: new Headers(init.headers).get("X-Audit-Log-Reason") })
            if (typeof body.mute === "boolean") muted = body.mute
            if (typeof body.deaf === "boolean") deafened = body.deaf
        }
        return Response.json(wireMember({ mute: muted, deaf: deafened }))
    })
    const api = await setup(mode)

    expect(await api.fetch()).toMatchObject({ isMuted: false, isDeafened: false })
    expect(await api.move(connectionTarget, "50", { auditReason: "Moved" })).toMatchObject({
        isMuted: false,
        isDeafened: false,
    })
    await api.disconnect(target)
    expect((await api.setMute(true)).isMuted).toBe(true)
    expect((await api.setDeaf(true)).isDeafened).toBe(true)
    expect(await api.get()).toMatchObject({ isMuted: true, isDeafened: true })
    expect((await api.setMute(false)).isMuted).toBe(false)
    expect((await api.setDeaf(false)).isDeafened).toBe(false)
    expect(await api.get()).toMatchObject({ isMuted: false, isDeafened: false })
    expect(calls).toEqual([
        { body: { channel_id: "50", connection_id: "connection-one" }, auditReason: "Moved" },
        { body: { channel_id: null }, auditReason: null },
        { body: { mute: true }, auditReason: null },
        { body: { deaf: true }, auditReason: null },
        { body: { mute: false }, auditReason: null },
        { body: { deaf: false }, auditReason: null },
    ])
})

test.each(modes)("%s preserves omitted member flags and rejects malformed supplied flags", async (mode) => {
    let response: Record<string, unknown> = wireMember({ mute: undefined, deaf: undefined })
    stubFetchWithHostedDiscovery(async () => Response.json(response))
    const api = await setup(mode)

    const partial = await api.fetch()
    expect(partial).not.toHaveProperty("isMuted")
    expect(partial).not.toHaveProperty("isDeafened")
    response = wireMember({ mute: "yes" })
    await expect(api.fetch()).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "members.fetch",
        reason: "response",
        outcome: "unknown",
    })
})

test.each(modes)(
    "%s classifies voice permission/server rejection without replay and evicts dispatched moderation state",
    async (mode) => {
        let patchStatus = 200
        let patchCalls = 0
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            if (init.method !== "PATCH") return Response.json(wireMember())
            patchCalls++
            return patchStatus === 200
                ? Response.json(wireMember())
                : new Response("private provider response", { status: patchStatus })
        })
        const api = await setup(mode)
        await api.fetch()

        patchStatus = 403
        await expect(api.move(target, "50")).rejects.toMatchObject({
            _tag: "GuildOperationError",
            operation: "members.move",
            reason: "rejected",
            outcome: "rejected",
            status: 403,
        })
        expect(await api.get()).toBeUndefined()
        await api.fetch()

        patchStatus = 503
        await expect(api.setMute(true)).rejects.toMatchObject({
            _tag: "GuildOperationError",
            operation: "members.setMute",
            reason: "rejected",
            outcome: "unknown",
            status: 503,
        })
        expect(await api.get()).toBeUndefined()
        expect(patchCalls).toBe(2)
    },
)

test.each(modes)("%s treats a malformed successful voice write as unknown and invalidates the member", async (mode) => {
    let malformed = false
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) =>
        init.method === "PATCH" && malformed ? Response.json({}) : Response.json(wireMember()),
    )
    const api = await setup(mode)
    await api.fetch()
    malformed = true

    await expect(api.setDeaf(true)).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "members.setDeaf",
        reason: "response",
        outcome: "unknown",
        status: 200,
    })
    expect(await api.get()).toBeUndefined()
})
