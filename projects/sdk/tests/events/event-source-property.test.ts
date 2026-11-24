/*
 * Seeded property-based tests for EventSource under "stop", "dropOldest" and "dropNewest" overflow policies.
 * Drives multiple partition keys and varying byte sizes, verifying exact byte and message accounting,
 * hard queue bounds, clean overflow termination and partitioned fairness under dropOldest
 */
import { Cause, Effect, Exit } from "effect"
import { expect, test } from "vitest"
import { EventOverflowError } from "../../src/message-errors.js"
import { EventSource } from "../../src/internal/events.js"

const baseSeed = Number(process.env.FLUXERLY_MODEL_SEED ?? 1) >>> 0

function prng(seed: number) {
    let state = seed >>> 0
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0
        let value = state
        value = Math.imul(value ^ (value >>> 15), value | 1)
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
    }
    const below = (count: number) => Math.floor(next() * count)
    return {
        below,
        chance: (probability: number) => next() < probability,
        pick: <T>(items: readonly T[]): T => items[below(items.length)]!,
    }
}

interface SyntheticEvent {
    readonly id: number
    readonly channelId: string
    readonly bytes: number
    readonly badPartition?: boolean
}

const failedGroup = Symbol("failed")
type ShadowGroup = string | typeof failedGroup

function shadowGroupOf(event: SyntheticEvent): ShadowGroup {
    return event.badPartition ? failedGroup : event.channelId
}

/** Reference fairness eviction simulator matching EventSource's partitioned dropOldest contract */
function checkPartitionedDropOldestFairness(
    before: readonly SyntheticEvent[],
    after: readonly SyntheticEvent[],
    arriving: SyntheticEvent,
    maxMessages: number,
    maxBytes: number,
    tag: string,
) {
    const remaining = [...before]
    const counts = new Map<ShadowGroup, number>()
    let usedBytes = 0
    for (const item of remaining) {
        counts.set(shadowGroupOf(item), (counts.get(shadowGroupOf(item)) ?? 0) + 1)
        usedBytes += item.bytes
    }
    const arrivalGroup = shadowGroupOf(arriving)
    let discardArrival = false

    while (remaining.length >= maxMessages || arriving.bytes > maxBytes - usedBytes) {
        if (remaining.length === 0) break
        const ownPostArrival = (counts.get(arrivalGroup) ?? 0) + 1
        let maxOtherCount = 0
        let victimIndex = -1
        let ownOldestIndex = -1

        for (let index = 0; index < remaining.length; index++) {
            const group = shadowGroupOf(remaining[index]!)
            if (group === arrivalGroup) {
                if (ownOldestIndex === -1) ownOldestIndex = index
                continue
            }
            const count = counts.get(group) ?? 0
            if (count > maxOtherCount) {
                maxOtherCount = count
                victimIndex = index
            }
        }

        const chosenIndex = maxOtherCount > ownPostArrival ? victimIndex : ownOldestIndex
        if (chosenIndex === -1) {
            discardArrival = true
            break
        }
        const [evicted] = remaining.splice(chosenIndex, 1)
        const victimGroup = shadowGroupOf(evicted!)
        if (maxOtherCount > ownPostArrival) {
            // Never evict from a shorter backlog while a strictly longer backlog exists
            expect(counts.get(victimGroup), `${tag}: evicted shorter backlog`).toBe(maxOtherCount)
        } else {
            expect(victimGroup, `${tag}: evicted other key without strictly longer backlog`).toBe(arrivalGroup)
        }
        counts.set(victimGroup, (counts.get(victimGroup) ?? 1) - 1)
        usedBytes -= evicted!.bytes
    }

    const expected = discardArrival ? [...before] : [...remaining, arriving]
    expect(after, `${tag}: partitioned dropOldest outcome`).toEqual(expected)
    expect(after.length, `${tag}: post-eviction count bound`).toBeLessThanOrEqual(maxMessages)
    expect(
        after.reduce((sum, item) => sum + item.bytes, 0),
        `${tag}: post-eviction byte bound`,
    ).toBeLessThanOrEqual(maxBytes)
}

