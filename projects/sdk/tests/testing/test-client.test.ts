import { setImmediate as turn } from "node:timers/promises"
import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import { describe, expect, onTestFinished, test, vi } from "vitest"
import {
    ClientClosedError,
    ConfigurationError,
    type EventMap,
    type EventName,
    type LogRecord,
} from "../../src/index.js"
import {
    createTestClient as createDefaultTestClient,
    type TestClient as DefaultTestClient,
    type TestClientOptions,
} from "../../src/testing.js"
import {
    createTestClient as createNativeTestClient,
    type TestClient as NativeTestClient,
} from "../../src/effect-testing.js"
import * as nativeTesting from "../../src/effect-testing.js"
import * as defaultTesting from "../../src/testing.js"
import { fixtureToken } from "../../src/internal/testing/fixtures.js"
import { modes, type Mode } from "../support/both-apis.js"
import { settle } from "../support/settle.js"

/**
 * One test client driven through either API style with the same promise-returning calls, so each behavior below is
 * checked once per style. Native effects run here, and native registrations use the test-owned scope
 */
interface Driver {
    readonly test: DefaultTestClient | NativeTestClient
    ready(): Promise<void>
    emit(type: string, payload: unknown, options?: { readonly shardId?: number }): Promise<void>
    disconnect(options?: { readonly shardId?: number; readonly code?: number }): Promise<void>
    on<K extends EventName>(event: K, handler: (value: EventMap[K]) => void): Promise<void>
    shutdown(): Promise<void>
}

