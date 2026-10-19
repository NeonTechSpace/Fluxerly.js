import { describe, expect, onTestFinished, test } from "vitest"
import { createTestClient } from "../../src/testing.js"
import { waitUntil } from "../support/clock.js"

describe("eventsDroppedByEvent", () => {
    test("a full message collector's ignored event is counted under messageCreate", async () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const release = Promise.withResolvers<void>()
        const entered = Promise.withResolvers<void>()
        await test.ready()
        test.client.messages.collect("20", {
            maxMessages: 1,
            onMessage: async () => {
                entered.resolve()
                await release.promise
            },
        })
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "first", channel_id: "20" }))
        await entered.promise
        // The collector holds its limit while the callback runs, so the next event is ignored
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "second", channel_id: "20" }))
        await waitUntil(() => test.counters().eventsDropped.collector === 1)
        expect(test.counters().eventsDroppedByEvent).toEqual({ messageCreate: 1 })
        release.resolve()
    })

    test("a full reaction collector's ignored event is counted under messageReactionAdd", async () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const release = Promise.withResolvers<void>()
        const entered = Promise.withResolvers<void>()
        await test.ready()
        test.client.messages.collectReactions(
            { id: "10", channelId: "20" },
            {
                maxReactions: 1,
                onReaction: async () => {
                    entered.resolve()
                    await release.promise
                },
            },
        )
        const reaction = { message_id: "10", channel_id: "20", user_id: "30", emoji: { name: "✅" } }
        test.emit("MESSAGE_REACTION_ADD", reaction)
        await entered.promise
        test.emit("MESSAGE_REACTION_ADD", { ...reaction, user_id: "31" })
        await waitUntil(() => test.counters().eventsDropped.collector === 1)
        expect(test.counters().eventsDroppedByEvent).toEqual({ messageReactionAdd: 1 })
        release.resolve()
    })

    test("a skipped malformed dispatch is counted under its event only when the type names one event", async () => {
        const test = createTestClient({ gateway: { onMalformedDispatch: "skip" } })
        onTestFinished(() => test.shutdown())
        await test.ready()
        test.emit("MESSAGE_DELETE", { not: "a delete" })
        await waitUntil(() => test.counters().eventsDropped.malformed === 1)
        expect(test.counters().eventsDroppedByEvent).toEqual({ messageDelete: 1 })
        // CHANNEL_CREATE delivers guildChannelCreate and directMessageCreate, so only the reason total counts it
        test.emit("CHANNEL_CREATE", { not: "a channel" })
        await waitUntil(() => test.counters().eventsDropped.malformed === 2)
        expect(test.counters().eventsDroppedByEvent).toEqual({ messageDelete: 1 })
    })

    test("malformed reaction dispatches are counted under the event they would have delivered", async () => {
        const test = createTestClient({ gateway: { onMalformedDispatch: "skip" } })
        onTestFinished(() => test.shutdown())
        await test.ready()
        test.emit("MESSAGE_REACTION_ADD", { not: "a reaction" })
        test.emit("MESSAGE_REACTION_ADD_MANY", { not: "a batch" })
        await waitUntil(() => test.counters().eventsDropped.malformed === 2)
        expect(test.counters().eventsDroppedByEvent).toEqual({ messageReactionAdd: 1, messageReactionAddMany: 1 })
    })

    test("events a draining shutdown refuses are counted by name", async () => {
        const test = createTestClient()
        const release = Promise.withResolvers<void>()
        const entered = Promise.withResolvers<void>()
        test.client.on("messageCreate", async () => {
            entered.resolve()
            await release.promise
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "running" }))
        await entered.promise
        const draining = test.client.shutdown({ drainMs: 60_000 })
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "late" }))
        release.resolve()
        await draining
        expect(test.counters().eventsDropped.closed).toBe(1)
        expect(test.counters().eventsDroppedByEvent).toEqual({ messageCreate: 1 })
    })
})
