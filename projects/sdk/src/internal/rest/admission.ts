/**
 * REST admission for one client: The bounded request queue, active-request slots, learned rate-limit waits and the
 * shared global pause.
 * Invariant: Admission coordinates requests and rate state within one client. The only state that crosses processes is
 * a global pause Fluxer declared, which a supervised child shares with the other children of its supervisor. A 429 that
 * names no limiter pauses this client only. A request waits in the
 * queue only while count and JSON-byte budgets allow it and no learned wait outlasts its deadline, media transfers use
 * their own slots so upload sources cannot starve their own reads, and closure fails every waiting request.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Effect from "effect/Effect"
import { ClientClosedError } from "#sdk/errors"
import type { LogicalScheduler, LogicalTimer } from "../logical-scheduler.js"
import { RateLimits } from "../rate-limits.js"
import { RestFailure } from "./classify.js"
import { concurrencyPerShard, defaultRestConfiguration, maximumConcurrency, type RestConfiguration } from "./options.js"

/** Longest single timer delay */
const maximumTimerMs = 2_147_483_647
/** Longest client pause that repeated unidentified 429s grow to, unless a 429 itself asks for longer */
const maximumUnidentifiedPauseMs = 60_000
/** Most jitter added to a grown unidentified pause */
const maximumUnidentifiedJitterMs = 1_000
/** A rate limit that holds queued requests this long is reported, so short waits stay quiet */
const rateLimitHoldReportMs = 1_000

type Pending = {
    route: string
    /** Method and route template for reports, without IDs */
    group: string | undefined
    bytes: number
    until: number
    deadline: number
    rateLimited: boolean
    media: boolean
    /** Whether this request may become the probe that ends an unidentified pause */
    probe: boolean
    resume: (effect: Effect.Effect<() => void, RestFailure | ClientClosedError>) => void
}

/**
 * Releases an admitted request's slot. Safe to call more than once. Each admission returns its own function, which
 * also identifies that attempt when it reports a response, so only the selected probe can end a recovery
 */
export type AdmissionRelease = () => void

/** Where a waiting request goes and what it charges */
export interface AdmissionRequest {
    /** Rate-limit route key the request reserves when it enters */
    readonly route: string
    /** Method and route template, such as "POST /channels/:id/messages", named in rate-limit hold reports */
    readonly group?: string
    /** JSON bytes charged against the queue budget while it waits */
    readonly bytes: number
    /** Logical time before which it may not enter, used for retry backoff */
    readonly until?: number
    /**
     * Logical deadline of the request. When a learned route or global wait lasts until then, the request fails at once
     * with reason rateLimit and the remaining wait instead of waiting
     */
    readonly deadline?: number
    /** Whether learned route and global waits apply. Discovery and media reads are not rate limited */
    readonly rateLimited?: boolean
    /** Whether it uses a media transfer slot instead of an API request slot */
    readonly media?: boolean
    /**
     * Whether this request may become the probe that ends an unidentified pause, true by default. A signed storage PUT
     * answers for another host, so it still waits for the pause and for a probe in flight, but its response neither
     * ends the recovery nor resets the growing pause
     */
    readonly probe?: boolean
}

/** Queued requests that wait for a rate limit, as diagnostics and the ratelimit.queueHeld record report them */
export interface RateLimitHold {
    readonly reason: "global" | "client" | "route"
    readonly requests: number
    readonly waitMs: number
    readonly route: string | null
}

