import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { createGuildTestRole, cleanupGuildTestRole } from "./live/guild-fixture.mjs"
import { createReactionEmoji, cleanupReactionEmoji } from "./live/reaction-fixture.mjs"
import { createGuildChannelFixture, cleanupGuildChannelFixtures } from "./live/channel-fixture.mjs"

const source = readFileSync(new URL("./live/messages.js", import.meta.url), "utf8")
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const cleanupStart = source.indexOf("async function cleanup() {")
const cleanupEnd = source.indexOf("async function verifyModeration(", cleanupStart)
assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart)
const mainCleanup = new AsyncFunction(
    "context",
    `with (context) { ${source.slice(cleanupStart, cleanupEnd)} return cleanup() }`,
)
const creationStart = source.indexOf("    journal = { guildId, name: `fluxerly-sdk-test-")
const creationEnd = source.indexOf("    let typingCacheTarget", creationStart)
assert.ok(creationStart >= 0 && creationEnd > creationStart)
const mainCreate = new AsyncFunction("context", `with (context) { ${source.slice(creationStart, creationEnd)} }`)

const owners = [
    {
        name: "main channel",
        create: (state) => mainCreate(state.context),
        cleanup: (state) => mainCleanup(state.context),
        id: (journal) => journal.channelId,
        marker: (journal) => journal.name,
        remote: (name) => ({ id: "45", name, guild_id: "20", type: 0 }),
    },
    {
        name: "role",
        create: (state) => createGuildTestRole(state.api, state.context.journal, state.save),
        cleanup: (state) => cleanupGuildTestRole(state.api, state.context.journal, state.save),
        id: (journal) => journal.roleId,
        marker: (journal) => journal.roleName,
        remote: (name) => ({ id: "45", name, permissions: "0" }),
    },
    {
        name: "nested second role",
        create: (state) => {
            state.context.journal.secondRole = { guildId: "20" }
            return createGuildTestRole(state.api, state.context.journal.secondRole, state.save)
        },
        cleanup: (state) => cleanupGuildTestRole(state.api, state.context.journal, state.save),
        id: (journal) => journal.secondRole.roleId,
        marker: (journal) => journal.secondRole.roleName,
        remote: (name) => ({ id: "45", name, permissions: "0" }),
    },
    {
        name: "emoji",
        create: (state) => createReactionEmoji(state.api, state.context.journal, state.save, "30"),
        cleanup: (state) => cleanupReactionEmoji(state.api, state.context.journal, state.save),
        id: (journal) => journal.emojiId,
        marker: (journal) => journal.emojiName,
        remote: (name) => ({ id: "45", name, user: { id: "30" } }),
    },
    {
        name: "channel fixture",
        create: (state) =>
            createGuildChannelFixture(state.context.journal, state.save, "explicitChild", { type: 0 }, (input) =>
                state.api("POST", "/guilds/20/channels", input),
            ),
        cleanup: (state) => cleanupGuildChannelFixtures(state.api, state.context.journal, state.save),
        id: (journal) => journal.channelFixtures.explicitChild.id,
        marker: (journal) => journal.channelFixtures.explicitChild.marker,
        remote: (name) => ({ id: "45", name, guild_id: "20", type: 0 }),
    },
]

function fixture(owner) {
    const lostCreate = new Error("fixture lost create response")
    const lostDelete = new Error("fixture lost delete response")
    const saveFailure = new Error("fixture journal save failure")
    const state = {
        durable: "",
        items: [],
        deletes: 0,
        loseDelete: false,
        failSave: false,
        unlinked: false,
        context: { journal: { guildId: "20" } },
    }
    state.save = () => {
        if (state.failSave) throw saveFailure
        state.durable = JSON.stringify(state.context.journal)
    }
    state.api = async (method, path, input) => {
        if (method === "POST") {
            expect(owner.marker(JSON.parse(state.durable))).toBe(input.name)
            state.items = [owner.remote(input.name)]
            throw lostCreate
        }
        if (method === "DELETE") {
            expect(owner.id(JSON.parse(state.durable))).toBe("45")
            state.deletes++
            state.items = []
            if (state.loseDelete) throw lostDelete
            return { status: 204, data: null }
        }
        expect(method).toBe("GET")
        if (path.startsWith("/channels/")) {
            const found = state.items.find((item) => item.id === path.split("/").at(-1))
            return { status: found ? 200 : 404, data: found ?? null }
        }
        return { status: 200, data: state.items }
    }
    Object.assign(state.context, {
        api: state.api,
        assert,
        cleanupModeration: async () => undefined,
        cleanupReactionEmoji,
        cleanupGuildTestRole,
        cleanupGuildChannelFixtures,
        guildId: "20",
        journalPath: "fixture journal",
        moderationUserId: undefined,
        randomUUID: () => "a".repeat(32),
        report: () => undefined,
        stage: "fixture",
        unlinkSync: () => {
            state.unlinked = true
        },
        writeFileSync: () => state.save(),
    })
    return { state, lostCreate, lostDelete, saveFailure }
}

