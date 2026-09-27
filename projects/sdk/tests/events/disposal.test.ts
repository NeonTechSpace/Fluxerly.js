import { afterEach, expect, test, vi } from "vitest"
import {
    createClient,
    EventOverflowError,
    type Client,
    type Collector,
    type ConnectionState,
    type EventSubscription,
    type ReactionCollector,
    type Subscription,
} from "../../src/index.js"
import { defaultApi, fixtureToken } from "../support/both-apis.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

// Disposal hooks are a default-API contract; native resources are released by their owning Scope

async function connected() {
    const server = await startGatewayServer()
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const client: Client = defaultApi()
    await settle(client.connect())
    return { server, client }
}

const typing = (timestamp: number) => ({ channel_id: "20", user_id: "30", timestamp })
const message = (id: string) => ({
    id,
    channel_id: "20",
    content: "fixture",
    author: { id: "30", username: "fixture" },
})

test("await using shuts a default client down at the end of its block", async () => {
    let escaped: Client | undefined
    {
        await using client = createClient({ token: fixtureToken })
        escaped = client
        expect(client.state).toBe("Disconnected")
    }
    expect(escaped.state).toBe("Closed")
    expect((await escaped.waitForClose()).isOk()).toBe(true)
})

test("await using closes a subscription, signals its running handler and releases it before the block ends", async () => {
    const { server, client } = await connected()
    const handled: number[] = []
    const signals: AbortSignal[] = []
    const started = Promise.withResolvers<void>()
    let escaped: Subscription | undefined
    {
        await using subscription = client.on("typingStart", (event, signal) => {
            handled.push(event.timestamp)
            signals.push(signal)
            started.resolve()
            return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        })
        escaped = subscription
        server.dispatch("TYPING_START", typing(1))
        await started.promise
        expect(signals[0]?.aborted).toBe(false)
    }
    expect(signals[0]?.aborted).toBe(true)
    expect((await escaped.waitForClose()).isOk()).toBe(true)
    // A later subscription is the barrier: once it has received two more events, the closed one would have too
    await using barrier = client.subscribe("typingStart")
    server.dispatch("TYPING_START", typing(2))
    expect(await settle(barrier.next())).toMatchObject({ timestamp: 2 })
    server.dispatch("TYPING_START", typing(3))
    expect(await settle(barrier.next())).toMatchObject({ timestamp: 3 })
    expect(handled).toEqual([1])
})

test("await using an overflowed event subscription does not rethrow its overflow outcome", async () => {
    const { server, client } = await connected()
    const subscription = client.subscribe("typingStart", { maxPendingMessages: 1 })
    for (const timestamp of [1, 2, 3]) server.dispatch("TYPING_START", typing(timestamp))
    const closed = await subscription.waitForClose()
    expect(closed.isErr() && closed.error).toBeInstanceOf(EventOverflowError)
    // Disposal settles even though the subscription already ended with a failure
    await expect(subscription[Symbol.asyncDispose]()).resolves.toBeUndefined()
    {
        await using open = client.subscribe("typingStart", { maxPendingMessages: 1 })
        for (const timestamp of [4, 5, 6]) server.dispatch("TYPING_START", typing(timestamp))
        await vi.waitFor(async () => expect((await open.waitForClose()).isErr()).toBe(true))
    }
    // The outcome stays readable after disposal
    const after = await subscription.waitForClose()
    expect(after.isErr() && after.error).toBeInstanceOf(EventOverflowError)
})

test("await using an event subscription closes it so next reports the end", async () => {
    const { client } = await connected()
    let escaped: EventSubscription<"typingStart"> | undefined
    {
        await using subscription = client.subscribe("typingStart")
        escaped = subscription
    }
    expect((await escaped.waitForClose()).isOk()).toBe(true)
    expect(await settle(escaped.next())).toBeNull()
})

test("await using closes a message collector, awaits its result and does not rethrow a failed outcome", async () => {
    const { server, client } = await connected()
    let stopped: Collector | undefined
    {
        await using collector = client.messages.collect("20", { maxMessages: 5 })
        stopped = collector
    }
    server.dispatch("MESSAGE_CREATE", message("10"))
    const result = await stopped.result()
    expect(result.isOk() && result.value).toEqual({ reason: "stopped", messages: [] })

    const failure = new Error("callback failure")
    let failed: Collector | undefined
    {
        await using collector = client.messages.collect("20", {
            maxMessages: 5,
            onMessage: () => {
                throw failure
            },
        })
        failed = collector
        server.dispatch("MESSAGE_CREATE", message("11"))
        await vi.waitFor(async () => expect((await collector.result()).isErr()).toBe(true))
    }
    const outcome = await failed.result()
    expect(outcome.isErr() && outcome.error).toMatchObject({
        _tag: "CollectorError",
        reason: "handler",
        cause: failure,
    })
})

test("await using closes a reaction collector and does not rethrow a failed outcome", async () => {
    const { server, client } = await connected()
    const target = { id: "10", channelId: "20" }
    let stopped: ReactionCollector | undefined
    {
        await using collector = client.messages.collectReactions(target, { maxReactions: 5 })
        stopped = collector
    }
    const result = await stopped.result()
    expect(result.isOk() && result.value.reason).toBe("stopped")

    const failure = new Error("reaction callback failure")
    let failed: ReactionCollector | undefined
    {
        await using collector = client.messages.collectReactions(target, {
            maxReactions: 5,
            onReaction: () => Promise.reject(failure),
        })
        failed = collector
        server.dispatch("MESSAGE_REACTION_ADD", {
            message_id: "10",
            channel_id: "20",
            user_id: "30",
            emoji: { name: "✅" },
        })
        await vi.waitFor(async () => expect((await collector.result()).isErr()).toBe(true))
    }
    const outcome = await failed.result()
    expect(outcome.isErr() && outcome.error).toMatchObject({ reason: "handler", cause: failure })
})

test("using a state observer stops delivery at the end of its block", async () => {
    await startGatewayServer()
    stubFetchWithHostedDiscovery(async () => Response.json({}))
    const client: Client = defaultApi()
    const states: ConnectionState[] = []
    {
        using _observer = client.observeState((state) => void states.push(state))
        await vi.waitFor(() => expect(states).toEqual(["Disconnected"]))
    }
    // A later observer is the barrier: once it has seen the connection, the ended one would have too
    const later: ConnectionState[] = []
    using _later = client.observeState((state) => void later.push(state))
    await settle(client.connect())
    await vi.waitFor(() => expect(later).toContain("Connected"))
    expect(states).toEqual(["Disconnected"])
})
