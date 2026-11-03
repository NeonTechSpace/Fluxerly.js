import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import {
    LiveThrottledError,
    clearThrottle,
    createPacer,
    defaultIntervalMs,
    pacedFetch,
    readState,
    sanitizedRoute,
} from "./support/live-pacing.js"
import { anyStatus, createSandboxApi } from "./support/sandbox-api.js"

const parent = realpathSync(tmpdir())
const roots = []
/** Wall time at the start of every test. The host Date is fixed to it, so HTTP-date waits are exact */
const start = Date.parse("2026-11-03T12:00:00.000Z")
afterEach(() => {
    vi.useRealTimers()
    for (const root of roots.splice(0)) {
        expect(dirname(root)).toBe(parent)
        rmSync(root, { recursive: true })
    }
})

/** A pacing state file in a fresh temporary folder, and one controlled clock that every pacer of a test shares */
function world() {
    const root = mkdtempSync(join(parent, "fluxerly-live-pacing-"))
    roots.push(root)
    vi.useFakeTimers({ toFake: ["Date"], now: start })
    const clock = { now: start, sleeps: [] }
    const pacer = (options = {}) =>
        createPacer({
            statePath: join(root, ".env.test.pace.json"),
            logPath: join(root, "requests.jsonl"),
            now: () => clock.now,
            // Sleeping moves the controlled clock, so no test waits on host time
            sleep: async (milliseconds) => {
                clock.sleeps.push(milliseconds)
                clock.now += milliseconds
            },
            lockWaitMs: 0,
            ...options,
        })
    const log = () =>
        existsSync(join(root, "requests.jsonl"))
            ? readFileSync(join(root, "requests.jsonl"), "utf8")
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line))
            : []
    return { root, clock, pacer, log, state: () => readState(join(root, ".env.test.pace.json")) }
}

/** A fake transport that records each start on the controlled clock and answers with the next scripted response */
function transport(clock, responses = []) {
    const starts = []
    const fetch = async () => {
        starts.push(clock.now - start)
        return responses.shift() ?? Response.json({ id: "1" })
    }
    return { starts, fetch }
}

test("raw helper requests start one interval apart with no initial burst and are logged as raw", async () => {
    const { clock, pacer, log } = world()
    const fake = transport(clock)
    const api = createSandboxApi({ fetch: pacedFetch(fake.fetch, pacer()), token: () => "synthetic-token-value" })
    for (let index = 0; index < 4; index++) await api("GET", "/channels/123456789012345678/messages")
    expect(fake.starts).toEqual([0, 1, 2, 3].map((n) => n * defaultIntervalMs))
    expect(log().map((entry) => [entry.sender, entry.method, entry.route, entry.status])).toEqual(
        Array(4).fill(["raw", "GET", "fluxer.com/api/v1/channels/:id/messages", 200]),
    )
})

test("pacing carries across processes, API modes and checks through the shared state file", async () => {
    const { clock, pacer } = world()
    const fake = transport(clock)
    // Each pacer stands for a separate harness process, such as the default and Effect runs of one check
    const defaultMode = pacedFetch(fake.fetch, pacer())
    const effectMode = pacedFetch(fake.fetch, pacer())
    await defaultMode("https://fluxer.com/api/v1/users/@me")
    await effectMode("https://fluxer.com/api/v1/users/@me")
    await defaultMode("https://fluxer.com/.well-known/fluxer")
    expect(fake.starts).toEqual([0, 1, 2].map((n) => n * defaultIntervalMs))
})

test("the interval is configurable", async () => {
    const { clock, pacer } = world()
    const fake = transport(clock)
    const fetch = pacedFetch(fake.fetch, pacer({ intervalMs: 4000 }))
    await fetch("https://fluxer.com/api/v1/users/@me")
    await fetch("https://fluxer.com/api/v1/users/@me")
    expect(fake.starts).toEqual([0, 4000])
})

test("a hosted 429 pauses every sender for at least its Retry-After and marks the run throttled", async () => {
    const { clock, pacer, state } = world()
    const fake = transport(clock, [new Response("429 - Ratelimited", { status: 429, headers: { "retry-after": "5" } })])
    const sdk = pacedFetch(fake.fetch, pacer())
    const raw = pacedFetch(fake.fetch, pacer())
    expect((await sdk("https://fluxer.com/api/v1/channels/20")).status).toBe(429)
    expect(state().throttled).toEqual({ at: start, waitMs: 5000, route: "fluxer.com/api/v1/channels/:id" })
    // Another sender, including cleanup, waits for the whole pause before it starts
    await raw("https://fluxer.com/api/v1/channels/21", { method: "DELETE" })
    expect(fake.starts).toEqual([0, 5000])
})

