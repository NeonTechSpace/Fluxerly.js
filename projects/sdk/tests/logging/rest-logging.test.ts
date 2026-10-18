import { afterEach, expect, test, vi } from "vitest"
import type { Client, LogRecord, Observation } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"
import { modes, setup } from "../support/both-apis.js"
import { driveSdkTime, fakeHostTime, hostTurnsUntil, sdkClock } from "../support/client-clock.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs, counters } from "../support/log-capture.js"
import { expectErr, settle } from "../support/settle.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

const target = { id: "10", channelId: "20" }
const wire = (content: string) => ({ id: "10", channel_id: "20", content, author: { id: "30", username: "fixture" } })

test.each(modes)("%s unsafe REST logging reads at most 64 KiB of a response copy, then cancels it", async (mode) => {
    const body = JSON.stringify(wire("y".repeat(200_000)))
    let pulled = 0
    let cancelled = false
    // The logging copy is a separate stream, so the bytes it pulls show exactly how much logging read
    vi.spyOn(Response.prototype, "clone").mockImplementation(function (this: Response) {
        let offset = 0
        const bytes = new TextEncoder().encode(body)
        return new Response(
            new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (offset >= bytes.length) return controller.close()
                    const chunk = bytes.subarray(offset, offset + 16_384)
                    offset += chunk.length
                    pulled += chunk.length
                    controller.enqueue(chunk)
                },
                cancel() {
                    cancelled = true
                },
            }),
            { status: this.status, headers: this.headers },
        )
    })
    stubFetchWithHostedDiscovery(async () => new Response(body, { headers: { "content-type": "application/json" } }))
    const logs = captureLogs()
    const client = await setup(mode, { logging: { ...logs.logging, unsafe: { payloads: true, categories: ["rest"] } } })
    const fetched = await settle(
        mode === "default"
            ? (client as Client).messages.fetch(target)
            : (client as NativeClient).messages.fetch(target),
    )
    // Decoding reads its own stream, so the full content still arrives
    expect(fetched.content).toHaveLength(200_000)
    await vi.waitFor(() => expect(logs.withCode("rest.payloadReceived")).toHaveLength(1))
    expect(logs.withCode("rest.payloadReceived")[0]).toMatchObject({ fields: { truncated: true } })
    expect(pulled).toBeLessThanOrEqual(65_536 + 16_384)
    expect(cancelled).toBe(true)
})

test.each(modes)(
    "%s truncated unsafe REST payloads mask credential-key values without hiding ordinary content",
    async (mode) => {
        const credentials = {
            password: "password fixture with spaces",
            cookie: "session=fixture-cookie; other=fixture",
            "set-cookie": "session=fixture-set-cookie",
            PASSWORD: "uppercase fixture password",
            authorization: "arbitrary fixture authorization",
            client_secret: "fixture client secret",
            customToken: "fixture custom token",
            token: 'fixture token with an escaped "quote"',
        }
        const body = JSON.stringify({
            ...credentials,
            code: "FIXTURE_DIAGNOSTIC_CODE",
            ...wire("visible content " + "y".repeat(200_000)),
        })
        stubFetchWithHostedDiscovery(
            async () => new Response(body, { headers: { "content-type": "application/json" } }),
        )
        const logs = captureLogs()
        const received = Promise.withResolvers<void>()
        const client = await setup(mode, {
            logging: {
                sink: (record: LogRecord) => {
                    logs.logging.sink(record)
                    if (record.code === "rest.payloadReceived") received.resolve()
                },
                unsafe: { payloads: true, categories: ["rest"] },
            },
        })
        await settle(
            mode === "default"
                ? (client as Client).messages.fetch(target)
                : (client as NativeClient).messages.fetch(target),
        )
        await received.promise
        expect(logs.withCode("rest.payloadReceived")).toHaveLength(1)
        const record = logs.withCode("rest.payloadReceived")[0]!
        expect(record.fields?.truncated).toBe(true)
        const payload = String(record.fields?.payload)
        for (const value of Object.values(credentials)) expect(payload).not.toContain(value)
        expect(payload).not.toContain("fixture-cookie")
        expect(payload).not.toContain("fixture-set-cookie")
        expect(payload).not.toContain("escaped")
        expect(payload).toContain("visible content")
        expect(payload).toContain("FIXTURE_DIAGNOSTIC_CODE")
    },
)

