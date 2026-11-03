// A controlled Effect Clock for live checks whose SDK deadlines must not depend on host or network speed
import { setTimeout as sleep } from "node:timers/promises"
import { Clock, Duration, Effect } from "effect"

/**
 * Control the SDK's default Effect Clock, which clients created without their own Clock read for deadlines and waits.
 * Time stands still until advance moves it, so a window the check injects ends only when the check says so.
 * Restoring waits until real time has caught up, so SDK time never runs backwards
 */
export function controlledClock() {
    const clock = Effect.runSync(Clock.Clock)
    const start = clock.monotonicTimeNanosUnsafe()
    let offsetMs = 0
    let restored = false
    const pending = new Set()
    const now = () => start + BigInt(offsetMs) * 1_000_000n
    clock.monotonicTimeNanosUnsafe = now
    clock.sleep = (duration) =>
        Effect.callback((resume) => {
            const item = { at: offsetMs + Duration.toMillis(duration), wake: () => resume(Effect.void) }
            if (item.at <= offsetMs) return resume(Effect.void)
            pending.add(item)
            return Effect.sync(() => pending.delete(item))
        })
    return {
        /** Milliseconds until the earliest sleep on the controlled clock ends, or undefined when none is waiting */
        nextWakeMs() {
            return pending.size === 0 ? undefined : Math.min(...[...pending].map((item) => item.at)) - offsetMs
        },
        advance(milliseconds) {
            offsetMs += milliseconds
            for (const item of [...pending])
                if (item.at <= offsetMs) {
                    pending.delete(item)
                    item.wake()
                }
        },
        async restore() {
            if (restored) return
            restored = true
            while (process.hrtime.bigint() < now())
                await sleep(Math.ceil(Number(now() - process.hrtime.bigint()) / 1e6))
            delete clock.monotonicTimeNanosUnsafe
            delete clock.sleep
            // Sleeps started on the controlled clock end now, so their owners schedule again on real time
            for (const item of pending) item.wake()
            pending.clear()
        },
    }
}
