import { describe, expect, test } from "vitest"
import { InputValidationFailure } from "../../src/input-validation.js"
import { count, identifier, int32, nonNegativeInteger, snapshotArray } from "../../src/internal/decode/primitives.js"
import { timestamp } from "../../src/internal/decode/timestamp.js"
import { guildEdit } from "../../src/internal/guild-settings.js"
import { decodeMember } from "../../src/internal/guilds.js"
import { decodePinsUpdate, encodePinsQuery } from "../../src/internal/pins.js"

// Forms that the previous per-module grammars disagreed on: offsets, fractions longer than nine digits,
// a missing zone and missing seconds. Every timestamp boundary now shares one answer for each of them
const accepted = [
    "2024-02-29T12:00:00Z",
    "2024-01-01T00:00:00.123Z",
    "2024-01-01T00:00:00.1234567890123Z",
    "2024-01-01T00:00:00+05:30",
    "2024-01-01T00:00:00.5-08:00",
]
const rejected = [
    "2023-02-29T00:00:00Z",
    "2024-04-31T00:00:00+02:00",
    "2024-01-01T00:00:00",
    "2024-01-01T00:00Z",
    "2024-01-01 00:00:00Z",
    "2024-01-01T00:00:00+0530",
    "2024-01-01T00:00:00.Z",
    " 2024-01-01T00:00:00Z",
]

test("the timestamp grammar accepts seconds, any fraction and a Z or ±hh:mm offset on a real calendar day", () => {
    for (const value of accepted) expect(timestamp(value), value).toBe(true)
    for (const value of [...rejected, undefined, null, 0, new Date()])
        expect(timestamp(value), String(value)).toBe(false)
})

describe("timestamp boundaries share the grammar and preserve accepted values", () => {
    test("received member join times", () => {
        const member = (joinedAt: string) =>
            decodeMember({ user: { id: "10", username: "fixture" }, roles: [], joined_at: joinedAt }, "20")
        for (const value of accepted) expect(member(value)?.joinedAt, value).toBe(value)
        for (const value of rejected) expect(member(value), value).toBeUndefined()
    })

    test("received last-pin times", () => {
        const update = (value: string) => decodePinsUpdate({ channel_id: "30", last_pin_timestamp: value })
        for (const value of accepted) expect(update(value)?.lastPinTimestamp, value).toBe(value)
        for (const value of rejected) expect(update(value), value).toBeUndefined()
    })

    test("pin cursors", () => {
        for (const value of accepted) {
            const query = encodePinsQuery("30", { before: value })
            expect(query, value).not.toBeInstanceOf(InputValidationFailure)
            expect((query as Exclude<typeof query, InputValidationFailure>).params.get("before")).toBe(value)
        }
        for (const value of rejected)
            expect(encodePinsQuery("30", { before: value }), value).toBeInstanceOf(InputValidationFailure)
    })

    test("guild history cutoffs", () => {
        for (const value of accepted) {
            const request = guildEdit("20", { messageHistoryCutoff: value })
            expect(request, value).not.toBeInstanceOf(InputValidationFailure)
            const json = (request as Exclude<typeof request, InputValidationFailure>).json
            expect(JSON.parse(json!).message_history_cutoff).toBe(value)
        }
        for (const value of rejected)
            expect(guildEdit("20", { messageHistoryCutoff: value }), value).toBeInstanceOf(InputValidationFailure)
    })
})

describe("primitive decoders", () => {
    test("identifiers are decimal strings without leading zeros", () => {
        // Request IDs are bounded to the signed 63-bit range, but response IDs stay lexical so a longer provider ID still decodes
        expect(["0", "1", "18446744073709551615", "100000000000000000000"].every(identifier)).toBe(true)
        expect(["", "01", "-1", "1.0", " 1", 1].some(identifier)).toBe(false)
    })

    test("integer ranges accept only safe integers inside their bounds", () => {
        expect([0, 2_147_483_647].every(count)).toBe(true)
        expect([-1, 2_147_483_648, 1.5, "1"].some(count)).toBe(false)
        expect(int32(-2_147_483_648) && !int32(-2_147_483_649)).toBe(true)
        expect(nonNegativeInteger(3, 3) && !nonNegativeInteger(4, 3)).toBe(true)
        expect(nonNegativeInteger(Number.MAX_SAFE_INTEGER) && !nonNegativeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(
            true,
        )
    })

    test("array snapshots are frozen copies that later caller mutation cannot change", () => {
        const source = ["1", "2"]
        const copy = snapshotArray(source, 2)
        source.push("3")
        expect(copy).toEqual(["1", "2"])
        expect(Object.isFrozen(copy)).toBe(true)
        expect(snapshotArray(["1", "2", "3"], 2)).toBeUndefined()
        expect(snapshotArray("12", 2)).toBeUndefined()
    })
})
