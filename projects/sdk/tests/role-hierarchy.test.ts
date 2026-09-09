import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import {
    canManageHierarchy,
    compareHierarchy,
    createClient,
    isAboveInHierarchy,
    type RoleHierarchyInput,
} from "../src/index.js"
import {
    canManageHierarchy as canManageNativeHierarchy,
    compareHierarchy as compareNativeHierarchy,
    isAboveInHierarchy as isAboveNativeHierarchy,
} from "../src/effect.js"
import type { GuildOperationError } from "../src/guilds.js"

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

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

function value<A>(result: {
    readonly isOk: () => boolean
    readonly value?: A
    readonly error?: GuildOperationError
}): A {
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
    vi.stubGlobal("fetch", async (url: string) => {
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
