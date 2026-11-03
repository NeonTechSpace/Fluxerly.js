import assert from "node:assert/strict"
import { test } from "node:test"
import { Permissions } from "@neontechspace/fluxerly"
import { createTestBot, type TestBot, type WireChannel } from "@neontechspace/fluxerly/testing"
import { bot } from "./bot.ts"

// Setup reads the category and the staff role from these variables
const categoryId = "100"
const staffRoleId = "200"
process.env.TICKET_CATEGORY_ID = categoryId
process.env.TICKET_STAFF_ROLE_ID = staffRoleId

// The fake Fluxer lists the community's channels and creates a ticket channel as requested
function answerChannels(testBot: TestBot, channels: WireChannel[] = []) {
    const { fixtures, rest } = testBot
    const { guild } = fixtures.ids
    rest.respond(`GET /guilds/${guild}/channels`, { body: [fixtures.channel(), ...channels] })
    return rest.respond(`POST /guilds/${guild}/channels`, (request) => ({
        body: fixtures.channel({ ...(request.body as object), id: fixtures.nextId() }),
    }))
}

test("!ticket opens a channel that only the member, the staff and the bot can see", async () => {
    // The example logs failures through onError, so the test collects them to check that nothing failed
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    const created = answerChannels(testBot)
    await testBot.ready()
    const { guild, user, bot: botId } = testBot.fixtures.ids

    const replies = await testBot.say("!ticket")
    // Checked first, because a failed assertion and a failed cleanup together can hide the reason behind SuppressedError
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    const [request] = created.requests()
    // Request bodies are JSON in Fluxer's wire shape, where overwrite type 0 is a role and 1 a member
    const channel = request?.body as { name: string; parent_id: string; permission_overwrites: unknown[] }
    assert.equal(channel.name, `ticket-${user}`)
    assert.equal(channel.parent_id, categoryId)
    // The everyone role, whose ID is the community's, may not view the channel. The staff, the member and the bot may
    const access = String(Permissions.ViewChannel | Permissions.SendMessages | Permissions.ReadMessageHistory)
    assert.deepEqual(channel.permission_overwrites, [
        { id: guild, type: 0, allow: "0", deny: String(Permissions.ViewChannel) },
        { id: staffRoleId, type: 0, allow: access, deny: "0" },
        { id: user, type: 1, allow: access, deny: "0" },
        { id: botId, type: 1, allow: access, deny: "0" },
    ])
    // The bot greets the member in the new channel, then replies where the member asked
    assert.equal(replies.length, 2)
    assert.match(replies[1]?.content ?? "", /^Ticket opened: <#\d+>$/)
})

test("!ticket points to a ticket that is already open", async () => {
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    const { fixtures } = testBot
    const open = fixtures.channel({ id: fixtures.nextId(), name: `ticket-${fixtures.ids.user}`, parent_id: categoryId })
    const created = answerChannels(testBot, [open])
    await testBot.ready()

    const replies = await testBot.say("!ticket")
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    assert.deepEqual(created.requests(), [])
    assert.deepEqual(
        replies.map((message) => message.content),
        [`A ticket is already open: <#${open.id}>`],
    )
})

test("!close deletes only ticket channels", async () => {
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    const { fixtures, rest } = testBot
    const ticket = fixtures.channel({
        id: fixtures.nextId(),
        name: `ticket-${fixtures.ids.user}`,
        parent_id: categoryId,
    })
    rest.respond(`GET /channels/${fixtures.ids.channel}`, { body: fixtures.channel() })
    rest.respond(`GET /channels/${ticket.id}`, { body: ticket })
    rest.respond(`DELETE /channels/${ticket.id}`, {})
    await testBot.ready()

    // The default channel is not in the ticket category, so it stays
    const refused = await testBot.say("!close")
    await testBot.say("!close", { message: { channel_id: ticket.id } })
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    assert.deepEqual(
        refused.map((message) => message.content),
        ["Send !close inside a ticket channel"],
    )
    assert.deepEqual(
        testBot
            .requests()
            .filter((request) => request.method === "DELETE")
            .map((request) => request.path),
        [`/channels/${ticket.id}`],
    )
})
