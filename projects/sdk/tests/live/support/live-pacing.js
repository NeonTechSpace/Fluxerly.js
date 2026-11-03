// One request pacer for every live HTTP sender: the raw sandbox helper, the SDK's fetch inside harness processes,
// discovery, cleanup and asset reads. Harness processes import it through harness.js before they capture fetch, so
// every later fetch passes through it, and loading the sandbox env file switches it on. Requests to loopback hosts,
// such as local proof servers, are not paced, and copies of this module in offline fixture roots never pace.
//
// Pacing lives in a small state file in the SDK folder, so it carries across the default and Effect modes, across the
// checks run-all.js starts and across separate runs: It holds the last request start, any pause after a real 429 and
// the throttle mark that tells run-all.js to stop. Request starts are spaced by at least the interval, one every
// 750 ms by default or FLUXERLY_LIVE_PACE_MS, with no initial burst. A hosted 429 pauses every sender for at least its
// Retry-After, or one minute when it gives none. The harness's own injected 429s never reach this layer, because
// they replace fetch above it.
//
// Each request is logged as one JSON line to FLUXERLY_LIVE_REQUEST_LOG, which run-all.js sets next to the check log,
// or to a file in the system temporary folder. A line holds the start time, when the sender was ready, how long it
// waited for its slot, how long the response headers took, the process, the sender, the method, the host and path with
// IDs and tokens replaced, the status, and only the rate-limit headers. Never tokens, bodies or other headers
import {
    appendFileSync,
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stateRoot } from "./state-root.js"

const sdkRoot = fileURLToPath(stateRoot)
/**
 * Whether this module runs inside the SDK package. Offline harness checks copy it into a temporary fixture root with
 * a fake transport, where the pacer stays out of the way and leaves the fixture's fetch in place
 */
const inSdkPackage = (() => {
    try {
        return JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).name === "@neontechspace/fluxerly"
    } catch {
        // allow-silent: A root without a readable package file is a fixture root, which is not paced
        return false
    }
})()
/** The shared pacing state file. It is ignored by Git like every other `.env.test.*` file */
export const defaultStatePath = join(sdkRoot, ".env.test.pace.json")
export const defaultIntervalMs = 750
/** Wait used when a hosted 429 gives no usable Retry-After */
export const unknownRetryAfterMs = 60_000
/** Longest pause a sender waits out. A longer one stops the sender with LiveThrottledError instead */
export const maximumPauseWaitMs = 10_000
/** Set on a fetch init by the raw sandbox helper, so the request log can name its sender */
export const rawSender = Symbol.for("fluxerly.live.rawSender")
const installed = Symbol.for("fluxerly.live.pacing")

/** A hosted 429 asked for a wait longer than a sender may wait out, so the sender stops instead of returning early */
export class LiveThrottledError extends Error {
    constructor(waitMs) {
        super(`Fluxer rate-limited the live run for ${Math.ceil(waitMs)} ms, so the live run stops`)
        this.name = "LiveThrottledError"
        this.check = "throttled"
        this.status = 429
        this.waitMs = Math.ceil(waitMs)
    }
}

/**
 * The wait in milliseconds that a `Retry-After` header asks for, in seconds or as an HTTP date measured against
 * `now`, or undefined when the header is missing or unreadable
 */
export function retryAfterHeaderMs(headers, now) {
    const value = headers.get("retry-after")?.trim()
    if (!value) return undefined
    const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - now
    return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : undefined
}

const rateHeaderNames = [
    "retry-after",
    "x-ratelimit-bucket",
    "x-ratelimit-global",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-reset-after",
    "x-ratelimit-scope",
]

/** The rate-limit headers of a response, and no other header */
export function rateHeaders(headers) {
    return Object.fromEntries(rateHeaderNames.flatMap((name) => (headers.has(name) ? [[name, headers.get(name)]] : [])))
}

