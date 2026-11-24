/*
 * Seeded property-based tests for CommandPacer.
 * Drives random sequences of send, submit, cancel, replace, clock advances and close(), verifying that the
 * rolling-window send budget is never exceeded at any timestamp t, cancelled commands never reach the socket,
 * replaced commands deliver their latest payload and pending counters never drift or go negative
 */
import { Cause, Effect, Exit, Fiber } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { commandPacer, type QueuedCommand } from "../../src/internal/gateway/commands.js"
import { sdkClock } from "../support/client-clock.js"

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

afterEach(() => {
    vi.restoreAllMocks()
})

test("CommandPacer never exceeds its rolling-window budget and keeps cancel, replace and close accounting exact", async () => {
    const budget = 5
    const windowMs = 100

    for (let trial = 0; trial < 15; trial++) {
        const seed = (baseSeed + trial * 257) >>> 0
        const rng = prng(seed)
        const clock = sdkClock()
        const sentTimestamps: number[] = []
        const sentFrames: {
            readonly op: number
            readonly d: { readonly id: number; readonly rev: number }
            readonly at: number
        }[] = []

        const pacer = commandPacer({
            send: (op, d) => {
                const time = clock.now()
                sentTimestamps.push(time)
                sentFrames.push({ op, d: d as { readonly id: number; readonly rev: number }, at: time })
                return true
            },
            now: clock.now,
            logger: undefined,
            shardId: 0,
            budget,
            windowMs,
        })

        const runner = Effect.runFork(pacer.run)

        type TrackedInternal = {
            readonly id: number
            readonly handle: QueuedCommand
            rev: number
            settled: boolean
            cancelled: boolean
            sentResult?: boolean
            staleCallbackCalled: boolean
        }
        type TrackedApp = {
            readonly id: number
            readonly fiber: Fiber.Fiber<void, "closed" | "busy">
            sentCallbackCount: number
            settled: boolean
            cancelled: boolean
            exit?: Exit.Exit<void, "closed" | "busy">
        }

        const pendingInternal = new Map<number, TrackedInternal>()
        const pendingApp = new Map<number, TrackedApp>()
        const cancelledIds = new Set<number>()
        const latestRev = new Map<number, number>()
        let nextId = 1

        const assertRollingWindow = (step: number) => {
            const tag = `seed=${seed} trial=${trial} step=${step} now=${clock.now()}`
            for (let index = 0; index < sentTimestamps.length; index++) {
                const t = sentTimestamps[index]!
                let inWindow = 0
                for (let back = index; back >= 0 && sentTimestamps[back]! > t - windowMs; back--) inWindow++
                expect(inWindow, `${tag}: rolling window at t=${t}`).toBeLessThanOrEqual(budget)
            }
            for (const frame of sentFrames) {
                expect(cancelledIds.has(frame.d.id), `${tag}: cancelled command ${frame.d.id} sent`).toBe(false)
                expect(frame.d.rev, `${tag}: replaced command ${frame.d.id} sent stale rev`).toBe(
                    latestRev.get(frame.d.id),
                )
            }
        }

        for (let step = 0; step < 140; step++) {
            const action = rng.below(100)
            if (action < 32) {
                // Internal send
                const id = nextId++
                latestRev.set(id, 0)
                let settledNow = false
                let sentNow: boolean | undefined
                const submission = pacer.send(3, { id, rev: 0 }, (sent) => {
                    settledNow = true
                    sentNow = sent
                    const item = pendingInternal.get(id)
                    if (item) {
                        item.settled = true
                        item.sentResult = sent
                        pendingInternal.delete(id)
                    }
                })
                expect(submission).not.toBe("closed")
                expect(submission).not.toBe("busy")
                if (!settledNow && typeof submission === "object" && submission !== null) {
                    pendingInternal.set(id, {
                        id,
                        handle: submission,
                        rev: 0,
                        settled: false,
                        cancelled: false,
                        staleCallbackCalled: false,
                    })
                } else {
                    expect(sentNow).toBe(true)
                }
            } else if (action < 60) {
                // Application submit
                const id = nextId++
                latestRev.set(id, 0)
                const tracked: TrackedApp = {
                    id,
                    fiber: undefined as unknown as Fiber.Fiber<void, "closed" | "busy">,
                    sentCallbackCount: 0,
                    settled: false,
                    cancelled: false,
                }
                const fiber = Effect.runFork(
                    pacer.submit(20, { id, rev: 0 }, () => {
                        tracked.sentCallbackCount++
                    }),
                )
                ;(tracked as { fiber: Fiber.Fiber<void, "closed" | "busy"> }).fiber = fiber
                pendingApp.set(id, tracked)
                void Effect.runPromiseExit(Fiber.join(fiber)).then((exit) => {
                    tracked.settled = true
                    tracked.exit = exit
                    pendingApp.delete(id)
                })
                await clock.advance(0)
            } else if (action < 72 && pendingInternal.size > 0) {
                // Replace an unsent internal command
                const item = rng.pick([...pendingInternal.values()])
                const nextRev = item.rev + 1
                item.rev = nextRev
                latestRev.set(item.id, nextRev)
                item.handle.replace({ id: item.id, rev: nextRev }, (sent) => {
                    if (item.rev !== nextRev) item.staleCallbackCalled = true
                    item.settled = true
                    item.sentResult = sent
                    pendingInternal.delete(item.id)
                })
            } else if (action < 82 && pendingInternal.size > 0) {
                // Cancel an unsent internal command
                const item = rng.pick([...pendingInternal.values()])
                item.cancelled = true
                cancelledIds.add(item.id)
                pendingInternal.delete(item.id)
                item.handle.cancel()
                // Redundant cancel must be a safe no-op
                item.handle.cancel()
            } else if (action < 90 && pendingApp.size > 0) {
                // Interrupt an unsent application submit
                const item = rng.pick([...pendingApp.values()])
                item.cancelled = true
                pendingApp.delete(item.id)
                await Effect.runPromise(Fiber.interrupt(item.fiber))
                if (item.sentCallbackCount === 0) cancelledIds.add(item.id)
            } else {
                await clock.advance(rng.pick([1, 15, 40, 100]))
            }
            assertRollingWindow(step)
        }

        // Close while some work may still be pending
        const remainingInternal = [...pendingInternal.values()]
        const remainingApp = [...pendingApp.values()]
        pacer.close()
        await clock.advance(0)

        for (const item of remainingInternal) {
            expect(item.settled).toBe(true)
            expect(item.sentResult).toBe(false)
            expect(item.staleCallbackCalled).toBe(false)
        }
        for (const item of remainingApp) {
            const exit = await Effect.runPromiseExit(Fiber.join(item.fiber))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe("closed")
        }

        // Post-close submissions return closed immediately without sending
        const sentBeforePostClose = sentFrames.length
        expect(pacer.send(3, { id: nextId++, rev: 0 })).toBe("closed")
        const postCloseExit = await Effect.runPromiseExit(pacer.submit(20, { id: nextId++, rev: 0 }))
        expect(Exit.isFailure(postCloseExit)).toBe(true)
        if (Exit.isFailure(postCloseExit)) expect(Cause.squash(postCloseExit.cause)).toBe("closed")
        expect(sentFrames.length).toBe(sentBeforePostClose)

        await Effect.runPromise(Fiber.interrupt(runner))
        assertRollingWindow(999)
    }
})

