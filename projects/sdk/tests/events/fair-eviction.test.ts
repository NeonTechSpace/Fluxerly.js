import { Effect, Metric } from "effect"
import { expect, test } from "vitest"
import { ConfigurationError } from "../../src/errors.js"
import type { LogRecord } from "../../src/index.js"
import { EventBus } from "../../src/internal/events.js"
import { loggingConfiguration } from "../../src/internal/logging.js"

function logger() {
    const records: LogRecord[] = []
    const result = loggingConfiguration({ sink: (record: LogRecord) => records.push(record), dedupe: false }, false)
    if (result instanceof ConfigurationError) throw result
    return { records, logger: result }
}

/** A partitioned dropOldest subscription on typingStart, keyed by channel, whose events are labelled by user ID */
function queue(options: { readonly maxPendingMessages: number; readonly maxPendingBytes?: number }) {
    const { records, logger: log } = logger()
    const bus = new EventBus(() => log)
    const source = Effect.runSync(bus.open("typingStart", { partition: "channel", overflow: "dropOldest", ...options }))
    return {
        records,
        log,
        bus,
        source,
        offer: (channel: string, label: string, bytes = 10) =>
            bus.offer("typingStart", { channelId: channel, userId: label, timestamp: 1 } as never, bytes),
        waiting: () => {
            const labels: string[] = []
            while (source.pendingCount) labels.push((Effect.runSync(source.take()) as { userId: string }).userId)
            return labels
        },
    }
}

test("a quiet key's arrival evicts the longest backlog, and the busy key's own arrival evicts itself", () => {
    const q = queue({ maxPendingMessages: 6 })
    for (const label of ["H1", "H2", "H3", "H4", "H5"]) q.offer("hot", label)
    q.offer("quiet", "Q1")
    // The quiet key's backlog stays shorter than the hot key's, so the hot key loses its oldest events
    q.offer("quiet", "Q2")
    q.offer("quiet", "Q3")
    expect(q.source.waitingFor("hot")).toBe(3)
    // Now equal backlogs: The quiet key evicts its own oldest event rather than the hot key's
    q.offer("quiet", "Q4")
    expect(q.waiting()).toEqual(["H3", "H4", "H5", "Q2", "Q3", "Q4"])
    expect(q.log.counters().eventsDropped.overflow).toBe(3)
})

test("a hot key's arrival evicts its own oldest event while a quiet key keeps its events", () => {
    const q = queue({ maxPendingMessages: 6 })
    for (const label of ["H1", "H2", "H3", "H4"]) q.offer("hot", label)
    q.offer("quiet", "Q1")
    q.offer("quiet", "Q2")
    q.offer("hot", "H5")
    q.offer("hot", "H6")
    expect(q.waiting()).toEqual(["H3", "H4", "Q1", "Q2", "H5", "H6"])
})

test("a shorter or equal backlog never takes room, so a new key's arrival is the one discarded among single events", () => {
    const q = queue({ maxPendingMessages: 3 })
    q.offer("a", "A1")
    q.offer("b", "B1")
    q.offer("d", "D1")
    q.offer("c", "C1")
    expect(q.waiting()).toEqual(["A1", "B1", "D1"])
    expect(q.log.counters().eventsDropped.overflow).toBe(1)
    expect(q.records.filter((record) => record.code === "events.dropped")).toEqual([
        expect.objectContaining({ level: "warn", fields: expect.objectContaining({ policy: "dropOldest" }) }),
    ])
})

test("with equal backlogs a key discards its own oldest, and a longer one gives up its oldest", () => {
    const equal = queue({ maxPendingMessages: 3 })
    for (const [channel, label] of [
        ["a", "A1"],
        ["a", "A2"],
        ["b", "B1"],
        ["b", "B2"],
    ] as const)
        equal.offer(channel, label)
    expect(equal.waiting()).toEqual(["A1", "A2", "B2"])
    const longer = queue({ maxPendingMessages: 4 })
    for (const [channel, label] of [
        ["a", "A1"],
        ["a", "A2"],
        ["a", "A3"],
        ["b", "B1"],
        ["b", "B2"],
    ] as const)
        longer.offer(channel, label)
    expect(longer.waiting()).toEqual(["A2", "A3", "B1", "B2"])
})

test("ties between other keys go to the key whose oldest waiting event is oldest", () => {
    const q = queue({ maxPendingMessages: 4 })
    for (const [channel, label] of [
        ["a", "A1"],
        ["b", "B1"],
        ["a", "A2"],
        ["b", "B2"],
    ] as const)
        q.offer(channel, label)
    // The new key holds no events, and both others hold more, so the key with the oldest waiting event gives up that event
    q.offer("c", "C1")
    expect(q.waiting()).toEqual(["B1", "A2", "B2", "C1"])
})

