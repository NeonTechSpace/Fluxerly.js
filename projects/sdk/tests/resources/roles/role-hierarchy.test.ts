import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { SdkDefect, hierarchy, createClient, type RoleHierarchyInput } from "../../../src/index.js"
import { createClient as createNative, hierarchy as nativeHierarchy } from "../../../src/effect.js"
import { GuildOperationError } from "../../../src/guilds.js"
import { modes } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"

const guild = (ownerId = "1") => ({ id: "20", ownerId, name: "fixture", features: [] })
const member = (userId: string, roleIds: readonly string[] = []) => ({
    guildId: "20",
    userId,
    username: `member-${userId}`,
    isBot: true,
    roleIds,
    joinedAt: "2026-09-08T12:00:00.000Z",
})
const role = (id: string, position: number, guildId = "20") => ({
    guildId,
    id,
    name: `role-${id}`,
    color: 0,
    position,
    permissions: 0n,
    hoist: false,
    mentionable: false,
})
const input = (actor = member("2", ["100"]), target = member("3", ["101"])): RoleHierarchyInput => ({
    guild: guild(),
    actor,
    target,
    roles: [role("100", 2), role("101", 1)],
})

const wireRole = (id: string, position: number) => ({
    id,
    name: id === "20" ? "everyone" : `role-${id}`,
    color: 0,
    position,
    permissions: "0",
    hoist: false,
    mentionable: false,
})