/**
 * The host and path of a request URL with every ID, token and long value replaced, and without its query or
 * fragment, for the request log
 */
export function sanitizedRoute(url) {
    const segments = url.pathname.split("/")
    const replaced = segments.map((segment, index) => {
        if (segment === "") return segment
        const previous = segments[index - 1]
        const beforePrevious = segments[index - 2]
        if (/^\d+$/.test(segment)) return ":id"
        // Webhook and interaction tokens follow their ID, and invite codes follow their collection
        if (beforePrevious === "webhooks" || beforePrevious === "interactions") return ":token"
        if (previous === "invites" || previous === "templates") return ":code"
        if (segment.length > 24 || /\d{5,}/.test(segment)) return ":value"
        return segment
    })
    return `${url.host}${replaced.join("/")}`
}

function paced(url) {
    return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

/**
 * The shared pacer. `now` and `sleep(milliseconds, signal)` are replaced by controlled versions in offline checks.
 * State changes hold the `<state>.lock` file, created exclusively with this process ID like the sandbox lock. A lock
 * that stays for `lockWaitMs` is never removed here, because its owner may still be running
 */
export function createPacer({
    statePath = defaultStatePath,
    intervalMs = defaultIntervalMs,
    logPath,
    now = Date.now,
    sleep = defaultSleep,
    lockWaitMs = 2_000,
} = {}) {
    const lockPath = `${statePath}.lock`
    const withState = (change) => {
        mkdirSync(dirname(statePath), { recursive: true })
        let descriptor
        for (let waited = 0; descriptor === undefined; waited += 2) {
            try {
                descriptor = openSync(lockPath, "wx")
            } catch (error) {
                if (error?.code !== "EEXIST") throw error
                if (waited >= lockWaitMs)
                    throw new Error(
                        `The live pacing lock ${lockPath} stayed. Confirm the process it records has stopped before removing it`,
                    )
                // Another process holds the lock only while it reads and writes the small state file
                Atomics.wait(sleepBuffer, 0, 0, 2)
            }
        }
        try {
            writeSync(descriptor, String(process.pid))
            const state = readState(statePath)
            const result = change(state)
            const temporary = `${statePath}.${process.pid}.tmp`
            const file = openSync(temporary, "w")
            try {
                writeSync(file, JSON.stringify(state))
            } finally {
                closeSync(file)
            }
            renameSync(temporary, statePath)
            return result
        } finally {
            closeSync(descriptor)
            unlinkSync(lockPath)
        }
    }
    const pacer = {
        now,
        intervalMs,
        /**
         * Reserve the next request start for this sender and wait for it. A pause over maximumPauseWaitMs stops it.
         * After waiting, the sender checks the state again, because another sender's 429 may have recorded a pause
         * meanwhile, and then reserves a slot after that pause
         */
        async admit(signal) {
            signal?.throwIfAborted()
            for (let waited = false; ; waited = true) {
                const start = withState((state) => {
                    const current = now()
                    const paused = state.pausedUntil ?? 0
                    // A reserved slot already counted toward the spacing, so only a newer pause moves it
                    if (waited && paused <= current) return { at: current }
                    if (paused - current > maximumPauseWaitMs) return { stop: paused - current }
                    const at = Math.max(current, (state.lastStartAt ?? -Infinity) + intervalMs, paused)
                    state.lastStartAt = at
                    return { at }
                })
                if (start.stop !== undefined) throw new LiveThrottledError(start.stop)
                const wait = start.at - now()
                if (wait <= 0) return
                await sleep(wait, signal)
            }
        },
        /** Record a hosted 429, which pauses every sender and marks the run throttled */
        limited(waitMs, route) {
            withState((state) => {
                const current = now()
                state.pausedUntil = Math.max(state.pausedUntil ?? 0, current + waitMs)
                state.throttled = { at: current, waitMs, route }
            })
        },
        /** Remove the throttle mark, keeping the last start and any pause */
        clearThrottle() {
            withState((state) => {
                delete state.throttled
            })
        },
        /** Append one request record to the request log */
        log(entry) {
            if (logPath === undefined) return
            mkdirSync(dirname(logPath), { recursive: true })
            appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
        },
    }
    return pacer
}

/** The current pacing state, or an empty one when the file is missing or unreadable */
export function readState(statePath = defaultStatePath) {
    try {
        const state = JSON.parse(readFileSync(statePath, "utf8"))
        return state !== null && typeof state === "object" ? state : {}
    } catch {
        // allow-silent: A missing or damaged state file starts pacing afresh, which only delays the next request
        return {}
    }
}

/**
 * Clear the throttle mark of an earlier run while keeping its last request start and pause, so pacing still carries
 * across runs. run-all.js calls this when a run starts
 */
export function clearThrottle(options = {}) {
    createPacer(options).clearThrottle()
}

function defaultSleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, milliseconds)
        function done() {
            signal?.removeEventListener("abort", aborted)
            resolve()
        }
        function aborted() {
            clearTimeout(timer)
            reject(signal.reason)
        }
        signal?.addEventListener("abort", aborted, { once: true })
    })
}

