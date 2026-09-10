import { Deferred, Effect } from "effect"
import { expect, test } from "vitest"
import type { ConnectionState } from "../src/client.js"
import { CollectorError } from "../src/collectors.js"
import { collect } from "../src/internal/collector.js"
import type { ClientOwner } from "../src/internal/client.js"
import { EventBus } from "../src/internal/events.js"
import { collectReactions } from "../src/internal/reaction-collector.js"
import type { Message } from "../src/messages.js"
import type { MessageReaction } from "../src/reactions.js"

function fixture() {
    let aggregate: ConnectionState = "Connected"
    const gatewayStates = new Map<string, ConnectionState>([
        ["40", "Connected"],
        ["41", "Connected"],
    ])
    const aggregateListeners = new Set<(state: ConnectionState) => void>()
    const gatewayListeners = new Map<string, Set<(state: ConnectionState) => void>>()
    const events = new EventBus()
    const owner = {
        get state() {
            return aggregate
        },
        events,
        shardIdForGuild(guildId: string) {
            return guildId === "40" ? 1 : guildId === "41" ? 2 : undefined
        },
        gatewayState(guildId?: string) {
            return guildId === undefined ? aggregate : (gatewayStates.get(guildId) ?? "Disconnected")
        },
        subscribe(listener: (state: ConnectionState) => void) {
            aggregateListeners.add(listener)
            listener(aggregate)
            return () => aggregateListeners.delete(listener)
        },
        subscribeGateway(guildId: string, listener: (state: ConnectionState) => void) {
            let listeners = gatewayListeners.get(guildId)
            if (!listeners) gatewayListeners.set(guildId, (listeners = new Set()))
            listeners.add(listener)
            listener(gatewayStates.get(guildId) ?? "Disconnected")
            return () => {
                listeners.delete(listener)
                if (!listeners.size) gatewayListeners.delete(guildId)
            }
        },
        setAggregate(state: ConnectionState) {
            aggregate = state
            for (const listener of aggregateListeners) listener(state)
        },
        setGateway(guildId: string, state: ConnectionState) {
            gatewayStates.set(guildId, state)
            for (const listener of gatewayListeners.get(guildId) ?? []) listener(state)
        },
    } as unknown as ClientOwner & {
        setAggregate(state: ConnectionState): void
        setGateway(guildId: string, state: ConnectionState): void
    }
    return { events, owner }
}

function message(id: string, guildId?: string): Message {
    return {
        id,
        channelId: "20",
        ...(guildId === undefined ? {} : { guildId }),
        content: id,
        embeds: [],
        attachments: [],
        stickers: [],
        author: { id: "30", username: "fixture", isBot: true },
    }
}

function reaction(userId: string, guildId?: string): MessageReaction {
    return {
        id: "10",
        channelId: "20",
        ...(guildId === undefined ? {} : { guildId }),
        userId,
        emoji: { name: "👍" },
    }
}

test("message collectors isolate owned shard intake and recovery without channel lookup", async () => {
    const { events, owner } = fixture()

    for (const guildId of [null, "0", "01", "18446744073709551616"])
        await expect(Effect.runPromise(collect(owner, "20", { guildId } as never))).rejects.toMatchObject({
            _tag: "ConfigurationError",
            field: "guildId",
        })
    await expect(Effect.runPromise(collect(owner, "20", { guildId: "99" }))).rejects.toMatchObject({
        _tag: "CollectorError",
        reason: "notConnected",
    })
    await expect(Effect.runPromise(collect(owner, "20", { guildId: "18446744073709551615" }))).rejects.toMatchObject({
        _tag: "CollectorError",
        reason: "notConnected",
    })

    const collector = await Effect.runPromise(collect(owner, "20", { guildId: "40" }))
    events.offer("messageCreate", message("wrong-shard", "40"), 10, 0)
    events.offer("messageCreate", message("wrong-guild", "41"), 10, 1)
    // Guild context is optional in gateway payloads. The selected source shard, rather than a cache lookup, isolates it
    events.offer("messageCreate", message("partial"), 10, 1)
    await expect(Effect.runPromise(Deferred.await(collector.closed))).resolves.toMatchObject({
        reason: "limit",
        messages: [expect.objectContaining({ id: "partial" })],
    })

    const healthy = await Effect.runPromise(collect(owner, "20", { guildId: "40" }))
    owner.setGateway("41", "Recovering")
    events.offer("messageCreate", message("healthy", "40"), 10, 1)
    await expect(Effect.runPromise(Deferred.await(healthy.closed))).resolves.toMatchObject({ reason: "limit" })

    const affected = await Effect.runPromise(collect(owner, "20", { guildId: "40" }))
    owner.setGateway("40", "Recovering")
    await expect(Effect.runPromise(Deferred.await(affected.closed))).rejects.toMatchObject({
        _tag: "CollectorError",
        reason: "connectionLost",
    })

    owner.setGateway("40", "Connected")
    const aggregate = await Effect.runPromise(collect(owner, "20"))
    owner.setAggregate("Recovering")
    await expect(Effect.runPromise(Deferred.await(aggregate.closed))).rejects.toMatchObject({
        _tag: "CollectorError",
        reason: "connectionLost",
    })
})

test("reaction collectors use the same shard and known-guild admission rules", async () => {
    const { events, owner } = fixture()
    await expect(
        Effect.runPromise(collectReactions(owner, { id: "10", channelId: "20" }, { guildId: "0" })),
    ).rejects.toMatchObject({ _tag: "ConfigurationError", field: "guildId" })
    const collector = await Effect.runPromise(collectReactions(owner, { id: "10", channelId: "20" }, { guildId: "40" }))
    events.offer("messageReactionAdd", reaction("wrong-shard", "40"), 10, 0)
    events.offer("messageReactionAdd", reaction("wrong-guild", "41"), 10, 1)
    events.offer("messageReactionAdd", reaction("partial"), 10, 1)
    await expect(Effect.runPromise(Deferred.await(collector.closed))).resolves.toMatchObject({
        reason: "limit",
        reactions: [expect.objectContaining({ userId: "partial" })],
    })

    const affected = await Effect.runPromise(collectReactions(owner, { id: "10", channelId: "20" }, { guildId: "40" }))
    owner.setGateway("40", "Recovering")
    await expect(Effect.runPromise(Deferred.await(affected.closed))).rejects.toBeInstanceOf(CollectorError)
})

test("scoped collectors end when their ready shard returns to Disconnected during partial startup cleanup", async () => {
    const { events, owner } = fixture()
    owner.setAggregate("Connecting")
    const messages = await Effect.runPromise(collect(owner, "20", { guildId: "40" }))
    const reactions = await Effect.runPromise(collectReactions(owner, { id: "10", channelId: "20" }, { guildId: "40" }))
    owner.setGateway("40", "Disconnected")
    owner.setGateway("40", "Connected")
    events.offer("messageCreate", message("after-reconnect", "40"), 10, 1)
    events.offer("messageReactionAdd", reaction("after-reconnect", "40"), 10, 1)
    for (const closed of [
        Deferred.await(messages.closed).pipe(Effect.asVoid),
        Deferred.await(reactions.closed).pipe(Effect.asVoid),
    ])
        await expect(Effect.runPromise(closed)).rejects.toMatchObject({
            _tag: "CollectorError",
            reason: "connectionLost",
        })
})