function responseWithCleanupFailure(status: number, cleanup: unknown, cancelled?: () => void): Response {
    return new Response(
        new ReadableStream({
            cancel: () => {
                cancelled?.()
                throw cleanup
            },
        }),
        { status },
    )
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

function value<A>(result: { readonly isOk: () => boolean; readonly value?: A; readonly error?: unknown }): A {
    if (!result.isOk()) throw result.error
    return result.value as A
}

function expectInputError(
    run: () => unknown,
    operation: "hierarchy.compare" | "hierarchy.isAbove" | "hierarchy.canManage",
) {
    let thrown: unknown
    try {
        run()
    } catch (error) {
        thrown = error
    }
    expect(thrown).toBeInstanceOf(GuildOperationError)
    expect(thrown).toMatchObject({
        _tag: "GuildOperationError",
        operation,
        reason: "input",
        outcome: "notDispatched",
        status: null,
        retryAfterMs: null,
    })
    expect(thrown).not.toHaveProperty("input")
}

test("compares positions then smaller numeric IDs for tied role hierarchy", () => {
    expect(hierarchy.compare(role("100", 2), role("101", 1))).toBe(1)
    expect(hierarchy.compare(role("101", 1), role("100", 2))).toBe(-1)
    expect(hierarchy.compare(role("100", 2), role("101", 2))).toBe(1)
    expect(hierarchy.compare(role("101", 2), role("100", 2))).toBe(-1)
    expect(hierarchy.compare(role("100", 2), role("100", 2))).toBe(0)
    expect(hierarchy.isAbove(role("100", 2), role("101", 2))).toBe(true)
    expect(hierarchy.isAbove(role("100", 2), role("100", 2))).toBe(false)
    expect(nativeHierarchy.compare(role("100", 2), role("101", 2))).toBe(1)
    expect(nativeHierarchy.isAbove(role("100", 2), role("100", 2))).toBe(false)
})

test("evaluates only target hierarchy with exact owner, self, tie and empty-role semantics", () => {
    expect(hierarchy.canManage(input())).toBe(true)
    expect(hierarchy.canManage(input(member("2", ["100"]), member("3", ["101"])))).toBe(true)
    expect(
        hierarchy.canManage({
            ...input(),
            roles: [role("100", 2), role("101", 2)],
        }),
    ).toBe(true)
    expect(
        hierarchy.canManage({
            ...input(),
            actor: member("2", ["101"]),
            target: member("3", ["100"]),
            roles: [role("100", 2), role("101", 2)],
        }),
    ).toBe(false)
    expect(hierarchy.canManage(input(member("2", ["100"]), member("3")))).toBe(true)
    expect(hierarchy.canManage(input(member("2"), member("3")))).toBe(false)
    expect(hierarchy.canManage(input(member("1"), member("3", ["101"])))).toBe(true)
    expect(hierarchy.canManage(input(member("2", ["100"]), member("1", ["101"])))).toBe(false)
    expect(hierarchy.canManage(input(member("2", ["100"]), member("2", ["100"])))).toBe(true)
    expect(nativeHierarchy.canManage(input(member("2"), member("3")))).toBe(false)
})

test("accepts the full public roles.fetchAll observation without caller filtering", async () => {
    stubFetchWithHostedDiscovery(async (url: string) => {
        expect(new URL(url).pathname).toBe("/v1/guilds/20/roles")
        return Response.json([wireRole("20", 0), wireRole("100", 2), wireRole("101", 1)])
    })
    const client = createClient({ token: "fixture" })
    try {
        const roles = (await client.roles.fetchAll("20"))._unsafeUnwrap()
        expect(roles.map((role) => role.id)).toEqual(["20", "100", "101"])
        expect(hierarchy.canManage({ ...input(), roles })).toBe(true)
    } finally {
        ;(await client.shutdown())._unsafeUnwrap()
    }
})

test("throws exact input errors for malformed, cross-guild, and incomplete snapshots in both entries", () => {
    for (const compare of [hierarchy.compare, nativeHierarchy.compare])
        expectInputError(() => compare(role("100", 2), role("101", 2, "21")), "hierarchy.compare")
    for (const isAbove of [hierarchy.isAbove, nativeHierarchy.isAbove])
        expectInputError(() => isAbove(role("100", 2), role("101", 2, "21")), "hierarchy.isAbove")

    const cases = [
        { ...input(), roles: [role("100", 2)] },
        { ...input(), roles: [role("100", 2), role("100", 1)] },
        { ...input(), roles: [role("100", 2), role("101", 1, "21")] },
        { ...input(), actor: member("2", ["20"]) },
        { ...input(), actor: member("2", ["100", "100"]) },
        { ...input(), target: { ...member("3", ["101"]), guildId: "21" } },
        { ...input(), guild: { ...guild(), ownerId: "invalid" } },
        { ...input(), roles: [role("100", -1), role("101", 1)] },
        { ...input(), roles: [role("100", 2_147_483_648), role("101", 1)] },
    ]
    for (const snapshot of cases)
        for (const canManage of [hierarchy.canManage, nativeHierarchy.canManage])
            expectInputError(() => canManage(snapshot as RoleHierarchyInput), "hierarchy.canManage")
})

test("native hierarchy input errors thrown inside Effect code become defects", async () => {
    const exit = await Effect.runPromiseExit(
        Effect.sync(() => nativeHierarchy.canManage({ ...input(), roles: [role("100", 2)] })),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
        expect(exit.cause.reasons.find((reason) => reason._tag === "Die")).toMatchObject({
            defect: { _tag: "GuildOperationError", operation: "hierarchy.canManage", reason: "input" },
        })
})

test.each(modes)("%s fetchCanManage reads four fresh inputs concurrently without cache authority", async (mode) => {
    const calls: string[] = []
    const releases: Array<(response: Response) => void> = []
    stubFetchWithHostedDiscovery((url: string) => {
        const path = new URL(url).pathname
        calls.push(path)
        return new Promise<Response>((resolve) => releases.push(resolve))
    })
    const response = (path: string) => {
        if (path.endsWith("/guilds/20"))
            return Response.json({ id: "20", owner_id: "99", name: "fixture", features: [] })
        if (path.endsWith("/members/@me"))
            return Response.json({
                user: { id: "2", username: "bot", bot: true },
                roles: ["100"],
                joined_at: "2026-09-08T12:00:00Z",
            })
        if (path.endsWith("/members/3"))
            return Response.json({
                user: { id: "3", username: "target" },
                roles: ["101"],
                joined_at: "2026-09-08T12:00:00Z",
            })
        if (path.endsWith("/roles")) return Response.json([wireRole("20", 0), wireRole("100", 2), wireRole("101", 1)])
        throw Error(`Unexpected request ${path}`)
    }
    const run = async () => {
        if (mode === "default") {
            const client = createClient({ token: "fixture" })
            try {
                return value(await client.members.fetchCanManage({ guildId: "20", userId: "3" }))
            } finally {
                value(await client.shutdown())
            }
        }
        return Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* createNative({ token: "fixture" })
                    return yield* client.members.fetchCanManage({ guildId: "20", userId: "3" })
                }),
            ),
        )
    }
    const pending = run()
    await vi.waitFor(() => expect(calls).toHaveLength(4))
    for (let index = 0; index < releases.length; index++) releases[index]!(response(calls[index]!))
    await expect(pending).resolves.toBe(true)
    expect(new Set(calls)).toEqual(
        new Set(["/v1/guilds/20", "/v1/guilds/20/members/@me", "/v1/guilds/20/members/3", "/v1/guilds/20/roles"]),
    )
})

