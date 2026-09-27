// Direct sandbox API requests shared by the live harnesses. They bypass the SDK, so setup, readback and cleanup stay
// independent of the code under test. Harnesses pass the fetch they captured before any SDK observation, and a token
// getter because the token is loaded after the request function is created. Failures name only the HTTP status
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"

const origin = "https://api.fluxer.app/v1"

function request(method, token, body, signal) {
    return {
        method,
        redirect: "error",
        signal,
        headers: {
            Authorization: `Bot ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
}

/**
 * The wait in milliseconds that a 429 asks for through `Retry-After` or `retry_after`, or undefined for any other
 * status or a wait that is missing or longer than ten seconds. The provider did not process a 429 request, so
 * repeating it after the wait cannot duplicate a write
 */
function rateLimitWait(response, data) {
    if (response.status !== 429) return undefined
    const waitMs = Math.max(Number(response.headers.get("retry-after")) || 0, Number(data?.retry_after) || 0) * 1_000
    return Number.isFinite(waitMs) && waitMs > 0 && waitMs <= 10_000 ? waitMs : undefined
}

/** A refused status as an assertion failure that reports only the HTTP status, including in harness failure lines */
function statusFailure(status) {
    return Object.assign(new assert.AssertionError({ message: `Sandbox HTTP ${status}` }), { status })
}

/**
 * The request core behind every export. It resolves `{ status, ok, data }`, where `data` is the parsed JSON body or
 * null. Each attempt has its own `timeoutMs`, and the optional `deadline` signal also aborts attempts and 429 waits.
 * Up to two retries follow a 429 that asks for a wait of at most ten seconds. A 429 with a longer or missing wait, or
 * a third 429, resolves like any other status, so the caller's status check decides the outcome
 */
async function send(fetch, token, method, path, body, { deadline, timeoutMs = 15_000 } = {}) {
    for (let attempt = 0; ; attempt++) {
        const timeout = AbortSignal.timeout(timeoutMs)
        const signal = deadline === undefined ? timeout : AbortSignal.any([deadline, timeout])
        const response = await fetch(`${origin}${path}`, request(method, token, body, signal))
        // Reading the body also releases it when a status such as 204 carries none
        const data = await response.json().catch(() => null)
        const waitMs = attempt < 2 ? rateLimitWait(response, data) : undefined
        if (waitMs === undefined) return { status: response.status, ok: response.ok, data }
        await sleep(waitMs, undefined, deadline === undefined ? undefined : { signal: deadline })
    }
}

/** Sends through the core and fails with `statusFailure` when `accept` refuses the final status */
async function checked(options, accept, method, path, body) {
    const { status, ok, data } = await send(options.fetch, options.token(), method, path, body, {
        deadline: options.deadline?.(),
        timeoutMs: options.timeoutMs,
    })
    if (!accept({ status, ok })) throw statusFailure(status)
    return { status, data }
}

/** Accepts a successful status only */
export const successOnly = (response) => response.ok

/** Accepts a successful status or 404 */
export const successOrNotFound = (response) => response.ok || response.status === 404

/** Accepts every status, for harnesses that check each status at the call site */
export const anyStatus = () => true

/**
 * Returns `api(method, path, body)`, which resolves `{ status, data }` after the core's 429 handling. The `accept`
 * predicate receives `{ status, ok }`, and a refused status fails an assertion that carries only `status`. The
 * optional `deadline` getter returns the current whole-run signal, and `timeoutMs` sets the per-attempt timeout, which
 * defaults to 15 seconds
 */
export function createSandboxApi({ fetch, token, accept = successOnly, deadline, timeoutMs }) {
    const options = { fetch, token, deadline, timeoutMs }
    return (method, path, body) => checked(options, accept, method, path, body)
}

/**
 * Returns `api(method, path, body, allowNotFound)`, which works like `createSandboxApi` and also accepts a 404 when
 * `allowNotFound` is true. The `allowNotFound` option sets the default for calls that omit it
 */
export function createRetryingSandboxApi({ fetch, token, allowNotFound: allowNotFoundByDefault = false }) {
    const options = { fetch, token }
    return (method, path, body, allowNotFound = allowNotFoundByDefault) =>
        checked(options, allowNotFound ? successOrNotFound : successOnly, method, path, body)
}

/**
 * Returns `api(method, path, body)` for harnesses with a whole-run request deadline. The `deadline` getter returns the
 * current deadline signal, which aborts requests and 429 waits. A successful status or 404 resolves
 */
export function createDeadlineSandboxApi({ fetch, token, deadline }) {
    return createSandboxApi({ fetch, token, deadline, accept: successOrNotFound })
}

/**
 * Reads one sandbox path through the global fetch at call time and resolves the parsed JSON body, for identity checks
 * made before any SDK observation. It uses the core's 429 handling. An unsuccessful status, with `exact` any status
 * other than 200, or a body that is not JSON throws without response details
 */
export async function readSandbox(path, token, { timeout = 15_000, exact = false } = {}) {
    const { status, ok, data } = await send(globalThis.fetch, token, "GET", path, undefined, { timeoutMs: timeout })
    if ((exact ? status !== 200 : !ok) || data === null) throw new Error("Sandbox identity request failed")
    return data
}