/** A fetch that admits each non-loopback request through `pacer`, records hosted 429s and logs every request */
export function pacedFetch(base, pacer) {
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (!paced(url)) return base(input, init)
        const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        const sender = init?.[rawSender] === true ? "raw" : "sdk"
        const route = sanitizedRoute(url)
        const ready = pacer.now()
        await pacer.admit(signal)
        const started = pacer.now()
        // Timing fields show where a run's time goes: waiting for a paced slot or waiting for Fluxer
        const timing = {
            at: new Date(started).toISOString(),
            readyAt: new Date(ready).toISOString(),
            waitMs: started - ready,
        }
        let response
        try {
            response = await base(input, init)
        } catch (error) {
            pacer.log({ ...timing, ms: pacer.now() - started, pid: process.pid, sender, method, route, status: null })
            throw error
        }
        const ms = pacer.now() - started
        if (response.status === 429)
            pacer.limited(retryAfterHeaderMs(response.headers, pacer.now()) ?? unknownRetryAfterMs, route)
        pacer.log({
            ...timing,
            ms,
            pid: process.pid,
            sender,
            method,
            route,
            status: response.status,
            headers: rateHeaders(response.headers),
        })
        return response
    }
}

/**
 * Put the inert pacing layer under `globalThis.fetch` once per process. Until `activateLivePacing` runs, it passes
 * every request straight to the fetch it replaced
 */
export function installLivePacing() {
    if (!inSdkPackage) return { activate() {} }
    const existing = globalThis.fetch?.[installed]
    if (existing) return existing
    const base = globalThis.fetch
    // The fetch under the layer, for the pace calibration, which paces each of its steps with its own spacing
    const control = { fetch: undefined, base }
    const layer = (input, init) => (control.fetch ?? base)(input, init)
    layer[installed] = control
    control.activate = (pacer) => {
        control.fetch ??= pacedFetch(base, pacer)
    }
    globalThis.fetch = layer
    return control
}

/** The pace interval from FLUXERLY_LIVE_PACE_MS, or the default */
export function paceIntervalMs(env = process.env) {
    const interval = Number(env.FLUXERLY_LIVE_PACE_MS)
    return env.FLUXERLY_LIVE_PACE_MS !== undefined && Number.isFinite(interval) && interval >= 0
        ? interval
        : defaultIntervalMs
}

/** Switch pacing on for this live process, with the interval and request log from the environment */
export function activateLivePacing() {
    if (!inSdkPackage) return
    const logPath =
        process.env.FLUXERLY_LIVE_REQUEST_LOG ||
        join(
            tmpdir(),
            "fluxerly-live-requests",
            `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}.jsonl`,
        )
    installLivePacing().activate(createPacer({ intervalMs: paceIntervalMs(), logPath }))
}
