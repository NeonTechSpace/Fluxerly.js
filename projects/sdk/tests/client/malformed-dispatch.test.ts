import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, type ClientDiagnostics, type LogRecord, type Message } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { createTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes } from "../support/both-apis.js"
import { sdkClock } from "../support/client-clock.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs } from "../support/log-capture.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const message = (id: string, content = `Message ${id}`) => ({
    id,
    channel_id: "20",
    content,
    author: { id: "30", username: "fixture" },
})

async function gateway() {
    const fixture = await startGatewayServer()
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    return fixture
}

test.each(modes)(
    "%s skips a malformed known dispatch with its field path, keeps the session and clears the cached copy",
    async (mode) => {
        const server = await gateway()
        const logs = captureLogs()
        const received: string[] = []
        const options = {
            token: "fixture-only-not-a-credential",
            cache: { messages: true },
            logging: logs.logging,
        } as const
        const scope = Scope.makeUnsafe()
        let client: { readonly state: string; diagnostics(): ClientDiagnostics }
        let cached: () => Promise<Message | undefined>
        if (mode === "default") {
            const created = createClient(options)
            onTestFinished(async () => {
                await created.shutdown()
            })
            created.on("messageCreate", (value) => {
                received.push(value.id)
            })
            created.on("messageUpdate", (value) => {
                received.push(`update:${value.id}`)
            })
            expect((await created.connect()).isOk()).toBe(true)
            client = created
            cached = async () => created.messages.get({ id: "10", channelId: "20" })
        } else {
            const created = await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
            onTestFinished(async () => {
                await Effect.runPromise(created.shutdown())
                await Effect.runPromise(Scope.close(scope, Exit.void))
            })
            await Effect.runPromise(
                created
                    .on("messageCreate", (value) => Effect.sync(() => received.push(value.id)))
                    .pipe(Scope.provide(scope)),
            )
            await Effect.runPromise(
                created
                    .on("messageUpdate", (value) => Effect.sync(() => received.push(`update:${value.id}`)))
                    .pipe(Scope.provide(scope)),
            )
            await Effect.runPromise(created.connect())
            client = created
            cached = () => Effect.runPromise(created.messages.get({ id: "10", channelId: "20" }))
        }
        server.dispatch("MESSAGE_CREATE", message("10"))
        await vi.waitFor(() => expect(received).toEqual(["10"]))
        expect(await cached()).toMatchObject({ id: "10" })

        server.dispatch("MESSAGE_UPDATE", { ...message("10"), author: { id: 30, username: "fixture" } })
        server.dispatch("MESSAGE_CREATE", message("11"))
        await vi.waitFor(() => expect(received).toEqual(["10", "11"]))
        expect(client.state).toBe("Connected")
        expect(await cached()).toBeUndefined()
        expect(client.diagnostics().counters).toMatchObject({ protocolFailures: 1, eventsDropped: { malformed: 1 } })
        expect(logs.withCode("gateway.dispatchRejected")[0]).toMatchObject({
            level: "warn",
            category: "gateway",
            shardId: 0,
            fields: { dispatch: "MESSAGE_UPDATE", field: "author.id" },
        })
        expect(JSON.stringify(logs.records)).not.toContain("Message 10")
    },
)

test("unknown dispatch types and opcodes are counted and recorded at Debug without affecting the session", async () => {
    const server = await gateway()
    const logs = captureLogs()
    const client = createClient({
        token: "fixture-only-not-a-credential",
        logging: { categories: { gateway: "debug" }, ...logs.logging },
    })
    onTestFinished(async () => {
        await client.shutdown()
    })
    expect((await client.connect()).isOk()).toBe(true)
    server.dispatch("FUTURE_FEATURE_UPDATE", { value: 1 })
    server.send({ op: 42, d: null })
    await vi.waitFor(() =>
        expect(client.diagnostics().counters).toMatchObject({ unknownDispatches: 1, unknownOpcodes: 1 }),
    )
    expect(logs.withCode("gateway.unknownDispatch")[0]).toMatchObject({
        level: "debug",
        fields: { dispatch: "FUTURE_FEATURE_UPDATE" },
    })
    expect(logs.withCode("gateway.unknownOpcode")[0]).toMatchObject({
        level: "debug",
        fields: { opcode: 42 },
    })
    expect(logs.withCode("gateway.dispatch")[0]).toBeDefined()
    expect(client.state).toBe("Connected")
})

test("terminate keeps a malformed known dispatch terminal and names it in the protocol failure", async () => {
    const server = await gateway()
    const client = createClient({
        token: "fixture-only-not-a-credential",
        gateway: { onMalformedDispatch: "terminate" },
        logging: { level: "silent" },
    })
    onTestFinished(async () => {
        await client.shutdown()
    })
    expect((await client.connect()).isOk()).toBe(true)
    server.dispatch("TYPING_START", { channel_id: "20", user_id: "30", timestamp: "soon" })
    const closed = await client.waitForClose()
    expect(closed.isErr() && closed.error).toMatchObject({
        _tag: "ConnectionError",
        reason: "protocol",
        code: "connection.gateway.protocol",
        details: { dispatch: "TYPING_START", field: "timestamp", opcode: 0 },
    })
})

