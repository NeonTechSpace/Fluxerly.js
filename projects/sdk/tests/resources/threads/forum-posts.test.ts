import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { ChannelType } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { expectErr, settle } from "../../support/settle.js"

// Fluxer 4749eb7f: ThreadController creates a forum or media post from POST /channels/:id/threads with the first message
// in the body, takes files as files[n] parts beside payload_json, and answers 201 with the thread and its message
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

test.each(modes)("%s creates a forum post with a file in one multipart request", async (mode) => {
    const api = await open(mode)
    const { fixtures } = api
    const forum = fixtures.forumChannel()
    const post = fixtures.thread({ parent_id: forum.id, name: "Crash on start", applied_tags: ["5"] })
    const first = fixtures.message({ id: post.id, channel_id: post.id, content: "Log attached" })
    const route = api.rest.respond(`POST /channels/${forum.id}/threads`, {
        status: 201,
        body: { ...post, message: first },
    })

    const created = await settle(
        api.client.threads.createPost(
            forum.id,
            {
                name: "Crash on start",
                appliedTagIds: ["5"],
                autoArchiveMinutes: 10_080,
                message: {
                    content: "Log attached",
                    attachments: [{ data: new Uint8Array([1, 2, 3]), filename: "log.txt", contentType: "text/plain" }],
                },
            },
            { auditReason: "Bug report" },
        ),
    )
    expect(created.thread).toMatchObject({ id: post.id, type: ChannelType.PublicThread, appliedTagIds: ["5"] })
    expect(created.message).toMatchObject({ id: first.id, channelId: post.id, content: "Log attached" })
    expect(Object.isFrozen(created)).toBe(true)

    // The test transport has presigned uploads off, so every request it records is the post itself
    expect(api.requests()).toHaveLength(1)
    const request = route.requests()[0]!
    expect(request.headers["x-audit-log-reason"]).toBe("Bug report")
    expect(request.files).toEqual([{ field: "files[0]", filename: "log.txt", contentType: "text/plain", size: 3 }])
    expect(request.body).toMatchObject({
        name: "Crash on start",
        applied_tags: ["5"],
        auto_archive_duration: 10_080,
        message: { content: "Log attached", attachments: [{ id: 0, filename: "log.txt" }] },
    })
    // Fluxer's forum message schema has no nonce, so the post sends none
    expect(request.body).not.toHaveProperty("message.nonce")
})

test.each(modes)("%s creates a forum post without files as JSON", async (mode) => {
    const api = await open(mode)
    const { fixtures } = api
    const forum = fixtures.forumChannel({ type: ChannelType.Media })
    const post = fixtures.thread({ parent_id: forum.id })
    const route = api.rest.respond(`POST /channels/${forum.id}/threads`, {
        status: 201,
        body: { ...post, message: fixtures.message({ channel_id: post.id, content: "Hello" }) },
    })
    const created = await settle(
        api.client.threads.createPost(forum.id, { name: "Hello", message: { content: "Hello" } }),
    )
    expect(created.thread.id).toBe(post.id)
    expect(route.requests()[0]).toMatchObject({
        headers: { "content-type": "application/json" },
        files: [],
        body: { name: "Hello", message: { content: "Hello", allowed_mentions: { parse: [] } } },
    })
})

test.each(modes)("%s rejects message settings a post's first message cannot carry", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel().id
    const cases = [
        { message: { content: "Hi", nonce: "1" }, path: "message" },
        { message: { content: "Hi", tts: true }, path: "message" },
        { message: { content: "Hi", messageReference: { id: "1", channelId: forum } }, path: "message" },
        { message: { content: "" }, path: "message" },
        { message: { content: "Hi", flags: 32 }, path: "message.flags" },
    ]
    for (const { message, path } of cases)
        expect(
            await expectErr(api.client.threads.createPost(forum, { name: "Post", message: message as never })),
            JSON.stringify(message),
        ).toMatchObject({ reason: "input", outcome: "notDispatched", inputValidation: { path } })
    expect(api.requests()).toEqual([])
})

test.each(modes)("%s rejects a post whose first message is not in its thread", async (mode) => {
    const api = await open(mode)
    const { fixtures } = api
    const forum = fixtures.forumChannel()
    const post = fixtures.thread({ parent_id: forum.id })
    api.rest.respond(`POST /channels/${forum.id}/threads`, {
        status: 201,
        body: { ...post, message: fixtures.message({ content: "Elsewhere" }) },
    })
    expect(
        await expectErr(api.client.threads.createPost(forum.id, { name: "Post", message: { content: "Hi" } })),
    ).toMatchObject({ reason: "response", outcome: "unknown" })
})
