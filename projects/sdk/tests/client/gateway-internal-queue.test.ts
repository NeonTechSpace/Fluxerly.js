import { Clock, Effect } from "effect"
import { expect, test, vi } from "vitest"
import { nowMs } from "../../src/internal/clock.js"
import { commandPacer } from "../../src/internal/gateway/commands.js"
import { runWithTestClock } from "../support/clock.js"

test("bounds internal queued commands and releases each cancelled slot only once", () =>
    runWithTestClock(
        Effect.gen(function* () {
            const clock = yield* Clock.Clock
            const send = vi.fn(() => true)
            const settled = vi.fn()
            const pacer = commandPacer({
                send,
                now: () => nowMs(clock),
                logger: undefined,
                shardId: 0,
                budget: 1,
            })
            pacer.send(3, "fills the send budget")
            const waiting = Array.from({ length: 500 }, (_, index) => pacer.send(15, index, settled))
            expect(pacer.send(15, "overflow")).toBe("busy")
            const withdrawn = waiting[0]
            if (!withdrawn || typeof withdrawn === "string") throw new Error("Expected a queued command handle")
            withdrawn.cancel()
            withdrawn.cancel()
            expect(pacer.send(15, "replacement", settled)).toHaveProperty("cancel")
            expect(pacer.send(15, "still full")).toBe("busy")
            expect(send).toHaveBeenCalledTimes(1)
            pacer.close()
            pacer.close()
            expect(settled).toHaveBeenCalledTimes(500)
            expect(settled.mock.calls.every(([sent]) => sent === false)).toBe(true)
            expect(pacer.send(15, "after close")).toBe("closed")
        }),
    ))
