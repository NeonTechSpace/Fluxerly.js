import { expect, test } from "vitest"
import { createGuildTestRole, cleanupGuildTestRole } from "./guild-fixture.mjs"
import { createReactionEmoji, cleanupReactionEmoji } from "./reaction-fixture.mjs"
import {
    cleanupGuildChannelFixtures,
    cleanupMainTestChannel,
    createGuildChannelFixture,
    createMainTestChannel,
} from "./channel-fixture.mjs"

const owners = [
    {
        name: "main channel",
        create: (state) => createMainTestChannel(state.api, state.journal, { create: state.save, save: state.save }),
        cleanup: (state) => cleanupMainTestChannel(state.api, state.journal, state.save),
        id: (journal) => journal.channelId,
        marker: (journal) => journal.name,
        remote: (name) => ({ id: "45", name, guild_id: "20", type: 0 }),
    },
    {
        name: "role",
        create: (state) => createGuildTestRole(state.api, state.journal, state.save),
        cleanup: (state) => cleanupGuildTestRole(state.api, state.journal, state.save),
        id: (journal) => journal.roleId,
        marker: (journal) => journal.roleName,
        remote: (name) => ({ id: "45", name, permissions: "0" }),
    },
    {
        name: "nested second role",
        create: (state) => {
            state.journal.secondRole = { guildId: "20" }
            return createGuildTestRole(state.api, state.journal.secondRole, state.save)
        },
        cleanup: (state) => cleanupGuildTestRole(state.api, state.journal, state.save),
        id: (journal) => journal.secondRole.roleId,
        marker: (journal) => journal.secondRole.roleName,
        remote: (name) => ({ id: "45", name, permissions: "0" }),
    },
    {
        name: "emoji",
        create: (state) => createReactionEmoji(state.api, state.journal, state.save, "30"),
        cleanup: (state) => cleanupReactionEmoji(state.api, state.journal, state.save),
        id: (journal) => journal.emojiId,
        marker: (journal) => journal.emojiName,
        remote: (name) => ({ id: "45", name, user: { id: "30" } }),
    },
    {
        name: "channel fixture",
        create: (state) =>
            createGuildChannelFixture(state.journal, state.save, "explicitChild", { type: 0 }, (input) =>
                state.api("POST", "/guilds/20/channels", input),
            ),
        cleanup: (state) => cleanupGuildChannelFixtures(state.api, state.journal, state.save),
        id: (journal) => journal.channelFixtures.explicitChild.id,
        marker: (journal) => journal.channelFixtures.explicitChild.marker,
        remote: (name) => ({ id: "45", name, guild_id: "20", type: 0 }),
    },
]

// A fake sandbox API that loses create responses after the resource exists and can lose delete responses. It records
// the durable journal at each POST and DELETE so tests can check that intent and resolved IDs were saved before dispatch
function fixture(owner) {
    const lostCreate = new Error("fixture lost create response")
    const lostDelete = new Error("fixture lost delete response")
    const saveFailure = new Error("fixture journal save failure")
    const state = {
        durable: "",
        items: [],
        posts: [],
        deletes: [],
        loseDelete: false,
        failSave: false,
        journal: { guildId: "20" },
    }
    state.save = () => {
        if (state.failSave) throw saveFailure
        state.durable = JSON.stringify(state.journal)
    }
    state.api = async (method, path, input) => {
        if (method === "POST") {
            state.posts.push({ name: input.name, durable: JSON.parse(state.durable) })
            state.items = [owner.remote(input.name)]
            throw lostCreate
        }
        if (method === "DELETE") {
            state.deletes.push(JSON.parse(state.durable))
            state.items = []
            if (state.loseDelete) throw lostDelete
            return { status: 204, data: null }
        }
        if (method !== "GET") throw new Error("fixture unexpected request method")
        if (path.startsWith("/channels/")) {
            const found = state.items.find((item) => item.id === path.split("/").at(-1))
            return { status: found ? 200 : 404, data: found ?? null }
        }
        return { status: 200, data: state.items }
    }
    return { state, lostCreate, lostDelete, saveFailure }
}

async function createWithLostResponse(owner, state, lostCreate) {
    await expect(owner.create(state)).rejects.toBe(lostCreate)
    // The unique marker was durable before the only POST
    expect(state.posts).toHaveLength(1)
    expect(owner.marker(state.posts[0].durable)).toBe(state.posts[0].name)
    expect(owner.id(JSON.parse(state.durable))).toBeUndefined()
    state.journal = JSON.parse(state.durable)
}

test.each(owners)("$name persists marker-resolved identity across lost create and cleanup responses", async (owner) => {
    const { state, lostCreate, lostDelete } = fixture(owner)
    await createWithLostResponse(owner, state, lostCreate)
    state.loseDelete = true
    await expect(owner.cleanup(state)).rejects.toBe(lostDelete)
    expect(owner.id(JSON.parse(state.durable))).toBe("45")
    expect(state.items).toEqual([])
    state.journal = JSON.parse(state.durable)
    await owner.cleanup(state)
    // The only DELETE followed a durable save of the marker-resolved ID, and the retry verified absence instead
    expect(state.deletes.map(owner.id)).toEqual(["45"])
})

test.each(owners)("$name does not DELETE when saving the resolved ID fails", async (owner) => {
    const { state, lostCreate, saveFailure } = fixture(owner)
    await createWithLostResponse(owner, state, lostCreate)
    state.failSave = true
    await expect(owner.cleanup(state)).rejects.toBe(saveFailure)
    expect(state.deletes).toEqual([])
    expect(owner.id(JSON.parse(state.durable))).toBeUndefined()
    expect(state.items).toHaveLength(1)
})

test.each(owners)("$name retains absent or ambiguous ID-less ownership intent", async (owner) => {
    const { state, lostCreate } = fixture(owner)
    await createWithLostResponse(owner, state, lostCreate)
    const owned = state.items[0]
    for (const items of [[], [owned, { ...owned, id: "46" }]]) {
        state.journal = JSON.parse(state.durable)
        state.items = items
        await expect(owner.cleanup(state)).rejects.toMatchObject({ code: "ERR_ASSERTION" })
        expect(state.deletes).toEqual([])
        expect(owner.id(JSON.parse(state.durable))).toBeUndefined()
    }
})

test.each(owners)("$name rejects changed ownership before saving or deleting", async (owner) => {
    const { state, lostCreate } = fixture(owner)
    await createWithLostResponse(owner, state, lostCreate)
    const item = state.items[0]
    if (item.user) item.user.id = "31"
    else if ("permissions" in item) item.permissions = "8"
    else item.guild_id = "21"
    await expect(owner.cleanup(state)).rejects.toMatchObject({ code: "ERR_ASSERTION" })
    expect(state.deletes).toEqual([])
    expect(owner.id(JSON.parse(state.durable))).toBeUndefined()
})
