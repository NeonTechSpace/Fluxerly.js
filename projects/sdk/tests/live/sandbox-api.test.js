import { afterEach, expect, test, vi } from "vitest"
import { defaultIntervalMs } from "./support/live-pacing.js"
import {
    createDeadlineSandboxApi,
    createRetryingSandboxApi,
    createSandboxApi,
    readSandbox,
    successOrNotFound,
} from "./support/sandbox-api.js"

const limited = (retryAfter, { header = true } = {}) =>
    new Response(JSON.stringify({ retry_after: retryAfter, global: true }), {
        status: 429,
        headers: {
            "Content-Type": "application/json",
            ...(header ? { "Retry-After": String(retryAfter) } : {}),
        },
    })

function scripted(responses) {
    const calls = []
    const fetch = async (url, init) => {
        calls.push({ url, method: init.method, body: init.body, signal: init.signal })
        return responses.shift()
    }
    return { calls, fetch }
}

function controlledWait() {
    let entered
    const waiting = new Promise((resolve) => {
        entered = resolve
    })
    const wait = (milliseconds, _value, { signal }) =>
        new Promise((resolve, reject) => {
            const aborted = () => reject(new DOMException("Wait aborted", "AbortError"))
            signal.addEventListener("abort", aborted, { once: true })
            entered({
                milliseconds,
                signal,
                release() {
                    signal.removeEventListener("abort", aborted)
                    resolve()
                },
            })
            if (signal.aborted) aborted()
        })
    return { wait, waiting }
}

const factories = {
    createSandboxApi: (fetch) => createSandboxApi({ fetch, token: () => "token" }),
    createRetryingSandboxApi: (fetch) => createRetryingSandboxApi({ fetch, token: () => "token" }),
    createDeadlineSandboxApi: (fetch) =>
        createDeadlineSandboxApi({ fetch, token: () => "token", deadline: () => AbortSignal.timeout(5_000) }),
}

const originalFetch = globalThis.fetch
afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
})

test("a short 429 is repeated after its requested wait and then succeeds", async () => {
    const { calls, fetch } = scripted([limited(0.05), Response.json({ id: "1" })])
    const sleep = controlledWait()
    const api = createSandboxApi({ fetch, token: () => "token", wait: sleep.wait })
    const pending = api("POST", "/channels/1/messages", { content: "x" })
    const waiting = await sleep.waiting
    expect(waiting.milliseconds).toBe(50)
    expect(calls).toHaveLength(1)
    waiting.release()
    await expect(pending).resolves.toEqual({
        status: 200,
        data: { id: "1" },
    })
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toBe(calls[0].body)
})

test("a retry_after body field sets the wait when the header is missing", async () => {
    const { calls, fetch } = scripted([limited(0.05, { header: false }), new Response(null, { status: 204 })])
    const sleep = controlledWait()
    const api = createRetryingSandboxApi({ fetch, token: () => "token", wait: sleep.wait })
    const pending = api("DELETE", "/channels/1")
    const waiting = await sleep.waiting
    expect(waiting.milliseconds).toBe(50)
    expect(calls).toHaveLength(1)
    waiting.release()
    await expect(pending).resolves.toEqual({ status: 204, data: null })
    expect(calls).toHaveLength(2)
})

test.each(Object.keys(factories))(
    "%s stops on a 429 whose wait exceeds ten seconds with its status and no retry",
    async (factory) => {
        const { calls, fetch } = scripted([limited(60)])

        const failure = await factories[factory](fetch)("GET", "/users/@me").catch((error) => error)
        expect(failure).toMatchObject({ name: "LiveThrottledError", check: "throttled", status: 429, waitMs: 60_000 })
        expect(calls).toHaveLength(1)
    },
)

test("a 429 without a wait stops instead of resolving like an ordinary status", async () => {
    const { calls, fetch } = scripted([new Response(null, { status: 429 })])
    const api = createSandboxApi({ fetch, token: () => "token", accept: () => true })
    await expect(api("GET", "/users/@me")).rejects.toMatchObject({ name: "LiveThrottledError", status: 429 })
    expect(calls).toHaveLength(1)
})