test.each(modes)(
    "%s truncated invite lists mask access codes without masking nested diagnostic codes",
    async (mode) => {
        const invites = Array.from({ length: 1_000 }, (_, index) => ({
            code: `fixture-invite-${index}`,
            type: 0,
            channel: { id: "20", type: 0, name: "Fixture channel" },
            guild: { id: "40", name: "Fixture guild" },
            member_count: 1,
            presence_count: 1,
            temporary: false,
            created_at: "2026-01-01T00:00:00.000Z",
            uses: 0,
            max_uses: 0,
            max_age: 86_400,
            diagnostic: { code: "FIXTURE_DIAGNOSTIC_CODE" },
        }))
        const body = JSON.stringify(invites)
        expect(body.length).toBeGreaterThan(65_536)
        stubFetchWithHostedDiscovery(
            async () => new Response(body, { headers: { "content-type": "application/json" } }),
        )
        const logs = captureLogs()
        const received = Promise.withResolvers<void>()
        const client = await setup(mode, {
            logging: {
                sink: (record: LogRecord) => {
                    logs.logging.sink(record)
                    if (record.code === "rest.payloadReceived") received.resolve()
                },
                unsafe: { payloads: true, categories: ["rest"] },
            },
        })
        const fetched = await settle(
            mode === "default"
                ? (client as Client).invites.fetchForChannel("20")
                : (client as NativeClient).invites.fetchForChannel("20"),
        )
        expect(fetched).toHaveLength(invites.length)
        await received.promise
        const record = logs.withCode("rest.payloadReceived")[0]!
        expect(record.fields?.truncated).toBe(true)
        const payload = String(record.fields?.payload)
        expect(payload.includes("fixture-invite-")).toBe(false)
        expect(payload).toContain("[redacted]")
        expect(payload).toContain("Fixture channel")
        expect(payload).toContain("FIXTURE_DIAGNOSTIC_CODE")
    },
)

test.each(modes)(
    "%s a rate limit that would pass the deadline fails at once and is not counted as a wait",
    async (mode) => {
        stubFetchWithHostedDiscovery(async () => Response.json({ retry_after: 5, global: false }, { status: 429 }))
        const logs = captureLogs()
        const client = await setup(mode, { logging: { ...logs.logging, categories: { ratelimit: "debug" } } })
        fakeHostTime()
        let completed = false
        const pending = expectErr(
            mode === "default"
                ? (client as Client).messages.fetch(target, { timeoutMs: 1_000 })
                : (client as NativeClient).messages.fetch(target, { timeoutMs: 1_000 }),
        ).finally(() => {
            completed = true
        })
        // Neither the request deadline nor a retry wait can fire without advancing fake time
        await hostTurnsUntil(() => completed)
        const error = await pending
        expect(performance.now()).toBe(0)
        expect(error).toMatchObject({ reason: "rateLimit", retryAfterMs: 5_000 })
        expect(counters(client).rateLimitWaits).toBe(0)
        expect(logs.withCode("ratelimit.wait")).toEqual([])
        expect(logs.withCode("ratelimit.deadline")).toEqual([
            expect.objectContaining({ level: "warn", delayMs: 5_000, route: "/channels/:id/messages/:id" }),
        ])
        // A body without rate-limit headers adds only the body members it sent
        expect(logs.withCode("ratelimit.deadline")[0]!.fields).toEqual({
            method: "GET",
            global: false,
            retryAfterSeconds: 5,
            bodyGlobal: false,
        })
    },
)

