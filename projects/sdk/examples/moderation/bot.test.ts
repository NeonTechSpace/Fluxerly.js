import assert from "node:assert/strict"
import { test } from "node:test"
import { Permissions } from "@neontechspace/fluxerly"
import { createTestBot, type TestBot, type WireRole } from "@neontechspace/fluxerly/testing"
import { bot } from "./bot.ts"

// The permission guard and the rank check read the community, its roles, the channel and each member, so the fake
// Fluxer answers those reads. Each member holds the roles that memberRoles lists for it
function answerCommunityReads(
    testBot: TestBot,
    community: { ownerId?: string; roles?: WireRole[]; memberRoles?: Record<string, string[]> } = {},
) {
    const { fixtures, rest } = testBot
    const { guild, channel, user } = fixtures.ids
    rest.respond(`GET /guilds/${guild}`, { body: fixtures.guild({ owner_id: community.ownerId ?? user }) })
    rest.respond(`GET /guilds/${guild}/roles`, {
        body: [fixtures.role({ id: guild, name: "@everyone", permissions: "0" }), ...(community.roles ?? [])],
    })
    rest.respond(`GET /channels/${channel}`, { body: fixtures.channel() })
    rest.respond(`GET /guilds/${guild}/members/:user`, (request) => {
        const userId = request.path.split("/").at(-1) ?? ""
        const roles = community.memberRoles?.[userId] ?? []
        return { body: fixtures.member({ user: fixtures.user({ id: userId }), roles }) }
    })
    rest.respond(`DELETE /guilds/${guild}/members/:user`, {})
}

const kicks = (testBot: TestBot) => testBot.requests().filter((request) => request.method === "DELETE")

test("!kick removes the member with the reason and confirms", async () => {
    // The example logs failures through onError, so the test collects them to check that nothing failed
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    // The default author owns the community, so it may kick anyone
    answerCommunityReads(testBot)
    await testBot.ready()
    const member = testBot.fixtures.nextId()

    const replies = await testBot.say(`!kick <@${member}> spam`)
    // Checked first, because a failed assertion and a failed cleanup together can hide the reason behind SuppressedError
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    const [kick] = kicks(testBot)
    assert.equal(kick?.path, `/guilds/${testBot.fixtures.ids.guild}/members/${member}`)
    assert.equal(kick?.headers["x-audit-log-reason"], "spam")
    assert.deepEqual(
        replies.map((message) => message.content),
        [`Kicked <@${member}>`],
    )
})

test("!kick needs the KickMembers permission", async () => {
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    const { fixtures } = testBot
    // The author outranks the member through a role without permissions, so only the guard stops the kick
    const helpers = fixtures.role({ name: "Helpers", position: 1 })
    answerCommunityReads(testBot, {
        ownerId: fixtures.ids.bot,
        roles: [helpers],
        memberRoles: { [fixtures.ids.user]: [helpers.id] },
    })
    await testBot.ready()

    await testBot.say(`!kick <@${fixtures.nextId()}>`)
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    assert.deepEqual(kicks(testBot), [])
})

test("!kick refuses a member who ranks at or above the moderator", async () => {
    const reported: string[] = []
    await using testBot = createTestBot({ ...bot, onError: (report) => void reported.push(report.describe()) })
    const { fixtures } = testBot
    const moderators = fixtures.role({ name: "Moderators", position: 1, permissions: String(Permissions.KickMembers) })
    const admins = fixtures.role({ name: "Admins", position: 2 })
    const member = fixtures.nextId()
    answerCommunityReads(testBot, {
        ownerId: fixtures.ids.bot,
        roles: [moderators, admins],
        memberRoles: { [fixtures.ids.user]: [moderators.id], [member]: [admins.id] },
    })
    await testBot.ready()

    const replies = await testBot.say(`!kick <@${member}>`)
    assert.deepEqual(testBot.failures(), [])
    assert.deepEqual(reported, [])
    assert.deepEqual(kicks(testBot), [])
    assert.deepEqual(
        replies.map((message) => message.content),
        ["That member ranks at or above the moderator"],
    )
})
