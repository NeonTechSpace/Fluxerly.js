import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { Permissions } from "@neontechspace/fluxerly/effect"
import { createTestBot, type TestBot, type WireChannel } from "@neontechspace/fluxerly/effect/testing"
import { bot } from "./bot-effect.ts"

// Setup reads the category and the staff role from these variables
const categoryId = "100"
const staffRoleId = "200"
process.env.TICKET_CATEGORY_ID = categoryId
process.env.TICKET_STAFF_ROLE_ID = staffRoleId

// The example logs failures through onError, so a test bot collects them instead, to check that nothing failed
const createReportingBot = (reported: string[]) =>
    createTestBot({ ...bot, onError: (report) => Effect.sync(() => void reported.push(report.describe())) })

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
    const reported: string[] = []
    // Effect.scoped shuts the test bot down once the conversation ends
    const { ids, replies, requests, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                const created = answerChannels(testBot)
                yield* testBot.ready()
                const replies = yield* testBot.say("!ticket")
                return {
                    ids: testBot.fixtures.ids,
                    replies,
                    requests: created.requests(),
                    failures: testBot.failures(),
                }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    // Request bodies are JSON in Fluxer's wire shape, where overwrite type 0 is a role and 1 a member
    const channel = requests[0]?.body as { name: string; parent_id: string; permission_overwrites: unknown[] }
    assert.equal(channel.name, `ticket-${ids.user}`)
    assert.equal(channel.parent_id, categoryId)
    // The everyone role, whose ID is the community's, may not view the channel. The staff, the member and the bot may
    const access = String(Permissions.ViewChannel | Permissions.SendMessages | Permissions.ReadMessageHistory)
    assert.deepEqual(channel.permission_overwrites, [
        { id: ids.guild, type: 0, allow: "0", deny: String(Permissions.ViewChannel) },
        { id: staffRoleId, type: 0, allow: access, deny: "0" },
        { id: ids.user, type: 1, allow: access, deny: "0" },
        { id: ids.bot, type: 1, allow: access, deny: "0" },
    ])
    // The bot greets the member in the new channel, then replies where the member asked
    assert.equal(replies.length, 2)
    assert.match(replies[1]?.content ?? "", /^Ticket opened: <#\d+>$/)
})

test("!ticket points to a ticket that is already open", async () => {
    const reported: string[] = []
    const { openId, replies, requests, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                const { fixtures } = testBot
                const name = `ticket-${fixtures.ids.user}`
                const open = fixtures.channel({ id: fixtures.nextId(), name, parent_id: categoryId })
                const created = answerChannels(testBot, [open])
                yield* testBot.ready()
                const replies = yield* testBot.say("!ticket")
                return { openId: open.id, replies, requests: created.requests(), failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    assert.deepEqual(requests, [])
    assert.deepEqual(
        replies.map((message) => message.content),
        [`A ticket is already open: <#${openId}>`],
    )
})

test("!close deletes only ticket channels", async () => {
    const reported: string[] = []
    const { ticketId, refused, deleted, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                const { fixtures, rest } = testBot
                const name = `ticket-${fixtures.ids.user}`
                const ticket = fixtures.channel({ id: fixtures.nextId(), name, parent_id: categoryId })
                rest.respond(`GET /channels/${fixtures.ids.channel}`, { body: fixtures.channel() })
                rest.respond(`GET /channels/${ticket.id}`, { body: ticket })
                rest.respond(`DELETE /channels/${ticket.id}`, {})
                yield* testBot.ready()
                // The default channel is not in the ticket category, so it stays
                const refused = yield* testBot.say("!close")
                yield* testBot.say("!close", { message: { channel_id: ticket.id } })
                const deleted = testBot
                    .requests()
                    .filter((request) => request.method === "DELETE")
                    .map((request) => request.path)
                return { ticketId: ticket.id, refused, deleted, failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    assert.deepEqual(
        refused.map((message) => message.content),
        ["Send !close inside a ticket channel"],
    )
    assert.deepEqual(deleted, [`/channels/${ticketId}`])
})
