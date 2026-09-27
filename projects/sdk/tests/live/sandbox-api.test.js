import { afterEach, expect, test } from "vitest"
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
        calls.push({ url, method: init.method, body: init.body, at: performance.now() })
        return responses.shift()
    }
    return { calls, fetch }
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
})

test("a short 429 is repeated after its requested wait and then succeeds", async () => {
    const { calls, fetch } = scripted([limited(0.05), Response.json({ id: "1" })])
    const api = createSandboxApi({ fetch, token: () => "token" })

    await expect(api("POST", "/channels/1/messages", { content: "x" })).resolves.toEqual({
        status: 200,
        data: { id: "1" },
    })
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toBe(calls[0].body)
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(40)
})

test("a retry_after body field sets the wait when the header is missing", async () => {
    const { calls, fetch } = scripted([limited(0.05, { header: false }), new Response(null, { status: 204 })])
    const api = createRetryingSandboxApi({ fetch, token: () => "token" })

    await expect(api("DELETE", "/channels/1")).resolves.toEqual({ status: 204, data: null })
    expect(calls).toHaveLength(2)
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(40)
})

test.each(Object.keys(factories))(
    "%s fails a 429 whose wait exceeds ten seconds with its status and no retry",
    async (factory) => {
        const { calls, fetch } = scripted([limited(60)])

        const failure = await factories[factory](fetch)("GET", "/users/@me").catch((error) => error)
        expect(failure).toMatchObject({ name: "AssertionError", code: "ERR_ASSERTION", status: 429 })
        expect(calls).toHaveLength(1)
    },
)

test("a refused status fails as an assertion that carries only the status", async () => {
    const { fetch } = scripted([new Response(null, { status: 503 }), new Response(null, { status: 404 })])
    const api = createSandboxApi({ fetch, token: () => "token", accept: successOrNotFound })

    await expect(api("GET", "/users/@me")).rejects.toMatchObject({ name: "AssertionError", status: 503 })
    await expect(api("GET", "/users/@me")).resolves.toMatchObject({ status: 404 })
})

test("repeated 429 responses stop after two retries", async () => {
    const { calls, fetch } = scripted([limited(0.01), limited(0.01), limited(0.01)])
    const api = createSandboxApi({ fetch, token: () => "token" })

    await expect(api("GET", "/users/@me")).rejects.toMatchObject({ status: 429 })
    expect(calls).toHaveLength(3)
})

test("the run deadline aborts a 429 wait without another request", async () => {
    const { calls, fetch } = scripted([limited(5)])
    const deadline = new AbortController()
    const api = createDeadlineSandboxApi({ fetch, token: () => "token", deadline: () => deadline.signal })

    const started = performance.now()
    const pending = api("GET", "/users/@me")
    setTimeout(() => deadline.abort(), 20)
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(performance.now() - started).toBeLessThan(2_000)
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