test("CommandPacer pending internal and application counters never drift across fill, cancel and drain cycles", async () => {
    const clock = sdkClock()
    let sentCount = 0
    const pacer = commandPacer({
        send: () => {
            sentCount++
            return true
        },
        now: clock.now,
        logger: undefined,
        shardId: 0,
        budget: 2,
        windowMs: 1_000,
    })
    const runner = Effect.runFork(pacer.run)

    // Exhaust the 2-command rolling budget so all subsequent submissions queue
    expect(pacer.send(3, "a")).not.toBe("busy")
    expect(pacer.send(3, "b")).not.toBe("busy")
    expect(sentCount).toBe(2)

    // Fill internal queue to exact cap (500), cancel half, refill half, verify exact 500 cap still holds
    const internalHandles: QueuedCommand[] = []
    for (let index = 0; index < 500; index++) {
        const result = pacer.send(3, index)
        expect(typeof result).toBe("object")
        internalHandles.push(result as QueuedCommand)
    }
    expect(pacer.send(3, "overflow")).toBe("busy")

    for (let index = 0; index < 250; index++) {
        internalHandles[index]!.cancel()
        // Double cancel must not decrement pending counter below actual count
        internalHandles[index]!.cancel()
    }
    for (let index = 0; index < 250; index++) {
        const result = pacer.send(3, `refill-${index}`)
        expect(typeof result).toBe("object")
        internalHandles[index] = result as QueuedCommand
    }
    expect(pacer.send(3, "overflow-again")).toBe("busy")

    // Fill application queue to exact cap (500) independently of internal queue
    const appFibers: Fiber.Fiber<void, "closed" | "busy">[] = []
    for (let index = 0; index < 500; index++) {
        appFibers.push(Effect.runFork(pacer.submit(20, index)))
    }
    await clock.advance(0)
    const appOverflow = await Effect.runPromiseExit(pacer.submit(20, "overflow"))
    expect(Exit.isFailure(appOverflow)).toBe(true)
    if (Exit.isFailure(appOverflow)) expect(Cause.squash(appOverflow.cause)).toBe("busy")

    // Interrupt 100 app fibers and verify exactly 100 slots reopen
    for (let index = 0; index < 100; index++) await Effect.runPromise(Fiber.interrupt(appFibers[index]!))
    for (let index = 0; index < 100; index++) appFibers[index] = Effect.runFork(pacer.submit(20, `refill-${index}`))
    await clock.advance(0)
    const appOverflowAgain = await Effect.runPromiseExit(pacer.submit(20, "overflow-again"))
    expect(Exit.isFailure(appOverflowAgain)).toBe(true)
    if (Exit.isFailure(appOverflowAgain)) expect(Cause.squash(appOverflowAgain.cause)).toBe("busy")

    // Close releases everything cleanly
    pacer.close()
    await Promise.all(appFibers.map((fiber) => Effect.runPromiseExit(Fiber.join(fiber))))
    await Effect.runPromise(Fiber.interrupt(runner))
})
