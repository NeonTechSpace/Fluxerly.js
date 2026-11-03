import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, type ClientOptions } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { modes, type Mode } from "../support/both-apis.js"
import { fakeHostTime, hostTurnsUntil, outcome } from "../support/client-clock.js"
import { attachAccountLimits } from "../../src/internal/client.js"
import { captureLogs } from "../support/log-capture.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

async function setup(mode: Mode, logging: NonNullable<ClientOptions["logging"]>) {
    fakeHostTime()
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture-only-not-a-credential", logging }
    const client =
        mode === "default"
            ? createClient(options)
            : await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        await outcome(client.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return client
}

/** Answer the first request with a 429 of these headers and body, and every later one with 204 */
function firstRefused(headers: Record<string, string>, body: string | null) {
    const calls: string[] = []
    stubFetchWithHostedDiscovery(async (url) => {
        calls.push(new URL(url).pathname)
        return calls.length === 1 ? new Response(body, { status: 429, headers }) : new Response(null, { status: 204 })
    })
    return calls
}

test.each(modes)("%s reports requests held by a global pause once it lasts a second", async (mode) => {
    const logs = captureLogs()
    const client = await setup(mode, { ...logs.logging, categories: { ratelimit: "debug" } })
    firstRefused({ "retry-after": "5", "x-ratelimit-global": "true" }, null)
    const first = outcome(client.messages.typing("20"))
    await vi.advanceTimersByTimeAsync(0)
    const others = [outcome(client.messages.typing("21")), outcome(client.messages.typing("22"))]
    await vi.advanceTimersByTimeAsync(0)
    // The refused request waits to send again, and the two others wait behind the same pause
    expect(client.diagnostics().rest.rateLimitHold).toEqual({
        reason: "global",
        requests: 3,
        waitMs: 5_000,
        route: null,
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(logs.withCode("ratelimit.queueHeld")).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(logs.withCode("ratelimit.queueHeld")).toEqual([
        expect.objectContaining({ level: "warn", delayMs: 4_000, fields: { reason: "global", requests: 3 } }),
    ])
    await vi.advanceTimersByTimeAsync(4_000)
    expect(await Promise.all([first, ...others])).toEqual([
        { value: undefined },
        { value: undefined },
        { value: undefined },
    ])
    expect(client.diagnostics().rest.rateLimitHold).toBeNull()
    // One record per hold, not one per waiting request or per second
    expect(logs.withCode("ratelimit.queueHeld")).toHaveLength(1)
})

test.each(modes)("%s reports a client pause after a 429 that named no limit", async (mode) => {
    const logs = captureLogs()
    const client = await setup(mode, logs.logging)
    firstRefused({ "retry-after": "3", "content-type": "text/plain" }, "429 - Ratelimited")
    const first = outcome(client.messages.typing("20"))
    await vi.advanceTimersByTimeAsync(0)
    const other = outcome(client.messages.delete({ channelId: "21", id: "10" }))
    await vi.advanceTimersByTimeAsync(1_000)
    const [record] = logs.withCode("ratelimit.queueHeld")
    expect(record).toMatchObject({ level: "warn", delayMs: 2_000, fields: { reason: "client", requests: 2 } })
    expect(record!.message).toContain("named no limit")
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await Promise.all([first, other])).toEqual([{ value: undefined }, { value: undefined }])
})

test.each(modes)("%s reports a route limit at Debug with its route", async (mode) => {
    const logs = captureLogs()
    const client = await setup(mode, { ...logs.logging, categories: { ratelimit: "debug" } })
    const calls = firstRefused({ "retry-after": "2", "x-ratelimit-scope": "user" }, '{"global":false}')
    const first = outcome(client.messages.typing("20"))
    await vi.advanceTimersByTimeAsync(0)
    const same = outcome(client.messages.typing("20"))
    // Another route is not held by that route's limit
    expect(await outcome(client.messages.typing("21"))).toEqual({ value: undefined })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain("/channels/21/typing")
    expect(client.diagnostics().rest.rateLimitHold).toEqual({
        reason: "route",
        requests: 2,
        waitMs: 2_000,
        route: "POST /channels/:id/typing",
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(logs.withCode("ratelimit.queueHeld")).toEqual([
        expect.objectContaining({
            level: "debug",
            route: "POST /channels/:id/typing",
            delayMs: 1_000,
            fields: { reason: "route", requests: 2 },
        }),
    ])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await Promise.all([first, same])).toEqual([{ value: undefined }, { value: undefined }])
})

// A wait shorter than a second is ordinary pacing and is not reported
test.each(modes)("%s does not report a hold shorter than a second", async (mode) => {
    const quiet = captureLogs()
    const other = await setup(mode, { ...quiet.logging, categories: { ratelimit: "debug" } })
    firstRefused({ "x-ratelimit-global": "true" }, '{"retry_after":0.5,"global":true}')
    const refused = outcome(other.messages.typing("20"))
    await vi.advanceTimersByTimeAsync(0)
    expect(other.diagnostics().rest.rateLimitHold).toMatchObject({ reason: "global", requests: 1 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await refused).toEqual({ value: undefined })
    expect(quiet.withCode("ratelimit.queueHeld")).toEqual([])
})

/** A client whose global pauses can also arrive from outside, as a supervisor relays them from other children */
async function relayed(mode: Mode, logging: NonNullable<ClientOptions["logging"]>, concurrency: number) {
    fakeHostTime()
    const scope = Scope.makeUnsafe()
    let relay: (waitMs: number) => void = () => {
        throw new Error("The client did not listen for relayed pauses")
    }
    const options = attachAccountLimits(
        { token: "fixture-only-not-a-credential", logging, rest: { concurrency } },
        {
            shareGlobalPause: () => {},
            onGlobalPause: (listener) => {
                relay = listener
            },
            members: { request: () => Effect.succeed({ kind: "unreachable" as const }), sent: () => {} },
        },
    )
    const client =
        mode === "default"
            ? createClient(options)
            : await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        await outcome(client.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return { client, relay: (waitMs: number) => relay(waitMs) }
}

/** Keep every operation request open until finish is called, and count them */
function heldOpen() {
    const finishers: (() => void)[] = []
    const finish = () => finishers.splice(0).forEach((resolve) => resolve())
    // Shutdown waits for requests in flight, so a failed assertion must not leave them open
    onTestFinished(finish)
    stubFetchWithHostedDiscovery(
        () =>
            new Promise<Response>((resolve) => void finishers.push(() => resolve(new Response(null, { status: 204 })))),
    )
    return { sent: () => finishers.length, finish }
}

// A pause relayed from another child must recheck calls that already wait, or one whose deadline ends inside the
// pause waits out its deadline and times out without the wait it needed
test.each(modes)("%s fails a queued call at once when a relayed global pause outlasts its deadline", async (mode) => {
    const { client, relay } = await relayed(mode, { sink: () => {} }, 1)
    const requests = heldOpen()
    const active = outcome(client.messages.typing("20"))
    await vi.advanceTimersByTimeAsync(0)
    expect(requests.sent()).toBe(1)
    let settled = false
    const queued = outcome(client.messages.typing("21", { timeoutMs: 1_000 })).finally(() => {
        settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.diagnostics().rest.queuedRequests).toBe(1)
    relay(5_000)
    await hostTurnsUntil(() => settled, 200)
    expect(await queued).toMatchObject({
        error: { reason: "rateLimit", outcome: "notDispatched", retryAfterMs: 5_000 },
    })
    expect(requests.sent()).toBe(1)
    requests.finish()
    expect(await active).toEqual({ value: undefined })
})

// Diagnostics count a call that waits for a slot and a pause, so the report must not wait for a free slot either
test.each(modes)("%s reports a pause that holds queued calls while every slot is busy", async (mode) => {
    const logs = captureLogs()
    const { client, relay } = await relayed(mode, logs.logging, 1)
    const requests = heldOpen()
    const active = outcome(client.messages.typing("20"))
    await vi.advanceTimersByTimeAsync(0)
    const queued = outcome(client.messages.typing("21"))
    await vi.advanceTimersByTimeAsync(0)
    relay(5_000)
    expect(client.diagnostics().rest.rateLimitHold).toMatchObject({ reason: "global", requests: 1 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(logs.withCode("ratelimit.queueHeld")).toEqual([
        expect.objectContaining({ level: "warn", fields: { reason: "global", requests: 1 } }),
    ])
    requests.finish()
    await vi.advanceTimersByTimeAsync(4_000)
    requests.finish()
    expect(await Promise.all([active, queued])).toEqual([{ value: undefined }, { value: undefined }])
})

// A route backlog reported at Debug must not hide the Warn for a broader pause that starts while it lasts
test.each(modes)("%s reports a client pause that starts during an already reported route hold", async (mode) => {
    const logs = captureLogs()
    const client = await setup(mode, { ...logs.logging, categories: { ratelimit: "debug" } })
    let routeRefused = false
    let otherRefused = false
    stubFetchWithHostedDiscovery(async (url) => {
        if (url.includes("/channels/20/") && !routeRefused) {
            routeRefused = true
            return new Response('{"global":false}', {
                status: 429,
                headers: { "retry-after": "5", "x-ratelimit-scope": "user" },
            })
        }
        if (url.includes("/channels/21/") && !otherRefused) {
            otherRefused = true
            return new Response("429 - Ratelimited", {
                status: 429,
                headers: { "retry-after": "3", "content-type": "text/plain" },
            })
        }
        return new Response(null, { status: 204 })
    })
    const route = [outcome(client.messages.typing("20"))]
    await vi.advanceTimersByTimeAsync(0)
    route.push(outcome(client.messages.typing("20")))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(logs.withCode("ratelimit.queueHeld")).toEqual([
        expect.objectContaining({ level: "debug", fields: { reason: "route", requests: 2 } }),
    ])
    const other = outcome(client.messages.typing("21"))
    await vi.advanceTimersByTimeAsync(0)
    expect(client.diagnostics().rest.rateLimitHold).toMatchObject({ reason: "client", requests: 3 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(logs.withCode("ratelimit.queueHeld")).toEqual([
        expect.objectContaining({ level: "debug", fields: { reason: "route", requests: 2 } }),
        expect.objectContaining({ level: "warn", fields: { reason: "client", requests: 3 } }),
    ])
    await vi.advanceTimersByTimeAsync(4_000)
    expect(await Promise.all([...route, other])).toEqual([
        { value: undefined },
        { value: undefined },
        { value: undefined },
    ])
})

// A short global pause can hold a request whose own route waits longer. The record names that longer wait on its own,
// not as the length of the global pause
test.each(modes)("%s does not report a longer route wait as the length of a global pause", async (mode) => {
    const logs = captureLogs()
    const { client, relay } = await relayed(mode, { ...logs.logging, categories: { ratelimit: "debug" } }, 1)
    firstRefused({ "retry-after": "20", "x-ratelimit-scope": "user" }, '{"global":false}')
    const pending = outcome(client.messages.typing("20", { timeoutMs: 60_000 }))
    await vi.advanceTimersByTimeAsync(1_000)
    relay(5_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.diagnostics().rest.rateLimitHold).toMatchObject({ reason: "global", waitMs: 18_000 })
    const [record] = logs.withCode("ratelimit.queueHeld").filter((entry) => entry.fields?.reason === "global")
    expect(record).toMatchObject({ level: "warn", delayMs: 18_000 })
    // The global pause has about four seconds left, so its sentence must not carry the route's 18 seconds
    expect(record!.message).toContain("18000 ms")
    expect(record!.message).not.toMatch(/global rate limit[^.]*18000/)
    await vi.advanceTimersByTimeAsync(18_000)
    expect(await pending).toEqual({ value: undefined })
})
