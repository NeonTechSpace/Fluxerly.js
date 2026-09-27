import { Deferred, Effect, Exit, Scope } from "effect"
import { describe, expect, onTestFinished, test, vi } from "vitest"
import { ConfigurationError, type FailureReport } from "../../src/index.js"
import { createTestBot, createTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"

/** Gates keyed by message content, so a test decides when each handler invocation finishes */
function gates() {
    const pending = new Map<string, PromiseWithResolvers<void>>()
    const gate = (content: string) => {
        let entry = pending.get(content)
        if (!entry) pending.set(content, (entry = Promise.withResolvers<void>()))
        return entry
    }
    return { wait: (content: string) => gate(content).promise, release: (content: string) => gate(content).resolve() }
}

describe("default API partition", () => {
    test("events of one channel run in order while another channel's events run beside them", async () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const { wait, release } = gates()
        const started: string[] = []
        const finished: string[] = []
        test.client.on(
            "messageCreate",
            async (message) => {
                started.push(message.content)
                await wait(message.content)
                finished.push(message.content)
            },
            { partition: "channel" },
        )
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a1", channel_id: "101" }))
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "a2", channel_id: "101" }))
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "b1", channel_id: "202" }))
        // b1 starts although a1 is still running, and a2 waits for a1 in its own channel
        await vi.waitFor(() => expect(started).toEqual(["a1", "b1"]))
        release("b1")
        await vi.waitFor(() => expect(finished).toEqual(["b1"]))
        expect(started).toEqual(["a1", "b1"])
        release("a1")
        await vi.waitFor(() => expect(started).toEqual(["a1", "b1", "a2"]))
        release("a2")
        await vi.waitFor(() => expect(finished).toEqual(["b1", "a1", "a2"]))
    })

    test("a partition function keys events, and a throwing one reports that event's failure without stopping others", async () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        const handled: string[] = []
        const reports: FailureReport[] = []
        const failure = new Error("no key")
        test.client.on("messageCreate", (message) => void handled.push(message.content), {
            partition: (message) => {
                if (message.content === "bad") throw failure
                return message.author.id
            },
            onError: (report) => void reports.push(report),
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "bad" }))
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "good" }))
        await vi.waitFor(() => expect(handled).toEqual(["good"]))
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        expect(reports[0]).toMatchObject({ kind: "handler", event: "messageCreate", error: failure })
    })

    test("an invalid partition throws ConfigurationError", () => {
        const test = createTestClient()
        onTestFinished(() => test.shutdown())
        expect(() => test.client.on("messageCreate", () => undefined, { partition: "user" as never })).toThrow(
            expect.objectContaining({ _tag: "ConfigurationError", field: "partition" }),
        )
        expect(() => test.client.on("messageCreate", () => undefined, { partition: 5 as never })).toThrow(
            ConfigurationError,
        )
    })

    test("a runBot handler accepts partition and then runs several communities at once by default", async () => {
        const { wait, release } = gates()
        const started: string[] = []
        const test = createTestBot({
            events: {
                guildMemberAdd: {
                    partition: "guild",
                    handler: async ({ event }) => {
                        started.push(event.guildId)
                        await wait(event.guildId)
                    },
                },
            },
        })
        onTestFinished(() => test.shutdown())
        await test.ready()
        test.emit("GUILD_MEMBER_ADD", test.fixtures.member({ guild_id: "301" }))
        test.emit("GUILD_MEMBER_ADD", test.fixtures.member({ guild_id: "301" }))
        test.emit("GUILD_MEMBER_ADD", test.fixtures.member({ guild_id: "302" }))
        await vi.waitFor(() => expect(started).toEqual(["301", "302"]))
        release("301")
        await vi.waitFor(() => expect(started).toEqual(["301", "302", "301"]))
        release("302")
    })
})

describe("native API partition", () => {
    test("events of one channel run in order while another channel's events run beside them", async () => {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        const test = await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
        const pending = new Map<string, Deferred.Deferred<void>>()
        const gate = (content: string) => {
            let entry = pending.get(content)
            if (!entry) pending.set(content, (entry = Deferred.makeUnsafe<void>()))
            return entry
        }
        const started: string[] = []
        await Effect.runPromise(
            test.client
                .on(
                    "messageCreate",
                    (message) =>
                        Effect.sync(() => started.push(message.content)).pipe(
                            Effect.andThen(Deferred.await(gate(message.content))),
                        ),
                    { partition: (message) => message.channelId },
                )
                .pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(test.ready())
        for (const [content, channel] of [
            ["a1", "101"],
            ["a2", "101"],
            ["b1", "202"],
        ] as const)
            await Effect.runPromise(
                test.emit("MESSAGE_CREATE", test.fixtures.message({ content, channel_id: channel })),
            )
        await vi.waitFor(() => expect(started).toEqual(["a1", "b1"]))
        Deferred.doneUnsafe(gate("a1"), Effect.void)
        await vi.waitFor(() => expect(started).toEqual(["a1", "b1", "a2"]))
        Deferred.doneUnsafe(gate("a2"), Effect.void)
        Deferred.doneUnsafe(gate("b1"), Effect.void)
    })
})