test.each(["stop", "dropOldest", "dropNewest"] as const)(
    "EventSource (%s) preserves exact counts, byte accounting, bounds and fairness across random sequences",
    (overflow) => {
        const keys = ["k0", "k1", "k2", "k3", "k4"] as const

        for (const partitioned of [false, true]) {
            for (let trial = 0; trial < 15; trial++) {
                const seed = (baseSeed + trial * 149 + (partitioned ? 10_000 : 0) + overflow.length * 17) >>> 0
                const rng = prng(seed)
                const maxPendingMessages = 3 + rng.below(6)
                const maxPendingBytes = 60 + rng.below(140)
                let released = false

                const source = new EventSource<SyntheticEvent>(
                    {
                        concurrency: 1,
                        maxPendingMessages,
                        maxPendingBytes,
                        overflow,
                        partition: partitioned
                            ? (((event: SyntheticEvent) => {
                                  if (event.badPartition) throw new Error("partition failure")
                                  return event.channelId
                              }) as never)
                            : undefined,
                    },
                    () => {
                        released = true
                    },
                )

                const shadow: SyntheticEvent[] = []
                let nextEventId = 1

                const assertAccounting = (step: number) => {
                    const tag = `overflow=${overflow} partitioned=${partitioned} seed=${seed} step=${step}`
                    const totalBytes = shadow.reduce((sum, item) => sum + item.bytes, 0)
                    expect(source.pendingCount, `${tag}: pendingCount`).toBe(shadow.length)
                    expect(source.pendingCount, `${tag}: maxPendingMessages`).toBeLessThanOrEqual(maxPendingMessages)
                    expect(totalBytes, `${tag}: maxPendingBytes`).toBeLessThanOrEqual(maxPendingBytes)

                    if (partitioned) {
                        const expectedPerKey = new Map<string, number>()
                        for (const item of shadow) {
                            if (!item.badPartition)
                                expectedPerKey.set(item.channelId, (expectedPerKey.get(item.channelId) ?? 0) + 1)
                        }
                        for (const key of keys) {
                            expect(source.waitingFor(key), `${tag}: waitingFor(${key})`).toBe(
                                expectedPerKey.get(key) ?? 0,
                            )
                        }
                        expect(source.waitingKeys().toSorted(), `${tag}: waitingKeys`).toEqual(
                            [...expectedPerKey.keys()].toSorted(),
                        )
                    }
                }

                for (let step = 0; step < 180; step++) {
                    if (!source.active) break
                    const action = rng.below(100)

                    if (action < 62) {
                        const bytes = 1 + rng.below(maxPendingBytes + 25)
                        const badPartition = partitioned && rng.chance(0.1)
                        const event: SyntheticEvent = {
                            id: nextEventId++,
                            channelId: rng.pick(keys),
                            bytes,
                            ...(badPartition ? { badPartition: true } : {}),
                        }
                        const before = [...shadow]
                        const beforeBytes = before.reduce((sum, item) => sum + item.bytes, 0)
                        const fits = before.length < maxPendingMessages && bytes <= maxPendingBytes - beforeBytes

                        source.offer(event, bytes, { shardId: 0, sessionEpoch: 1, receipt: event.id })

                        if (fits) {
                            shadow.push(event)
                        } else if (overflow === "stop") {
                            expect(source.active).toBe(false)
                            expect(source.failure).toBeInstanceOf(EventOverflowError)
                            expect(source.pendingCount).toBe(0)
                            expect(released).toBe(true)
                            shadow.length = 0
                            // Subsequent offers after stop are ignored and takeDelivery fails with EventOverflowError
                            source.offer(event, 1, { shardId: 0, sessionEpoch: 1, receipt: nextEventId++ })
                            const exit = Effect.runSyncExit(source.takeDelivery())
                            expect(Exit.isFailure(exit)).toBe(true)
                            if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(source.failure)
                        } else if (overflow === "dropNewest" || bytes > maxPendingBytes) {
                            // Queue must be unchanged
                            expect(source.active).toBe(true)
                        } else if (!partitioned) {
                            // Unpartitioned dropOldest evicts oldest items until arrival fits
                            let used = beforeBytes
                            while (shadow.length >= maxPendingMessages || bytes > maxPendingBytes - used) {
                                const dropped = shadow.shift()!
                                used -= dropped.bytes
                            }
                            shadow.push(event)
                        } else {
                            // Partitioned dropOldest: Drain a snapshot via takeFirst-compatible mirror to verify fairness
                            // We read actual retained items by taking all and verifying, then re-syncing shadow by simulating
                            // the exact arrival on a fresh probe or inspecting directly via shadow replay
                            const drained: SyntheticEvent[] = []
                            while (source.pendingCount > 0) {
                                const delivery = Effect.runSync(source.takeDelivery())!
                                expect(delivery.bytes).toBe(delivery.message.bytes)
                                drained.push(delivery.message)
                            }
                            checkPartitionedDropOldestFairness(
                                before,
                                drained,
                                event,
                                maxPendingMessages,
                                maxPendingBytes,
                                `seed=${seed} trial=${trial} step=${step}`,
                            )
                            // Re-offer the exact drained items (they all fit!) so the sequence continues seamlessly
                            shadow.length = 0
                            for (const kept of drained) {
                                source.offer(kept, kept.bytes, { shardId: 0, sessionEpoch: 1, receipt: kept.id })
                                shadow.push(kept)
                            }
                        }
                    } else if (action < 80 && shadow.length > 0) {
                        const delivery = Effect.runSync(source.takeDelivery())
                        const expected = shadow.shift()!
                        expect(delivery?.message).toEqual(expected)
                        expect(delivery?.bytes).toBe(expected.bytes)
                    } else if (action < 92 && shadow.length > 0) {
                        const chosenKey = rng.pick(keys)
                        const taken = source.takeFirst((delivery) => delivery.message.channelId === chosenKey)
                        const idx = shadow.findIndex((item) => item.channelId === chosenKey)
                        if (idx === -1) {
                            expect(taken).toBeUndefined()
                        } else {
                            const [expected] = shadow.splice(idx, 1)
                            expect(taken?.message).toEqual(expected)
                            expect(taken?.bytes).toBe(expected!.bytes)
                        }
                    } else if (partitioned && shadow.length > 0) {
                        const chosenKey = rng.pick(keys)
                        const taken = source.takeKey(chosenKey)
                        const expected = shadow.filter((item) => !item.badPartition && item.channelId === chosenKey)
                        const kept = shadow.filter((item) => item.badPartition || item.channelId !== chosenKey)
                        shadow.length = 0
                        shadow.push(...kept)
                        expect(taken.map((delivery) => delivery.message)).toEqual(expected)
                    }

                    assertAccounting(step)
                }

                // Final drain check: Exact byte and element correspondence with shadow
                if (source.active) {
                    const drained: SyntheticEvent[] = []
                    let drainedBytes = 0
                    while (source.pendingCount > 0) {
                        const delivery = Effect.runSync(source.takeDelivery())!
                        expect(delivery.bytes).toBe(delivery.message.bytes)
                        drained.push(delivery.message)
                        drainedBytes += delivery.bytes
                    }
                    expect(drained).toEqual(shadow)
                    expect(drainedBytes).toBe(shadow.reduce((sum, item) => sum + item.bytes, 0))
                    source.stop()
                    expect(source.active).toBe(false)
                    expect(released).toBe(true)
                }
            }
        }
    },
)