test.each(modes)(
    "%s fetchCanManage keeps a mapped remote failure with a sibling response-cleanup defect",
    async (mode) => {
        const cleanup = new Error("private hierarchy sibling cleanup defect")
        let releaseGuild!: (response: Response) => void
        let releaseSibling!: (response: Response) => void
        let observeSiblingAbort!: () => void
        const siblingAborted = new Promise<void>((resolve) => {
            observeSiblingAbort = resolve
        })
        let ready!: () => void
        const started = new Promise<void>((resolve) => {
            ready = resolve
        })
        stubFetchWithHostedDiscovery((url: string, init: RequestInit) => {
            const path = new URL(url).pathname
            if (path.endsWith("/guilds/20")) return new Promise<Response>((resolve) => (releaseGuild = resolve))
            if (path.endsWith("/members/@me"))
                return new Promise<Response>((resolve) => {
                    releaseSibling = resolve
                    init.signal?.addEventListener("abort", observeSiblingAbort, { once: true })
                    ready()
                })
            if (path.endsWith("/members/3"))
                return Promise.resolve(
                    Response.json({
                        user: { id: "3", username: "target" },
                        roles: ["101"],
                        joined_at: "2026-09-08T12:00:00Z",
                    }),
                )
            return Promise.resolve(Response.json([wireRole("20", 0), wireRole("100", 2), wireRole("101", 1)]))
        })
        if (mode === "default") {
            const client = createClient({ token: "fixture" })
            try {
                const result = Promise.resolve(client.members.fetchCanManage({ guildId: "20", userId: "3" }))
                await started
                releaseGuild(new Response(null, { status: 401 }))
                await siblingAborted
                releaseSibling(responseWithCleanupFailure(200, cleanup))
                await expect(result).rejects.toMatchObject({
                    name: "SdkDefect",
                    operation: "members.fetchCanManage",
                    reasons: expect.arrayContaining([
                        {
                            kind: "Failure",
                            failure: expect.objectContaining({
                                _tag: "GuildOperationError",
                                operation: "members.fetchCanManage",
                                status: 401,
                            }),
                        },
                        expect.objectContaining({ kind: "Defect" }),
                    ]),
                } satisfies Partial<SdkDefect>)
            } finally {
                value(await client.shutdown())
            }
        } else {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
            try {
                const result = Effect.runPromiseExit(client.members.fetchCanManage({ guildId: "20", userId: "3" }))
                await started
                releaseGuild(new Response(null, { status: 401 }))
                await siblingAborted
                releaseSibling(responseWithCleanupFailure(200, cleanup))
                const exit = await result
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isFailure(exit))
                    expect(exit.cause.reasons).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({
                                _tag: "Fail",
                                error: expect.objectContaining({
                                    _tag: "GuildOperationError",
                                    operation: "members.fetchCanManage",
                                    status: 401,
                                }),
                            }),
                            expect.objectContaining({ _tag: "Die", defect: cleanup }),
                        ]),
                    )
            } finally {
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        }
    },
)

test.each(modes)("%s fetchCanManage checks the member named by actorUserId instead of the bot", async (mode) => {
    const calls: string[] = []
    stubFetchWithHostedDiscovery(async (url: string) => {
        const path = new URL(url).pathname
        calls.push(path)
        if (path.endsWith("/guilds/20"))
            return Response.json({ id: "20", owner_id: "99", name: "fixture", features: [] })
        // The moderator holds the lower role, so the answer depends on reading the moderator rather than the bot
        if (path.endsWith("/members/5"))
            return Response.json({
                user: { id: "5", username: "moderator" },
                roles: ["101"],
                joined_at: "2026-09-08T12:00:00Z",
            })
        if (path.endsWith("/members/3"))
            return Response.json({
                user: { id: "3", username: "target" },
                roles: ["100"],
                joined_at: "2026-09-08T12:00:00Z",
            })
        if (path.endsWith("/roles")) return Response.json([wireRole("20", 0), wireRole("100", 2), wireRole("101", 1)])
        throw Error(`Unexpected request ${path}`)
    })
    const target = { guildId: "20", userId: "3" }
    /** Run one check, returning its answer or its expected failure in either API style */
    const run = async (options: object): Promise<{ readonly answer?: boolean; readonly failure?: unknown }> => {
        if (mode === "default") {
            const client = createClient({ token: "fixture" })
            try {
                const result = await client.members.fetchCanManage(target, options)
                return result.isOk() ? { answer: result.value } : { failure: result.error }
            } finally {
                value(await client.shutdown())
            }
        }
        return Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* createNative({ token: "fixture" })
                    return yield* client.members.fetchCanManage(target, options).pipe(
                        Effect.map((answer) => ({ answer })),
                        Effect.catch((failure) => Effect.succeed({ failure })),
                    )
                }),
            ),
        )
    }
    expect(await run({ actorUserId: "5" })).toEqual({ answer: false })
    expect(new Set(calls)).toEqual(
        new Set(["/v1/guilds/20", "/v1/guilds/20/members/5", "/v1/guilds/20/members/3", "/v1/guilds/20/roles"]),
    )

    calls.length = 0
    expect((await run({ actorUserId: "moderator" })).failure).toMatchObject({
        operation: "members.fetchCanManage",
        reason: "input",
        inputValidation: { path: "options.actorUserId", constraint: "format" },
    })
    expect(calls).toEqual([])
})
