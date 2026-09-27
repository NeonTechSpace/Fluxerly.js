import { err } from "neverthrow"
import { afterEach, expect, test, vi } from "vitest"
import {
    commandArgumentMetadata,
    convertCommandArguments,
    snapshotCommandArguments,
} from "../../../src/internal/command-arguments.js"
import type { CommandArgumentDescriptor } from "../../../src/command-arguments.js"
import { ConfigurationError } from "../../../src/errors.js"

afterEach(() => {
    vi.unstubAllGlobals()
})

test("ID arguments return raw IDs and only their selected anchored mention kind without resource reads", () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const schema = snapshotCommandArguments({
        user: { type: "id", mention: "user" },
        channel: { type: "id", mention: "channel" },
        role: { type: "id", mention: "role" },
    } as const)

    expect(commandArgumentMetadata(schema)).toEqual([
        { name: "user", type: "id", optional: false, rest: false, mention: "user" },
        { name: "channel", type: "id", optional: false, rest: false, mention: "channel" },
        { name: "role", type: "id", optional: false, rest: false, mention: "role" },
    ])
    expect(convertCommandArguments(schema, ["1", "20", "9223372036854775807"])).toEqual({
        _tag: "Converted",
        values: { user: "1", channel: "20", role: "9223372036854775807" },
    })
    expect(convertCommandArguments(schema, ["<@!10>", "<#20>", "<@&30>"])).toEqual({
        _tag: "Converted",
        values: { user: "10", channel: "20", role: "30" },
    })
    expect(convertCommandArguments(schema, ["<@10>", "20", "30"])).toEqual({
        _tag: "Converted",
        values: { user: "10", channel: "20", role: "30" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test("ID conversion rejects other mention kinds, malformed or out-of-range IDs and unanchored mentions", () => {
    const schema = snapshotCommandArguments({ target: { type: "id", mention: "user" } } as const)

    for (const raw of [
        "<#10>",
        "<@&10>",
        "prefix<@10>",
        "<@10>suffix",
        "<@>",
        "01",
        "1.0",
        "0",
        "<@0>",
        "9223372036854775808",
        "<@9223372036854775808>",
        "123456789012345678901",
        "<@123456789012345678901>",
    ])
        expect(convertCommandArguments(schema, [raw])).toEqual({
            _tag: "Rejected",
            argument: "target",
            reason: "Invalid",
        })
    const memberMention = () => snapshotCommandArguments({ target: { type: "id", mention: "member" } } as never)
    expect(memberMention).toThrow(ConfigurationError)
    expect(memberMention).toThrow(expect.objectContaining({ field: "command" }))
})

test.each(["userChoice", "channelChoice", "roleChoice"] as const)(
    "%s numeric resource selection prefers IDs and falls back only for plain tokens",
    (type) => {
        const mention = type === "userChoice" ? "<@20>" : type === "channelChoice" ? "<#20>" : "<@&20>"
        const candidates = [
            { id: "10", name: "identified", username: "identified" },
            { id: "1", name: "10", username: "10" },
            { id: "2", name: "20", username: "20" },
            { id: "3", name: "30", username: "30" },
            { id: "4", name: "30", username: "30" },
            { id: "5", name: mention, username: mention },
        ]
        const descriptor: CommandArgumentDescriptor = { type, candidates }
        const schema = snapshotCommandArguments({ target: descriptor })
        for (const [raw, id] of [
            ["10", "10"],
            ["20", "2"],
        ] as const)
            expect(convertCommandArguments(schema, [raw])).toMatchObject({
                _tag: "Converted",
                values: { target: { id } },
            })
        expect(convertCommandArguments(schema, ["30"])).toEqual({
            _tag: "Rejected",
            argument: "target",
            reason: "Ambiguous",
        })
        expect(convertCommandArguments(schema, [mention])).toEqual({
            _tag: "Rejected",
            argument: "target",
            reason: "Invalid",
        })
        candidates.push({ id: "10", name: "duplicate", username: "duplicate" })
        const duplicateIds = snapshotCommandArguments({ target: descriptor })
        expect(convertCommandArguments(duplicateIds, ["10"])).toEqual({
            _tag: "Rejected",
            argument: "target",
            reason: "Ambiguous",
        })
    },
)

test("numeric bounds reject values outside min and max, and a default fills only an omitted token", () => {
    const schema = snapshotCommandArguments({
        count: { type: "integer", min: 1, max: 10 },
        ratio: { type: "number", min: -0.5, max: 0.5, default: 0.25 },
        sides: { type: "integer", min: 2, default: 6 },
    })
    expect(convertCommandArguments(schema, ["1"])).toEqual({
        _tag: "Converted",
        values: { count: 1, ratio: 0.25, sides: 6 },
    })
    expect(convertCommandArguments(schema, ["10", "-0.5", "2"])).toEqual({
        _tag: "Converted",
        values: { count: 10, ratio: -0.5, sides: 2 },
    })
    for (const [args, argument] of [
        [["0"], "count"],
        [["11"], "count"],
        [["5", "0.75"], "ratio"],
        [["5", "0", "1"], "sides"],
    ] as const)
        expect(convertCommandArguments(schema, args)).toEqual({ _tag: "Rejected", argument, reason: "Invalid" })
    expect(convertCommandArguments(schema, [])).toEqual({ _tag: "Rejected", argument: "count", reason: "Missing" })
})

test.each([
    ["90s", 90_000],
    ["5m", 300_000],
    ["1h30m", 5_400_000],
    ["2d", 172_800_000],
    ["500ms", 500],
    ["1w", 604_800_000],
    ["1m500ms", 60_500],
])("duration %s converts to %i milliseconds", (raw, milliseconds) => {
    const schema = snapshotCommandArguments({ wait: { type: "duration" } })
    expect(convertCommandArguments(schema, [raw])).toEqual({ _tag: "Converted", values: { wait: milliseconds } })
})

test("durations reject bare numbers, unknown units, unordered parts and values outside their bounds", () => {
    const schema = snapshotCommandArguments({ wait: { type: "duration", min: 1_000, max: 3_600_000 } })
    for (const raw of ["10", "5x", "m5", "30m1h", "1.5h", "-5m", "5 m", "1H", "2h"])
        expect(convertCommandArguments(schema, [raw])).toEqual({
            _tag: "Rejected",
            argument: "wait",
            reason: "Invalid",
        })
    expect(convertCommandArguments(schema, ["999ms"])).toEqual({
        _tag: "Rejected",
        argument: "wait",
        reason: "Invalid",
    })
    expect(convertCommandArguments(schema, ["1h"])).toEqual({ _tag: "Converted", values: { wait: 3_600_000 } })
    const defaulted = snapshotCommandArguments({ wait: { type: "duration", default: 60_000 } })
    expect(convertCommandArguments(defaulted, [])).toEqual({ _tag: "Converted", values: { wait: 60_000 } })
})

test("a wholeSeconds duration rejects a millisecond part and appears in help metadata", () => {
    const schema = snapshotCommandArguments({ length: { type: "duration", wholeSeconds: true, max: 63_072_000_000 } })
    for (const raw of ["1m500ms", "500ms", "200w"])
        expect(convertCommandArguments(schema, [raw])).toEqual({
            _tag: "Rejected",
            argument: "length",
            reason: "Invalid",
        })
    expect(convertCommandArguments(schema, ["1m30s"])).toEqual({ _tag: "Converted", values: { length: 90_000 } })
    expect(commandArgumentMetadata(schema)).toEqual([
        { name: "length", type: "duration", optional: false, rest: false, max: 63_072_000_000, wholeSeconds: true },
    ])
    for (const descriptor of [
        { type: "duration", wholeSeconds: false },
        { type: "duration", wholeSeconds: true, default: 1_500 },
        { type: "integer", wholeSeconds: true },
    ])
        expect(() => snapshotCommandArguments({ length: descriptor as CommandArgumentDescriptor })).toThrow(
            ConfigurationError,
        )
})

test("member arguments accept a user mention or ID in the message's guild and reject them elsewhere", () => {
    const schema = snapshotCommandArguments({ target: { type: "member" } })
    for (const raw of ["<@31>", "<@!31>", "31"])
        expect(convertCommandArguments(schema, [raw], { guildId: "40" })).toEqual({
            _tag: "Converted",
            values: { target: { guildId: "40", userId: "31" } },
        })
    expect(convertCommandArguments(schema, ["<@!9223372036854775807>"], { guildId: "40" })).toEqual({
        _tag: "Converted",
        values: { target: { guildId: "40", userId: "9223372036854775807" } },
    })
    for (const raw of [
        "<#31>",
        "<@&31>",
        "0",
        "<@0>",
        "01",
        "name",
        "<@31>x",
        "9223372036854775808",
        "<@!123456789012345678901>",
    ])
        expect(convertCommandArguments(schema, [raw], { guildId: "40" })).toEqual({
            _tag: "Rejected",
            argument: "target",
            reason: "Invalid",
        })
    expect(convertCommandArguments(schema, ["31"], {})).toEqual({
        _tag: "Rejected",
        argument: "target",
        reason: "Invalid",
    })
})

test("custom arguments use their parse result, reject undefined and pass remaining tokens with rest", () => {
    const hex = (token: string) => (/^#[0-9a-f]{6}$/i.test(token) ? Number.parseInt(token.slice(1), 16) : undefined)
    const schema = snapshotCommandArguments({
        color: { type: "custom", parse: hex, expected: "a hex color such as #ff8800" },
        label: { type: "custom", parse: (token: string) => token.toUpperCase(), rest: true, optional: true },
    })
    expect(convertCommandArguments(schema, ["#ff8800", "two", "words"])).toEqual({
        _tag: "Converted",
        values: { color: 0xff8800, label: "TWO WORDS" },
    })
    expect(convertCommandArguments(schema, ["#ff8800"])).toEqual({
        _tag: "Converted",
        values: { color: 0xff8800, label: undefined },
    })
    expect(convertCommandArguments(schema, ["orange"])).toEqual({
        _tag: "Rejected",
        argument: "color",
        reason: "Invalid",
    })
    const failure = new Error("parse failed")
    const throwing = snapshotCommandArguments({
        value: {
            type: "custom",
            parse: () => {
                throw failure
            },
        },
    })
    // A throwing parse is a command failure, not a rejection, so the dispatcher reports it
    expect(() => convertCommandArguments(throwing, ["token"])).toThrow(failure)
    // A returned Err is thrown the same way, and an asynchronous result is misuse rather than a stored value
    const returningErr = snapshotCommandArguments({ value: { type: "custom", parse: () => err(failure) } })
    expect(() => convertCommandArguments(returningErr, ["token"])).toThrow(failure)
    const asynchronous = snapshotCommandArguments({ value: { type: "custom", parse: async () => 1 } })
    expect(() => convertCommandArguments(asynchronous, ["token"])).toThrow(ConfigurationError)
})

test("argument metadata describes bounds, defaults and custom expectations without parse functions", () => {
    const schema = snapshotCommandArguments({
        count: { type: "integer", min: 1, max: 10 },
        color: { type: "custom", parse: () => 1, expected: "a hex color" },
        wait: { type: "duration", default: 60_000 },
        target: { type: "member", optional: true },
    })
    expect(commandArgumentMetadata(schema)).toEqual([
        { name: "count", type: "integer", optional: false, rest: false, min: 1, max: 10 },
        { name: "color", type: "custom", optional: false, rest: false, expected: "a hex color" },
        { name: "wait", type: "duration", optional: true, rest: false, default: 60_000 },
        { name: "target", type: "member", optional: true, rest: false },
    ])
})

test("argument descriptors with contradictory bounds, defaults or custom settings are configuration errors", () => {
    const invalid: unknown[] = [
        { type: "integer", default: 3, optional: true },
        { type: "integer", min: 5, max: 1 },
        { type: "integer", min: 1.5 },
        { type: "number", max: Number.POSITIVE_INFINITY },
        { type: "duration", default: 500, min: 1_000 },
        { type: "duration", min: 0.5 },
        { type: "member", min: 1 },
        { type: "custom" },
        { type: "custom", parse: () => 1, expected: "" },
        { type: "text", default: 1 },
    ]
    for (const descriptor of invalid)
        expect(() => snapshotCommandArguments({ value: descriptor } as never)).toThrow(ConfigurationError)
    expect(() =>
        snapshotCommandArguments({ first: { type: "integer", default: 1 }, second: { type: "integer" } }),
    ).toThrow(ConfigurationError)
})
