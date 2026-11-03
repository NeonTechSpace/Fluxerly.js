import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestBot } from "@neontechspace/fluxerly/testing"
import { bot } from "./bot.ts"

test("!ping and !greet reply", async () => {
    // The example logs failures through onError, so the test collects them to check that nothing failed
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    await testBot.ready()

    const ping = await testBot.say("!ping")
    const greet = await testBot.say("!greet Ada Lovelace")
    // Checked first, because a failed assertion and a failed cleanup together can hide the reason behind SuppressedError
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    assert.deepEqual(
        ping.map((message) => message.content),
        ["Pong!"],
    )
    // The name argument takes the rest of the message
    assert.deepEqual(
        greet.map((message) => message.content),
        ["Hello, Ada Lovelace!"],
    )
})

test("!greet waits for its five-second cooldown", async () => {
    const reported: string[] = []
    // The manual clock moves only when the test advances it, so the cooldown ends without waiting five seconds
    await using testBot = createTestBot({
        ...bot,
        clock: "manual",
        onError: (report) => void reported.push(report.describe()),
    })
    await testBot.ready()

    await testBot.say("!greet Ada")
    // The second greeting comes during the cooldown, so the bot answers with the cooldown instead
    const early = await testBot.say("!greet Grace")
    await testBot.advance(5_000)
    const later = await testBot.say("!greet Grace")
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    assert.equal(early.length, 1)
    assert.notEqual(early[0]?.content, "Hello, Grace!")
    assert.deepEqual(
        later.map((message) => message.content),
        ["Hello, Grace!"],
    )
})

test("!announce needs the ManageMessages permission", async () => {
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    const { fixtures, rest } = testBot
    const { guild, channel, user, bot: botId } = fixtures.ids
    // The guard reads the community, the author's membership, the roles and the channel. Another account owns the
    // community and nobody has a permission, so the guard denies the command
    rest.respond(`GET /guilds/${guild}`, { body: fixtures.guild({ owner_id: botId }) })
    rest.respond(`GET /guilds/${guild}/members/${user}`, { body: fixtures.member() })
    rest.respond(`GET /guilds/${guild}/roles`, { body: [fixtures.role({ id: guild, permissions: "0" })] })
    rest.respond(`GET /channels/${channel}`, { body: fixtures.channel() })
    await testBot.ready()

    const replies = await testBot.say("!announce The server moves on Friday")
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    assert.ok(replies.every((message) => message.embeds === undefined || message.embeds.length === 0))
})
