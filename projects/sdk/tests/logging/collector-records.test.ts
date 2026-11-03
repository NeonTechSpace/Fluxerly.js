import { expect, onTestFinished, test } from "vitest"
import { createTestBot } from "../../src/testing.js"

// Catches: Collector Warn records named no channel, so equal overflows of collectors in different channels collapsed
// into one record that did not say which collector stopped
test("overflowing collectors in different channels log one Warn each, naming the channel", async () => {
    const bot = createTestBot({ cache: { messages: true } })
    onTestFinished(() => bot.shutdown())
    await bot.ready()
    const channels = ["1456074443980800101", "1456074443980800102"]
    // Any message is larger than one byte, so each collector overflows on its first message
    const collectors = channels.map((channelId) => bot.client.messages.collect(channelId, { maxPendingBytes: 1 }))
    for (const channelId of channels) bot.emit("MESSAGE_CREATE", bot.fixtures.message({ channel_id: channelId }))
    for (const collector of collectors)
        expect(await collector.result()).toMatchObject({ error: { reason: "overflow", limit: "maxPendingBytes" } })
    const failed = bot.logs().filter((record) => record.code === "collectors.failed")
    expect(failed.map((record) => [record.level, record.fields?.channelId])).toEqual([
        ["warn", channels[0]],
        ["warn", channels[1]],
    ])
})

// Catches: Callback failure records named no message, so equal failures of collectors in different channels were
// deduplicated into one record and a later repeat count that did not say which collector stopped
test("equal callback failures in collectors in different channels log one Error each, naming the channel", async () => {
    const bot = createTestBot({ cache: { messages: true } })
    onTestFinished(() => bot.shutdown())
    await bot.ready()
    const channels = ["1456074443980800101", "1456074443980800102", "1456074443980800103"]
    const collectors = channels.map((channelId) =>
        bot.client.messages.collect(channelId, {
            onMessage: () => {
                throw new Error("Database unavailable")
            },
        }),
    )
    for (const channelId of channels) bot.emit("MESSAGE_CREATE", bot.fixtures.message({ channel_id: channelId }))
    for (const collector of collectors) expect(await collector.result()).toMatchObject({ error: { reason: "handler" } })
    const failed = bot.logs().filter((record) => record.code === "collectors.callbackFailed")
    expect(failed.map((record) => [record.level, record.fields?.channelId, record.fields?.repeated])).toEqual(
        channels.map((channelId) => ["error", channelId, undefined]),
    )
    bot.failures()
})
