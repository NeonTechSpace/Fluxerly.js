import { expect, test } from "vitest"

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>
// @ts-expect-error The live fixture is runtime-only JavaScript, not a public module
const { cleanupModeration } = (await import("./live/moderation-fixture.mjs")) as {
    cleanupModeration: (api: Api, journal: unknown, authorizedUserId: string) => Promise<void>
}

function fixture() {
    const reason = "fluxerly-sdk-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-moderation"
    const journal = {
        guildId: "20",
        name: reason.replace(/-moderation$/, ""),
        moderation: { userId: "30", botId: "40", reason, timeoutUntil: "2026-09-09T02:00:00Z" },
    }
    const state = {
        ban: { user: { id: "30" }, reason, moderator_id: "40" } as
            { user: { id: string }; reason: string; moderator_id: string } | undefined,
        until: journal.moderation.timeoutUntil as string | null,
        writes: [] as string[],
        lost: false,
    }
    const api: Api = async (method, path) => {
        if (path === "/users/@me") return { status: 200, data: { id: "40" } }
        if (path === "/guilds/20") return { status: 200, data: { id: "20", owner_id: "50" } }
        if (path === "/guilds/20/bans") return { status: 200, data: state.ban ? [state.ban] : [] }
        if (method === "DELETE") {
            state.writes.push(path)
            state.ban = undefined
            if (state.lost) throw new Error("Test-owned loss")
            return { status: 204, data: null }
        }
        if (method === "PATCH") {
            state.writes.push(path)
            state.until = null
        }
        return { status: 200, data: { user: { id: "30" }, communication_disabled_until: state.until } }
    }
    return { journal, state, api }
}

test("moderation recovery verifies removal and reconciles an earlier lost cleanup response", async () => {
    const { journal, state, api } = fixture()
    state.lost = true
    await expect(cleanupModeration(api, journal, "30")).rejects.toThrow("Test-owned loss")
    state.lost = false
    await cleanupModeration(api, journal, "30")
    expect(state.ban).toBeUndefined()
    expect(state.until).toBeNull()
    expect(state.writes).toEqual(["/guilds/20/bans/30", "/guilds/20/members/30"])
})

test("moderation recovery refuses a different target, moderator or ban reason", async () => {
    for (const change of ["target", "moderator", "reason"] as const) {
        const { journal, state, api } = fixture()
        if (change === "moderator") state.ban!.moderator_id = "99"
        if (change === "reason") state.ban!.reason = "Unrelated moderation"
        await expect(cleanupModeration(api, journal, change === "target" ? "99" : "30")).rejects.toThrow()
        expect(state.writes).toEqual([])
    }
})

test("moderation recovery preserves a timeout changed by another moderator", async () => {
    const { journal, state, api } = fixture()
    state.ban = undefined
    state.until = "2026-09-10T02:00:00Z"
    await expect(cleanupModeration(api, journal, "30")).rejects.toThrow()
    expect(state.writes).toEqual([])
})
