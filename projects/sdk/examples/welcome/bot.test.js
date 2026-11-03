import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestBot } from "@neontechspace/fluxerly/testing"

// The example reads WELCOME_ROLE_ID when it loads, so the test sets it before importing the bot. Setup reads
// WELCOME_CHANNEL_ID, which the fixture channel answers
const starterRoleId = "100"
process.env.WELCOME_ROLE_ID = starterRoleId
const { bot } = await import("./bot.js")

test("a new member is welcomed with a mention and receives the starter role", async () => {
    // The example logs failures through onError, so the test collects them to check that nothing failed
    const reported = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    const { fixtures, rest } = testBot
    process.env.WELCOME_CHANNEL_ID = fixtures.ids.channel
    rest.respond(`GET /channels/${fixtures.ids.channel}`, { body: fixtures.channel() })
    rest.respond("PUT /guilds/:guild/members/:user/roles/:role", {})
    await testBot.ready()
    const newcomer = fixtures.user({ id: fixtures.nextId(), username: "newcomer" })

    testBot.emit("GUILD_MEMBER_ADD", fixtures.member({ user: newcomer }))
    await testBot.idle()
    // Checked first, because a failed assertion and a failed cleanup together can hide the reason behind SuppressedError
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    const [welcome, grant] = testBot.requests().filter((request) => request.method !== "GET")
    assert.equal(welcome?.path, `/channels/${fixtures.ids.channel}/messages`)
    // Request bodies are JSON in Fluxer's wire shape
    const message = welcome?.body
    assert.equal(message.content, `Welcome, <@${newcomer.id}>!`)
    // Only the new member is notified
    assert.deepEqual(message.allowed_mentions.users, [newcomer.id])
    assert.equal(grant?.path, `/guilds/${fixtures.ids.guild}/members/${newcomer.id}/roles/${starterRoleId}`)
})

test("joining bots and joins in other communities get no welcome", async () => {
    const reported = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    const { fixtures, rest } = testBot
    process.env.WELCOME_CHANNEL_ID = fixtures.ids.channel
    rest.respond(`GET /channels/${fixtures.ids.channel}`, { body: fixtures.channel() })
    await testBot.ready()

    const joiningBot = fixtures.user({ id: fixtures.nextId(), bot: true })
    testBot.emit("GUILD_MEMBER_ADD", fixtures.member({ user: joiningBot }))
    testBot.emit("GUILD_MEMBER_ADD", fixtures.member({ guild_id: fixtures.nextId() }))
    await testBot.idle()
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    assert.deepEqual(
        testBot.requests().filter((request) => request.method !== "GET"),
        [],
    )
})
