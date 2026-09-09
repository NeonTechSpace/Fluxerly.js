import { expect, test } from "vitest"

type Fixture = {
    createGuildChannelFixture: (
        journal: Record<string, unknown>,
        save: () => void,
        key: string,
        input: { type: number },
        create: (input: { name: string; type: number }) => Promise<unknown>,
    ) => Promise<unknown>
    cleanupGuildChannelFixtures: (
        api: (method: string, path: string) => Promise<{ status: number; data: unknown }>,
        journal: Record<string, unknown>,
    ) => Promise<void>
}

// @ts-expect-error The live fixture is runtime-only JavaScript and deliberately has no public declaration
const fixture = (await import("./live/channel-fixture.mjs")) as Fixture

const marker = (character: string) => `fluxerly-sdk-channel-${character.repeat(32)}`
const channel = (id: string, name: string, type: number, parentId: string | null = null) => ({
    id,
    name,
    type,
    guild_id: "20",
    parent_id: parentId,
})

test("channel fixture records intent before create and reconciles a lost response by its marker", async () => {
    const journal: Record<string, any> = { guildId: "20" }
    const saved: Record<string, unknown>[] = []
    const lost = new Error("response lost after dispatch")
    let creates = 0
    await expect(
        fixture.createGuildChannelFixture(
            journal,
            () => saved.push(structuredClone(journal)),
            "categoryA",
            { type: 4 },
            async (input) => {
                creates++
                expect(saved).toHaveLength(1)
                expect(saved[0]).toMatchObject({
                    channelFixtures: { categoryA: { name: input.name, marker: input.name, type: 4 } },
                })
                throw lost
            },
        ),
    ).rejects.toBe(lost)
    expect(creates).toBe(1)
    expect(journal.channelFixtures.categoryA.id).toBeUndefined()

    const owned = channel("45", journal.channelFixtures.categoryA.marker, 4)
    let exists = true
    const deletes: string[] = []
    const api = async (method: string, path: string) => {
        if (method === "GET" && path === "/guilds/20/channels") return { status: 200, data: exists ? [owned] : [] }
        if (method === "GET" && path === "/channels/45")
            return { status: exists ? 200 : 404, data: exists ? owned : null }
        if (method === "DELETE" && path === "/channels/45") {
            exists = false
            deletes.push("45")
            return { status: 204, data: null }
        }
        throw new Error(`${method} ${path}`)
    }
    await fixture.cleanupGuildChannelFixtures(api, journal)
    expect(deletes).toEqual(["45"])
    expect(exists).toBe(false)
})

test("channel fixture never deletes a marker mismatch", async () => {
    const name = marker("b")
    const journal: Record<string, any> = {
        guildId: "20",
        channelFixtures: { categoryA: { marker: name, name, type: 4, id: "45" } },
    }
    let deletes = 0
    const api = async (method: string, path: string) => {
        if (method === "GET" && path === "/guilds/20/channels")
            return { status: 200, data: [channel("45", "someone-else", 4)] }
        if (method === "GET" && path === "/channels/45") return { status: 200, data: channel("45", "someone-else", 4) }
        if (method === "DELETE") deletes++
        return { status: 204, data: null }
    }
    await expect(fixture.cleanupGuildChannelFixtures(api, journal)).rejects.toBeDefined()
    expect(deletes).toBe(0)
})

test("channel fixture removes journaled children before a category and rechecks the category list", async () => {
    const categoryName = marker("c")
    const childName = marker("d")
    const journal: Record<string, any> = {
        guildId: "20",
        channelFixtures: {
            categoryA: { marker: categoryName, name: categoryName, type: 4, id: "4" },
            inheritedChild: { marker: childName, name: childName, type: 0, id: "5" },
        },
    }
    let items = [channel("4", categoryName, 4), channel("5", childName, 0, "4")]
    const calls: string[] = []
    const api = async (method: string, path: string) => {
        calls.push(`${method} ${path}`)
        if (method === "GET" && path === "/guilds/20/channels") return { status: 200, data: items }
        if (method === "GET" && path.startsWith("/channels/")) {
            const found = items.find((item) => item.id === path.slice("/channels/".length))
            return { status: found ? 200 : 404, data: found ?? null }
        }
        if (method === "DELETE" && path.startsWith("/channels/")) {
            const id = path.slice("/channels/".length)
            items = items.filter((item) => item.id !== id)
            return { status: 204, data: null }
        }
        throw new Error(`${method} ${path}`)
    }
    await fixture.cleanupGuildChannelFixtures(api, journal)
    const childDelete = calls.indexOf("DELETE /channels/5")
    const categoryDelete = calls.indexOf("DELETE /channels/4")
    expect(childDelete).toBeGreaterThanOrEqual(0)
    expect(categoryDelete).toBeGreaterThan(childDelete)
    expect(calls.slice(childDelete + 1, categoryDelete)).toContain("GET /guilds/20/channels")
    expect(items).toEqual([])
})

test("channel fixture fails closed when any child remains under a journaled category", async () => {
    const categoryName = marker("e")
    const journal: Record<string, any> = {
        guildId: "20",
        channelFixtures: { categoryA: { marker: categoryName, name: categoryName, type: 4, id: "4" } },
    }
    const items = [channel("4", categoryName, 4), channel("6", "user-child", 0, "4")]
    let deletes = 0
    const api = async (method: string, path: string) => {
        if (method === "GET" && path === "/guilds/20/channels") return { status: 200, data: items }
        if (method === "GET" && path === "/channels/4") return { status: 200, data: items[0] }
        if (method === "DELETE") deletes++
        return { status: 204, data: null }
    }
    await expect(fixture.cleanupGuildChannelFixtures(api, journal)).rejects.toBeDefined()
    expect(deletes).toBe(0)
})
