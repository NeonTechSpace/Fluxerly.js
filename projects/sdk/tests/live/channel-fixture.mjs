import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

const markerPattern = /^fluxerly-sdk-channel-[a-f0-9]{32}$/
const fixtureKeys = new Set(["categoryA", "categoryB", "inheritedChild", "explicitChild"])

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
export async function cleanupGuildChannelFixtures(api, journal) {
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