test.each(modes)(
    "%s a rate-limit wait and a deadline repeat the rate-limit headers and body members Fluxer sent",
    async (mode) => {
        const clock = sdkClock()
        const sent = {
            "retry-after": "1",
            "x-ratelimit-scope": "user",
            "x-ratelimit-bucket": "0123456789abcdef",
            "x-ratelimit-limit": "5",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1767225601",
            "x-ratelimit-reset-after": "0.42833333333333334",
        }
        let calls = 0
        stubFetchWithHostedDiscovery(async () =>
            ++calls === 2
                ? Response.json(wire("x"))
                : Response.json(
                      {
                          code: "RATE_LIMITED",
                          message: "Slow down",
                          global: false,
                          retry_after: calls === 1 ? 0.02 : 5,
                      },
                      { status: 429, headers: sent },
                  ),
        )
        const logs = captureLogs()
        const observations: Observation[] = []
        const client = await setup(mode, {
            logging: { ...logs.logging, categories: { ratelimit: "debug" } },
            observe: (observation) => void observations.push(observation),
        })
        const fetch = (timeoutMs: number) =>
            settle(
                mode === "default"
                    ? (client as Client).messages.fetch(target, { timeoutMs })
                    : (client as NativeClient).messages.fetch(target, { timeoutMs }),
            ).then(
                () => "fetched",
                () => "failed",
            )
        expect(await driveSdkTime(clock, fetch(1_000), { stepMs: 20 })).toBe("fetched")
        const details = {
            scope: "user",
            bucket: "0123456789abcdef",
            limit: 5,
            remaining: 0,
            resetAfterSeconds: 0.42833333333333334,
            retryAfterHeaderSeconds: 1,
            retryAfterSeconds: 0.02,
            bodyGlobal: false,
        }
        expect(logs.withCode("ratelimit.wait")).toEqual([
            expect.objectContaining({ delayMs: 20, fields: { method: "GET", global: false, ...details } }),
        ])
        expect(observations.filter((observation) => observation.type === "rateLimit")).toEqual([
            {
                type: "rateLimit",
                method: "GET",
                route: "/channels/:id/messages/:id",
                waitMs: 20,
                global: false,
                ...details,
            },
        ])
        // The second 429 asks for 5 seconds, past the 1-second timeout, so it fails without waiting
        expect(await driveSdkTime(clock, fetch(1_000), { stepMs: 20 })).toBe("failed")
        expect(logs.withCode("ratelimit.deadline")).toEqual([
            expect.objectContaining({
                delayMs: 5_000,
                fields: { method: "GET", global: false, ...details, retryAfterSeconds: 5 },
            }),
        ])
    },
)

test.each(modes)(
    "%s rate-limit details omit values in another form and mask the token in what an observer receives",
    async (mode) => {
        const clock = sdkClock()
        const token = "fixture-only-not-a-credential-token"
        let calls = 0
        stubFetchWithHostedDiscovery(async () =>
            ++calls === 2
                ? Response.json(wire("x"))
                : Response.json(
                      { global: "no", retry_after: 0.02 },
                      {
                          status: 429,
                          headers: {
                              "retry-after": "Thu, 01 Jan 2026 00:00:01 GMT",
                              "x-ratelimit-scope": "user scope",
                              "x-ratelimit-bucket": token,
                              "x-ratelimit-limit": "5.5",
                              "x-ratelimit-remaining": "-1",
                              "x-ratelimit-reset-after": `0.${"1".repeat(31)}`,
                          },
                      },
                  ),
        )
        const logs = captureLogs()
        const observations: Observation[] = []
        const client = await setup(mode, {
            token,
            logging: { ...logs.logging, categories: { ratelimit: "debug" } },
            observe: (observation) => void observations.push(observation),
        })
        await driveSdkTime(
            clock,
            settle(
                mode === "default"
                    ? (client as Client).messages.fetch(target)
                    : (client as NativeClient).messages.fetch(target),
            ),
            { stepMs: 20 },
        )
        expect(logs.withCode("ratelimit.wait")[0]!.fields).toEqual({
            method: "GET",
            global: false,
            bucket: "[redacted]",
            retryAfterSeconds: 0.02,
        })
        expect(observations.find((observation) => observation.type === "rateLimit")).toEqual({
            type: "rateLimit",
            method: "GET",
            route: "/channels/:id/messages/:id",
            waitMs: 20,
            global: false,
            bucket: "[redacted]",
            retryAfterSeconds: 0.02,
        })
    },
)
