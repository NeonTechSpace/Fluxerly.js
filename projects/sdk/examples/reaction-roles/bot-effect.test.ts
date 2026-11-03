import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { createTestBot, type TestBot } from "@neontechspace/fluxerly/effect/testing"

// The example reads ROLE_EMOJI when it loads, so the test sets it before importing the bot, whatever the shell sets
process.env.ROLE_EMOJI = "✅"
const { bot } = await import("./bot-effect.ts")

const messageId = "100"

// The example logs failures through onError, so a test bot collects them instead, to check that nothing failed
const createReportingBot = (reported: string[]) =>
    createTestBot({ ...bot, onError: (report) => Effect.sync(() => void reported.push(report.describe())) })

// Setup reads the channel, the bot's own membership and the roles, then reacts to the message. The bot's role ranks
// above the opt-in role, as setup requires
function answerSetup(testBot: TestBot) {
    const { fixtures, rest } = testBot
    const { guild, channel } = fixtures.ids
    const botRole = fixtures.role({ name: "Bot", position: 2 })
    const optInRole = fixtures.role({ name: "Notifications", position: 1 })
    process.env.ROLE_CHANNEL_ID = channel
    process.env.ROLE_MESSAGE_ID = messageId
    process.env.ROLE_ID = optInRole.id
    rest.respond(`GET /channels/${channel}`, { body: fixtures.channel() })
    rest.respond(`GET /guilds/${guild}/members/@me`, {
        body: fixtures.member({ user: fixtures.botUser(), roles: [botRole.id] }),
    })
    rest.respond(`GET /guilds/${guild}/roles`, { body: [fixtures.role({ id: guild }), botRole, optInRole] })
    rest.respond(`PUT /channels/${channel}/messages/${messageId}/reactions/:emoji/@me`, {})
    rest.respond("/guilds/:guild/members/:user/roles/:role", {})
    return optInRole.id
}

// A reaction event as Fluxer sends it, by default the default author's ✅ on the role message
function reaction(testBot: TestBot, overrides: { userId?: string; emoji?: string } = {}) {
    const { guild, channel, user } = testBot.fixtures.ids
    return {
        guild_id: guild,
        channel_id: channel,
        message_id: messageId,
        user_id: overrides.userId ?? user,
        emoji: { name: overrides.emoji ?? "✅" },
    }
}

const roleChanges = (testBot: TestBot) =>
    testBot
        .requests()
        .filter((request) => request.path.includes("/roles/"))
        .map((request) => `${request.method} ${request.path}`)

test("reacting grants the role and removing the reaction takes it back", async () => {
    const reported: string[] = []
    // Effect.scoped shuts the test bot down once the conversation ends
    const { member, changes, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                const roleId = answerSetup(testBot)
                yield* testBot.ready()
                yield* testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot))
                yield* testBot.idle()
                yield* testBot.emit("MESSAGE_REACTION_REMOVE", reaction(testBot))
                yield* testBot.idle()
                const { guild, user } = testBot.fixtures.ids
                const member = `/guilds/${guild}/members/${user}/roles/${roleId}`
                return { member, changes: roleChanges(testBot), failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    assert.deepEqual(changes, [`PUT ${member}`, `DELETE ${member}`])
})

test("other emoji and the bot's own reaction change no role", async () => {
    const reported: string[] = []
    const { changes, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                answerSetup(testBot)
                yield* testBot.ready()
                yield* testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot, { emoji: "🎉" }))
                yield* testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot, { userId: testBot.fixtures.ids.bot }))
                yield* testBot.idle()
                return { changes: roleChanges(testBot), failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    assert.deepEqual(changes, [])
})

// A response the test sends only once it calls release, so a request stays in flight meanwhile
function held() {
    let release!: () => void
    let arrive!: () => void
    const released = new Promise<void>((done) => (release = done))
    const arrived = new Promise<void>((done) => (arrive = done))
    return { release, arrived, answer: () => (arrive(), released.then(() => ({}))) }
}

// The client works on setImmediate, so these turns let it hand an event to its handler and send what that handler
// sends. No clock is involved, and correct code passes however few turns run
const turns = (count = 50) =>
    Effect.promise(async () => {
        for (let turn = 0; turn < count; turn++) await new Promise((done) => setImmediate(done))
    })

test("a member who takes the reaction back while their add waits behind another member's ends without the role", async () => {
    const reported: string[] = []
    const { member, changes, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                const roleId = answerSetup(testBot)
                yield* testBot.ready()
                const { guild, user: first } = testBot.fixtures.ids
                const second = "900000000000000001"
                const firstAdd = held()
                testBot.rest.respond(`PUT /guilds/${guild}/members/${first}/roles/${roleId}`, firstAdd.answer)

                // The second member's add waits behind the first member's, which Fluxer has not answered yet
                yield* testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot))
                yield* testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot, { userId: second }))
                yield* testBot.emit("MESSAGE_REACTION_REMOVE", reaction(testBot, { userId: second }))
                yield* turns()
                firstAdd.release()
                yield* testBot.idle()
                const member = `/guilds/${guild}/members/${second}/roles/${roleId}`
                return { member, changes: roleChanges(testBot), failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    assert.equal(
        changes.findLast((change) => change.endsWith(member)),
        `DELETE ${member}`,
    )
})

test("a removal waits for the member's own add in flight to finish", async () => {
    const reported: string[] = []
    let added = false
    let removedEarly = false
    const { member, changes, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                const roleId = answerSetup(testBot)
                yield* testBot.ready()
                const { guild, user } = testBot.fixtures.ids
                const member = `/guilds/${guild}/members/${user}/roles/${roleId}`
                const add = held()
                testBot.rest.respond(`PUT ${member}`, () => add.answer().then((response) => ((added = true), response)))
                testBot.rest.respond(`DELETE ${member}`, () => ((removedEarly = !added), {}))

                yield* testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot))
                yield* Effect.promise(() => add.arrived)
                yield* testBot.emit("MESSAGE_REACTION_REMOVE", reaction(testBot))
                yield* turns()
                add.release()
                yield* testBot.idle()
                return { member, changes: roleChanges(testBot), failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    assert.equal(removedEarly, false)
    assert.deepEqual(changes, [`PUT ${member}`, `DELETE ${member}`])
})
