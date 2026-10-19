import { expect, test } from "vitest"
import { assertScrubbed, clockKey, createScrubber, knownKeys } from "./support/gateway-scrub.js"

const token = "synthetic-token-value"
const guildId = "123456789012345678"
const botId = "223456789012345678"
const payload = {
    id: "323456789012345678",
    guild_id: guildId,
    content: `hello ${token}`,
    timestamp: "2025-03-04T05:06:07.123456+00:00",
    edited_timestamp: null,
    tts: false,
    flags: 4,
    mentions: [
        { id: botId, username: "Synthetic Bot", avatar: "a_0123456789abcdef0123456789abcdef", discriminator: "4321" },
    ],
    roles: [guildId, "423456789012345678"],
    embeds: [{ type: "rich", url: "https://example.org/private/path", title: "Private title" }],
    position: 5,
    last_pin_timestamp: 1_760_000_000_123,
}

test("scrubbing keeps types, nesting and nullability and replaces every string", () => {
    const scrubber = createScrubber()
    const result = scrubber.scrub(payload)
    expect(Object.keys(result)).toEqual(Object.keys(payload))
    expect(result.edited_timestamp).toBeNull()
    expect(result).toMatchObject({ tts: false, flags: 4, position: 5 })
    expect(result.id).toMatch(/^[1-9][0-9]{18}$/)
    expect(result.timestamp).toMatch(/^2026-01-01T00:00:\d{2}\.000000\+00:00$/)
    expect(result.mentions[0].discriminator).toMatch(/^[0-9]{4}$/)
    expect(result.mentions[0].discriminator).not.toBe("4321")
    expect(result.mentions[0].avatar).toMatch(/^a_[0-9a-f]{32}$/)
    expect(result.embeds[0].url).toMatch(/^https:\/\/example\.invalid\//)
    expect(result.last_pin_timestamp).not.toBe(payload.last_pin_timestamp)
    expect(result.last_pin_timestamp).toBeGreaterThan(1e11)
    // The embed kind is protocol vocabulary and stays, everything else about the embed does not
    expect(result.embeds[0].type).toBe("rich")
    expect(JSON.stringify(result)).not.toMatch(/Private|example\.org|Synthetic/)
})

test("one original value always becomes the same placeholder, and different values never share one", () => {
    const result = createScrubber().scrub(payload)
    expect(result.guild_id).toBe(result.roles[0])
    expect(result.roles[1]).not.toBe(result.roles[0])
    expect(result.mentions[0].id).not.toBe(result.id)
    expect(createScrubber().scrub(payload)).toEqual(result)
})

test("a scrubbed result with no sensitive value passes the assertion", () => {
    const scrubber = createScrubber()
    const result = scrubber.scrub(payload)
    expect(() =>
        assertScrubbed(result, {
            secrets: [token, guildId, botId, "Synthetic Bot"],
            originals: scrubber.originals,
            kept: scrubber.kept,
        }),
    ).not.toThrow()
})

test("the assertion refuses a surviving secret or original without revealing it", () => {
    const scrubber = createScrubber()
    scrubber.scrub(payload)
    const options = { secrets: [token, guildId, botId, "Synthetic Bot"], originals: scrubber.originals }
    for (const leaked of [
        { value: `prefix ${token} suffix` },
        { value: { nested: [guildId] } },
        { mentions: [{ username: "Synthetic Bot" }] },
        { [botId]: "key" },
    ]) {
        let message = ""
        try {
            assertScrubbed(leaked, options)
        } catch (error) {
            message = String(error?.message)
        }
        expect(message).not.toBe("")
        for (const secret of options.secrets) expect(message).not.toContain(secret)
    }
    // An original that no rule replaced is refused even when it is not a listed secret
    expect(() => assertScrubbed({ title: "Private title" }, { secrets: [], originals: scrubber.originals })).toThrow()
    expect(() => assertScrubbed(payload, options)).toThrow()
})

test("the scrubber refuses field names and numbers it does not know instead of passing them", () => {
    const refused = (value) => {
        try {
            createScrubber().scrub(value)
        } catch (error) {
            return String(error?.message)
        }
        return ""
    }
    expect(refused({ id: "1", brand_new_field: "x" })).not.toBe("")
    // An identifier used as a key is refused without echoing it
    const keyed = refused({ roles: { [guildId]: "x" } })
    expect(keyed).not.toBe("")
    expect(keyed).not.toContain(guildId)
    // A large number outside a clock field could be an identifier
    expect(refused({ flags: 1_760_000_000_123 })).not.toBe("")
    expect(refused({ position: 1_760_000_000_123 })).not.toBe("")
    expect(knownKeys.has("brand_new_field")).toBe(false)
})

test("numbers outside the listed protocol fields are replaced and clock values stay distinct", () => {
    const scrubber = createScrubber()
    const result = scrubber.scrub({
        color: 5814783,
        flags: 16,
        rate_limit_per_user: 7,
        accent_color: 123456,
    })
    expect(result).toMatchObject({ color: 5814783, flags: 16, rate_limit_per_user: 7 })
    // Colors and flags are protocol fields. An account accent color is not listed, so it is replaced
    expect(result.accent_color).not.toBe(123456)
    const stamps = Array.from({ length: 130 }, (_, index) => `2025-03-04T05:06:07.${String(index).padStart(3, "0")}Z`)
    const scrubbed = createScrubber().scrub({ roles: stamps })
    expect(new Set(scrubbed.roles).size).toBe(130)
    const seconds = createScrubber().scrub({ timestamp: [1_760_000_001, 1_760_000_002, 1_760_000_001] })
    expect(seconds.timestamp[0]).toBe(seconds.timestamp[2])
    expect(seconds.timestamp[0]).not.toBe(seconds.timestamp[1])
    for (const key of ["timestamp", "last_timestamp_ms", "edited_at", "disabled_until", "timestamp_ms"])
        expect(clockKey.test(key)).toBe(true)
    expect(clockKey.test("flags")).toBe(false)
})

test("all-zero and short digit strings do not make the assertion refuse a correct result", () => {
    const scrubber = createScrubber()
    const result = scrubber.scrub({ discriminator: "0000", global_name: "0001", topic: "9" })
    expect(() => assertScrubbed(result, { secrets: [], originals: scrubber.originals })).not.toThrow()
    const distinct = createScrubber().scrub({ roles: ["12", "34"] })
    expect(distinct.roles[0]).not.toBe(distinct.roles[1])
})

test("account flags pass only for the bot's own account", () => {
    const other = { id: "523456789012345678", username: "Someone", flags: 4_194_304 }
    const bot = { id: botId, username: "Synthetic Bot", flags: 16 }
    const message = {
        flags: 4,
        author: other,
        mentions: [bot, other],
        member: { roles: [], user: other },
        referenced_message: { flags: 0, author: bot },
    }
    const result = createScrubber({ botId }).scrub(message)
    expect(result.author.flags).toBe(0)
    expect(result.mentions.map((user) => user.flags)).toEqual([16, 0])
    expect(result.member.user.flags).toBe(0)
    expect(result.referenced_message.author.flags).toBe(16)
    // A message's own flags describe the message, not an account
    expect(result.flags).toBe(4)
    // Without a bot, no account keeps its flags
    expect(createScrubber().scrub(message).referenced_message.author.flags).toBe(0)
})

test("flags survive only on the message, its referenced message and the bot's own objects", () => {
    const result = createScrubber({ botId }).scrub({
        flags: 4,
        member: { flags: 7, roles: [], user: { id: "523456789012345678", flags: 4_194_304 } },
        mentions: [
            { id: "523456789012345678", flags: 4_194_304 },
            { id: botId, flags: 16 },
        ],
        referenced_message: { flags: 2, author: { id: "523456789012345678", flags: 8 }, embeds: [{ flags: 3 }] },
        author: { flags: 5 },
    })
    expect(result.flags).toBe(4)
    expect(result.referenced_message.flags).toBe(2)
    expect(result.mentions.map((user) => user.flags)).toEqual([0, 16])
    // Sparse users without a username, member objects and any other nested object lose their flags
    expect(result.member.user.flags).toBe(0)
    expect(result.member.flags).toBe(0)
    expect(result.referenced_message.author.flags).toBe(0)
    expect(result.referenced_message.embeds[0].flags).toBe(0)
    expect(result.author.flags).toBe(0)
})