test.each(owners)("$name persists marker-resolved identity across lost create and cleanup responses", async (owner) => {
    const { state, lostCreate, lostDelete } = fixture(owner)
    await expect(owner.create(state)).rejects.toBe(lostCreate)
    expect(owner.id(JSON.parse(state.durable))).toBeUndefined()
    state.context.journal = JSON.parse(state.durable)
    state.loseDelete = true
    await expect(owner.cleanup(state)).rejects.toBe(lostDelete)
    expect(owner.id(JSON.parse(state.durable))).toBe("45")
    expect(state.items).toEqual([])
    state.context.journal = JSON.parse(state.durable)
    await owner.cleanup(state)
    expect(state.deletes).toBe(1)
    if (owner.name === "main channel") expect(state.unlinked).toBe(true)
})

test.each(owners)("$name does not DELETE when saving the resolved ID fails", async (owner) => {
    const { state, lostCreate, saveFailure } = fixture(owner)
    await expect(owner.create(state)).rejects.toBe(lostCreate)
    state.context.journal = JSON.parse(state.durable)
    state.failSave = true
    await expect(owner.cleanup(state)).rejects.toBe(saveFailure)
    expect(state.deletes).toBe(0)
    expect(owner.id(JSON.parse(state.durable))).toBeUndefined()
    expect(state.items).toHaveLength(1)
})

test.each(owners)("$name retains absent or ambiguous ID-less ownership intent", async (owner) => {
    const { state, lostCreate } = fixture(owner)
    await expect(owner.create(state)).rejects.toBe(lostCreate)
    const owned = state.items[0]
    for (const items of [[], [owned, { ...owned, id: "46" }]]) {
        state.context.journal = JSON.parse(state.durable)
        state.items = items
        await expect(owner.cleanup(state)).rejects.toBeDefined()
        expect(state.deletes).toBe(0)
        expect(owner.id(JSON.parse(state.durable))).toBeUndefined()
    }
})

test.each(owners)("$name rejects changed ownership before saving or deleting", async (owner) => {
    const { state, lostCreate } = fixture(owner)
    await expect(owner.create(state)).rejects.toBe(lostCreate)
    const item = state.items[0]
    if (item.user) item.user.id = "31"
    else if ("permissions" in item) item.permissions = "8"
    else item.guild_id = "21"
    state.context.journal = JSON.parse(state.durable)
    await expect(owner.cleanup(state)).rejects.toBeDefined()
    expect(state.deletes).toBe(0)
    expect(owner.id(JSON.parse(state.durable))).toBeUndefined()
})

const defaultStart = source.indexOf("        client = created.value")
const defaultEnd = source.indexOf(
    "    } else {\n        const { Deferred, Effect, Exit, Fiber, Scope, Stream }",
    defaultStart,
)
assert.ok(defaultStart >= 0 && defaultEnd > defaultStart)
const runDefault = new AsyncFunction("context", `with (context) { ${source.slice(defaultStart, defaultEnd)} }`)

test.each(["nonce", "observer"])(
    "default %s failure immediately after acquisition shuts down the client",
    async (failurePoint) => {
        const failure = new Error("fixture acquisition-adjacent failure")
        const events = []
        const client = {
            messages: {},
            observeState: () => {
                throw failure
            },
            shutdown: async () => {
                events.push("shutdown")
                return { isErr: () => false, isOk: () => true }
            },
        }
        const context = {
            assert,
            created: { value: client },
            client: undefined,
            channel: { id: "45" },
            cache: false,
            typing: false,
            search: false,
            nonceOnly: failurePoint === "nonce",
            forceRecovery: failurePoint === "observer",
            states: [],
            quiescent: true,
            clearTimeout: () => events.push("clear_timer"),
            verifyNonce: async () => {
                throw failure
            },
        }
        await expect(runDefault(context)).rejects.toBe(failure)
        expect(events).toEqual(["clear_timer", "shutdown"])
        expect(context.quiescent).toBe(true)
        client.shutdown = async () => {
            events.push("shutdown")
            throw new Error("fixture shutdown failure")
        }
        await expect(runDefault(context)).rejects.toThrow("fixture shutdown failure")
        expect(context.quiescent).toBe(false)
    },
)
