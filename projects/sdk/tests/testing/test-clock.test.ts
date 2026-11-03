// The manual test clock of the default test kit: Each SDK feature that waits follows it, so advancing it runs the
// waiting work without real time, and none of these tests waits for an SDK delay in real time
import { Cause, Effect, Exit, Scope } from "effect"
import { readFile } from "node:fs/promises"
import { setTimeout as realSetTimeout } from "node:timers"
import { describe, expect, onTestFinished, test } from "vitest"
import { ClientClosedError, ConfigurationError } from "../../src/index.js"
import { createTestBot, createTestClient, type TestClientOptions } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"

/** A manual-clock test client that shuts down when the test ends */
function manual(options: TestClientOptions = {}) {
    const test = createTestClient({ ...options, clock: "manual" })
    onTestFinished(() => test.shutdown())
    return test
}

/**
 * Pass n event loop turns on real zero-delay timers, the same turns advance counts, so a test can show that advance is
 * still waiting after far more turns than its own wait for SDK work needs
 */
async function turns(n: number) {
    for (let index = 0; index < n; index++) await new Promise((resolve) => realSetTimeout(resolve, 0))
}

/** A promise the test opens, standing in for application I/O whose timing the test controls */
function gate() {
    let open!: () => void
    const opened = new Promise<void>((resolve) => (open = resolve))
    return { opened, open }
}

/** Track whether a promise has settled, without waiting for it */
function track<A>(promise: PromiseLike<A>) {
    const state = { settled: false, value: undefined as A | undefined }
    void Promise.resolve(promise).then((value) => {
        state.settled = true
        state.value = value
    })
    return state
}

