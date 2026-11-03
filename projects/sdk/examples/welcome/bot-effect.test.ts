import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { createTestBot } from "@neontechspace/fluxerly/effect/testing"

// The example reads WELCOME_ROLE_ID when it loads, so the test sets it before importing the bot. Setup reads
// WELCOME_CHANNEL_ID, which the fixture channel answers
const starterRoleId = "100"
process.env.WELCOME_ROLE_ID = starterRoleId
const { bot } = await import("./bot-effect.ts")

// The example logs failures through onError, so a test bot collects them instead, to check that nothing failed
const createReportingBot = (reported: string[]) =>
    createTestBot({ ...bot, onError: (report) => Effect.sync(() => void reported.push(report.describe())) })

test("a new member is welcomed with a mention and receives the starter role", async () => {
    const reported: string[] = []
    // Effect.scoped shuts the test bot down once the conversation ends
    const { newcomer, ids, sent, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                const { fixtures, rest } = testBot
                process.env.WELCOME_CHANNEL_ID = fixtures.ids.channel
                rest.respond(`GET /channels/${fixtures.ids.channel}`, { body: fixtures.channel() })
                rest.respond("PUT /guilds/:guild/members/:user/roles/:role", {})
                yield* testBot.ready()
                const newcomer = fixtures.user({ id: fixtures.nextId(), username: "newcomer" })
                yield* testBot.emit("GUILD_MEMBER_ADD", fixtures.member({ user: newcomer }))
                yield* testBot.idle()
                const sent = testBot.requests().filter((request) => request.method !== "GET")
                return { newcomer, ids: fixtures.ids, sent, failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    const [welcome, grant] = sent
    assert.equal(welcome?.path, `/channels/${ids.channel}/messages`)
    // Request bodies are JSON in Fluxer's wire shape
    const message = welcome?.body as { content: string; allowed_mentions: { users: string[] } }
    assert.equal(message.content, `Welcome, <@${newcomer.id}>!`)
    // Only the new member is notified
    assert.deepEqual(message.allowed_mentions.users, [newcomer.id])
    assert.equal(grant?.path, `/guilds/${ids.guild}/members/${newcomer.id}/roles/${starterRoleId}`)
})

test("joining bots and joins in other communities get no welcome", async () => {
    const reported: string[] = []
    const { sent, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                const { fixtures, rest } = testBot
                process.env.WELCOME_CHANNEL_ID = fixtures.ids.channel
                rest.respond(`GET /channels/${fixtures.ids.channel}`, { body: fixtures.channel() })
                yield* testBot.ready()
                const joiningBot = fixtures.user({ id: fixtures.nextId(), bot: true })
                yield* testBot.emit("GUILD_MEMBER_ADD", fixtures.member({ user: joiningBot }))
                yield* testBot.emit("GUILD_MEMBER_ADD", fixtures.member({ guild_id: fixtures.nextId() }))
                yield* testBot.idle()
                const sent = testBot.requests().filter((request) => request.method !== "GET")
                return { sent, failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    assert.deepEqual(sent, [])
})
