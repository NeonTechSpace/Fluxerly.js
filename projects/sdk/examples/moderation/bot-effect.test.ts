import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { Permissions } from "@neontechspace/fluxerly/effect"
import { createTestBot, type TestBot, type WireRole } from "@neontechspace/fluxerly/effect/testing"
import { bot } from "./bot-effect.ts"

// The example logs failures through onError, so a test bot collects them instead, to check that nothing failed
const createReportingBot = (reported: string[]) =>
    createTestBot({ ...bot, onError: (report) => Effect.sync(() => void reported.push(report.describe())) })

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
    const reported: string[] = []
    // Effect.scoped shuts the test bot down once the conversation ends
    const { member, guild, replies, kicked, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                // The default author owns the community, so it may kick anyone
                answerCommunityReads(testBot)
                yield* testBot.ready()
                const member = testBot.fixtures.nextId()
                const replies = yield* testBot.say(`!kick <@${member}> spam`)
                const { guild } = testBot.fixtures.ids
                return { member, guild, replies, kicked: kicks(testBot), failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    assert.equal(kicked[0]?.path, `/guilds/${guild}/members/${member}`)
    assert.equal(kicked[0]?.headers["x-audit-log-reason"], "spam")
    assert.deepEqual(
        replies.map((message) => message.content),
        [`Kicked <@${member}>`],
    )
})

test("!kick needs the KickMembers permission", async () => {
    const reported: string[] = []
    const { kicked, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                const { fixtures } = testBot
                // The author outranks the member through a role without permissions, so only the guard stops the kick
                const helpers = fixtures.role({ name: "Helpers", position: 1 })
                answerCommunityReads(testBot, {
                    ownerId: fixtures.ids.bot,
                    roles: [helpers],
                    memberRoles: { [fixtures.ids.user]: [helpers.id] },
                })
                yield* testBot.ready()
                yield* testBot.say(`!kick <@${fixtures.nextId()}>`)
                return { kicked: kicks(testBot), failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    assert.deepEqual(kicked, [])
})

test("!kick refuses a member who ranks at or above the moderator", async () => {
    const reported: string[] = []
    const { replies, kicked, failures } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createReportingBot(reported)
                const { fixtures } = testBot
                const moderators = fixtures.role({
                    name: "Moderators",
                    position: 1,
                    permissions: String(Permissions.KickMembers),
                })
                const admins = fixtures.role({ name: "Admins", position: 2 })
                const member = fixtures.nextId()
                answerCommunityReads(testBot, {
                    ownerId: fixtures.ids.bot,
                    roles: [moderators, admins],
                    memberRoles: { [fixtures.ids.user]: [moderators.id], [member]: [admins.id] },
                })
                yield* testBot.ready()
                const replies = yield* testBot.say(`!kick <@${member}>`)
                return { replies, kicked: kicks(testBot), failures: testBot.failures() }
            }),
        ),
    )

    assert.deepEqual(failures, [])
    assert.deepEqual(reported, [])
    assert.deepEqual(kicked, [])
    assert.deepEqual(
        replies.map((message) => message.content),
        ["That member ranks at or above the moderator"],
    )
})