describe("manual test clock", () => {
    test("a delayed task runs when the clock reaches its delay and not one millisecond earlier", async () => {
        const test = manual()
        await test.ready()
        let runs = 0
        test.client.schedule(() => void runs++, { delayMs: 600_000 })
        await test.advance(599_999)
        expect(runs).toBe(0)
        await test.advance(1)
        expect(runs).toBe(1)
        expect(test.failures()).toEqual([])
    })

    test("an interval task advanced by three intervals runs three times, each run's work settling first", async () => {
        const test = manual()
        await test.ready()
        const channelId = test.fixtures.ids.channel
        test.client.schedule(() => test.client.messages.send(channelId, "tick"), {
            delayMs: 60_000,
            intervalMs: 60_000,
        })
        await test.advance(180_000)
        expect(test.requests().map((request) => request.body)).toEqual([
            expect.objectContaining({ content: "tick" }),
            expect.objectContaining({ content: "tick" }),
            expect.objectContaining({ content: "tick" }),
        ])
    })

    test("a waitFor timeout fires when the clock passes it", async () => {
        const test = manual()
        await test.ready()
        const waited = track(test.client.waitFor("typingStart", { timeoutMs: 30_000 }))
        await test.advance(29_999)
        expect(waited.settled).toBe(false)
        await test.advance(1)
        expect(waited.settled).toBe(true)
        expect(waited.value?.isErr() && waited.value.error).toMatchObject({ _tag: "EventWaitError", reason: "timeout" })
    })

    test("a handler awaiting waitFor does not hold the clock still", async () => {
        const test = manual()
        const channelId = test.fixtures.ids.channel
        test.client.on("messageCreate", async (message) => {
            if (message.content !== "!quiz") return
            const answer = await test.client.waitFor("messageCreate", { timeoutMs: 30_000 })
            await test.client.messages.send(channelId, answer.isErr() ? "Time is up" : "Answered")
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!quiz" }))
        await test.advance(30_000)
        expect(test.requests().map((request) => request.body)).toEqual([
            expect.objectContaining({ content: "Time is up" }),
        ])
    })

    test("advance waits while a handler awaits its own work, then fires the timeout the handler starts after it", async () => {
        const test = manual()
        const channelId = test.fixtures.ids.channel
        const read = gate()
        test.client.on("messageCreate", async (message) => {
            if (message.content !== "!quiz") return
            await read.opened
            const answer = await test.client.waitFor("messageCreate", { timeoutMs: 30_000 })
            await test.client.messages.send(channelId, answer.isErr() ? "Time is up" : "Answered")
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!quiz" }))
        const advanced = track(test.advance(30_000))
        await turns(100)
        expect(advanced.settled).toBe(false)
        read.open()
        await test.advance(0)
        expect(advanced.settled).toBe(true)
        expect(test.requests().map((request) => request.body)).toEqual([
            expect.objectContaining({ content: "Time is up" }),
        ])
    })

    test("advance waits while a scheduled task awaits its own work, so its message is sent when advance resolves", async () => {
        const test = manual()
        await test.ready()
        const channelId = test.fixtures.ids.channel
        const read = gate()
        test.client.schedule(
            async () => {
                await read.opened
                await test.client.messages.send(channelId, "reminder")
            },
            { delayMs: 60_000 },
        )
        const advanced = track(test.advance(60_000))
        await turns(100)
        expect(advanced.settled).toBe(false)
        read.open()
        await test.advance(0)
        expect(test.requests().map((request) => request.body)).toEqual([
            expect.objectContaining({ content: "reminder" }),
        ])
    })

    test("a handler doing real file and timer I/O before waitFor gets its timeout", async () => {
        const test = manual()
        const channelId = test.fixtures.ids.channel
        test.client.on("messageCreate", async (message) => {
            if (message.content !== "!quiz") return
            await readFile(new URL(import.meta.url))
            await new Promise((resolve) => realSetTimeout(resolve, 30))
            const answer = await test.client.waitFor("messageCreate", { timeoutMs: 30_000 })
            await test.client.messages.send(channelId, answer.isErr() ? "Time is up" : "Answered")
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "!quiz" }))
        await test.advance(30_000)
        expect(test.requests().map((request) => request.body)).toEqual([
            expect.objectContaining({ content: "Time is up" }),
        ])
    })

    test("say resolves once a command waits on the clock, and advance then lets the command finish", async () => {
        await using test = createTestBot({
            clock: "manual",
            commands: {
                prefix: "!",
                commands: {
                    quiz: {
                        execute: async ({ client, message, reply }) => {
                            await reply("What is 6 times 7?")
                            const answer = await client.waitFor("messageCreate", { timeoutMs: 30_000 })
                            await client.messages.send(message.channelId, answer.isErr() ? "Time is up" : "Answered")
                        },
                    },
                },
            },
        })
        await test.ready()
        expect((await test.say("!quiz")).map((sent) => sent.content)).toEqual(["What is 6 times 7?"])
        await test.advance(30_000)
        expect(test.requests().map((request) => request.body)).toEqual([
            expect.objectContaining({ content: "What is 6 times 7?" }),
            expect.objectContaining({ content: "Time is up" }),
        ])
        expect(test.failures()).toEqual([])
    })

    test("a message collector ends with timeout when the clock passes its total time", async () => {
        const test = manual()
        await test.ready()
        const collector = test.client.messages.collect(test.fixtures.ids.channel, { timeoutMs: 10_000 })
        const result = track(collector.result())
        await test.advance(9_999)
        expect(result.settled).toBe(false)
        await test.advance(1)
        expect(result.value?.isOk() && result.value.value.reason).toBe("timeout")
    })

    // Middleware runs the rest of the command separately, so both dispatch paths are checked
    test.each([
        ["without", []],
        ["with", [(_context: unknown, next: () => Promise<void>) => next()]],
    ] as const)("a command cooldown %s middleware expires when the clock passes it", async (_name, use) => {
        await using bot = createTestBot({
            clock: "manual",
            commands: {
                prefix: "!",
                onReject: "silent",
                use,
                commands: { ping: { cooldown: { durationMs: 10_000 }, execute: ({ reply }) => reply("Pong!") } },
            },
        })
        await bot.ready()
        expect(await bot.say("!ping")).toEqual([expect.objectContaining({ content: "Pong!" })])
        expect(await bot.say("!ping")).toEqual([])
        await bot.advance(9_999)
        expect(await bot.say("!ping")).toEqual([])
        await bot.advance(1)
        expect(await bot.say("!ping")).toEqual([expect.objectContaining({ content: "Pong!" })])
        expect(bot.failures()).toEqual([])
    })

    test("a cached snapshot expires when the clock passes its maxAgeMs", async () => {
        const test = manual({ cache: { users: { maxAgeMs: 60_000 } } })
        await test.ready()
        const user = test.fixtures.user({ id: test.fixtures.nextId() })
        test.emit("USER_UPDATE", user)
        await test.idle()
        expect(test.client.users.get(user.id)).toBeDefined()
        await test.advance(59_999)
        expect(test.client.users.get(user.id)).toBeDefined()
        await test.advance(1)
        expect(test.client.users.get(user.id)).toBeUndefined()
    })

    test("a rate-limited request is retried when the clock passes Fluxer's retry time", async () => {
        const test = manual()
        let answers = 0
        test.rest.respond("POST /channels/:id/messages", () =>
            answers++ === 0
                ? {
                      status: 429,
                      headers: { "retry-after": "5" },
                      body: { code: "RATE_LIMITED", message: "fixture", retry_after: 5, global: false },
                  }
                : { body: test.fixtures.message({ content: "sent" }) },
        )
        await test.ready()
        const sent = track(test.client.messages.send(test.fixtures.ids.channel, "hello"))
        await test.advance(4_999)
        expect(sent.settled).toBe(false)
        expect(test.requests()).toHaveLength(1)
        await test.advance(1)
        expect(test.requests()).toHaveLength(2)
        expect(sent.value?.isOk()).toBe(true)
    })

    test("presence updates are paced by the clock", async () => {
        const test = manual()
        await test.ready()
        const presences = () => test.commands().filter((command) => command.op === 3)
        expect(test.client.presence.set({ status: "idle" }).isOk()).toBe(true)
        await test.idle()
        expect(test.client.presence.set({ status: "dnd" }).isOk()).toBe(true)
        await test.idle()
        expect(presences()).toHaveLength(1)
        await test.advance(3_999)
        expect(presences()).toHaveLength(1)
        await test.advance(1)
        expect(presences().map((command) => (command.d as { status?: unknown }).status)).toEqual(["idle", "dnd"])
    })

    test("a member chunk request times out when the clock passes its timeout", async () => {
        const test = manual()
        await test.ready()
        const results: unknown[] = []
        const done = track(
            (async () => {
                for await (const result of test.client.members.iterateChunks(
                    test.fixtures.ids.guild,
                    { query: "a", limit: 10 },
                    { timeoutMs: 20_000 },
                ))
                    results.push(result.isErr() ? result.error : "chunk")
            })(),
        )
        await test.advance(19_999)
        expect(done.settled).toBe(false)
        await test.advance(1)
        expect(done.settled).toBe(true)
        expect(results).toEqual([expect.objectContaining({ _tag: "MemberChunkError", reason: "timeout" })])
    })

    test("keepTyping refreshes the typing indicator on the clock", async () => {
        const test = manual()
        await test.ready()
        const { promise: work, resolve: finish } = Promise.withResolvers<string>()
        const typed = () => test.requests().filter((request) => request.path.endsWith("/typing")).length
        test.rest.respond("POST /channels/:id/typing", { status: 204 })
        const kept = track(test.client.messages.keepTyping(test.fixtures.ids.channel, () => work))
        await test.advance(7_999)
        expect(typed()).toBe(1)
        await test.advance(1)
        expect(typed()).toBe(2)
        finish("done")
        await test.idle()
        expect(kept.value?.isOk() && kept.value.value).toBe("done")
    })

    test("a dropped connection reconnects once the clock passes the reconnect delay", async () => {
        const test = manual()
        await test.ready()
        test.disconnect()
        await test.idle()
        expect(test.client.state).not.toBe("Connected")
        // The first reconnect waits a random part of a few seconds, which advance covers
        await test.advance(10_000)
        expect(test.client.state).toBe("Connected")
        expect(test.counters().resumes).toBe(1)
    })

    test("shutdown does not wait for a handler that waits on the clock", async () => {
        const test = createTestClient({ clock: "manual" })
        let started = false
        test.client.on("messageCreate", async () => {
            started = true
            await test.client.waitFor("typingStart", { timeoutMs: 60_000 })
        })
        await test.ready()
        test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "hello" }))
        await test.advance(0)
        expect(started).toBe(true)
        await test.shutdown()
        expect(test.client.state).toBe("Closed")
    })

    test("the gateway heartbeat follows the clock", async () => {
        const test = manual({ heartbeatIntervalMs: 10_000 })
        await test.ready()
        const heartbeats = () => test.commands().filter((command) => command.op === 1).length
        const before = heartbeats()
        await test.advance(30_000)
        expect(heartbeats() - before).toBe(3)
    })
})

