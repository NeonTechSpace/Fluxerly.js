import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import {
    SdkDefect,
    canManageHierarchy,
    compareHierarchy,
    createClient,
    isAboveInHierarchy,
    type RoleHierarchyInput,
} from "../src/index.js"
import {
    createClient as createNative,
    canManageHierarchy as canManageNativeHierarchy,
    compareHierarchy as compareNativeHierarchy,
    isAboveInHierarchy as isAboveNativeHierarchy,
} from "../src/effect.js"
import type { GuildOperationError } from "../src/guilds.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

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
    result: { readonly isErr: () => boolean; readonly error?: GuildOperationError },
    operation: "hierarchy.compare" | "hierarchy.isAbove" | "hierarchy.canManage",
) {
    expect(result.isErr()).toBe(true)
    expect(result.error).toMatchObject({
        _tag: "GuildOperationError",
        operation,
        reason: "input",
        outcome: "notDispatched",
        status: null,
        retryAfterMs: null,
    })
    expect(result.error).not.toHaveProperty("input")
}

test("compares positions then smaller numeric IDs for tied role hierarchy", async () => {
    expect(value(compareHierarchy(role("100", 2), role("101", 1)))).toBe(1)
    expect(value(compareHierarchy(role("101", 1), role("100", 2)))).toBe(-1)
    expect(value(compareHierarchy(role("100", 2), role("101", 2)))).toBe(1)
    expect(value(compareHierarchy(role("101", 2), role("100", 2)))).toBe(-1)
    expect(value(compareHierarchy(role("100", 2), role("100", 2)))).toBe(0)
    expect(value(isAboveInHierarchy(role("100", 2), role("101", 2)))).toBe(true)
    expect(value(isAboveInHierarchy(role("100", 2), role("100", 2)))).toBe(false)
    expect(await Effect.runPromise(compareNativeHierarchy(role("100", 2), role("101", 2)))).toBe(1)
    expect(await Effect.runPromise(isAboveNativeHierarchy(role("100", 2), role("100", 2)))).toBe(false)
})

test("evaluates only target hierarchy with exact owner, self, tie and empty-role semantics", async () => {
    expect(value(canManageHierarchy(input()))).toBe(true)
    expect(value(canManageHierarchy(input(member("2", ["100"]), member("3", ["101"]))))).toBe(true)
    expect(
        value(
            canManageHierarchy({
                ...input(),
                roles: [role("100", 2), role("101", 2)],
            }),
        ),
    ).toBe(true)
    expect(
        value(
            canManageHierarchy({
                ...input(),
                actor: member("2", ["101"]),
                target: member("3", ["100"]),
                roles: [role("100", 2), role("101", 2)],
            }),
        ),
    ).toBe(false)
    expect(value(canManageHierarchy(input(member("2", ["100"]), member("3"))))).toBe(true)
    expect(value(canManageHierarchy(input(member("2"), member("3"))))).toBe(false)
    expect(value(canManageHierarchy(input(member("1"), member("3", ["101"]))))).toBe(true)
    expect(value(canManageHierarchy(input(member("2", ["100"]), member("1", ["101"]))))).toBe(false)
    expect(value(canManageHierarchy(input(member("2", ["100"]), member("2", ["100"]))))).toBe(true)
    expect(await Effect.runPromise(canManageNativeHierarchy(input(member("2"), member("3"))))).toBe(false)
})

test("accepts the full public roles.fetchAll observation without caller filtering", async () => {
    stubFetchWithHostedDiscovery(async (url: string) => {
        expect(new URL(url).pathname).toBe("/v1/guilds/20/roles")
        return Response.json([wireRole("20", 0), wireRole("100", 2), wireRole("101", 1)])
    })
    const client = createClient({ token: "fixture" })._unsafeUnwrap()
    try {
        const roles = (await client.roles.fetchAll("20"))._unsafeUnwrap()
        expect(roles.map((role) => role.id)).toEqual(["20", "100", "101"])
        expect(value(canManageHierarchy({ ...input(), roles }))).toBe(true)
    } finally {
        ;(await client.shutdown())._unsafeUnwrap()
    }
})

test("returns exact input errors for malformed, cross-guild, and incomplete snapshots", async () => {
    expectInputError(compareHierarchy(role("100", 2), role("101", 2, "21")), "hierarchy.compare")
    expectInputError(isAboveInHierarchy(role("100", 2), role("101", 2, "21")), "hierarchy.isAbove")

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
        expectInputError(canManageHierarchy(snapshot as RoleHierarchyInput), "hierarchy.canManage")

    const native = canManageNativeHierarchy({ ...input(), roles: [role("100", 2)] })
    const nativeResult = await Effect.runPromise(Effect.result(native))
    expect(nativeResult._tag).toBe("Failure")
    if (nativeResult._tag === "Failure")
        expectInputError({ isErr: () => true, error: nativeResult.failure }, "hierarchy.canManage")
})

test("defers native snapshot validation until the Effect runs", async () => {
    let accessed = 0
    const lazyRole = {
        ...role("100", 2),
        get guildId() {
            accessed += 1
            return "20"
        },
    }
    const comparison = compareNativeHierarchy(lazyRole, role("101", 1))
    expect(accessed).toBe(0)
    expect(await Effect.runPromise(comparison)).toBe(1)
    expect(accessed).toBeGreaterThan(0)
})

test.each(["default", "native"] as const)(
    "%s fetchHierarchyCheck reads four fresh inputs concurrently without cache authority",
    async (mode) => {
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
            if (path.endsWith("/roles"))
                return Response.json([wireRole("20", 0), wireRole("100", 2), wireRole("101", 1)])
            throw Error(`Unexpected request ${path}`)
        }
        const run = async () => {
            if (mode === "default") {
                const client = value(createClient({ token: "fixture" }))
                try {
                    return value(await client.members.fetchHierarchyCheck({ guildId: "20", userId: "3" }))
                } finally {
                    value(await client.shutdown())
                }
            }
            return Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const client = yield* createNative({ token: "fixture" })
                        return yield* client.members.fetchHierarchyCheck({ guildId: "20", userId: "3" })
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
    },
)

test.each(["default", "native"] as const)(
    "%s fetchHierarchyCheck keeps a mapped remote failure with a sibling response-cleanup defect",
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
            const client = value(createClient({ token: "fixture" }))
            try {
                const result = Promise.resolve(client.members.fetchHierarchyCheck({ guildId: "20", userId: "3" }))
                await started
                releaseGuild(new Response(null, { status: 401 }))
                await siblingAborted
                releaseSibling(responseWithCleanupFailure(200, cleanup))
                await expect(result).rejects.toMatchObject({
                    name: "SdkDefect",
                    operation: "members.fetchHierarchyCheck",
                    reasons: expect.arrayContaining([
                        {
                            kind: "Failure",
                            failure: expect.objectContaining({
                                _tag: "GuildOperationError",
                                operation: "members.fetchHierarchyCheck",
                                status: 401,
                            }),
                        },
                        { kind: "Defect" },
                    ]),
                } satisfies Partial<SdkDefect>)
            } finally {
                value(await client.shutdown())
            }
        } else {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
            try {
                const result = Effect.runPromiseExit(client.members.fetchHierarchyCheck({ guildId: "20", userId: "3" }))
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
                                    operation: "members.fetchHierarchyCheck",
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
