import { expect, test, vi } from "vitest"
import { waitForPartialStartup } from "./support/startup.js"

test("partial startup keeps a connection failure instead of replacing it with a deadline assertion", async () => {
    const failure = { _tag: "ConnectionTimeoutError", timeoutMs: 45_000 }
    await expect(waitForPartialStartup(Promise.reject(failure), () => false)).rejects.toBe(failure)
})

test("partial startup observes the held-permit barrier without waiting for the whole connection", async () => {
    vi.useFakeTimers()
    try {
        let ready = false
        const pending = waitForPartialStartup(new Promise(() => {}), () => ready)
        ready = true
        await vi.advanceTimersByTimeAsync(5)
        await pending
        expect(vi.getTimerCount()).toBe(0)
    } finally {
        vi.useRealTimers()
    }
})

test("partial startup rejects an unexpectedly completed connection", async () => {
    await expect(waitForPartialStartup(Promise.resolve(), () => false)).rejects.toMatchObject({
        code: "ERR_ASSERTION",
    })
})
