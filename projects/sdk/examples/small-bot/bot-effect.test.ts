import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { createTestBot } from "@neontechspace/fluxerly/effect/testing"
import { bot } from "./bot-effect.ts"

// The example logs failures through onError, so a test bot collects them instead, to check that nothing failed
const createReportingBot = (reported: string[]) =>
    createTestBot({ ...bot, onError: (report) => Effect.sync(() => void reported.push(report.describe())) })

test("!ping and !greet reply", async () => {
    const reported: string[] = []
    // Effect.scoped shuts the test bot down once the conversation ends
    const { ping, greet, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                yield* testBot.ready()
                const ping = yield* testBot.say("!ping")
                const greet = yield* testBot.say("!greet Ada Lovelace")
                return { ping, greet, failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
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
    // TestClock moves only when the test adjusts it, so the cooldown ends without waiting five seconds
    const { early, later, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                yield* testBot.ready()
                yield* testBot.say("!greet Ada")
                // The second greeting comes during the cooldown, so the bot answers with the cooldown instead
                const early = yield* testBot.say("!greet Grace")
                yield* TestClock.adjust("5 seconds")
                const later = yield* testBot.say("!greet Grace")
                return { early, later, failures: testBot.failures() }
            }),
        ).pipe(Effect.provide(TestClock.layer())),
    )

    assert.deepEqual(failures, [])
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
    const { replies, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                const { fixtures, rest } = testBot
                const { guild, channel, user, bot: botId } = fixtures.ids
                // The guard reads the community, the author's membership, the roles and the channel. Another account
                // owns the community and nobody has a permission, so the guard denies the command
                rest.respond(`GET /guilds/${guild}`, { body: fixtures.guild({ owner_id: botId }) })
                rest.respond(`GET /guilds/${guild}/members/${user}`, { body: fixtures.member() })
                rest.respond(`GET /guilds/${guild}/roles`, { body: [fixtures.role({ id: guild, permissions: "0" })] })
                rest.respond(`GET /channels/${channel}`, { body: fixtures.channel() })
                yield* testBot.ready()
                const replies = yield* testBot.say("!announce The server moves on Friday")
                return { replies, failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    assert.ok(replies.every((message) => message.embeds === undefined || message.embeds.length === 0))
})
