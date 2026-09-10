import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, type ClientOptions, type GuildMember, type MemberReference } from "../src/index.js"
import { createClient as createNative, type ClientOptions as NativeClientOptions } from "../src/effect.js"

const modes = ["default", "native"] as const
const target: MemberReference = { guildId: "20", userId: "31" }

const wireMember = (roles: readonly string[] = ["40"], userId = target.userId) => ({
    user: { id: userId, username: "target-member", bot: false },
    roles: [...roles],
    joined_at: "2026-09-08T12:00:00.000Z",
    nick: "Existing nickname",
})

const unwrap = <A, E>(result: { isErr(): boolean; value?: A; error?: E }): A => {
    if (result.isErr()) throw result.error
    return result.value!
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
        defaultApi,
        native,
        fetch: async (): Promise<GuildMember> =>
            defaultApi
                ? unwrap(await defaultApi.members.fetch(target))
                : await Effect.runPromise(native!.members.fetch(target)),
        get: async (): Promise<GuildMember | undefined> =>
            defaultApi ? unwrap(defaultApi.members.get(target)) : await Effect.runPromise(native!.members.get(target)),
        setRoles: async (
            member: MemberReference,
            roleIds: readonly string[],
            options?: { readonly timeoutMs?: number },
        ): Promise<GuildMember> =>
            defaultApi
                ? unwrap(await defaultApi.members.setRoles(member, roleIds, options))
                : await Effect.runPromise(native!.members.setRoles(member, roleIds, options)),
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test.each(modes)("%s replaces roles with one PATCH and returns Fluxer's frozen actual role set", async (mode) => {
    const calls: { path: string; method: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        calls.push({ path: new URL(url).pathname, method: init.method!, body })
        return Response.json(wireMember(Array.isArray(body.roles) && body.roles.length === 0 ? [] : ["61"]))
    })
    const api = await setup(mode)

    const assigned = await api.setRoles(target, ["40", "50"])
    const cleared = await api.setRoles(target, [])

    expect(assigned.roleIds).toEqual(["61"])
    expect(cleared.roleIds).toEqual([])
    expect(Object.isFrozen(assigned) && Object.isFrozen(assigned.roleIds)).toBe(true)
    expect(Object.isFrozen(cleared) && Object.isFrozen(cleared.roleIds)).toBe(true)
    expect(await api.get()).toEqual(cleared)
    expect(calls).toEqual([
        {
            path: "/v1/guilds/20/members/31",
            method: "PATCH",
            body: { roles: ["40", "50"] },
        },
        { path: "/v1/guilds/20/members/31", method: "PATCH", body: { roles: [] } },
    ])
})

test.each(modes)("%s rejects invalid full role sets before dispatch", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const api = await setup(mode)
    const tooMany = Array.from({ length: 251 }, (_, index) => String(index + 1000))

    for (const [member, roles] of [
        [{ guildId: "0", userId: "31" }, ["40"]],
        [{ guildId: "20", userId: "0" }, ["40"]],
        [{ guildId: "invalid", userId: "31" }, ["40"]],
        [target, ["0"]],
        [target, ["invalid"]],
        [target, ["40", "40"]],
        [target, ["20"]],
        [target, tooMany],
        [target, Array(1)],
        [target, new Set(["40"])],
    ])
        await expect(api.setRoles(member as MemberReference, roles as readonly string[])).rejects.toMatchObject({
            _tag: "GuildOperationError",
            operation: "members.setRoles",
            reason: "input",
            outcome: "notDispatched",
        })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s copies role IDs at its default or native execution boundary", async (mode) => {
    const bodies: unknown[] = []
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        bodies.push(body)
        return Response.json(wireMember(body.roles))
    })
    const api = await setup(mode)
    const roleIds = ["40"]

    if (api.defaultApi) {
        const operation = api.defaultApi.members.setRoles(target, roleIds)
        roleIds[0] = "50"
        unwrap(await operation)
    } else {
        const operation = api.native!.members.setRoles(target, roleIds)
        roleIds[0] = "50"
        await Effect.runPromise(operation)
    }

    expect(bodies).toEqual([{ roles: [mode === "default" ? "40" : "50"] }])
})

test.each(modes)("%s rejects a mismatched member response and evicts its uncertain cached write", async (mode) => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) =>
        init.method === "GET" ? Response.json(wireMember()) : Response.json(wireMember(["50"], "32")),
    )
    const api = await setup(mode)
    await api.fetch()

    await expect(api.setRoles(target, ["50"])).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "members.setRoles",
        reason: "response",
        outcome: "unknown",
        status: 200,
    })
    expect(await api.get()).toBeUndefined()
})

test.each(modes)("%s never replays an uncertain role replacement but retries a confirmed rate limit", async (mode) => {
    let attempts = 0
    vi.stubGlobal("fetch", async () => {
        attempts++
        return new Response("private provider response", { status: 503 })
    })
    const api = await setup(mode)

    await expect(api.setRoles(target, ["50"])).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "members.setRoles",
        reason: "rejected",
        outcome: "unknown",
        status: 503,
    })
    expect(attempts).toBe(1)

    attempts = 0
    vi.stubGlobal("fetch", async () => {
        attempts++
        if (attempts === 1)
            return Response.json({ retry_after: 0.001 }, { status: 429, headers: { "retry-after": "0.001" } })
        return Response.json(wireMember(["50"]))
    })
    expect((await api.setRoles(target, ["50"])).roleIds).toEqual(["50"])
    expect(attempts).toBe(2)
})

test.each(modes)("%s applies the shared deadline to an active role replacement and awaits cleanup", async (mode) => {
    let active = 0
    const fetch = vi.fn(
        async (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                active++
                init.signal!.addEventListener(
                    "abort",
                    () =>
                        setTimeout(() => {
                            active--
                            reject(Error("aborted"))
                        }, 5),
                    { once: true },
                )
            }),
    )
    vi.stubGlobal("fetch", fetch)
    const api = await setup(mode)

    await expect(api.setRoles(target, ["50"], { timeoutMs: 1 })).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "members.setRoles",
        reason: "timeout",
        outcome: "unknown",
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(active).toBe(0)
})

test.each(modes)("%s cancellation interrupts the role replacement and awaits transport cleanup", async (mode) => {
    let active = 0
    vi.stubGlobal(
        "fetch",
        (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                active++
                init.signal!.addEventListener(
                    "abort",
                    () =>
                        setTimeout(() => {
                            active--
                            reject(Error("aborted"))
                        }, 5),
                    { once: true },
                )
            }),
    )
    const api = await setup(mode)
    const controller = new AbortController()
    if (api.native) {
        const pending = Effect.runPromiseExit(api.native.members.setRoles(target, ["50"]), {
            signal: controller.signal,
        })
        await vi.waitFor(() => expect(active).toBe(1))
        controller.abort()
        const result = await pending
        expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
    } else {
        const pending = api
            .defaultApi!.members.setRoles(target, ["50"], { signal: controller.signal })
            .then((result) => (result.isErr() ? result.error : result.value))
        await vi.waitFor(() => expect(active).toBe(1))
        controller.abort()
        expect(await pending).toMatchObject({ _tag: "CancelledError" })
    }
    expect(active).toBe(0)
})
