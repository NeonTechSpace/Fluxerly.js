import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { createTestClient as createDefaultTestClient, type TestClientOptions } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { expectErr, settle } from "../../support/settle.js"

// Fluxer 5f3fc0b1: ForumController serves POST /channels/:id/post-data with thread_ids, and ThreadForumService answers
// { threads: { [id]: { owner, first_message } } } for every distinct requested ID, null for IDs that are not posts there.
// The owner is a guild member without guild_id
async function open(mode: Mode, options: Pick<TestClientOptions, "cache"> = {}) {
    if (mode === "default") {
        const test = createDefaultTestClient(options)
        onTestFinished(() => test.shutdown())
        return test
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
}

/** A REST guild member as Fluxer's member mapper sends it, with the full partial user */
const owner = (userId: string) => ({
    user: {
        id: userId,
        username: "ada",
        discriminator: "0001",
        global_name: "Ada",
        avatar: "a1b2",
        avatar_color: null,
        flags: 0,
    },
    nick: null,
    avatar: null,
    banner: null,
    accent_color: null,
    roles: [],
    joined_at: "2026-10-08T12:00:00.000Z",
    mute: false,
    deaf: false,
    communication_disabled_until: null,
})

test.each(modes)("%s reads post owners and first messages in request order", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel({ guild_id: "77" })
    const first = api.fixtures.message({ id: "501", channel_id: "501", content: "How do I start?" })
    const second = api.fixtures.message({ id: "502", channel_id: "502", content: "Webhook post" })
    api.rest.respond(`GET /channels/${forum.id}`, { body: forum })
    const route = api.rest.respond(`POST /channels/${forum.id}/post-data`, {
        body: {
            threads: {
                "501": { owner: owner("40"), first_message: first },
                "502": { owner: null, first_message: second },
                "503": { owner: null, first_message: null },
            },
        },
    })

    const posts = await settle(api.client.threads.fetchPostData(forum.id, ["503", "501", "502"]))
    expect(posts.map((post) => post.threadId)).toEqual(["503", "501", "502"])
    expect(posts[0]).toEqual({ threadId: "503", owner: null, firstMessage: null })
    expect(posts[1]!.owner).toMatchObject({
        guildId: "77",
        userId: "40",
        user: { id: "40", displayName: "Ada", avatar: "a1b2" },
    })
    expect(posts[1]!.firstMessage).toMatchObject({ id: "501", channelId: "501", content: "How do I start?" })
    expect(posts[2]).toMatchObject({ owner: null, firstMessage: { channelId: "502" } })
    expect(Object.isFrozen(posts) && posts.every(Object.isFrozen)).toBe(true)
    expect(route.requests()[0]!.body).toEqual({ thread_ids: ["503", "501", "502"] })
    // The forum's community comes from one channel read, since the channel cache is off
    expect(api.requests().map((request) => `${request.method} ${request.path}`)).toEqual([
        `GET /channels/${forum.id}`,
        `POST /channels/${forum.id}/post-data`,
    ])
})

test.each(modes)("%s takes the community from the channel cache without an extra read", async (mode) => {
    const api = await open(mode, { cache: { channels: true } })
    const forum = api.fixtures.forumChannel({ guild_id: "77" })
    api.rest.respond(`GET /channels/${forum.id}`, { body: forum })
    await settle(api.client.channels.fetch(forum.id))
    api.rest.respond(`POST /channels/${forum.id}/post-data`, {
        body: { threads: { "501": { owner: owner("40"), first_message: null } } },
    })

    const posts = await settle(api.client.threads.fetchPostData(forum.id, ["501", "501"]))
    expect(posts.map((post) => post.owner?.guildId)).toEqual(["77", "77"])
    expect(api.requests().map((request) => request.path)).toEqual([
        `/channels/${forum.id}`,
        `/channels/${forum.id}/post-data`,
    ])
})

test.each(modes)(
    "%s rejects a post data answer with a missing entry or a first message from elsewhere",
    async (mode) => {
        const api = await open(mode, { cache: { channels: true } })
        const forum = api.fixtures.forumChannel()
        api.rest.respond(`GET /channels/${forum.id}`, { body: forum })
        await settle(api.client.channels.fetch(forum.id))
        const answers = [
            { threads: { "501": { owner: null, first_message: null } } },
            {
                threads: {
                    "501": { owner: null, first_message: api.fixtures.message({ id: "900", channel_id: "900" }) },
                    "502": { owner: null, first_message: null },
                },
            },
        ]
        for (const body of answers) {
            api.rest.respond(`POST /channels/${forum.id}/post-data`, { body })
            expect(await expectErr(api.client.threads.fetchPostData(forum.id, ["501", "502"]))).toMatchObject({
                _tag: "ChannelOperationError",
                operation: "threads.fetchPostData",
                reason: "response",
            })
        }
    },
)

test.each(modes)("%s checks post IDs before sending", async (mode) => {
    const api = await open(mode)
    for (const threadIds of [[], Array.from({ length: 101 }, (_, index) => String(index + 1)), ["post"]])
        expect(await expectErr(api.client.threads.fetchPostData("10", threadIds))).toMatchObject({
            operation: "threads.fetchPostData",
            reason: "input",
            outcome: "notDispatched",
        })
    expect(api.requests()).toEqual([])
})
