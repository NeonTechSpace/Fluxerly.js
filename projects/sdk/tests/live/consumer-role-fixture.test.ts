import { expect, test } from "vitest"

type Api = (method: string, path: string, body?: { roles: string[] }) => Promise<{ status: number; data: unknown }>
// @ts-expect-error This live-test helper is runtime JavaScript, not part of the public SDK
const { restoreConsumerBotRoles } = (await import("./consumer-role-fixture.js")) as {
    restoreConsumerBotRoles: (
        api: Api,
        journal: Record<string, unknown>,
        guildId: string,
        botId: string,
    ) => Promise<void>
}
const journal = () => ({
    kind: "consumer-operations",
    guildId: "20",
    botId: "30",
    baselineRoleIds: ["40"],
    roleId: "50",
    roleName: `fluxerly-sdk-role-${"a".repeat(32)}`,
})

function fixture(
    options: {
        conflict?: "member" | "role" | "permissions" | "late"
        loseResponse?: boolean
        // The PATCH response reports the baseline, but later reads still return the pre-restoration roles
        staleAfterPatch?: boolean
    } = {},
) {
    let current = options.conflict === "member" ? ["40", "50", "60"] : ["40", "50"]
    let reads = 0
    const patches: string[][] = []
    const api: Api = async (method, path, body) => {
        if (method === "GET" && path === "/guilds/20/roles")
            return {
                status: 200,
                data: [
                    {
                        id: "50",
                        name: options.conflict === "role" ? "changed" : journal().roleName,
                        permissions: options.conflict === "permissions" ? "8" : "0",
                    },
                ],
            }
        if (path !== "/guilds/20/members/30") throw new Error("fixture unexpected request path")
        if (method === "PATCH") {
            const roles = [...body!.roles]
            patches.push(roles)
            if (!options.staleAfterPatch) current = roles
            if (options.loseResponse) throw new Error("Lost restoration response")
            return { status: 200, data: { user: { id: "30" }, roles } }
        }
        if (method !== "GET") throw new Error("fixture unexpected request method")
        if (++reads === 2 && options.conflict === "late") current = ["40", "50", "60"]
        return { status: 200, data: { user: { id: "30" }, roles: current } }
    }
    return { api, patches }
}

test("bot-role recovery restores the baseline once and reconciles a lost response without another PATCH", async () => {
    const { api, patches } = fixture({ loseResponse: true })
    await expect(restoreConsumerBotRoles(api, journal(), "20", "30")).rejects.toThrow("Lost restoration response")
    await restoreConsumerBotRoles(api, journal(), "20", "30")
    expect(patches).toEqual([["40"]])
})

test("bot-role recovery verifies the restored baseline by an independent read", async () => {
    const { api, patches } = fixture({ staleAfterPatch: true })
    await expect(restoreConsumerBotRoles(api, journal(), "20", "30")).rejects.toMatchObject({ code: "ERR_ASSERTION" })
    // The PATCH response matched the baseline, so only the read after it can refuse
    expect(patches).toEqual([["40"]])
})

test.each(["member", "role", "permissions", "late"] as const)(
    "bot-role recovery refuses a %s conflict",
    async (conflict) => {
        const { api, patches } = fixture({ conflict })
        await expect(restoreConsumerBotRoles(api, journal(), "20", "30")).rejects.toMatchObject({
            code: "ERR_ASSERTION",
        })
        expect(patches).toEqual([])
    },
)

test("bot-role recovery refuses a mismatched identity or corrupt baseline before HTTP", async () => {
    let calls = 0
    const api: Api = async () => {
        calls++
        throw new Error("Forbidden request")
    }
    await expect(restoreConsumerBotRoles(api, journal(), "21", "30")).rejects.toMatchObject({ code: "ERR_ASSERTION" })
    await expect(
        restoreConsumerBotRoles(api, { ...journal(), baselineRoleIds: undefined }, "20", "30"),
    ).rejects.toMatchObject({ code: "ERR_ASSERTION" })
    expect(calls).toBe(0)
})
