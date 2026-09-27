// Operations read each caller array entry and option once, so a value that changes between reads cannot pass
// validation with one value and be sent or applied with another
import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { defaultApi, modes, nativeApi } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { settle } from "../support/settle.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

/** An array whose first entry reads as first and afterwards as later, counting the reads of that entry */
function changingArray(first: string, later: string, rest: readonly string[]) {
    const reads = { count: 0 }
    const value = new Proxy([first, ...rest], {
        get(target, key, receiver) {
            if (key === "0") return ++reads.count === 1 ? first : later
            return Reflect.get(target, key, receiver)
        },
    })
    return { value, reads }
}

/** An options object whose one field reads as first and afterwards as later, counting its reads */
function changingOption(key: string, first: unknown, later: unknown, other: Record<string, unknown> = {}) {
    const reads = { count: 0 }
    const value = Object.defineProperty({ ...other }, key, {
        enumerable: true,
        get: () => (++reads.count === 1 ? first : later),
    })
    return { value, reads }
}

test.each(modes)("%s deleteMany copies the IDs once and sends the validated copy", async (mode) => {
    const bodies: unknown[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.fluxer.app/v1/channels/20/messages/bulk-delete")
        bodies.push(JSON.parse(String(init.body)))
        return new Response(null, { status: 204 })
    })
    const ids = changingArray("11", "not-an-id", ["12"])
    if (mode === "default") await settle(defaultApi().messages.deleteMany("20", ids.value))
    else await settle((await nativeApi()).messages.deleteMany("20", ids.value))
    expect(ids.reads.count).toBe(1)
    expect(bodies).toEqual([{ message_ids: ["11", "12"] }])
})

test("default cache.entries reads limit once and applies the validated limit", () => {
    const client = defaultApi({ cache: { messages: true } })
    const limit = changingOption("limit", 1, "not a limit")
    expect(client.cache.entries("messages", limit.value as never)).toEqual([])
    expect(limit.reads.count).toBe(1)
})

test("native cache.entries reads limit once and applies the validated limit", async () => {
    const client = await nativeApi({ cache: { messages: true } })
    const limit = changingOption("limit", 1, "not a limit")
    expect(await Effect.runPromise(client.cache.entries("messages", limit.value as never))).toEqual([])
    expect(limit.reads.count).toBe(1)
})

test.each(modes)("%s waitFor reads each wait option once and uses the validated filter", async (mode) => {
    const filter = changingOption("filter", () => true, "not a filter", { timeoutMs: 1 })
    const timeout = changingOption("timeoutMs", 1, 0, { filter: () => true })
    for (const options of [filter, timeout]) {
        const failure =
            mode === "default"
                ? await defaultApi().waitFor("messageCreate", options.value as never)
                : await Effect.runPromise(
                      Effect.result((await nativeApi()).waitFor("messageCreate", options.value as never)),
                  )
        // The wait runs with the validated values and ends at its deadline instead of failing validation
        expect(failure).toMatchObject(
            mode === "default"
                ? { error: { _tag: "EventWaitError", reason: "timeout" } }
                : { failure: { _tag: "EventWaitError", reason: "timeout" } },
        )
        expect(options.reads.count).toBe(1)
    }
})

test.each(modes)("%s presence and count requests read each caller ID once", async (mode) => {
    const members = changingArray("30", "not-an-id", ["31"])
    const guilds = changingArray("40", "not-an-id", ["41"])
    if (mode === "default") {
        const client = defaultApi()
        expect(client.presence.setMembers("40", members.value)).not.toMatchObject({ error: { reason: "input" } })
        expect(await client.guilds.fetchCounts(guilds.value)).toMatchObject({ error: { reason: "notConnected" } })
    } else {
        const client = await nativeApi()
        const selected = await Effect.runPromise(Effect.result(client.presence.setMembers("40", members.value)))
        expect(selected).not.toMatchObject({ failure: { reason: "input" } })
        const counted = await Effect.runPromise(Effect.result(client.guilds.fetchCounts(guilds.value)))
        expect(counted).toMatchObject({ failure: { reason: "notConnected" } })
    }
    expect([members.reads.count, guilds.reads.count]).toEqual([1, 1])
})
