// Direct sandbox API requests shared by the live harnesses. They bypass the SDK, so setup, readback and cleanup stay
// independent of the code under test. Harnesses pass the fetch they captured before any SDK observation, and a token
// getter because the token is loaded after the request function is created. Failures name only the HTTP status.
// Each request is marked as a raw sender for the shared live pacer in live-pacing.js, which spaces and logs it
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { LiveThrottledError, rawSender, retryAfterHeaderMs, unknownRetryAfterMs } from "./live-pacing.js"
import { pacedDeadlineMs } from "./watchdogs.js"

const origin = "https://fluxer.com/api/v1"

function request(method, token, body, signal) {
    return {
        method,
        redirect: "error",
        signal,
        [rawSender]: true,
        headers: {
            Authorization: `Bot ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
}

/** Most raw requests one harness process sends at the same time */
const concurrentRawRequests = 5

/** Longest 429 wait the helper waits out before sending the same request again */
const maximumRateLimitWaitMs = 10_000

/**
 * The wait in milliseconds that a 429 asks for through `Retry-After`, in seconds or as an HTTP date, or `retry_after`,
 * taking the longer, or undefined for any other status. A 429 whose wait is missing or longer than ten seconds throws
 * LiveThrottledError, so the caller stops rather than receiving the 429 as an ordinary status. The provider did not
 * process a 429 request, so repeating it after the wait cannot duplicate a write
 */
function rateLimitWait(response, data) {
    if (response.status !== 429) return undefined
    const header = retryAfterHeaderMs(response.headers, Date.now())
    const body = typeof data?.retry_after === "number" && data.retry_after >= 0 ? data.retry_after * 1_000 : undefined
    const waitMs = header === undefined && body === undefined ? undefined : Math.max(header ?? 0, body ?? 0)
    if (waitMs === undefined || !Number.isFinite(waitMs) || waitMs <= 0)
        throw new LiveThrottledError(unknownRetryAfterMs)
    if (waitMs > maximumRateLimitWaitMs) throw new LiveThrottledError(waitMs)
    return Math.ceil(waitMs)
}

/** A refused status as an assertion failure that reports only the HTTP status, including in harness failure lines */
function statusFailure(status) {
    return Object.assign(new assert.AssertionError({ message: `Sandbox HTTP ${status}` }), { status })
}

/**
 * The request core behind every export. It resolves `{ status, ok, data }`, where `data` is the parsed JSON body or
 * null. Each attempt has its own `timeoutMs`, extended by the paced slots of the raw requests sent with it, and the optional `deadline`
 * signal also aborts attempts and 429 waits.
 * Confirmed 429s with a wait of at most ten seconds retry until the whole-run deadline. Without a whole-run signal,
 * the request is bounded by one minute plus one attempt timeout. A longer or missing wait throws LiveThrottledError
 * with status 429, whatever the caller accepts. The shared pacer has already paused every sender and marked the run
 * throttled, so run-all.js starts no further checks
 */
async function send(fetch, token, method, path, body, { deadline, timeoutMs = 15_000, wait = sleep } = {}) {
    // An attempt starts its timeout before the shared pacer admits it, so it also covers the paced slots of the raw
    // requests its process sends together with it, at most five as in member-search.js's identity reads
    const attemptMs = pacedDeadlineMs(timeoutMs, concurrentRawRequests)
    const limit = deadline ?? AbortSignal.timeout(60_000 + attemptMs)
    for (;;) {
        limit.throwIfAborted()
        const timeout = AbortSignal.timeout(attemptMs)
        const signal = AbortSignal.any([limit, timeout])
        const response = await fetch(`${origin}${path}`, request(method, token, body, signal))
        // Reading the body also releases it when a status such as 204 carries none
        const data = await response.json().catch(() => null)
        const waitMs = rateLimitWait(response, data)
        if (waitMs === undefined) return { status: response.status, ok: response.ok, data }
        await wait(waitMs, undefined, { signal: limit })
    }
}

/** Sends through the core and fails with `statusFailure` when `accept` refuses the final status */
async function checked(options, accept, method, path, body) {
    const { status, ok, data } = await send(options.fetch, options.token(), method, path, body, {
        deadline: options.deadline?.(),
        timeoutMs: options.timeoutMs,
        wait: options.wait,
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
 * defaults to 15 seconds. The optional wait function replaces the host sleep for controlled local checks
 */
export function createSandboxApi({ fetch, token, accept = successOnly, deadline, timeoutMs, wait }) {
    const options = { fetch, token, deadline, timeoutMs, wait }
    return (method, path, body) => checked(options, accept, method, path, body)
}

/**
 * Returns `api(method, path, body, allowNotFound)`, which works like `createSandboxApi` and also accepts a 404 when
 * `allowNotFound` is true. The `allowNotFound` option sets the default for calls that omit it
 */
export function createRetryingSandboxApi({
    fetch,
    token,
    allowNotFound: allowNotFoundByDefault = false,
    deadline,
    wait,
}) {
    const options = { fetch, token, deadline, wait }
    return (method, path, body, allowNotFound = allowNotFoundByDefault) =>
        checked(options, allowNotFound ? successOrNotFound : successOnly, method, path, body)
}

/**
 * Returns `api(method, path, body)` for harnesses with a whole-run request deadline. The `deadline` getter returns the
 * current deadline signal, which aborts requests and 429 waits. A successful status or 404 resolves
 */
export function createDeadlineSandboxApi({ fetch, token, deadline, wait }) {
    return createSandboxApi({ fetch, token, deadline, wait, accept: successOrNotFound })
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