async function open(mode: Mode, options: TestClientOptions = {}): Promise<Driver> {
    if (mode === "default") {
        const test = createDefaultTestClient(options)
        onTestFinished(() => test.shutdown())
        return {
            test,
            ready: () => test.ready(),
            emit: async (type, payload, emitOptions) => test.emit(type, payload, emitOptions),
            disconnect: async (disconnectOptions) => test.disconnect(disconnectOptions),
            on: async (event, handler) => void test.client.on(event, (value) => handler(value as never)),
            shutdown: () => test.shutdown(),
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient(options as never).pipe(Scope.provide(scope)))
    return {
        test,
        ready: () => Effect.runPromise(test.ready()),
        emit: (type, payload, emitOptions) => Effect.runPromise(test.emit(type, payload, emitOptions)),
        disconnect: (disconnectOptions) => Effect.runPromise(test.disconnect(disconnectOptions)),
        on: async (event, handler) => {
            await Effect.runPromise(
                test.client.on(event, (value) => Effect.sync(() => handler(value as never))).pipe(Scope.provide(scope)),
            )
        },
        shutdown: () => Effect.runPromise(test.shutdown()),
    }
}

/** Resolve with the first value a handler receives */
function first<A>() {
    const { promise, resolve } = Promise.withResolvers<A>()
    return { promise, handler: (value: A) => resolve(value) }
}

/** The failure a promise rejects with, or the defect a native Effect died with */
async function misuse(run: () => Promise<unknown>): Promise<unknown> {
    try {
        await run()
    } catch (error) {
        if (Cause.isCause(error)) return Cause.squash(error)
        // Effect.runPromise rejects with the squashed defect for a failed or dying Effect
        return error
    }
    return expect.fail("Expected the control to fail")
}

describe.each(modes)("%s test client", (mode) => {
    test("rejects auto-suppressed events registered after READY without consuming a sequence", async () => {
        const driver = await open(mode, { gateway: { ignoredEvents: "auto" } })
        await driver.ready()
        const deliveries: unknown[] = []
        await driver.on("typingStart", (event) => void deliveries.push(event))
        const raw = first<EventMap["raw"]>()
        await driver.on("raw", raw.handler)
        const error = await misuse(() => driver.emit("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 }))
        expect(error).toBeInstanceOf(ConfigurationError)
        expect(error).toMatchObject({ field: "event", hint: expect.any(String) })
        await driver.emit("FIXTURE_ONLY_UNKNOWN", {})
        expect(await raw.promise).toMatchObject({ t: "FIXTURE_ONLY_UNKNOWN", s: 2 })
        expect(deliveries).toEqual([])
    })

    test("Resume retains automatic filtering after late registrations", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
        const driver = await open(mode, { gateway: { ignoredEvents: "auto" } })
        try {
            await driver.ready()
            const deliveries: unknown[] = []
            await driver.on("typingStart", (event) => void deliveries.push(event))
            const wire = { channel_id: "20", user_id: "30", timestamp: 1 }
            const recover = async (ready: () => boolean) => {
                for (let step = 0; step < 20 && !ready(); step++) {
                    await turn()
                    await vi.advanceTimersByTimeAsync(1_000)
                    await turn()
                }
                expect(ready()).toBe(true)
            }
            await driver.disconnect()
            await recover(() => driver.test.counters().resumes === 1 && driver.test.client.state === "Connected")
            expect(await misuse(() => driver.emit("TYPING_START", wire))).toBeInstanceOf(ConfigurationError)
            expect(driver.test.commands().filter((command) => command.op === 2)).toHaveLength(1)
            expect(deliveries).toEqual([])
        } finally {
            await driver.shutdown()
            vi.useRealTimers()
        }
    })

    test.each(["early handler", "disabled filtering"] as const)(
        "delivers events with %s at Identify",
        async (configuration) => {
            const driver = await open(mode, {
                gateway: { ignoredEvents: configuration === "early handler" ? "auto" : [] },
            })
            const typed = first<EventMap["typingStart"]>()
            if (configuration === "early handler") await driver.on("typingStart", typed.handler)
            await driver.ready()
            if (configuration === "disabled filtering") await driver.on("typingStart", typed.handler)
            await driver.emit("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 })
            expect(await typed.promise).toMatchObject({ channelId: "20", userId: "30" })
        },
    )

    test("explicit suppression rejects registered and unknown event types", async () => {
        const driver = await open(mode, { gateway: { ignoredEvents: ["typing_start", "FIXTURE_ONLY_UNKNOWN"] } })
        await driver.on("raw", () => {})
        await driver.on("typingStart", () => {})
        await driver.ready()
        for (const type of ["TYPING_START", "FIXTURE_ONLY_UNKNOWN"])
            expect(await misuse(() => driver.emit(type, {}))).toBeInstanceOf(ConfigurationError)
    })

    test("auto filtering retains the source of registered reaction batches", async () => {
        const driver = await open(mode, {
            gateway: { ignoredEvents: "auto", flags: { debounceMessageReactions: true } },
        })
        const received = first<EventMap["messageReactionAddMany"]>()
        await driver.on("messageReactionAddMany", received.handler)
        await driver.ready()
        const identify = driver.test.commands().find((command) => command.op === 2)!
        expect((identify.d as { ignored_events: readonly string[] }).ignored_events).not.toContain(
            "MESSAGE_REACTION_ADD",
        )
        const fixtures = driver.test.fixtures
        const id = fixtures.nextId()
        await driver.emit("MESSAGE_REACTION_ADD_MANY", {
            channel_id: fixtures.ids.channel,
            message_id: id,
            reactions: [{ user_id: fixtures.ids.user, emoji: { name: "thumbs-up" } }],
        })
        expect(await received.promise).toMatchObject({ channelId: fixtures.ids.channel, id })
    })

    test.each([
        { ignored: "MESSAGE_REACTION_ADD", delivered: false },
        { ignored: "MESSAGE_REACTION_ADD_MANY", delivered: true },
    ])("applies $ignored suppression to generated reaction batches", async ({ ignored, delivered }) => {
        const driver = await open(mode, { gateway: { ignoredEvents: [ignored] } })
        const received = first<EventMap["messageReactionAddMany"]>()
        await driver.on("messageReactionAddMany", received.handler)
        await driver.ready()
        const warning = driver.test.logs().find((record) => record.code === "gateway.ignoredEventRegistered")
        if (delivered) expect(warning).toBeUndefined()
        else expect(warning).toMatchObject({ fields: { events: "messageReactionAddMany" } })
        const fixtures = driver.test.fixtures
        const wire = {
            channel_id: fixtures.ids.channel,
            message_id: fixtures.nextId(),
            reactions: [{ user_id: fixtures.ids.user, emoji: { name: "thumbs-up" } }],
        }
        if (delivered) {
            await driver.emit("MESSAGE_REACTION_ADD_MANY", wire)
            expect(await received.promise).toMatchObject({ channelId: fixtures.ids.channel, id: wire.message_id })
        } else
            expect(await misuse(() => driver.emit("MESSAGE_REACTION_ADD_MANY", wire))).toBeInstanceOf(
                ConfigurationError,
            )
    })

    test.each([
        { name: "ordinary messages", mention: "none", delivered: false },
        { name: "other-user mentions", mention: "other", delivered: false },
        { name: "role-only mentions", mention: "role", delivered: false },
        { name: "direct messages without mentions", mention: "dm", delivered: false },
        { name: "own messages without mentions", mention: "own", delivered: false },
        { name: "bot mentions", mention: "bot", delivered: true },
        { name: "everyone mentions", mention: "everyone", delivered: true },
        { name: "here mentions", mention: "here", delivered: true },
    ])("applies ignored MESSAGE_CREATE to $name", async ({ mention, delivered }) => {
        const driver = await open(mode, { gateway: { ignoredEvents: ["MESSAGE_CREATE"] } })
        const received = first<EventMap["messageCreate"]>()
        await driver.on("messageCreate", received.handler)
        await driver.ready()
        const fixtures = driver.test.fixtures
        const wire = {
            ...fixtures.message(),
            ...(mention === "other" ? { mentions: [fixtures.user()] } : {}),
            ...(mention === "bot" ? { mentions: [fixtures.botUser()] } : {}),
            ...(mention === "role" ? { mention_roles: [fixtures.ids.guild] } : {}),
            ...(mention === "dm" ? { guild_id: undefined } : {}),
            ...(mention === "own" ? { author: fixtures.botUser() } : {}),
            ...(mention === "everyone" ? { mention_everyone: true } : {}),
            ...(mention === "here" ? { mention_here: true } : {}),
        }
        if (delivered) {
            await driver.emit("MESSAGE_CREATE", wire)
            expect(await received.promise).toMatchObject({ id: wire.id })
        } else expect(await misuse(() => driver.emit("MESSAGE_CREATE", wire))).toBeInstanceOf(ConfigurationError)
    })

    test("mention exceptions use the configured session user rather than the default fixture bot", async () => {
        const user = defaultTesting.createFixtures().botUser({ id: "999" })
        const driver = await open(mode, { user, gateway: { ignoredEvents: ["MESSAGE_CREATE"] } })
        const received = first<EventMap["messageCreate"]>()
        await driver.on("messageCreate", received.handler)
        await driver.ready()
        const fixtures = driver.test.fixtures
        expect(
            await misuse(() =>
                driver.emit("MESSAGE_CREATE", { ...fixtures.message(), mentions: [fixtures.botUser()] }),
            ),
        ).toBeInstanceOf(ConfigurationError)
        const wire = { ...fixtures.message(), mentions: [user] }
        await driver.emit("MESSAGE_CREATE", wire)
        expect(await received.promise).toMatchObject({ id: wire.id })
    })

    test("connects through the fake gateway with READY for Identify and records commands without the token", async () => {
        const driver = await open(mode)
        await driver.ready()
        expect(driver.test.client.state).toBe("Connected")
        const identify = driver.test.commands().find((command) => command.op === 2)
        expect(identify).toMatchObject({ shardId: 0, op: 2, d: { token: "[redacted]" } })
        expect(identify?.d).not.toHaveProperty("shard")
        expect(JSON.stringify(driver.test.commands())).not.toContain(fixtureToken)
        // Discovery is served in memory, so no HTTP request was needed to connect
        expect(driver.test.requests()).toEqual([])
    })

    test("emitted wire dispatches pass through the real decoders and message cache before handlers run", async () => {
        const driver = await open(mode, { cache: { messages: true } })
        const received = first<EventMap["messageCreate"]>()
        let cachedAtDelivery: unknown
        await driver.on("messageCreate", (message) => {
            cachedAtDelivery = driver.test.client.messages.get(message)
            received.handler(message)
        })
        await driver.ready()
        const wire = driver.test.fixtures.message({ content: "!ping" })
        await driver.emit("MESSAGE_CREATE", wire)
        const message = await received.promise
        expect(message).toMatchObject({
            id: wire.id,
            channelId: wire.channel_id,
            guildId: wire.guild_id,
            content: "!ping",
            author: { id: wire.author.id, username: wire.author.username, isBot: false },
        })
        const cached = await settle(driver.test.client.messages.get(message))
        expect(cached).toMatchObject({ id: wire.id })
        expect(await settle(cachedAtDelivery as never)).toMatchObject({ id: wire.id })
    })

    test("guild and member fixtures populate resource caches through GUILD_CREATE and GUILD_MEMBER_ADD", async () => {
        const driver = await open(mode, { cache: { guilds: true, members: true, roles: true, channels: true } })
        const joined = first<EventMap["guildMemberAdd"]>()
        await driver.on("guildMemberAdd", joined.handler)
        await driver.ready()
        const { fixtures } = driver.test
        await driver.emit("GUILD_CREATE", fixtures.guildCreate({ guild: { name: "Cached Guild" } }))
        const member = fixtures.member({ nick: "Fixture" })
        await driver.emit("GUILD_MEMBER_ADD", member)
        expect(await joined.promise).toMatchObject({ guildId: fixtures.ids.guild, userId: fixtures.ids.user })
        expect(await settle(driver.test.client.guilds.get(fixtures.ids.guild))).toMatchObject({ name: "Cached Guild" })
        expect(
            await settle(driver.test.client.members.get({ guildId: fixtures.ids.guild, userId: fixtures.ids.user })),
        ).toMatchObject({ nickname: "Fixture" })
    })

    test("rest.respond answers matching requests, hands handlers the parsed body and records requests without credentials", async () => {
        const driver = await open(mode)
        const { fixtures, rest } = driver.test
        let seenBody: unknown
        const sent = rest.respond("POST /channels/:channelId/messages", (request) => {
            seenBody = request.body
            return { body: fixtures.message({ content: String((request.body as { content: string }).content) }) }
        })
        const message = await settle(driver.test.client.messages.send(fixtures.ids.channel, { content: "hello" }))
        expect(message).toMatchObject({ channelId: fixtures.ids.channel, content: "hello" })
        expect(seenBody).toMatchObject({ content: "hello" })
        expect(sent.requests()).toHaveLength(1)
        const [request] = driver.test.requests()
        expect(request).toMatchObject({
            method: "POST",
            path: `/channels/${fixtures.ids.channel}/messages`,
            body: { content: "hello" },
            matched: true,
        })
        expect(request!.headers).not.toHaveProperty("authorization")
        expect(JSON.stringify(driver.test.requests())).not.toContain(fixtureToken)
    })

    test("unmatched requests receive a Fluxer-shaped 404 and a Warn record", async () => {
        const driver = await open(mode)
        const result = driver.test.client.users.fetch(driver.test.fixtures.ids.user)
        await expect(settle(result)).rejects.toMatchObject({ status: 404 })
        expect(driver.test.requests()).toEqual([
            expect.objectContaining({ method: "GET", path: `/users/${driver.test.fixtures.ids.user}`, matched: false }),
        ])
        expect(driver.test.logs()).toContainEqual(
            expect.objectContaining({ level: "warn", code: "testing.unmatchedRequest", status: 404 }),
        )
    })

    test("emitted dispatches reach the shard a guild routes to and resume with that shard's sequence", async () => {
        const driver = await open(mode, { sharding: { totalShards: 2 } })
        await driver.ready()
        const identifies = driver.test.commands().filter((command) => command.op === 2)
        expect(identifies.map((command) => (command.d as { shard: unknown }).shard).toSorted()).toEqual([
            [0, 2],
            [1, 2],
        ])
        // A guild ID whose timestamp bits are odd routes to shard 1 of 2
        const guildId = String((1n << 22n) + 5n)
        const typing = { channel_id: "20", user_id: "30", timestamp: 1_767_225_600, guild_id: guildId }
        await driver.emit("TYPING_START", typing)
        await driver.emit("TYPING_START", { ...typing, guild_id: undefined }, { shardId: 1 })
        await driver.disconnect({ shardId: 1 })
        await expect.poll(() => driver.test.client.state, { timeout: 10_000 }).toBe("Connected")
        await expect.poll(() => driver.test.counters().resumes, { timeout: 10_000 }).toBe(1)
        const resume = driver.test.commands().find((command) => command.op === 6)
        // READY is sequence 1, so the two dispatches left shard 1 at sequence 3 and shard 0 untouched
        expect(resume).toMatchObject({ shardId: 1, d: { seq: 3, token: "[redacted]" } })
        expect(await misuse(() => driver.emit("TYPING_START", typing, { shardId: 2 }))).toBeInstanceOf(
            ConfigurationError,
        )
    }, 20_000)

    test("controls reject emits before ready and after shutdown, and shutdown leaves no gateway sockets open", async () => {
        const driver = await open(mode)
        const message = driver.test.fixtures.message()
        expect(await misuse(() => driver.emit("MESSAGE_CREATE", message))).toBeInstanceOf(ConfigurationError)
        expect(await misuse(() => driver.emit("READY", {}))).toBeInstanceOf(ConfigurationError)
        await driver.ready()
        expect(await misuse(() => driver.emit("messageCreate", message))).toBeInstanceOf(ConfigurationError)
        await driver.shutdown()
        expect(driver.test.client.state).toBe("Closed")
        expect(await misuse(() => driver.emit("MESSAGE_CREATE", message))).toBeInstanceOf(ClientClosedError)
        expect(driver.test.logs().map((record) => record.code)).not.toContain("testing.socketsLeftOpen")
        await driver.shutdown()
    })

    test("logs capture records at the caller's level while caller sinks still receive them, and counters read diagnostics", async () => {
        const sinkRecords: LogRecord[] = []
        const driver = await open(mode, {
            logging: { level: "debug", sink: (record) => void sinkRecords.push(record) },
        })
        await driver.ready()
        await driver.emit("FIXTURE_ONLY_UNKNOWN", {})
        expect(driver.test.logs().map((record) => record.code)).toEqual(
            expect.arrayContaining(["lifecycle.ready", "gateway.dispatch", "gateway.unknownDispatch"]),
        )
        expect(sinkRecords).toEqual(driver.test.logs())
        expect(driver.test.counters()).toEqual(driver.test.client.diagnostics().counters)
        expect(driver.test.counters().unknownDispatches).toBe(1)
        const quiet = await open(mode)
        await quiet.ready()
        expect(quiet.test.logs().some((record) => record.level === "debug")).toBe(false)
        expect(quiet.test.logs().map((record) => record.code)).toContain("lifecycle.ready")
    })
})

// The export inventories and the shared fixtures and fixtureToken are checked by contract/module-conformance.test.ts
test("both entry points share the fixture builder factory", () => {
    expect(nativeTesting.createFixtures).toBe(defaultTesting.createFixtures)
})

test("response registrations match newest first, by method, RegExp, predicate and absolute URL, until removed", async () => {
    const test = createDefaultTestClient()
    onTestFinished(() => test.shutdown())
    const { rest, fixtures } = test
    const userPath = `/users/${fixtures.ids.user}`
    rest.respond("/users/:id", { body: fixtures.user({ username: "older" }) })
    const newer = rest.respond(
        { method: "get", path: /^\/users\/\d+$/ },
        { body: fixtures.user({ username: "newer" }) },
    )
    expect(await settle(test.client.users.fetch(fixtures.ids.user))).toMatchObject({ username: "newer" })
    newer.remove()
    expect(await settle(test.client.users.fetch(fixtures.ids.user))).toMatchObject({ username: "older" })
    rest.respond(
        (request) => request.path === userPath && request.method === "GET",
        Response.json(fixtures.user({ username: "raw" })),
    )
    // A registered Response answers repeatedly with its own copy each time
    expect(await settle(test.client.users.fetch(fixtures.ids.user))).toMatchObject({ username: "raw" })
    expect(await settle(test.client.users.fetch(fixtures.ids.user))).toMatchObject({ username: "raw" })
    expect(newer.requests()).toHaveLength(1)

    for (const invalid of ["GET", "GET users", "GET /a /b", 42, { path: 1 }, { method: "G T", path: "/a" }])
        expect(() => rest.respond(invalid as never, {})).toThrow(ConfigurationError)
    for (const invalid of [null, { status: 99 }, { status: 204, body: {} }, { headers: { a: 1 } }])
        expect(() => rest.respond("/a", invalid as never)).toThrow(ConfigurationError)
})

test("a throwing response handler fails the request as a network error and logs the application failure", async () => {
    const test = createDefaultTestClient()
    onTestFinished(() => test.shutdown())
    test.rest.respond("POST /channels/:id/typing", () => {
        throw new Error("fixture handler failure")
    })
    const result = await test.client.messages.typing(test.fixtures.ids.channel)
    expect(result.isErr() && result.error).toMatchObject({ reason: "network" })
    expect(test.logs()).toContainEqual(
        expect.objectContaining({
            level: "error",
            code: "testing.responderFailed",
            error: expect.objectContaining({ message: "fixture handler failure" }),
        }),
    )
})

test("test clients reject caller transport and instance options before creating a client", () => {
    for (const option of [{ transport: {} }, { instance: { url: "https://fluxer.example" } }, null])
        expect(() => createDefaultTestClient(option as never)).toThrow(ConfigurationError)
    expect(() => createDefaultTestClient({ heartbeatIntervalMs: 0 })).toThrow(ConfigurationError)
})

test("a native program can emit in the same fiber that became ready, while READY is still being delivered", async () => {
    const content = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const test = yield* createNativeTestClient()
                const received = yield* Effect.forkScoped(test.client.waitFor("messageCreate"))
                yield* Effect.yieldNow
                // Connect completes synchronously inside the READY delivery, so emit must already see the shard as ready
                yield* test.ready()
                yield* test.emit("MESSAGE_CREATE", test.fixtures.message({ content: "same fiber" }))
                const message = yield* Fiber.join(received)
                return message.content
            }),
        ),
    )
    expect(content).toBe("same fiber")
})

test("native test client scopes shut the client down and close the transport", async () => {
    let captured: NativeTestClient | undefined
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const test = yield* createNativeTestClient()
                captured = test
                yield* test.ready()
            }),
        ),
    )
    expect(captured?.client.state).toBe("Closed")
    const exit = await Effect.runPromiseExit(captured!.emit("MESSAGE_CREATE", captured!.fixtures.message()))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(ClientClosedError)
})

/** Long-lived handles, leaving out the Immediate callbacks the runner queues and drains between turns */
const handles = () =>
    process
        .getActiveResourcesInfo()
        .filter((kind) => kind !== "Immediate")
        .toSorted()

test("shutdown releases every handle the test client opened", async () => {
    const before = handles()
    const test = createDefaultTestClient({ heartbeatIntervalMs: 1_000 })
    test.rest.respond("POST /channels/:id/typing", {})
    await test.ready()
    await settle(test.client.messages.typing(test.fixtures.ids.channel))
    await test.shutdown()
    // Heartbeat timers, request deadlines and sockets are all released, leaving only what the runner already held
    await expect.poll(handles).toEqual(before)
})
