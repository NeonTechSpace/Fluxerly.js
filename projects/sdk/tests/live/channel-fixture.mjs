import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

const markerPattern = /^fluxerly-sdk-channel-[a-f0-9]{32}$/
const testChannelPattern = /^fluxerly-sdk-test-[a-f0-9]{32}$/
const fixtureKeys = new Set(["categoryA", "categoryB", "inheritedChild", "explicitChild", "voiceTier"])

const markerMatches = (entry, channel) =>
    typeof channel?.name === "string" && (channel.name === entry.name || channel.name.startsWith(`${entry.marker}-`))

/** Persist one unique marker before dispatch. A later cleanup resolves that marker rather than retrying an uncertain POST */
export async function createGuildChannelFixture(journal, save, key, input, create) {
    assert.ok(fixtureKeys.has(key))
    assert.equal(journal.channelFixtures?.[key], undefined)
    const marker = `fluxerly-sdk-channel-${randomUUID().replaceAll("-", "")}`
    const entry = { marker, name: marker, type: input.type }
    journal.channelFixtures ??= {}
    journal.channelFixtures[key] = entry
    save()

    const created = await create({ ...input, name: entry.name })
    assert.match(created?.id ?? "", /^\d+$/)
    assert.equal(created.guildId, journal.guildId)
    assert.equal(created.type, entry.type)
    assert.equal(created.name, entry.name)
    entry.id = created.id
    save()
    return created
}

/** Delete only journaled channels that still match their unique markers. Missing ID-less intent remains fail-closed */
export async function cleanupGuildChannelFixtures(api, journal, save) {
    if (journal.channelFixtures === undefined) return
    assert.match(journal.guildId ?? "", /^\d+$/)
    assert.ok(journal.channelFixtures && typeof journal.channelFixtures === "object")

    const fixtures = Object.entries(journal.channelFixtures)
    assert.ok(fixtures.length > 0 && fixtures.every(([key]) => fixtureKeys.has(key)))
    for (const [, entry] of fixtures) {
        assert.ok(entry && typeof entry === "object")
        assert.match(entry.marker ?? "", markerPattern)
        assert.equal(entry.name, entry.marker)
        assert.ok(Number.isInteger(entry.type))
        if (entry.id !== undefined) assert.match(entry.id, /^\d+$/)
    }

    const listed = await api("GET", `/guilds/${journal.guildId}/channels`)
    assert.ok(Array.isArray(listed.data))
    const ordered = [...fixtures].sort(([, left], [, right]) => Number(left.type === 4) - Number(right.type === 4))
    for (const [, entry] of ordered) {
        const matches = listed.data.filter((channel) => channel.type === entry.type && markerMatches(entry, channel))
        assert.ok(matches.length <= 1)
        if (matches.length === 0) {
            // An interrupted POST with no returned ID cannot be safely declared absent from this one list observation
            assert.match(entry.id ?? "", /^\d+$/)
            assert.equal((await api("GET", `/channels/${entry.id}`)).status, 404)
            continue
        }
        const channel = matches[0]
        assert.match(channel.id ?? "", /^\d+$/)
        assert.equal(channel.guild_id, journal.guildId)
        if (entry.id !== undefined) assert.equal(channel.id, entry.id)
        const current = await api("GET", `/channels/${channel.id}`)
        assert.equal(current.status, 200)
        assert.equal(current.data?.guild_id, journal.guildId)
        assert.equal(current.data?.type, entry.type)
        assert.ok(markerMatches(entry, current.data ?? {}))
        if (entry.type === 4) {
            // A fresh read detects any user-created or uncleaned child before category deletion
            const beforeCategoryDelete = await api("GET", `/guilds/${journal.guildId}/channels`)
            assert.ok(Array.isArray(beforeCategoryDelete.data))
            assert.ok(
                beforeCategoryDelete.data.some(
                    (item) => item.id === channel.id && item.type === entry.type && markerMatches(entry, item),
                ),
            )
            assert.ok(!beforeCategoryDelete.data.some((item) => item.parent_id === channel.id))
        }
        entry.id = channel.id
        await save()
        assert.equal((await api("DELETE", `/channels/${channel.id}`)).status, 204)
        assert.equal((await api("GET", `/channels/${channel.id}`)).status, 404)
    }

    const after = await api("GET", `/guilds/${journal.guildId}/channels`)
    assert.ok(
        Array.isArray(after.data) &&
            fixtures.every(
                ([, entry]) =>
                    !after.data.some((channel) => channel.type === entry.type && markerMatches(entry, channel)),
            ),
    )
}

/**
 * Journals the main test channel's unique name through `create` before dispatch, then records the returned ID through
 * `save`. Cleanup reconciles a lost response through that name, never through another POST
 */
export async function createMainTestChannel(api, journal, { create, save }) {
    assert.equal(journal.name, undefined)
    journal.name = `fluxerly-sdk-test-${randomUUID().replaceAll("-", "")}`
    create()
    const channel = (await api("POST", `/guilds/${journal.guildId}/channels`, { name: journal.name, type: 0 })).data
    assert.match(channel?.id ?? "", /^\d+$/)
    assert.equal(channel.guild_id, journal.guildId)
    assert.equal(channel.name, journal.name)
    journal.channelId = channel.id
    save()
    return channel
}

/**
 * Deletes the main test channel only while it matches the journaled server, type, unique name and any returned ID.
 * Without a returned ID, exactly one listed channel must carry the name, so absent or ambiguous intent fails closed
 */
export async function cleanupMainTestChannel(api, journal, save) {
    const { guildId } = journal
    assert.match(guildId ?? "", /^\d+$/)
    assert.match(journal.name ?? "", testChannelPattern)
    const listed = await api("GET", `/guilds/${guildId}/channels`)
    assert.ok(Array.isArray(listed.data))
    // A returned ID is authoritative. Marker lookup is only safe while creation never returned an ID
    const matches =
        journal.channelId === undefined ? listed.data.filter((channel) => channel.name === journal.name) : []
    assert.ok(matches.length <= 1)
    let channel = matches[0]
    if (journal.channelId !== undefined) {
        const recorded = await api("GET", `/channels/${journal.channelId}`)
        if (recorded.status !== 404) channel = recorded.data
    }
    if (journal.channelId === undefined) assert.ok(channel, "Unresolved channel creation retains its journal")
    if (channel) {
        assert.match(channel.id, /^\d+$/)
        if (journal.channelId !== undefined) assert.equal(channel.id, journal.channelId)
        assert.equal(channel.guild_id, guildId)
        assert.equal(channel.type, 0)
        assert.equal(channel.name, journal.name)
        const current = await api("GET", `/channels/${channel.id}`)
        assert.equal(current.data?.id, channel.id)
        assert.equal(current.data?.name, journal.name)
        assert.equal(current.data?.guild_id, guildId)
        journal.channelId = channel.id
        save()
        await api("DELETE", `/channels/${channel.id}`)
        assert.equal((await api("GET", `/channels/${channel.id}`)).status, 404)
    }
    const after = await api("GET", `/guilds/${guildId}/channels`)
    assert.ok(Array.isArray(after.data) && !after.data.some((channel) => channel.name === journal.name))
}
