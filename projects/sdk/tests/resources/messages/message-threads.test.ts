import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { ChannelType, MessageFlags, MessageType, type MessageFields } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes } from "../../support/both-apis.js"
import { expectErr, settle } from "../../support/settle.js"

// Fluxer 4749eb7f: MessageResponseSchemas gives a message that started a thread its thread object, and the thread
// documents describe HAS_THREAD and the THREAD_CREATED notice that references only its thread
const selections: { label: string; fields: MessageFields | undefined }[] = [
    { label: "full", fields: undefined },
    { label: "minimal", fields: [] },
]
const cases = modes.flatMap((mode) => selections.map((selection) => ({ mode, ...selection })))

async function open(mode: (typeof modes)[number], messageFields: MessageFields | undefined) {
    const options = { messageFields }
    if (mode === "default") {
        const test = createDefaultTestClient(options)
        onTestFinished(() => test.shutdown())
        return { test, fetch: (target: { id: string; channelId: string }) => test.client.messages.fetch(target) }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
    return { test, fetch: (target: { id: string; channelId: string }) => test.client.messages.fetch(target) }
}

test.each(cases)("$mode $label reads the thread a message started and thread notices", async ({ mode, fields }) => {
    const { test, fetch } = await open(mode, fields)
    const { fixtures } = test
    const starter = fixtures.message({ content: "Release plan", flags: MessageFlags.HasThread })
    const thread = fixtures.thread({ id: starter.id, name: "Release plan", member_count: 2 })
    const notice = fixtures.message({
        type: MessageType.ThreadCreated,
        content: "Release plan",
        message_reference: { channel_id: thread.id, guild_id: fixtures.ids.guild, type: 0 },
    })
    test.rest.respond(`GET /channels/${starter.channel_id}/messages/${starter.id}`, {
        body: { ...starter, thread },
    })
    test.rest.respond(`GET /channels/${notice.channel_id}/messages/${notice.id}`, { body: notice })

    const read = await settle(fetch({ id: starter.id, channelId: starter.channel_id }))
    const readNotice = await settle(fetch({ id: notice.id, channelId: notice.channel_id }))
    // The type is part of MessageCore, so a selection never drops it
    expect(readNotice.type).toBe(MessageType.ThreadCreated)
    if (fields !== undefined) {
        expect(Object.hasOwn(read, "thread")).toBe(false)
        return
    }
    expect(read).toMatchObject({ flags: MessageFlags.HasThread })
    expect("thread" in read && read.thread).toMatchObject({
        id: starter.id,
        type: ChannelType.PublicThread,
        parentId: fixtures.ids.channel,
        name: "Release plan",
        memberCount: 2,
    })
    expect("messageReference" in readNotice && readNotice.messageReference).toEqual({
        channelId: thread.id,
        guildId: fixtures.ids.guild,
        type: 0,
    })
})

test.each(cases)("$mode $label rejects a message whose thread is malformed", async ({ mode, fields }) => {
    const { test, fetch } = await open(mode, fields)
    const starter = test.fixtures.message({ flags: MessageFlags.HasThread })
    const { owner_id: _owner, ...thread } = test.fixtures.thread({ id: starter.id })
    test.rest.respond(`GET /channels/${starter.channel_id}/messages/${starter.id}`, { body: { ...starter, thread } })
    // Selection changes construction only, so an unselected thread is still validated
    expect(await expectErr(fetch({ id: starter.id, channelId: starter.channel_id }))).toMatchObject({
        reason: "response",
    })
})