// A sender already waiting for its slot when another sender's 429 arrives must also wait out the new pause
test("a sender already waiting for its slot waits for a pause recorded meanwhile", async () => {
    const held = []
    const { clock, pacer, state } = world()
    // Each sleep is held until the test releases it, then ends at the time it was asked to wake
    const sleep = (milliseconds) =>
        new Promise((resolve) => {
            const until = clock.now + milliseconds
            held.push(() => {
                clock.now = Math.max(clock.now, until)
                resolve()
            })
        })
    let answer
    const starts = []
    const base = async () => {
        starts.push(clock.now - start)
        if (starts.length === 1) return new Promise((resolve) => (answer = resolve))
        return Response.json({ id: "1" })
    }
    const first = pacedFetch(base, pacer({ sleep }))("https://fluxer.com/api/v1/users/@me")
    const second = pacedFetch(base, pacer({ sleep }))("https://fluxer.com/api/v1/users/@me")
    await vi.waitFor(() => expect(held).toHaveLength(1))
    // The first request is answered with a 429 while the second sleeps until its reserved slot one interval later
    clock.now = start + 300
    answer(new Response(null, { status: 429, headers: { "retry-after": "5" } }))
    expect((await first).status).toBe(429)
    expect(state().pausedUntil).toBe(start + 5300)
    held.shift()()
    // The second sender either starts or sleeps again
    await vi.waitFor(() => expect(held.length + starts.length).toBe(2))
    expect(starts).toEqual([0])
    held.shift()()
    expect((await second).status).toBe(200)
    expect(starts).toEqual([0, 5300])
})

test("a 429 without a usable Retry-After pauses for one minute, and a pause over ten seconds stops senders", async () => {
    const { clock, pacer } = world()
    const fake = transport(clock, [new Response(null, { status: 429 })])
    const fetch = pacedFetch(fake.fetch, pacer())
    await fetch("https://fluxer.com/api/v1/users/@me")
    clock.now += 1000
    await expect(fetch("https://fluxer.com/api/v1/users/@me")).rejects.toMatchObject({
        name: "LiveThrottledError",
        waitMs: 59_000,
    })
    expect(fake.starts).toEqual([0])
    // Once the remaining pause fits in ten seconds, the sender waits it out instead
    clock.now = start + 50_000
    await fetch("https://fluxer.com/api/v1/users/@me")
    expect(fake.starts).toEqual([0, 60_000])
})

test("an injected test 429 above the pacing layer neither pauses senders nor throttles the run", async () => {
    const { clock, pacer, state } = world()
    const fake = transport(clock)
    const paced = pacedFetch(fake.fetch, pacer())
    // A harness injects its own 429 by replacing fetch above the pacer, as the rate-limit checks do
    const injecting = async (url, init) =>
        url.endsWith("/typing")
            ? new Response(null, { status: 429, headers: { "retry-after": "1" } })
            : paced(url, init)
    expect((await injecting("https://fluxer.com/api/v1/channels/20/typing")).status).toBe(429)
    await injecting("https://fluxer.com/api/v1/users/@me")
    expect(state().throttled).toBeUndefined()
    expect(fake.starts).toEqual([0])
})

test("the request log keeps only the time, sender, method, sanitized route, status and rate-limit headers", async () => {
    const { clock, pacer, log } = world()
    const fake = transport(clock, [
        Response.json(
            { token: "private-body-value" },
            {
                headers: {
                    "x-ratelimit-bucket": "fixture-bucket",
                    "x-ratelimit-remaining": "3",
                    "set-cookie": "session=private-cookie-value",
                    "x-private": "private-header-value",
                },
            },
        ),
    ])
    const fetch = pacedFetch(fake.fetch, pacer())
    await fetch("https://fluxer.com/api/v1/webhooks/123456789012345678/private-webhook-token?wait=true", {
        method: "post",
        headers: { Authorization: "Bot synthetic-token-value" },
        body: JSON.stringify({ content: "private-request-body" }),
    })
    const [entry] = log()
    expect(entry).toEqual({
        at: new Date(start).toISOString(),
        readyAt: new Date(start).toISOString(),
        waitMs: 0,
        ms: 0,
        pid: process.pid,
        sender: "sdk",
        method: "POST",
        route: "fluxer.com/api/v1/webhooks/:id/:token",
        status: 200,
        headers: { "x-ratelimit-bucket": "fixture-bucket", "x-ratelimit-remaining": "3" },
    })
    const text = JSON.stringify(log())
    for (const secret of ["synthetic-token", "private"]) expect(text).not.toContain(secret)
})

test("routes replace IDs, tokens, invite codes and long values", () => {
    const route = (path) => sanitizedRoute(new URL(`https://fluxer.com${path}`))
    expect(route("/api/v1/guilds/123/members/456")).toBe("fluxer.com/api/v1/guilds/:id/members/:id")
    expect(route("/api/v1/interactions/123/abc/callback")).toBe("fluxer.com/api/v1/interactions/:id/:token/callback")
    expect(route("/api/v1/invites/abcdef")).toBe("fluxer.com/api/v1/invites/:code")
    expect(route("/attachments/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4/image.png")).toBe(
        "fluxer.com/attachments/:value/image.png",
    )
})

