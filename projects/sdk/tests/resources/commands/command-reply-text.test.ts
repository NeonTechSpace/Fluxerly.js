import { expect, test } from "vitest"
import type { PrefixCommandMetadata } from "../../../src/index.js"
import { commandHelp, contextHelpOptions } from "../../../src/internal/command-help.js"
import { rejectionReply } from "../../../src/internal/commands.js"

const say = {
    name: "say",
    arguments: [{ name: "text", type: "text", rest: true }],
} as unknown as PrefixCommandMetadata

test("help and usage lines separate a bot mention prefix from the command name", () => {
    for (const mention of ["<@99>", "<@!99>"]) {
        expect(commandHelp([say], contextHelpOptions(undefined, mention))).toEqual([`${mention} say <text...>`])
        expect(
            rejectionReply({ _tag: "CommandArgumentRejected", argument: "text", reason: "Missing" }, say, mention, 0),
        ).toBe(`Missing text. Usage: ${mention} say <text...>`)
    }
    expect(commandHelp([say], contextHelpOptions(undefined, "!"))).toEqual(["!say <text...>"])
    expect(rejectionReply({ _tag: "CommandArgumentRejected", argument: "text", reason: "Missing" }, say, "!", 0)).toBe(
        "Missing text. Usage: !say <text...>",
    )
})

test("cooldown replies use seconds, minutes, then at most two units rounded up", () => {
    const reply = (seconds: number) =>
        rejectionReply({ _tag: "CommandCooldownActive", retryAtMs: seconds * 1_000 }, undefined, "!", 0)
    const expected: readonly [number, string][] = [
        [1, "1 second"],
        [60, "60 seconds"],
        [61, "2 minutes"],
        [120, "2 minutes"],
        [3_540, "59 minutes"],
        [3_600, "1 hour"],
        [3_601, "1 hour 1 minute"],
        [7_200, "2 hours"],
        [82_800, "23 hours"],
        [86_340, "23 hours 59 minutes"],
        [86_399, "1 day"],
        [86_400, "1 day"],
        [90_000, "1 day 1 hour"],
        [200_000, "2 days 8 hours"],
    ]
    for (const [seconds, text] of expected)
        expect(reply(seconds), `${seconds} s`).toBe(`This command is on cooldown. Try again in ${text}`)
})