export class RestAdmission {
    readonly #pending: Pending[] = []
    #bytes = 0
    #active = 0
    #activeMedia = 0
    #timer: LogicalTimer | undefined
    #closed = false
    #globalUntil = 0
    /** What set #globalUntil: A global limit Fluxer declared, or a client pause after a 429 that named no limit */
    #pauseKind: "global" | "client" = "global"
    /** Timer that reports a rate-limit hold once it has lasted rateLimitHoldReportMs */
    #holdTimer: LogicalTimer | undefined
    /**
     * The reason of the hold that #holdTimer waits to report or that was already reported, until no queued request
     * waits for a rate limit. A hold whose reason changes, such as a global pause that starts during a route backlog,
     * waits its own second and is reported again
     */
    #holdReason: RateLimitHold["reason"] | undefined
    /** Consecutive 429s that did not identify their limit, which lengthen the next client pause */
    #unidentified = 0
    /** After an unidentified pause, one request probes before the queue is released */
    #probe: "none" | "needed" | "inFlight" = "none"
    /** The admitted attempt selected as the current probe, while it owns it */
    #probeAttempt: AdmissionRelease | undefined
    /** API request slots: The configured concurrency, or the default scaled with the local shard count */
    #concurrency: number
    /** Learned buckets and aliases for this client's routes */
    readonly rates = new RateLimits()

    constructor(
        private readonly logical: LogicalScheduler,
        /** Slot, queue and byte limits, defaulting to the built-in limits */
        private readonly settings: RestConfiguration = defaultRestConfiguration,
        /** Called when a request fails with busy because the queue budgets are full */
        private readonly onBusy: () => void = () => {},
        /** Receives each longer global pause learned from Fluxer, in milliseconds from now, to share with other processes */
        private readonly shareGlobalPause?: (waitMs: number) => void,
        /** Called once for each time rate limits hold queued requests for rateLimitHoldReportMs or longer */
        private readonly onHold: (hold: RateLimitHold) => void = () => {},
    ) {
        this.#concurrency = settings.concurrency
    }

    /**
     * Size the default API request slots for the local shard count, four per shard up to 64. An explicit
     * rest.concurrency stays as configured
     */
    scaleConcurrency(localShards: number) {
        if (!this.settings.concurrencyScales) return
        this.#concurrency = Math.min(maximumConcurrency, concurrencyPerShard * Math.max(1, localShards))
        this.#pump()
    }

    diagnostics() {
        return {
            activeRequests: this.#active + this.#activeMedia,
            activeCapacity: this.#concurrency + this.settings.mediaConcurrency,
            queuedRequests: this.#pending.length,
            queuedCapacity: this.settings.maxQueued,
            queuedJsonBytes: this.#bytes,
            queuedJsonByteCapacity: this.settings.queuedJsonMaxBytes,
            rateLimitHold: this.rateLimitHold(),
        }
    }

