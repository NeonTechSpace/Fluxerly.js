import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestBot, type TestBot } from "@neontechspace/fluxerly/testing"

// The example reads ROLE_EMOJI when it loads, so the test sets it before importing the bot, whatever the shell sets
process.env.ROLE_EMOJI = "✅"
const { bot } = await import("./bot.ts")

const messageId = "100"

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
    // The example logs failures through onError, so the test collects them to check that nothing failed
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    const roleId = answerSetup(testBot)
    await testBot.ready()

    testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot))
    await testBot.idle()
    testBot.emit("MESSAGE_REACTION_REMOVE", reaction(testBot))
    await testBot.idle()
    // Checked first, because a failed assertion and a failed cleanup together can hide the reason behind SuppressedError
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    const member = `/guilds/${testBot.fixtures.ids.guild}/members/${testBot.fixtures.ids.user}/roles/${roleId}`
    assert.deepEqual(roleChanges(testBot), [`PUT ${member}`, `DELETE ${member}`])
})

test("other emoji and the bot's own reaction change no role", async () => {
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    answerSetup(testBot)
    await testBot.ready()

    testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot, { emoji: "🎉" }))
    testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot, { userId: testBot.fixtures.ids.bot }))
    await testBot.idle()
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    assert.deepEqual(roleChanges(testBot), [])
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
async function turns(count = 50) {
    for (let turn = 0; turn < count; turn++) await new Promise((done) => setImmediate(done))
}

test("a member who takes the reaction back while their add waits behind another member's ends without the role", async () => {
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    const roleId = answerSetup(testBot)
    await testBot.ready()
    const { guild, user: first } = testBot.fixtures.ids
    const second = "900000000000000001"
    const firstAdd = held()
    testBot.rest.respond(`PUT /guilds/${guild}/members/${first}/roles/${roleId}`, firstAdd.answer)

    // The second member's add waits behind the first member's, which Fluxer has not answered yet
    testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot))
    testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot, { userId: second }))
    testBot.emit("MESSAGE_REACTION_REMOVE", reaction(testBot, { userId: second }))
    await turns()
    firstAdd.release()
    await testBot.idle()
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    const member = `/guilds/${guild}/members/${second}/roles/${roleId}`
    assert.equal(
        roleChanges(testBot).findLast((change) => change.endsWith(member)),
        `DELETE ${member}`,
    )
})

test("a removal waits for the member's own add in flight to finish", async () => {
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    const roleId = answerSetup(testBot)
    await testBot.ready()
    const { guild, user } = testBot.fixtures.ids
    const member = `/guilds/${guild}/members/${user}/roles/${roleId}`
    const add = held()
    let added = false
    let removedEarly = false
    testBot.rest.respond(`PUT ${member}`, () => add.answer().then((response) => ((added = true), response)))
    testBot.rest.respond(`DELETE ${member}`, () => ((removedEarly = !added), {}))

    testBot.emit("MESSAGE_REACTION_ADD", reaction(testBot))
    await add.arrived
    testBot.emit("MESSAGE_REACTION_REMOVE", reaction(testBot))
    await turns()
    add.release()
    await testBot.idle()
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    assert.equal(removedEarly, false)
    assert.deepEqual(roleChanges(testBot), [`PUT ${member}`, `DELETE ${member}`])
})