describe("manual test clock misuse", () => {
    test("advance needs the manual clock and a finite, non-negative ms", async () => {
        await using real = createTestClient()
        expect(() => real.advance(1)).toThrow(ConfigurationError)
        expect(() => real.advance(1)).toThrow(
            expect.objectContaining({ hint: expect.stringContaining('clock: "manual"') }),
        )
        const test = manual()
        for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5" as never])
            expect(() => test.advance(ms)).toThrow(ConfigurationError)
        await test.shutdown()
        await expect(test.advance(1)).rejects.toBeInstanceOf(ClientClosedError)
    })

    test("an unknown clock value and a manual clock with several local shards are rejected", () => {
        expect(() => createTestClient({ clock: "fake" as never })).toThrow(ConfigurationError)
        expect(() => createTestClient({ clock: "manual", sharding: { totalShards: 2 } })).toThrow(
            expect.objectContaining({ field: "sharding" }),
        )
        expect(() => createTestBot({ clock: "manual", sharding: { totalShards: 4, shardIds: [0, 1] } })).toThrow(
            ConfigurationError,
        )
    })

    test("a manual clock with automatic sharding is rejected in both spellings, and one owned shard is accepted", async () => {
        for (const sharding of ["auto", { totalShards: "auto" }] as const) {
            expect(() => createTestClient({ clock: "manual", sharding })).toThrow(
                expect.objectContaining({ field: "sharding" }),
            )
            expect(() => createTestBot({ clock: "manual", sharding })).toThrow(
                expect.objectContaining({ field: "sharding" }),
            )
        }
        await using test = createTestClient({ clock: "manual", sharding: { totalShards: 2, shardIds: [1] } })
        await test.ready()
        expect(test.client.shards.map((shard) => shard.shardId)).toEqual([1])
    })

    test("the native test client points to TestClock instead of accepting a clock option", async () => {
        const scope = Scope.makeUnsafe()
        const exit = await Effect.runPromiseExit(
            createNativeTestClient({ clock: "manual" } as never).pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(Scope.close(scope, Exit.void))
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
            _tag: "ConfigurationError",
            hint: expect.stringContaining("TestClock"),
        })
    })
})
