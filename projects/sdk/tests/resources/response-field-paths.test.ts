import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"
import { expectErr } from "../support/settle.js"

// A malformed answer names the field that failed. The message decoder used to read every nested part before checking
// any, so a bad embed timestamp was reported as the last part read, stickers
async function open(mode: Mode) {
    if (mode === "default") {
        const test = createDefaultTestClient()
        onTestFinished(() => test.shutdown())
        return test
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
}

const badEmbed = { type: "rich", title: "Release", timestamp: "not a timestamp" }
const sticker = { id: "90", name: "wave", animated: false }

test.each(modes)("%s names a malformed embed timestamp rather than a later field", async (mode) => {
    const api = await open(mode)
    const cases: [Record<string, unknown>, string][] = [
        [{ embeds: [badEmbed], attachments: [], stickers: [sticker] }, "embeds.0.timestamp"],
        [{ embeds: [], attachments: [{ id: 1 }], stickers: [sticker] }, "attachments.0.id"],
        [{ embeds: [badEmbed], mentions: [], mention_roles: ["70"] }, "embeds.0.timestamp"],
        [
            {
                message_snapshots: [
                    {
                        timestamp: "2026-10-08T12:00:00.000Z",
                        type: 0,
                        flags: 0,
                        embeds: [badEmbed],
                        attachments: [],
                        stickers: [sticker],
                    },
                ],
            },
            "message_snapshots.0.embeds.0.timestamp",
        ],
    ]
    for (const [fields, responseField] of cases) {
        api.rest.respond("GET /channels/20/messages/10", {
            body: api.fixtures.message({ id: "10", channel_id: "20", ...fields }),
        })
        expect(await expectErr(api.client.messages.fetch({ channelId: "20", id: "10" }))).toMatchObject({
            reason: "response",
            details: { responseField },
        })
    }
})

test.each(modes)("%s names a malformed forum post owner rather than its first message", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel({ guild_id: "77" })
    api.rest.respond(`GET /channels/${forum.id}`, { body: forum })
    api.rest.respond(`POST /channels/${forum.id}/post-data`, {
        body: {
            threads: {
                "501": {
                    owner: { user: 5 },
                    first_message: api.fixtures.message({ id: "501", channel_id: "501" }),
                },
            },
        },
    })
    expect(await expectErr(api.client.threads.fetchPostData(forum.id, ["501"]))).toMatchObject({
        reason: "response",
        details: { responseField: expect.stringMatching(/^threads\.501\.owner\b/) },
    })
})

const directoryGuild = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: "Fixture directory",
    icon: null,
    banner: null,
    description: "A fixture directory result",
    category_type: 4,
    primary_language: "en-US",
    custom_tags: ["typescript"],
    member_count: 12,
    online_count: 3,
    features: ["DISCOVERABLE"],
    verification_level: 2,
    ...extra,
})

test.each(modes)("%s names a malformed discovery result rather than a later one", async (mode) => {
    const api = await open(mode)
    api.rest.respond("GET /discovery/guilds", {
        body: {
            guilds: [directoryGuild("200", { member_count: "many" }), directoryGuild("201")],
            total: 2,
            category_counts: [],
        },
    })
    expect(await expectErr(api.client.discovery.search())).toMatchObject({
        reason: "response",
        details: { responseField: expect.stringMatching(/^guilds\.0\./) },
    })
})

test.each(modes)("%s names the nested field of a malformed webhook source", async (mode) => {
    const api = await open(mode)
    api.rest.respond("GET /webhooks/101", {
        body: {
            id: "101",
            guild_id: "200",
            channel_id: "300",
            type: 2,
            name: "Announcements",
            avatar: null,
            source_guild: { id: 5, name: "Source community", icon: null },
            source_channel: { id: "301", name: "news" },
        },
    })
    expect(await expectErr(api.client.webhooks.fetch("101"))).toMatchObject({
        reason: "response",
        details: { responseField: "source_guild.id" },
    })
})