const guildChannel = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    guild_id: "40",
    type: 0,
    name: "fixture",
    position: 1,
    parent_id: null,
    topic: null,
    last_message_id: null,
    last_pin_timestamp: null,
    rate_limit_per_user: 0,
    nsfw: false,
    permission_overwrites: [],
    ...extra,
})

test.each(modes)(
    "%s a skipped dispatch without a usable channel or guild ID still clears the entries it could have changed",
    async (mode) => {
        const server = await gateway()
        const logs = captureLogs()
        const options = {
            token: "fixture-only-not-a-credential",
            cache: { messages: true, channels: true },
            logging: logs.logging,
        } as const
        const scope = Scope.makeUnsafe()
        const received: string[] = []
        let cachedMessage: () => Promise<Message | undefined>
        let cachedChannel: () => Promise<unknown>
        if (mode === "default") {
            const created = createClient(options)
            onTestFinished(async () => {
                await created.shutdown()
            })
            created.on("typingStart", (value) => void received.push(String(value.timestamp)))
            expect((await created.connect()).isOk()).toBe(true)
            cachedMessage = async () => created.messages.get({ id: "10", channelId: "20" })
            cachedChannel = async () => created.channels.get("50")
        } else {
            const created = await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
            onTestFinished(async () => {
                await Effect.runPromise(created.shutdown())
                await Effect.runPromise(Scope.close(scope, Exit.void))
            })
            await Effect.runPromise(
                created
                    .on("typingStart", (value) => Effect.sync(() => void received.push(String(value.timestamp))))
                    .pipe(Scope.provide(scope)),
            )
            await Effect.runPromise(created.connect())
            cachedMessage = () => Effect.runPromise(created.messages.get({ id: "10", channelId: "20" }))
            cachedChannel = () => Effect.runPromise(created.channels.get("50"))
        }
        // A later typing event on the same socket proves each skipped dispatch was processed first
        let sequence = 0
        const barrier = async () => {
            server.dispatch("TYPING_START", { channel_id: "20", user_id: "30", timestamp: ++sequence })
            await vi.waitFor(() => expect(received).toContain(String(sequence)))
        }
        server.dispatch("MESSAGE_CREATE", message("10"))
        server.dispatch("CHANNEL_CREATE", guildChannel("50"))
        await barrier()
        expect(await cachedMessage()).toMatchObject({ id: "10" })
        expect(await cachedChannel()).toMatchObject({ id: "50" })

        server.dispatch("MESSAGE_DELETE", { id: "10", channel_id: 20 })
        await barrier()
        expect(await cachedMessage()).toBeUndefined()

        server.dispatch("CHANNEL_UPDATE", guildChannel("50", { guild_id: 40, name: "renamed" }))
        await barrier()
        expect(await cachedChannel()).toBeUndefined()
        expect(logs.withCode("gateway.dispatchRejected").map((record) => record.fields?.dispatch)).toEqual([
            "MESSAGE_DELETE",
            "CHANNEL_UPDATE",
        ])
    },
)

test.each(modes)(
    "%s keeps identical malformed dispatches on different shards in separate records instead of collapsing them",
    async (mode) => {
        const clock = sdkClock()
        const options = { sharding: { totalShards: 2 } }
        // The user ID must be a string, so both shards skip the same dispatch with the same message
        const malformed = { channel_id: "20", user_id: 30, timestamp: 1_767_225_600 }
        let records: () => readonly LogRecord[]
        if (mode === "default") {
            const test = createTestClient(options)
            onTestFinished(() => test.shutdown())
            test.client.on("typingStart", () => undefined)
            const ready = test.ready()
            // The SDK starts the second shard's session one second after the first
            await clock.waiting(1_000)
            await clock.advance(1_000)
            await ready
            // The test gateway delivers each dispatch synchronously, so its record exists when emit returns
            for (const shardId of [0, 1]) test.emit("TYPING_START", malformed, { shardId })
            records = () => test.logs()
        } else {
            const scope = Scope.makeUnsafe()
            onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
            const test = await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
            await Effect.runPromise(test.client.on("typingStart", () => Effect.void).pipe(Scope.provide(scope)))
            const ready = Effect.runPromise(test.ready())
            await clock.waiting(1_000)
            await clock.advance(1_000)
            await ready
            for (const shardId of [0, 1]) await Effect.runPromise(test.emit("TYPING_START", malformed, { shardId }))
            records = () => test.logs()
        }
        expect(
            records()
                .filter((record) => record.code === "gateway.dispatchRejected")
                .map((record) => record.shardId),
        ).toEqual([0, 1])
    },
)
