import { Cause, Deferred, Effect, Exit, Scope } from "effect"
import { describe, expect, onTestFinished, test } from "vitest"
import { defaultPartitionReady, EventBus } from "../../src/internal/events.js"
import type { PartitionReady } from "../../src/internal/events.js"
import { waitUntil } from "../support/clock.js"

/** A bus with one typingStart handler keyed by channel, whose events are labelled by user ID and gated by label */
async function harness(options: Record<string, unknown>, partitionReady: PartitionReady) {
    const bus = new EventBus()
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const handled: string[] = []
    const reports: unknown[] = []
    const gates = new Map<string, Deferred.Deferred<void>>()
    const gate = (label: string) => {
        let entry = gates.get(label)
        if (!entry) gates.set(label, (entry = Deferred.makeUnsafe<void>()))
        return entry
    }
    const held = new Set<string>()
    const source = await Effect.runPromise(
        bus.on(
            "typingStart",
            (event) =>
                Effect.sync(() => void handled.push(event.userId)).pipe(
                    Effect.andThen(
                        Effect.suspend(() =>
                            held.has(event.userId) ? Deferred.await(gate(event.userId)) : Effect.void,
                        ),
                    ),
                ),
            { partition: "channel", ...options },
            (report) => Effect.sync(() => void reports.push(report)),
            scope,
            undefined,
            partitionReady,
        ),
    )
    return {
        bus,
        source,
        handled,
        reports,
        hold: (label: string) => void held.add(label),
        release: (label: string) => Deferred.doneUnsafe(gate(label), Effect.void),
        offer: (channel: string, label: string, bytes = 10) =>
            bus.offer("typingStart", { channelId: channel, userId: label, timestamp: 1 } as never, bytes),
    }
}

describe("partitionReady lifecycle", () => {
    test("evicting a ready key's own last waiting event does not make the key idle", async () => {
        const calls: string[] = []
        const h = await harness({ maxPendingMessages: 2, concurrency: 1 }, (key) => {
            calls.push(key)
            return Effect.void
        })
        h.hold("x1")
        h.offer("x", "x1")
        await waitUntil(() => h.handled.length === 1)
        h.offer("k", "k1")
        h.offer("y", "y1")
        await waitUntil(() => calls.length === 3)
        // The queue is full, so k2 evicts k1, but the key still has a waiting event once k2 arrived
        h.offer("k", "k2")
        h.release("x1")
        await waitUntil(() => h.handled.length === 3)
        expect(h.handled).toEqual(["x1", "y1", "k2"])
        expect(calls).toEqual(["x", "k", "y"])
    })

    test("an arrival that cannot fit leaves the waiting keys and their pending attempts untouched", async () => {
        const calls: string[] = []
        const gates = new Map<string, Deferred.Deferred<void>>()
        const h = await harness({ maxPendingBytes: 30, concurrency: 1 }, (key) => {
            calls.push(key)
            if (key === "x") return Effect.void
            const gate = Deferred.makeUnsafe<void>()
            gates.set(key, gate)
            return Deferred.await(gate)
        })
        h.hold("x1")
        h.offer("x", "x1")
        await waitUntil(() => h.handled.length === 1)
        h.offer("a", "a1")
        h.offer("b", "b1")
        await waitUntil(() => calls.length === 3)
        // A 30 byte event of key a could only make room by evicting a1, and would still not fit beside b1, so it alone goes
        h.offer("a", "a2", 30)
        h.release("x1")
        for (const gate of gates.values()) Deferred.doneUnsafe(gate, Effect.void)
        await waitUntil(() => h.handled.length === 3)
        expect(h.handled).toEqual(["x1", "a1", "b1"])
        expect(calls).toEqual(["x", "a", "b"])
        expect(h.reports).toEqual([])
    })

    test.each([
        [
            "an Effect hook that fails",
            (offer: () => void): PartitionReady =>
                (key) => {
                    if (key !== "a") return Effect.void
                    offer()
                    return Effect.fail("not ready")
                },
        ],
        [
            "a default hook that throws synchronously",
            (offer: () => void): PartitionReady =>
                defaultPartitionReady((key) => {
                    if (key !== "a") return undefined
                    offer()
                    throw new Error("not ready")
                }),
        ],
    ])("a key admitted while %s fails still gets its hook started", async (_name, make) => {
        const calls: string[] = []
        let offerB: () => void = () => undefined
        const hook = make(() => offerB())
        const h = await harness({}, (key, signal) => {
            calls.push(key)
            return hook(key, signal)
        })
        offerB = () => h.offer("b", "b1")
        h.offer("a", "a1")
        await waitUntil(() => h.handled.length === 1)
        expect(h.handled).toEqual(["b1"])
        expect(calls).toEqual(["a", "b"])
        expect(h.reports).toHaveLength(1)
    })

    test("a defect in an interrupted hook's cleanup reaches the subscription outcome", async () => {
        const failure = new Error("hook cleanup died")
        const calls: string[] = []
        const h = await harness({}, (key) => {
            calls.push(key)
            return Effect.never.pipe(Effect.ensuring(Effect.die(failure)))
        })
        h.offer("a", "a1")
        await waitUntil(() => calls.length === 1)
        h.source.stop()
        const exit = await Effect.runPromiseExit(Deferred.await(h.source.closed))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
    })
})