test("a single hot key evicts its own oldest event like an unpartitioned queue", () => {
    const q = queue({ maxPendingMessages: 3 })
    for (const label of ["H1", "H2", "H3", "H4"]) q.offer("hot", label)
    expect(q.waiting()).toEqual(["H2", "H3", "H4"])
})

test("under maxPendingBytes the count of waiting events decides, repeating until the arrival fits", () => {
    const q = queue({ maxPendingMessages: 100, maxPendingBytes: 30 })
    q.offer("a", "A1")
    q.offer("a", "A2")
    q.offer("b", "B1")
    q.offer("b", "B2")
    expect(q.waiting()).toEqual(["A1", "A2", "B2"])
    const large = queue({ maxPendingMessages: 100, maxPendingBytes: 30 })
    large.offer("a", "A1")
    large.offer("a", "A2")
    large.offer("b", "B1")
    // A 20 byte event of b needs two slots: B1 goes first, then a's longer backlog gives up A1
    large.offer("b", "B2", 20)
    expect(large.waiting()).toEqual(["A2", "B2"])
    expect(large.log.counters().eventsDropped.overflow).toBe(2)
})

test("an arrival that cannot fit is the only event discarded, and the record does not call it an oldest event", () => {
    const q = queue({ maxPendingMessages: 100, maxPendingBytes: 30 })
    q.offer("a", "A1")
    q.offer("b", "B1")
    q.offer("c", "C1")
    // A2 needs the whole budget, A1 would go first, but b and c hold as many events as a, so A2 itself goes
    q.offer("a", "A2", 30)
    expect(q.waiting()).toEqual(["A1", "B1", "C1"])
    expect(q.log.counters().eventsDropped.overflow).toBe(1)
    const [record] = q.records.filter((entry) => entry.code === "events.dropped")
    expect(record!.message).not.toContain("oldest")
})

test("events whose partition function failed share one backlog of their own", () => {
    const { logger: log } = logger()
    const bus = new EventBus(() => log)
    const source = Effect.runSync(
        bus.open("typingStart", {
            partition: (event: { readonly userId: string }) => {
                if (event.userId.startsWith("bad")) throw new Error("no key")
                return event.userId.slice(0, 1)
            },
            overflow: "dropOldest",
            maxPendingMessages: 3,
        } as never),
    )
    for (const userId of ["bad1", "bad2", "a1", "a2"])
        bus.offer("typingStart", { channelId: "1", userId, timestamp: 1 } as never, 10)
    // Equal backlogs of 2: The arriving a2 gives up its own oldest event, a1
    const labels: string[] = []
    while (source.pendingCount) labels.push((Effect.runSync(source.take()) as { userId: string }).userId)
    expect(labels).toEqual(["bad1", "bad2", "a2"])
})

test("dropped events are counted per event name for overflow and closed drops, with the metric attribute", async () => {
    const { logger: log } = logger()
    const bus = new EventBus(() => log)
    const oldest = Effect.runSync(bus.open("typingStart", { maxPendingMessages: 1, overflow: "dropOldest" }))
    const newest = Effect.runSync(bus.open("messageDelete", { maxPendingMessages: 1, overflow: "dropNewest" }))
    const stopping = Effect.runSync(bus.open("typingStart", { maxPendingMessages: 1 }))
    const typing = { channelId: "1", userId: "2", timestamp: 1 } as never
    const deletion = { id: "10", channelId: "20" } as never
    const before = async () => {
        const snapshots = await Effect.runPromise(Metric.snapshot)
        const metric = snapshots.find(
            ({ id, attributes }) =>
                id === "fluxerly_events_dropped_total" &&
                attributes?.reason === "overflow" &&
                attributes?.event === "typingStart",
        )
        return metric?.type === "Counter" ? Number(metric.state.count) : 0
    }
    const metricBefore = await before()
    bus.offer("typingStart", typing, 10)
    bus.offer("typingStart", typing, 10)
    // The dropOldest source drops 1, and the stopping source discards its waiting event and the arrival
    bus.offer("messageDelete", deletion, 10)
    bus.offer("messageDelete", deletion, 10)
    expect(stopping.active).toBe(false)
    expect(oldest.active).toBe(true)
    expect(log.counters().eventsDropped.overflow).toBe(1 + 2 + 1)
    expect(log.counters().eventsDroppedByEvent).toEqual({ typingStart: 3, messageDelete: 1 })
    bus.stop()
    expect(newest.active).toBe(false)
    // The closing bus discards one waiting typingStart event and one messageDelete event
    expect(log.counters().eventsDropped.closed).toBe(2)
    expect(log.counters().eventsDroppedByEvent).toEqual({ typingStart: 4, messageDelete: 2 })
    expect(await before()).toBe(metricBefore + 3)
    // The reported snapshot is a copy: Later drops do not change it
    const snapshot = log.counters().eventsDroppedByEvent
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(log.counters())).toBe(true)
})
