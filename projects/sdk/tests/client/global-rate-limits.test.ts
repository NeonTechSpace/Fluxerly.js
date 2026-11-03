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
    { name: "global header with missing body", headers: { "x-ratelimit-global": "true" }, body: null, pause: "global" },
    {
        name: "global header with non-JSON body",
        headers: { "x-ratelimit-global": "true" },
        body: "unavailable",
        pause: "global",
    },
    {
        name: "global header with oversized body",
        headers: { "x-ratelimit-global": "true" },
        body: "x".repeat(8193),
        pause: "global",
    },
    {
        name: "global header with oversized declared length",
        headers: { "x-ratelimit-global": "true", "content-length": "8193" },
        body: "{}",
        pause: "global",
    },
    {
        name: "global scope with malformed JSON",
        headers: { "x-ratelimit-scope": "global" },
        body: "{",
        pause: "global",
    },
    { name: "body-only global rejection", headers: {}, body: '{"global":true}', pause: "global" },
    {
        name: "global header overrides false body and shared scope",
        headers: { "x-ratelimit-global": "true", "x-ratelimit-scope": "shared" },
        body: '{"global":false}',
        pause: "global",
    },
    {
        name: "global scope overrides false header",
        headers: { "x-ratelimit-global": "false", "x-ratelimit-scope": "global" },
        body: "{}",
        pause: "global",
    },
    {
        name: "global body overrides local headers",
        headers: { "x-ratelimit-global": "false", "x-ratelimit-scope": "user" },
        body: '{"global":true}',
        pause: "global",
    },
    {
        name: "shared scope stays local",
        headers: { "x-ratelimit-scope": "shared" },
        body: '{"global":false}',
        pause: "bucket",
    },
    { name: "user scope stays local", headers: { "x-ratelimit-scope": "user" }, body: null, pause: "bucket" },
    {
        name: "a bucket header with a plain-text body stays local",
        headers: { "x-ratelimit-bucket": "fixture-bucket" },
        body: "429 - Ratelimited",
        pause: "bucket",
    },
    {
        name: "a Fluxer body with a false global member stays local",
        headers: {},
        body: '{"global":false}',
        pause: "bucket",
    },
    // A 429 that names no limiter, such as a proxy in front of the API, pauses the whole client without claiming global
    { name: "an empty JSON body pauses the client", headers: {}, body: "{}", pause: "client" },
    { name: "a plain-text body pauses the client", headers: {}, body: "429 - Ratelimited", pause: "client" },
    { name: "a missing body pauses the client", headers: {}, body: null, pause: "client" },
    {
        name: "malformed values do not assert global scope",
        headers: { "x-ratelimit-global": "1", "x-ratelimit-scope": "global, shared" },
        body: '{"global":"true"}',
        pause: "client",
    },
    {
        name: "combined global header is not a boolean",
        headers: { "x-ratelimit-global": "true, false" },
        body: null,
        pause: "client",
    },
] satisfies {
    name: string
    headers: Record<string, string>
    body: string | null
    /** What the SDK pauses: Fluxer's global limit, the whole client for an unidentified limiter, or one bucket */
    pause: "global" | "client" | "bucket"
}[]