test("a refused status fails as an assertion that carries only the status", async () => {
    const { fetch } = scripted([new Response(null, { status: 503 }), new Response(null, { status: 404 })])
    const api = createSandboxApi({ fetch, token: () => "token", accept: successOrNotFound })

    await expect(api("GET", "/users/@me")).rejects.toMatchObject({ name: "AssertionError", status: 503 })
    await expect(api("GET", "/users/@me")).resolves.toMatchObject({ status: 404 })
})

test("confirmed edge 429s retry beyond two attempts within the run deadline", async () => {
    const { calls, fetch } = scripted([
        ...Array.from({ length: 12 }, () => new Response(null, { status: 429, headers: { "Retry-After": "5" } })),
        Response.json({ id: "1" }),
    ])
    const deadline = new AbortController()
    const waits = []
    const api = createDeadlineSandboxApi({
        fetch,
        token: () => "token",
        deadline: () => deadline.signal,
        wait: async (milliseconds, _value, { signal }) => {
            expect(signal).toBe(deadline.signal)
            expect(calls).toHaveLength(waits.length + 1)
            waits.push(milliseconds)
        },
    })
    await expect(api("GET", "/users/@me")).resolves.toMatchObject({ status: 200, data: { id: "1" } })
    expect(waits).toEqual(Array(12).fill(5_000))
    expect(calls).toHaveLength(13)
})

test("a deadline reached between retries prevents the next request", async () => {
    const { calls, fetch } = scripted(Array.from({ length: 5 }, () => limited(0.01)))
    const deadline = new AbortController()
    let waits = 0
    const api = createDeadlineSandboxApi({
        fetch,
        token: () => "token",
        deadline: () => deadline.signal,
        wait: async () => {
            if (++waits === 4) deadline.abort()
        },
    })
    await expect(api("GET", "/users/@me")).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(4)
})

test("the run deadline aborts a 429 wait without another request", async () => {
    const { calls, fetch } = scripted([limited(5)])
    const deadline = new AbortController()
    const sleep = controlledWait()
    const api = createDeadlineSandboxApi({
        fetch,
        token: () => "token",
        deadline: () => deadline.signal,
        wait: sleep.wait,
    })

    const pending = api("GET", "/users/@me")
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    const waiting = await sleep.waiting
    expect(waiting.milliseconds).toBe(5_000)
    expect(calls).toHaveLength(1)
    deadline.abort()
    await rejected
    waiting.release()
    expect(calls).toHaveLength(1)
})

test("requests without a run deadline are bounded by one minute plus one paced attempt", async () => {
    const limit = new AbortController()
    const attempt = new AbortController()
    // Each attempt covers its 1.2 s timeout, the paced slots of up to five raw requests sent together with the margin,
    // and one longest pause
    const attemptMs = Math.ceil(1_200 + 5 * defaultIntervalMs * 1.25 + 10_000)
    const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((milliseconds) => (milliseconds === 60_000 + attemptMs ? limit.signal : attempt.signal))
    const { calls, fetch } = scripted([limited(5)])
    const sleep = controlledWait()
    const api = createSandboxApi({ fetch, token: () => "token", timeoutMs: 1_200, wait: sleep.wait })
    const pending = api("GET", "/users/@me")
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    const waiting = await sleep.waiting
    expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([60_000 + attemptMs, attemptMs])
    expect(waiting.signal).toBe(limit.signal)
    limit.abort()
    await rejected
    waiting.release()
    expect(calls).toHaveLength(1)
})

test("readSandbox repeats a short 429 through the global fetch at call time", async () => {
    const { calls, fetch } = scripted([limited(0.01), Response.json({ id: "7" })])
    globalThis.fetch = fetch

    await expect(readSandbox("/users/@me", "token", { exact: true })).resolves.toEqual({ id: "7" })
    expect(calls).toHaveLength(2)
})

test("readSandbox refuses a status outside its contract without response details", async () => {
    const { fetch } = scripted([new Response(JSON.stringify({ message: "private" }), { status: 201 })])
    globalThis.fetch = fetch

    const failure = await readSandbox("/users/@me", "token", { exact: true }).catch((error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).not.toContain("private")
})
