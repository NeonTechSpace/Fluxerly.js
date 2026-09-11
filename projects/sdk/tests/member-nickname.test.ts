import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { memberNicknameEdit } from "../src/internal/guilds.js"
import { createClient, type ClientOptions, type GuildMember, type MemberReference } from "../src/index.js"
import { createClient as createNative, type ClientOptions as NativeClientOptions } from "../src/effect.js"
import type { GuildRequest } from "../src/internal/guilds.js"
import { InputValidationFailure } from "../src/input-validation.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
const target: MemberReference = { guildId: "20", userId: "31" }

const wireMember = (nickname: string | null = "Before rename", userId = "31") => ({
    user: { id: userId, username: "target-member", bot: false },
    roles: ["40"],
    joined_at: "2026-09-08T12:00:00.000Z",
    nick: nickname,
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
    const close = async () => {
        try {
            if (defaultApi) unwrap(await defaultApi.shutdown())
            else await Effect.runPromise(native!.shutdown())
        } finally {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
    }
    onTestFinished(close)
    return {
        fetch: async (): Promise<GuildMember> =>
            defaultApi
                ? unwrap(await defaultApi.members.fetch(target))
                : await Effect.runPromise(native!.members.fetch(target)),
        get: async (): Promise<GuildMember | undefined> =>
            defaultApi ? unwrap(defaultApi.members.get(target)) : await Effect.runPromise(native!.members.get(target)),
        setNickname: async (nickname: string | null): Promise<GuildMember> =>
            defaultApi
                ? unwrap(await defaultApi.members.setNickname(target, nickname))
                : await Effect.runPromise(native!.members.setNickname(target, nickname)),
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test("builds a target-member nickname PATCH without a roles replacement", () => {
    const request = memberNicknameEdit(target, "Renamed")

    expect(request).toMatchObject({
        guildId: "20",
        bucket: "guild:member:nickname:update",
        path: "/guilds/20/members/31",
        method: "PATCH",
        status: 200,
        cache: { selection: { kind: "members", guildId: "20", id: "31" }, mutation: true },
    })
    expect(JSON.parse(validRequest(request).json!)).toEqual({ nick: "Renamed" })
    expect(JSON.parse(validRequest(memberNicknameEdit(target, null)).json!)).toEqual({ nick: null })
})

test("rejects invalid nickname target and values before dispatch", () => {
    for (const [member, nickname] of [
        [null, "name"],
        [{ guildId: "20", userId: "invalid" }, "name"],
        [target, ""],
        [target, "x".repeat(33)],
        [target, undefined],
    ])
        expect(memberNicknameEdit(member as never, nickname as never)).toBeInstanceOf(InputValidationFailure)
})

test.each(modes)("%s sets and clears a nickname through the public client", async (mode) => {
    const calls: { path: string; method: string; body: Record<string, unknown> }[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
        calls.push({ path: new URL(url).pathname, method: init.method!, body })
        return Response.json(wireMember(Object.hasOwn(body, "nick") ? (body.nick as string | null) : "Before rename"))
    })
    const api = await setup(mode)

    expect((await api.fetch()).nickname).toBe("Before rename")
    expect((await api.setNickname("Renamed")).nickname).toBe("Renamed")
    expect((await api.get())?.nickname).toBe("Renamed")
    expect((await api.setNickname(null)).nickname).toBeNull()
    expect((await api.get())?.nickname).toBeNull()
    expect(calls).toEqual([
        { path: "/v1/guilds/20/members/31", method: "GET", body: {} },
        { path: "/v1/guilds/20/members/31", method: "PATCH", body: { nick: "Renamed" } },
        { path: "/v1/guilds/20/members/31", method: "PATCH", body: { nick: null } },
    ])
})

test.each(modes)("%s preserves known cache state but evicts an uncertain nickname write", async (mode) => {
    let outcome: "rejected" | "malformed" = "rejected"
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        if (init.method === "PATCH" && outcome === "rejected")
            return new Response("private provider response", { status: 403 })
        if (init.method === "PATCH") return Response.json({})
        return Response.json(wireMember())
    })
    const api = await setup(mode)
    await api.fetch()

    await expect(api.setNickname("Rejected")).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "members.setNickname",
        reason: "rejected",
        outcome: "rejected",
        status: 403,
    })
    expect((await api.get())?.nickname).toBe("Before rename")

    outcome = "malformed"
    await expect(api.setNickname("Unknown")).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "members.setNickname",
        reason: "response",
        outcome: "unknown",
        status: 200,
    })
    expect(await api.get()).toBeUndefined()
})

test.each(modes)("%s rejects a nickname response for another member and evicts the targeted cache", async (mode) => {
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) =>
        init.method === "PATCH" ? Response.json(wireMember("Renamed", "32")) : Response.json(wireMember()),
    )
    const api = await setup(mode)
    await api.fetch()

    await expect(api.setNickname("Renamed")).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "members.setNickname",
        reason: "response",
        outcome: "unknown",
        status: 200,
    })
    expect(await api.get()).toBeUndefined()
})
