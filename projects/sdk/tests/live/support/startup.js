// A partial-startup observation shares the SDK connect operation's deadline. If startup fails first, preserve that
// failure instead of replacing it with a polling assertion at an independent deadline
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"

export async function waitForPartialStartup(pending, ready) {
    const stop = new AbortController()
    const observe = async () => {
        while (!ready()) await sleep(5, undefined, { signal: stop.signal })
    }
    try {
        await Promise.race([
            observe(),
            pending.then(() => assert.fail("Startup completed before the held Identify permit was cancelled")),
        ])
    } finally {
        stop.abort()
    }
}
