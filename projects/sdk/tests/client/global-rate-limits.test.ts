import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, type ClientOptions } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { modes, type Mode } from "../support/both-apis.js"
import { fakeHostTime, hostTurnsUntil, outcome } from "../support/client-clock.js"
import { captureLogs } from "../support/log-capture.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

async function setup(mode: Mode, logging?: ClientOptions["logging"]) {
    fakeHostTime()
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture-only-not-a-credential", ...(logging ? { logging } : {}) }
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

const cases = [
    { name: "global header with missing body", headers: { "x-ratelimit-global": "true" }, body: null, global: true },
    {
        name: "global header with non-JSON body",
        headers: { "x-ratelimit-global": "true" },
        body: "unavailable",
        global: true,
    },
    {
        name: "global header with oversized body",
        headers: { "x-ratelimit-global": "true" },
        body: "x".repeat(8193),
        global: true,
    },
    {
        name: "global header with oversized declared length",
        headers: { "x-ratelimit-global": "true", "content-length": "8193" },
        body: "{}",
        global: true,
    },
    { name: "global scope with malformed JSON", headers: { "x-ratelimit-scope": "global" }, body: "{", global: true },
    { name: "body-only global rejection", headers: {}, body: '{"global":true}', global: true },
    {
        name: "global header overrides false body and shared scope",
        headers: { "x-ratelimit-global": "true", "x-ratelimit-scope": "shared" },
        body: '{"global":false}',
        global: true,
    },
    {
        name: "global scope overrides false header",
        headers: { "x-ratelimit-global": "false", "x-ratelimit-scope": "global" },
        body: "{}",
        global: true,
    },
    {
        name: "global body overrides local headers",
        headers: { "x-ratelimit-global": "false", "x-ratelimit-scope": "user" },
        body: '{"global":true}',
        global: true,
    },
    {
        name: "shared scope stays local",
        headers: { "x-ratelimit-scope": "shared" },
        body: '{"global":false}',
        global: false,
    },
    { name: "user scope stays local", headers: { "x-ratelimit-scope": "user" }, body: null, global: false },
    { name: "absent scope stays local", headers: {}, body: "{}", global: false },
    {
        name: "malformed values do not assert global scope",
        headers: { "x-ratelimit-global": "1", "x-ratelimit-scope": "global, shared" },
        body: '{"global":"true"}',
        global: false,
    },
    {
        name: "combined global header is not a boolean",
        headers: { "x-ratelimit-global": "true, false" },
        body: null,
        global: false,
    },
] satisfies { name: string; headers: Record<string, string>; body: string | null; global: boolean }[]

for (const mode of modes) {
    test.each(cases)(`${mode}: $name preserves the correct cross-route admission`, async (entry) => {
        const client = await setup(mode)
        const calls: string[] = []
        stubFetchWithHostedDiscovery(async (url) => {
            calls.push(url)
            return calls.length === 1
                ? new Response(entry.body, { status: 429, headers: { "retry-after": "1", ...entry.headers } })
                : new Response(null, { status: 204 })
        })
        const first = outcome(client.messages.typing("20", { timeoutMs: 500 }))
        await vi.advanceTimersByTimeAsync(0)
        expect(await first).toMatchObject({ error: { reason: "rateLimit", outcome: "rejected", status: 429 } })

        // A request whose deadline ends within the pause fails at once with the remaining wait
        const other = outcome(client.messages.delete({ channelId: "21", id: "10" }, { timeoutMs: 100 }))
        expect(await other).toMatchObject(
            entry.global
                ? { error: { reason: "rateLimit", outcome: "notDispatched", retryAfterMs: 1_000 } }
                : { value: undefined },
        )
        expect(calls).toHaveLength(entry.global ? 1 : 2)
        await vi.advanceTimersByTimeAsync(110)

        // The rejected route is still paused even when unrelated routes can proceed
        const same = outcome(client.messages.typing("20", { timeoutMs: 100 }))
        expect(await same).toMatchObject({
            error: { reason: "rateLimit", outcome: "notDispatched", retryAfterMs: 890 },
        })
        await vi.advanceTimersByTimeAsync(1000)
        expect(await outcome(client.messages.typing("20"))).toEqual({ value: undefined })
        expect(calls).toHaveLength(entry.global ? 2 : 3)
    })

    test(`${mode}: a global header blocks other routes during slow body parsing and cancels the reader`, async () => {
        const client = await setup(mode)
        const cancelled = vi.fn()
        let calls = 0
        stubFetchWithHostedDiscovery(async () =>
            ++calls === 1
                ? new Response(new ReadableStream({ cancel: cancelled }), {
                      status: 429,
                      headers: { "retry-after": "1", "x-ratelimit-global": "true" },
                  })
                : new Response(null, { status: 204 }),
        )
        const first = outcome(client.messages.typing("20", { timeoutMs: 500 }))
        await vi.advanceTimersByTimeAsync(0)
        const other = outcome(client.messages.typing("21", { timeoutMs: 30 }))
        expect(await other).toMatchObject({
            error: { reason: "rateLimit", outcome: "notDispatched", retryAfterMs: 1_000 },
        })
        expect(cancelled).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(110)
        expect(await first).toMatchObject({ error: { reason: "rateLimit", outcome: "rejected" } })
        expect(cancelled).toHaveBeenCalledOnce()
        expect(calls).toBe(1)
    })

    test(`${mode}: cancellation removes a globally queued request without dispatch or delaying recovery`, async () => {
        const client = await setup(mode)
        let calls = 0
        stubFetchWithHostedDiscovery(async () =>
            ++calls === 1
                ? new Response(null, { status: 429, headers: { "retry-after": "1", "x-ratelimit-scope": "global" } })
                : new Response(null, { status: 204 }),
        )
        const first = outcome(client.messages.typing("20", { timeoutMs: 500 }))
        await vi.advanceTimersByTimeAsync(0)
        expect(await first).toHaveProperty("error")
        const controller = new AbortController()
        const operation = client.messages.typing("21", { signal: controller.signal })
        const queued = Effect.isEffect(operation)
            ? Effect.runPromiseExit(operation, { signal: controller.signal }).then((result) => {
                  expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
              })
            : operation.then((result) => {
                  expect(result.isErr() && result.error).toMatchObject({ _tag: "CancelledError" })
              })
        await vi.advanceTimersByTimeAsync(0)
        controller.abort()
        await queued
        expect(calls).toBe(1)
        await vi.advanceTimersByTimeAsync(1000)
        expect(await outcome(client.messages.typing("22"))).toEqual({ value: undefined })
        expect(calls).toBe(2)
        await outcome(client.shutdown())
        expect(vi.getTimerCount()).toBe(0)
    })

    test(`${mode}: global metadata uses body timing when the header delay is unavailable`, async () => {
        const client = await setup(mode)
        let calls = 0
        stubFetchWithHostedDiscovery(async () =>
            ++calls === 1
                ? Response.json({ retry_after: 1 }, { status: 429, headers: { "x-ratelimit-global": "true" } })
                : new Response(null, { status: 204 }),
        )
        const first = outcome(client.messages.typing("20", { timeoutMs: 500 }))
        await vi.advanceTimersByTimeAsync(0)
        expect(await first).toMatchObject({ error: { retryAfterMs: 1000, outcome: "rejected" } })
        const other = outcome(client.messages.typing("21", { timeoutMs: 100 }))
        await vi.advanceTimersByTimeAsync(110)
        expect(await other).toMatchObject({ error: { outcome: "notDispatched" } })
        expect(calls).toBe(1)
    })

    // One hour-long global pause held every later request until its own deadline ended as a timeout without a wait
    test(`${mode}: a request whose deadline ends within a global pause fails at once, and the pause still ends`, async () => {
        const logs = captureLogs()
        const client = await setup(mode, { ...logs.logging, categories: { ratelimit: "debug" } })
        let calls = 0
        stubFetchWithHostedDiscovery(async () =>
            ++calls === 1
                ? new Response(null, { status: 429, headers: { "retry-after": "3600", "x-ratelimit-global": "true" } })
                : new Response(null, { status: 204 }),
        )
        expect(await outcome(client.messages.typing("20"))).toMatchObject({
            error: { reason: "rateLimit", outcome: "rejected", retryAfterMs: 3_600_000 },
        })
        // Fake time stands still, so neither the 30 second default deadline nor the pause can end while this waits
        let settled = false
        const later = outcome(client.messages.typing("21")).finally(() => {
            settled = true
        })
        await hostTurnsUntil(() => settled)
        expect(await later).toMatchObject({
            error: { reason: "rateLimit", outcome: "notDispatched", retryAfterMs: 3_600_000 },
        })
        // A long pause refuses every request on the route, so a repeat within a minute is recorded at Debug only
        settled = false
        const repeat = outcome(client.messages.typing("22")).finally(() => {
            settled = true
        })
        await hostTurnsUntil(() => settled)
        expect(await repeat).toMatchObject({ error: { reason: "rateLimit", outcome: "notDispatched" } })
        expect(calls).toBe(1)
        expect(logs.withCode("ratelimit.deadline")).toEqual([
            expect.objectContaining({ level: "warn", delayMs: 3_600_000 }),
            expect.objectContaining({ level: "warn", delayMs: 3_600_000 }),
            expect.objectContaining({ level: "debug", delayMs: 3_600_000 }),
        ])
        await vi.advanceTimersByTimeAsync(3_600_000)
        expect(await outcome(client.messages.typing("21"))).toEqual({ value: undefined })
        expect(calls).toBe(2)
    })

    test.each(["network", "server"])(`${mode}: %s failure never replays an uncertain mutation`, async (failure) => {
        const client = await setup(mode)
        let calls = 0
        stubFetchWithHostedDiscovery(async () => {
            calls++
            if (failure === "network") throw new TypeError("fixture connection lost")
            return new Response(null, { status: 503, headers: { "retry-after": "1", "x-ratelimit-global": "true" } })
        })
        const write = outcome(client.messages.typing("20"))
        await vi.advanceTimersByTimeAsync(0)
        expect(await write).toMatchObject({ error: { outcome: "unknown" } })
        await vi.advanceTimersByTimeAsync(2000)
        expect(calls).toBe(1)
    })
}