for (const mode of modes) {
    test.each(cases)(`${mode}: $name preserves the correct cross-route admission`, async (entry) => {
        const logs = captureLogs()
        const client = await setup(mode, { ...logs.logging, categories: { ratelimit: "debug" } })
        const paused = entry.pause !== "bucket"
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
            paused
                ? { error: { reason: "rateLimit", outcome: "notDispatched", retryAfterMs: 1_000 } }
                : { value: undefined },
        )
        expect(calls).toHaveLength(paused ? 1 : 2)
        // The record says what the SDK paused, and global only when Fluxer declared a global limit
        expect(logs.withCode("ratelimit.deadline")[0]).toMatchObject({
            fields: { global: entry.pause === "global", pause: paused ? "client" : "bucket" },
        })
        await vi.advanceTimersByTimeAsync(110)

        // The rejected route is still paused even when unrelated routes can proceed
        const same = outcome(client.messages.typing("20", { timeoutMs: 100 }))
        expect(await same).toMatchObject({
            error: { reason: "rateLimit", outcome: "notDispatched", retryAfterMs: 890 },
        })
        await vi.advanceTimersByTimeAsync(1000)
        expect(await outcome(client.messages.typing("20"))).toEqual({ value: undefined })
        expect(calls).toHaveLength(paused ? 2 : 3)
    })

    test(`${mode}: an unidentified plain-text 429 holds every API route of this client for its wait`, async () => {
        const logs = captureLogs()
        const client = await setup(mode, { ...logs.logging, categories: { ratelimit: "debug" } })
        const sent: number[] = []
        stubFetchWithHostedDiscovery(async () => {
            sent.push(Date.now())
            return sent.length === 1
                ? new Response("429 - Ratelimited", {
                      status: 429,
                      headers: { "retry-after": "5", "content-type": "text/plain" },
                  })
                : new Response(null, { status: 204 })
        })
        const start = Date.now()
        const first = outcome(client.messages.typing("20"))
        await vi.advanceTimersByTimeAsync(0)
        const other = outcome(client.messages.delete({ channelId: "21", id: "10" }))
        await vi.advanceTimersByTimeAsync(4999)
        expect(sent).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(await first).toEqual({ value: undefined })
        expect(await other).toEqual({ value: undefined })
        expect(sent.map((at) => at - start)).toEqual([0, 5000, 5000])
        const [wait] = logs.withCode("ratelimit.wait")
        expect(wait).toMatchObject({ delayMs: 5000, fields: { global: false, pause: "client" } })
        // Fluxer did not declare a global limit, so the record does not claim one
        expect(wait!.message).not.toContain("globally")
        expect(wait!.message).toContain("Every API request of this client waits too")
    })

    // A proxy that keeps refusing for a minute while it always advertises five seconds would otherwise wake the whole
    // queue every five seconds
    test(`${mode}: repeated unidentified 429s grow the pause with bounded jitter and release the queue after one probe`, async () => {
        vi.spyOn(Math, "random").mockReturnValue(0.5)
        const logs = captureLogs()
        const client = await setup(mode, { ...logs.logging, categories: { ratelimit: "debug" } })
        const start = Date.now()
        const sent: [number, string][] = []
        stubFetchWithHostedDiscovery(async (url) => {
            sent.push([Date.now() - start, new URL(url).pathname])
            return Date.now() - start < 60_000
                ? new Response("429 - Ratelimited", { status: 429, headers: { "retry-after": "5" } })
                : new Response(null, { status: 204 })
        })
        const operations = ["20", "21", "22"].map((channel) =>
            outcome(client.messages.typing(channel, { timeoutMs: 120_000 })),
        )
        await vi.advanceTimersByTimeAsync(0)
        // The three requests were sent together and refused together, which pauses once for the asked five seconds.
        // Each probe that is refused again doubles the asked wait and adds half of the bounded jitter
        for (const [hold, count] of [
            [5_000, 3],
            [10_500, 4],
            [20_500, 5],
            [40_500, 6],
        ] as const) {
            expect(sent).toHaveLength(count)
            await vi.advanceTimersByTimeAsync(hold - 1)
            expect(sent).toHaveLength(count)
            await vi.advanceTimersByTimeAsync(1)
        }
        // The probe at 76.5 seconds is accepted, and only then are the two waiting requests released
        expect(await Promise.all(operations)).toEqual([
            { value: undefined },
            { value: undefined },
            { value: undefined },
        ])
        expect(sent.map(([at]) => at)).toEqual([0, 0, 0, 5_000, 15_500, 36_000, 76_500, 76_500, 76_500])
        expect(new Set(sent.slice(6).map(([, path]) => path)).size).toBe(3)
        // The logger collapses the three identical first waits into one record
        expect(logs.withCode("ratelimit.wait").map((record) => record.delayMs)).toEqual([5_000, 10_500, 20_500, 40_500])
    })

    // A request sent before the pause can answer after it, while the probe is still waiting. Only the probe's own
    // answer says whether the limit has passed, so the older answer must not release the queue
    test(`${mode}: an older response does not release the queue before the recovery probe answers`, async () => {
        const client = await setup(mode)
        const start = Date.now()
        const sent: [number, string][] = []
        const older = Promise.withResolvers<Response>()
        const probe = Promise.withResolvers<Response>()
        stubFetchWithHostedDiscovery(async (url) => {
            sent.push([Date.now() - start, new URL(url).pathname])
            if (sent.length === 1) return older.promise
            if (sent.length === 2)
                return new Response("429 - Ratelimited", { status: 429, headers: { "retry-after": "5" } })
            if (sent.length === 3) return probe.promise
            return new Response(null, { status: 204 })
        })
        const held = outcome(client.messages.typing("20", { timeoutMs: 60_000 }))
        await vi.advanceTimersByTimeAsync(0)
        const limited = outcome(client.messages.typing("21", { timeoutMs: 60_000 }))
        await vi.advanceTimersByTimeAsync(0)
        const queued = outcome(client.messages.typing("22", { timeoutMs: 60_000 }))
        await vi.advanceTimersByTimeAsync(5_000)
        // The refused request probes the limit after the pause, and the third waits for its answer
        expect(sent.map(([, path]) => path)).toEqual([
            "/api/v1/channels/20/typing",
            "/api/v1/channels/21/typing",
            "/api/v1/channels/21/typing",
        ])
        older.resolve(new Response(null, { status: 204 }))
        expect(await held).toEqual({ value: undefined })
        await vi.advanceTimersByTimeAsync(1_000)
        expect(sent).toHaveLength(3)
        probe.resolve(new Response(null, { status: 204 }))
        expect(await limited).toEqual({ value: undefined })
        expect(await queued).toEqual({ value: undefined })
        expect(sent.map(([at, path]) => [at, path])).toEqual([
            [0, "/api/v1/channels/20/typing"],
            [0, "/api/v1/channels/21/typing"],
            [5_000, "/api/v1/channels/21/typing"],
            [6_000, "/api/v1/channels/22/typing"],
        ])
    })

    // A probe ends its recovery when its response arrives, but keeps its slot while it reads the body. When a later
    // unidentified 429 starts a newer recovery meanwhile, that slot's release must not hand the newer probe's role on
    test(`${mode}: a finished probe's release does not start a second probe in a newer recovery`, async () => {
        const client = await setup(mode)
        const sent: string[] = []
        const limited = () => new Response("429 - Ratelimited", { status: 429, headers: { "retry-after": "1" } })
        let finishBody!: () => void
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode(
                        JSON.stringify({
                            id: "10",
                            channel_id: "20",
                            content: "",
                            author: { id: "30", username: "fixture" },
                        }),
                    ),
                )
                finishBody = () => controller.close()
            },
        })
        const newerProbe = Promise.withResolvers<Response>()
        stubFetchWithHostedDiscovery(async (url) => {
            const index = sent.push(new URL(url).pathname)
            if (index === 1 || index === 3) return limited()
            if (index === 2) return new Response(body, { headers: { "content-type": "application/json" } })
            if (index === 4) return newerProbe.promise
            return new Response(null, { status: 204 })
        })
        const read = outcome(client.messages.fetch({ channelId: "20", id: "10" }, { timeoutMs: 60_000 }))
        await vi.advanceTimersByTimeAsync(1_000)
        // The first probe's response arrived and released the queue, while its body is still open
        expect(sent).toHaveLength(2)
        const second = outcome(client.messages.typing("21", { timeoutMs: 60_000 }))
        await vi.advanceTimersByTimeAsync(0)
        expect(sent).toHaveLength(3)
        const waiting = outcome(client.messages.typing("22", { timeoutMs: 60_000 }))
        await vi.advanceTimersByTimeAsync(1_000)
        // The newer probe is in flight and the third request waits for its answer
        expect(sent).toHaveLength(4)
        finishBody()
        expect(await read).toMatchObject({ value: { id: "10" } })
        await vi.advanceTimersByTimeAsync(1_000)
        expect(sent).toHaveLength(4)
        newerProbe.resolve(new Response(null, { status: 204 }))
        expect(await second).toEqual({ value: undefined })
        expect(await waiting).toEqual({ value: undefined })
        expect(sent).toEqual([
            "/api/v1/channels/20/messages/10",
            "/api/v1/channels/20/messages/10",
            "/api/v1/channels/21/typing",
            "/api/v1/channels/21/typing",
            "/api/v1/channels/22/typing",
        ])
    })

    // A signed upload PUT goes to a storage host, so its success says nothing about Fluxer's API limit. Once it was
    // taken as the probe, it released the waiting API requests together and reset the growing pause
    test(`${mode}: a signed upload PUT neither ends an unidentified pause nor resets its growth`, async () => {
        vi.spyOn(Math, "random").mockReturnValue(0.5)
        const client = await setup(mode)
        const start = Date.now()
        const sent: [number, string][] = []
        const firstPut = Promise.withResolvers<Response>()
        onTestFinished(() => firstPut.resolve(new Response(null)))
        let puts = 0
        let typing = 0
        stubFetchWithHostedDiscovery(async (url, init) => {
            const target = new URL(url)
            sent.push([Date.now() - start, `${init.method} ${target.hostname}${target.pathname}`])
            if (target.hostname === "storage.example.test") {
                await new Response(init.body).arrayBuffer()
                return ++puts === 1 ? firstPut.promise : new Response(null)
            }
            if (target.pathname.endsWith("/attachments")) {
                const files = (JSON.parse(String(init.body)) as { attachments: { id: number }[] }).attachments
                return Response.json({
                    attachments: files.map((file, index) => ({
                        ...file,
                        content_type: "application/octet-stream",
                        upload_filename: `file-${index}`,
                        upload_mode: "singlepart",
                        upload_url: `https://storage.example.test/file-${index}`,
                    })),
                })
            }
            if (target.pathname.endsWith("/typing"))
                return ++typing <= 2
                    ? new Response("429 - Ratelimited", { status: 429, headers: { "retry-after": "5" } })
                    : new Response(null, { status: 204 })
            return Response.json({
                id: "10",
                channel_id: "20",
                content: "",
                author: { id: "30", username: "fixture", bot: true },
                attachments: [],
            })
        })
        const upload = outcome(
            client.messages.send(
                "20",
                {
                    attachments: [
                        { filename: "a.bin", data: new Uint8Array([1]) },
                        { filename: "b.bin", data: new Uint8Array([2]) },
                    ],
                },
                { timeoutMs: 120_000 },
            ),
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(puts).toBe(1)
        // An unidentified 429 pauses the client for five seconds while the first PUT is still open
        const refused = outcome(client.messages.typing("21", { timeoutMs: 500 }))
        await vi.advanceTimersByTimeAsync(0)
        expect(await refused).toMatchObject({ error: { reason: "rateLimit", retryAfterMs: 5_000 } })
        // The second PUT now waits for the pause, first in the queue and ahead of three API requests
        firstPut.resolve(new Response(null))
        await vi.advanceTimersByTimeAsync(0)
        const waiting = ["22", "23", "24"].map((channel) =>
            outcome(client.messages.typing(channel, { timeoutMs: 120_000 })),
        )
        await vi.advanceTimersByTimeAsync(5_000)
        // The PUT went out after the pause without waiting for the probe, and one API request probes alone
        expect(sent.filter(([at]) => at === 5_000).map(([, request]) => request)).toEqual([
            "PUT storage.example.test/file-1",
            "POST fluxer.com/api/v1/channels/22/typing",
        ])
        // That probe is refused again, so the next pause doubles to ten seconds plus half of the bounded jitter
        await vi.advanceTimersByTimeAsync(10_499)
        expect(sent.filter(([at]) => at > 5_000)).toEqual([])
        await vi.advanceTimersByTimeAsync(1)
        expect(await Promise.all(waiting)).toEqual([{ value: undefined }, { value: undefined }, { value: undefined }])
        expect(await upload).toMatchObject({ value: { id: "10" } })
        expect(sent.filter(([, request]) => request.endsWith("/typing")).map(([at]) => at)).toEqual([
            0, 5_000, 15_500, 15_500, 15_500,
        ])
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
