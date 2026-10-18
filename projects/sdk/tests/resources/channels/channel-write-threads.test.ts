import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { ChannelType, type Client } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { describeBothApis, type Mode } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"

// Fluxer 8a7c791: ThreadViews.withLiveTags drops removed forum tags from posts on read, and no thread update is sent

/** A connected test client in either API style with the channel cache enabled, driven through the default call shapes */
async function open(mode: Mode) {
    const options = { cache: { channels: true }, gateway: { ignoredEvents: [] } } as const
    if (mode === "default") {
        const test = createDefaultTestClient(options)
        onTestFinished(() => test.shutdown())
        await test.ready()
        return { test, client: test.client, emit: (type: string, body: unknown) => test.emit(type, body) }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
    await Effect.runPromise(test.ready())
    return {
        test,
        // Settling runs each native Effect, so the default method shapes describe both clients here
        client: test.client as unknown as Client,
        emit: (type: string, body: unknown) => Effect.runSync(test.emit(type, body)),
    }
}

describeBothApis("channel writes that change threads without thread events", (mode) => {
    async function filled() {
        const driver = await open(mode)
        const { fixtures, rest } = driver.test
        const tag = { id: fixtures.nextId(), name: "bug", moderated: false, emoji_id: null, emoji_name: null }
        const text = fixtures.channel()
        const forum = fixtures.forumChannel({ available_tags: [tag] })
        const textThread = fixtures.thread({ parent_id: text.id })
        const post = fixtures.thread({ parent_id: forum.id, applied_tags: [tag.id] })
        const untagged = fixtures.thread({ parent_id: forum.id, applied_tags: [] })
        const all = [text, forum, textThread, post, untagged]
        const refill = () =>
            driver.emit(
                "GUILD_CREATE",
                fixtures.guildCreate({ channels: [text, forum], threads: [textThread, post, untagged] }),
            )
        refill()
        const held = async () => {
            const kept: string[] = []
            for (const channel of all)
                if ((await settle(driver.client.channels.get(channel.id))) !== undefined) kept.push(channel.id)
            return kept
        }
        expect(await held()).toEqual(all.map((channel) => channel.id))
        rest.respond("PATCH /channels/:id", (request) => ({
            body: request.path.endsWith(forum.id) ? forum : { ...text, ...(request.body as object), id: text.id },
        }))
        rest.respond("DELETE /channels/:id", { status: 204 })
        rest.respond("/channels/:id/tags/:tag", { body: forum })
        return { ...driver, tag, text, forum, textThread, post, untagged, refill, held }
    }

    /** Hold a read of one channel until the returned release, answering with the given body */
    async function heldRead<B extends { readonly id: string }>(driver: Awaited<ReturnType<typeof filled>>, body: B) {
        let release!: () => void
        const answered = new Promise<void>((resolve) => (release = resolve))
        const route = driver.test.rest.respond(`GET /channels/${body.id}`, async () => {
            await answered
            return { body }
        })
        const read = settle(driver.client.channels.fetch(body.id))
        await route.next()
        return { read, release }
    }

    test("a type conversion or deletion of a channel removes its cached threads, unlike a rename", async () => {
        const { client, text, forum, textThread, post, untagged, refill, held } = await filled()
        await settle(client.channels.edit(text.id, { name: "renamed" }))
        expect(await held()).toEqual([forum.id, textThread.id, post.id, untagged.id])

        refill()
        await settle(client.channels.edit(text.id, { type: ChannelType.Announcement }))
        expect(await held()).toEqual([forum.id, post.id, untagged.id])

        refill()
        await settle(client.channels.delete(text.id))
        expect(await held()).toEqual([forum.id, post.id, untagged.id])
    })

    test("a channel update event that converts a cached channel's type removes its cached threads", async () => {
        const { emit, text, forum, textThread, post, untagged, held } = await filled()
        emit("CHANNEL_UPDATE", { ...text, name: "renamed" })
        expect(await held()).toEqual([text.id, forum.id, textThread.id, post.id, untagged.id])
        // Fluxer retypes the archived threads of a converted channel without thread updates
        emit("CHANNEL_UPDATE", { ...text, type: ChannelType.Announcement })
        expect(await held()).toEqual([text.id, forum.id, post.id, untagged.id])
    })

    test("removing forum tags removes only the posts applying one, while editing a tag keeps them", async () => {
        const { client, tag, text, forum, textThread, post, untagged, refill, held } = await filled()
        await settle(client.channels.editForumTag(forum.id, tag.id, { name: "renamed" }))
        expect(await held()).toEqual([text.id, textThread.id, post.id, untagged.id])

        refill()
        await settle(client.channels.deleteForumTag(forum.id, tag.id))
        expect(await held()).toEqual([text.id, textThread.id, untagged.id])

        refill()
        await settle(client.channels.edit(forum.id, { availableTags: [] }))
        expect(await held()).toEqual([text.id, textThread.id, untagged.id])

        // An entry that names the tag by ID keeps it
        refill()
        await settle(client.channels.edit(forum.id, { availableTags: [{ id: tag.id, name: "kept" }] }))
        expect(await held()).toEqual([text.id, textThread.id, post.id, untagged.id])
    })

    test("removing forum tags stops a pending read of a post, but not a read of another channel", async () => {
        const driver = await filled()
        const { client, tag, text, forum, post, held } = driver
        const postRead = await heldRead(driver, post)
        const textRead = await heldRead(driver, { ...text, name: "fresh" })
        await settle(client.channels.deleteForumTag(forum.id, tag.id))
        postRead.release()
        textRead.release()
        // The read still answers with the post, but the cache does not keep the stale applied tag
        expect((await postRead.read).id).toBe(post.id)
        expect(await held()).not.toContain(post.id)
        await textRead.read
        expect(await settle(client.channels.get(text.id))).toMatchObject({ name: "fresh" })
    })

    test("a forum update event removes only the posts applying a tag it lacks", async () => {
        const { emit, text, forum, textThread, untagged, held } = await filled()
        emit("CHANNEL_UPDATE", { ...forum, available_tags: [] })
        expect(await held()).toEqual([text.id, forum.id, textThread.id, untagged.id])
    })

    test("the echo of a forum rename after the write removed the forum keeps its posts", async () => {
        const { client, emit, text, forum, textThread, post, untagged, held } = await filled()
        await settle(client.channels.edit(forum.id, { name: "renamed" }))
        expect(await held()).toEqual([text.id, textThread.id, post.id, untagged.id])
        emit("CHANNEL_UPDATE", { ...forum, name: "renamed" })
        expect(await held()).toEqual([text.id, forum.id, textThread.id, post.id, untagged.id])
    })
})