    /**
     * Why queued requests wait for a rate limit now, or null when none does. A request that also waits for a slot
     * counts too. The longest known wait is reported, and the route group is the one with the most requests waiting
     * for their own route limit
     */
    rateLimitHold(): RateLimitHold | null {
        const now = this.logical.now()
        const paused = this.#globalUntil > now
        const probing = this.#probe === "inFlight"
        let requests = 0
        let until = now
        const groups = new Map<string, number>()
        for (const item of this.#pending) {
            if (!item.rateLimited) continue
            const routeUntil = this.rates.wait(item.route, now)
            if (!paused && !probing && routeUntil === 0) continue
            requests++
            until = Math.max(until, this.#globalUntil, routeUntil)
            if (routeUntil > now && item.group !== undefined) groups.set(item.group, (groups.get(item.group) ?? 0) + 1)
        }
        if (requests === 0) return null
        let route: string | null = null
        let most = 0
        for (const [group, count] of groups)
            if (count > most) {
                route = group
                most = count
            }
        return Object.freeze({
            reason: paused ? this.#pauseKind : probing ? "client" : "route",
            requests,
            waitMs: Math.ceil(until - now),
            route,
        })
    }

    /** Whether one more request with these JSON bytes fits the queue budgets now */
    hasRoom(bytes: number): boolean {
        return this.#pending.length < this.settings.maxQueued && bytes <= this.settings.queuedJsonMaxBytes - this.#bytes
    }

    /**
     * Hold every rate-limited route until the given logical time, keeping any later pause. A longer pause learned from
     * Fluxer goes to shareGlobalPause, while one shared by another process is not passed on again
     */
    pauseGlobal(until: number, shared = false) {
        if (until <= this.#globalUntil) return
        this.#globalUntil = until
        this.#pauseKind = "global"
        if (!shared) this.shareGlobalPause?.(Math.ceil(until - this.logical.now()))
        // A call already queued whose deadline ends inside the new pause fails now with the wait, and the hold report
        // starts even when no slot frees
        this.#pump()
    }

    /** Extend the pause for a 429 that named no limit, which stays in this client */
    #pauseUnidentified(until: number) {
        if (until <= this.#globalUntil) return
        this.#globalUntil = until
        this.#pauseKind = "client"
    }

    /**
     * Hold every rate-limited route of this client for a 429 that did not identify its limiter, and return the logical
     * time the pause ends. Fluxer did not declare the limit global, so the pause is not shared with other processes.
     * The first such 429 pauses until the time it asked for, and so do others answered during that pause. Each probe
     * that meets another one before a probe succeeds doubles the
     * pause it asked for, up to a minute unless it asked for longer, and adds up to a tenth of the pause, at most one
     * second, of jitter drawn from random, a number from 0 up to 1. When the pause ends, one API request probes the limit
     * and the others wait for its response. The attempt is the release function of the request that received the 429
     */
    pauseClient(until: number, random: number, attempt?: AdmissionRelease): number {
        const now = this.logical.now()
        const asked = Math.max(0, until - now)
        // During a recovery, only the selected probe's answer says something new about the limit. Requests that were
        // already sent when the pause began only keep the pause at least as long as they ask
        if (this.#probe !== "none" && (attempt === undefined || attempt !== this.#probeAttempt)) {
            this.#pauseUnidentified(until)
            return Math.max(until, this.#globalUntil)
        }
        const repeats = this.#unidentified++
        const grown =
            repeats === 0 ? asked : Math.max(asked, Math.min(maximumUnidentifiedPauseMs, asked * 2 ** repeats))
        const jitter =
            repeats === 0 ? 0 : Math.floor(random * Math.min(maximumUnidentifiedJitterMs, Math.floor(grown / 10)))
        this.#probe = "needed"
        this.#probeAttempt = undefined
        this.#pauseUnidentified(now + grown + jitter)
        return Math.max(until, this.#globalUntil)
    }

    /**
     * A response that was not an unidentified 429 arrived for the attempt with this release function. When that attempt
     * is the current probe, it ends the recovery and releases the queue. Any other response, such as one to a request
     * sent before the pause began, says nothing about the limit and is ignored
     */
    responded(attempt?: AdmissionRelease) {
        if (this.#probe !== "inFlight" || attempt === undefined || attempt !== this.#probeAttempt) return
        this.#probe = "none"
        this.#probeAttempt = undefined
        this.#unidentified = 0
        this.#pump()
    }

    #pump() {
        this.logical.clear(this.#timer)
        this.#timer = undefined
        const now = this.logical.now()
        if (this.#closed) return
        let earliest = Infinity
        for (let index = 0; index < this.#pending.length;) {
            const item = this.#pending[index]!
            // A request that cannot enter before its deadline would only time out, so it fails now with the remaining wait
            const held = item.rateLimited ? Math.max(this.#globalUntil, this.rates.wait(item.route, now, true)) : 0
            if (held > now && held >= item.deadline) {
                this.#pending.splice(index, 1)
                this.#bytes -= item.bytes
                item.resume(
                    Effect.fail(
                        new RestFailure({
                            reason: "rateLimit",
                            outcome: "notDispatched",
                            retryAfterMs: Math.ceil(held - now),
                        }),
                    ),
                )
                continue
            }
            // Source GETs must remain admissible while uploads await their lazy stream bodies. While one request probes
            // an unidentified limit, the other rate-limited requests wait for its response
            if (
                (item.media
                    ? this.#activeMedia >= this.settings.mediaConcurrency
                    : this.#active >= this.#concurrency) ||
                (item.rateLimited && this.#probe === "inFlight")
            ) {
                index++
                continue
            }
            const limited = item.rateLimited ? Math.max(this.#globalUntil, this.rates.wait(item.route, now)) : 0
            const until = Math.max(item.until, limited)
            if (until > now) {
                earliest = Math.min(earliest, until)
                index++
                continue
            }
            this.#pending.splice(index, 1)
            this.#bytes -= item.bytes
            if (item.media) this.#activeMedia++
            else this.#active++
            if (item.rateLimited) this.rates.reserve(item.route, now)
            let released = false
            const release: AdmissionRelease = () => {
                if (released) return
                released = true
                if (item.media) this.#activeMedia--
                else this.#active--
                // A probe that ended without a response, such as after a network failure, passes the probe on. A probe
                // that already answered, or whose recovery a newer pause replaced, no longer owns it
                if (this.#probe === "inFlight" && this.#probeAttempt === release) {
                    this.#probe = "needed"
                    this.#probeAttempt = undefined
                }
                this.#pump()
            }
            if (item.rateLimited && item.probe && this.#probe === "needed") {
                this.#probe = "inFlight"
                this.#probeAttempt = release
            }
            item.resume(Effect.succeed(release))
        }
        if (earliest !== Infinity)
            this.#timer = this.logical.set(
                () => this.#pump(),
                Math.min(maximumTimerMs, Math.max(1, earliest - now)),
                "REST admission queue",
            )
        // The same rule as diagnostics, so a call that waits for both a slot and a rate limit counts as held
        this.#trackHold(this.rateLimitHold()?.reason)
    }

    /**
     * Report a rate-limit hold once when it has lasted rateLimitHoldReportMs for one reason, and forget it once it
     * ends. A change of reason starts a new report timer, and the owner limits each reason to one log a minute
     */
    #trackHold(reason: RateLimitHold["reason"] | undefined) {
        if (reason === this.#holdReason) return
        this.logical.clear(this.#holdTimer)
        this.#holdTimer = undefined
        this.#holdReason = reason
        if (reason === undefined) return
        this.#holdTimer = this.logical.set(
            () => {
                this.#holdTimer = undefined
                const hold = this.rateLimitHold()
                if (this.#closed) return
                // The reason changed without a queue change, such as a pause that ended while every slot was busy
                if (hold?.reason !== reason) {
                    this.#holdReason = undefined
                    this.#trackHold(hold?.reason)
                    return
                }
                this.onHold(hold)
            },
            rateLimitHoldReportMs,
            "REST rate-limit hold report",
        )
    }

    /** Wait for a slot. The returned function releases it, is safe to call more than once and identifies the attempt */
    acquire(request: AdmissionRequest): Effect.Effect<AdmissionRelease, RestFailure | ClientClosedError> {
        const {
            route,
            group,
            bytes,
            until = 0,
            deadline = Infinity,
            rateLimited = true,
            media = false,
            probe = true,
        } = request
        return Effect.callback((resume) => {
            if (this.#closed) {
                resume(Effect.fail(new ClientClosedError()))
                return
            }
            // A new request may enter directly when there is no backlog and a slot is available
            if (!this.hasRoom(bytes)) {
                this.onBusy()
                resume(Effect.fail(new RestFailure({ reason: "busy", outcome: "notDispatched" })))
                return
            }
            const item = { route, group, bytes, until, deadline, rateLimited, media, probe, resume }
            this.#pending.push(item)
            this.#bytes += bytes
            this.#pump()
            return Effect.sync(() => {
                const index = this.#pending.indexOf(item)
                if (index !== -1) {
                    this.#pending.splice(index, 1)
                    this.#bytes -= bytes
                    this.#pump()
                }
            })
        })
    }

    /** Stop admission, forget learned rate state and fail every waiting request with ClientClosedError */
    close() {
        this.#closed = true
        this.logical.clear(this.#timer)
        this.#timer = undefined
        this.logical.clear(this.#holdTimer)
        this.#holdTimer = undefined
        const pending = this.#pending.splice(0)
        this.#bytes = 0
        this.rates.clear()
        for (const item of pending) item.resume(Effect.fail(new ClientClosedError()))
    }
}
