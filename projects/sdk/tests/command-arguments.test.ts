import { afterEach, expect, test, vi } from "vitest"
import {
    commandArgumentMetadata,
    convertCommandArguments,
    snapshotCommandArguments,
} from "../src/internal/command-arguments.js"
import type { CommandArgumentDescriptor } from "../src/command-arguments.js"

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
    expect(convertCommandArguments(schema, ["0", "20", "30"])).toEqual({
        _tag: "Converted",
        values: { user: "0", channel: "20", role: "30" },
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

test("ID mention conversion rejects other kinds, malformed IDs and unanchored mentions", () => {
    const schema = snapshotCommandArguments({ target: { type: "id", mention: "user" } } as const)

    for (const raw of ["<#10>", "<@&10>", "prefix<@10>", "<@10>suffix", "<@>", "01", "1.0"])
        expect(convertCommandArguments(schema, [raw])).toEqual({
            _tag: "Rejected",
            argument: "target",
            reason: "Invalid",
        })
    expect(() => snapshotCommandArguments({ target: { type: "id", mention: "member" } } as never)).toThrow(
        "mention must select user, channel or role when supplied",
    )
})

test.each(["user", "channel", "role"] as const)(
    "%s numeric resource selection prefers IDs and falls back only for plain tokens",
    (type) => {
        const mention = type === "user" ? "<@20>" : type === "channel" ? "<#20>" : "<@&20>"
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
