import { expect, test } from "vitest"
import { captureEmoji, retainFrame } from "./support/capture-filter.js"

const botId = "11"
const other = "22"
const channel = { id: "100", name: "marker" }
const keep = (type, body, scope = channel) => retainFrame(type, body, { channel: scope, botId })

test("the bot's own activity in the test channel is retained", () => {
    expect(keep("MESSAGE_CREATE", { channel_id: "100", author: { id: botId } })).toBe(true)
    expect(keep("MESSAGE_UPDATE", { channel_id: "100", author: { id: botId } })).toBe(true)
    expect(keep("MESSAGE_DELETE", { channel_id: "100", author_id: botId })).toBe(true)
    expect(keep("MESSAGE_REACTION_ADD", { channel_id: "100", user_id: botId, emoji: { name: captureEmoji } })).toBe(
        true,
    )
    expect(keep("MESSAGE_REACTION_REMOVE", { channel_id: "100", user_id: botId, emoji: { name: captureEmoji } })).toBe(
        true,
    )
    expect(keep("TYPING_START", { channel_id: "100", user_id: botId })).toBe(true)
    expect(keep("CHANNEL_UPDATE", { id: "100" })).toBe(true)
})

test("another member's frames in the test channel are not retained", () => {
    expect(keep("MESSAGE_CREATE", { channel_id: "100", author: { id: other } })).toBe(false)
    expect(keep("MESSAGE_UPDATE", { channel_id: "100", author: { id: other } })).toBe(false)
    expect(keep("MESSAGE_DELETE", { channel_id: "100", author_id: other })).toBe(false)
    expect(keep("MESSAGE_DELETE", { channel_id: "100" })).toBe(false)
    expect(keep("MESSAGE_REACTION_ADD", { channel_id: "100", user_id: other, emoji: { name: captureEmoji } })).toBe(
        false,
    )
    expect(keep("TYPING_START", { channel_id: "100", user_id: other })).toBe(false)
})

test("other emoji, other channels and unknown scopes are not retained", () => {
    expect(keep("MESSAGE_REACTION_ADD", { channel_id: "100", user_id: botId, emoji: { name: "x" } })).toBe(false)
    expect(
        keep("MESSAGE_REACTION_ADD", { channel_id: "100", user_id: botId, emoji: { id: "5", name: captureEmoji } }),
    ).toBe(false)
    expect(keep("TYPING_START", { channel_id: "101", user_id: botId })).toBe(false)
    expect(keep("CHANNEL_UPDATE", { id: "101" })).toBe(false)
    expect(keep("MESSAGE_CREATE", { channel_id: "100", author: { id: botId } }, null)).toBe(false)
    // Before the ID is known only the creation of the channel with the journaled name counts
    expect(keep("CHANNEL_CREATE", { id: "100", name: "marker" }, { name: "marker" })).toBe(true)
    expect(keep("CHANNEL_CREATE", { id: "101", name: "other" }, { name: "marker" })).toBe(false)
    expect(keep("MESSAGE_CREATE", { channel_id: "100", author: { id: botId } }, { name: "marker" })).toBe(false)
})