test("loopback requests, such as a local proof server, are neither paced nor logged", async () => {
    const { clock, pacer, log } = world()
    const fake = transport(clock)
    const fetch = pacedFetch(fake.fetch, pacer())
    await fetch("http://127.0.0.1:4000/proof", { method: "POST" })
    await fetch("http://127.0.0.1:4000/proof", { method: "POST" })
    expect(fake.starts).toEqual([0, 0])
    expect(log()).toEqual([])
})

test("a pacing lock left by another process is kept and stops the sender before it sends", async () => {
    const { root, clock, pacer } = world()
    const lock = join(root, ".env.test.pace.json.lock")
    writeFileSync(lock, "999999")
    const fake = transport(clock)
    await expect(pacedFetch(fake.fetch, pacer())("https://fluxer.com/api/v1/users/@me")).rejects.toThrow(
        /Confirm the process it records has stopped/,
    )
    expect(readFileSync(lock, "utf8")).toBe("999999")
    expect(fake.starts).toEqual([])
})

test("a new run clears the throttle mark but keeps the last start and pause", async () => {
    const { root, clock, pacer, state } = world()
    const fake = transport(clock, [new Response(null, { status: 429, headers: { "retry-after": "5" } })])
    await pacedFetch(fake.fetch, pacer())("https://fluxer.com/api/v1/users/@me")
    clearThrottle({ statePath: join(root, ".env.test.pace.json"), lockWaitMs: 0 })
    expect(state()).toEqual({ lastStartAt: start, pausedUntil: start + 5000 })
})

test("the raw helper waits out an HTTP-date Retry-After before sending again", async () => {
    const { clock, pacer } = world()
    const date = new Date(Date.now() + 5_000).toUTCString()
    const fake = transport(clock, [new Response(null, { status: 429, headers: { "retry-after": date } })])
    const waits = []
    const api = createSandboxApi({
        fetch: pacedFetch(fake.fetch, pacer()),
        token: () => "synthetic-token-value",
        wait: async (milliseconds) => {
            waits.push(milliseconds)
        },
    })
    await expect(api("GET", "/users/@me")).resolves.toMatchObject({ status: 200 })
    expect(waits).toEqual([5000])
    // The shared pause also holds the retry until the wait has passed
    expect(fake.starts).toEqual([0, 5000])
})

test.each(["60", "date"])(
    "the raw helper stops on a Retry-After of %s over ten seconds, even when it accepts any status",
    async (form) => {
        const { clock, pacer } = world()
        const header = form === "date" ? new Date(Date.now() + 60_000).toUTCString() : form
        const fake = transport(clock, [new Response(null, { status: 429, headers: { "retry-after": header } })])
        const api = createSandboxApi({
            fetch: pacedFetch(fake.fetch, pacer()),
            token: () => "synthetic-token-value",
            accept: anyStatus,
        })
        const failure = await api("GET", "/users/@me").catch((error) => error)
        expect(failure).toBeInstanceOf(LiveThrottledError)
        expect(failure).toMatchObject({ status: 429 })
        expect(failure.waitMs).toBe(60_000)
        expect(fake.starts).toEqual([0])
    },
)

// The typing refresh, bucket learning and rate-limit checks observe the SDK by replacing fetch above this layer
test("a harness observer above the pacer stamps the SDK's own call times, and pacing only delays the network start", async () => {
    const { clock, pacer } = world()
    const fake = transport(clock)
    const paced = pacedFetch(fake.fetch, pacer())
    const observed = []
    const observer = async (url, init) => {
        observed.push(clock.now - start)
        return paced(url, init)
    }
    // The SDK calls twice 100 ms apart, as a refresh or a queued read would
    const first = observer("https://fluxer.com/api/v1/channels/20/typing", { method: "POST" })
    await first
    clock.now += 100
    await observer("https://fluxer.com/api/v1/channels/20/typing", { method: "POST" })
    expect(observed).toEqual([0, 100])
    expect(fake.starts).toEqual([0, defaultIntervalMs])
    // A spacing check of the form "at least N ms apart" holds for the network starts too, because pacing only adds
    for (let index = 1; index < observed.length; index++)
        expect(fake.starts[index] - fake.starts[index - 1]).toBeGreaterThanOrEqual(
            observed[index] - observed[index - 1],
        )
})

// Catches: A request log that held only the admitted start, so a run could not tell paced waiting from Fluxer's response
// time
test("each logged request records when it was ready, its paced wait and its response time", async () => {
    const { clock, pacer, log } = world()
    const fetch = pacedFetch(async () => {
        clock.now += 120
        return Response.json({})
    }, pacer())
    await fetch("https://fluxer.com/api/v1/users/@me")
    clock.now += 100
    await fetch("https://fluxer.com/api/v1/users/@me")
    expect(log().map(({ readyAt, at, waitMs, ms }) => ({ readyAt, at, waitMs, ms }))).toEqual([
        { readyAt: new Date(start).toISOString(), at: new Date(start).toISOString(), waitMs: 0, ms: 120 },
        {
            readyAt: new Date(start + 220).toISOString(),
            at: new Date(start + defaultIntervalMs).toISOString(),
            waitMs: defaultIntervalMs - 220,
            ms: 120,
        },
    ])
})
