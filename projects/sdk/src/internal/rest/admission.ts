/**
 * REST admission for one client: The bounded request queue, active-request slots, learned rate-limit waits and the
 * shared global pause.
 * Invariant: Admission coordinates requests and rate state within one client, never across processes sharing a
 * credential. A request waits in the queue only while count and JSON-byte budgets allow it and no learned wait outlasts
 * its deadline, media transfers use their own slots so upload sources cannot starve their own reads, and closure fails
 * every waiting request.
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

type Pending = {
    route: string
    bytes: number
    until: number
    deadline: number
    rateLimited: boolean
    media: boolean
    resume: (effect: Effect.Effect<() => void, RestFailure | ClientClosedError>) => void
}

/** Where a waiting request goes and what it charges */
export interface AdmissionRequest {
    /** Rate-limit route key the request reserves when it enters */
    readonly route: string
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
}

export class RestAdmission {
    readonly #pending: Pending[] = []
    #bytes = 0
    #active = 0
    #activeMedia = 0
    #timer: LogicalTimer | undefined
    #closed = false
    #globalUntil = 0
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
        }
    }

    /** Whether one more request with these JSON bytes fits the queue budgets now */
    hasRoom(bytes: number): boolean {
        return this.#pending.length < this.settings.maxQueued && bytes <= this.settings.queuedJsonMaxBytes - this.#bytes
    }

    /** Hold every rate-limited route until the given logical time, keeping any later pause */
    pauseGlobal(until: number) {
        this.#globalUntil = Math.max(this.#globalUntil, until)
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
            // Source GETs must remain admissible while uploads await their lazy stream bodies
            if (item.media ? this.#activeMedia >= this.settings.mediaConcurrency : this.#active >= this.#concurrency) {
                index++
                continue
            }
            const until = item.rateLimited
                ? Math.max(item.until, this.#globalUntil, this.rates.wait(item.route, now))
                : item.until
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
            item.resume(
                Effect.succeed(() => {
                    if (released) return
                    released = true
                    if (item.media) this.#activeMedia--
                    else this.#active--
                    this.#pump()
                }),
            )
        }
        if (earliest !== Infinity)
            this.#timer = this.logical.set(
                () => this.#pump(),
                Math.min(maximumTimerMs, Math.max(1, earliest - now)),
                "REST admission queue",
            )
    }

    /** Wait for a slot. The returned function releases it and is safe to call more than once */
    acquire(request: AdmissionRequest): Effect.Effect<() => void, RestFailure | ClientClosedError> {
        const { route, bytes, until = 0, deadline = Infinity, rateLimited = true, media = false } = request
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
            const item = { route, bytes, until, deadline, rateLimited, media, resume }
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
        const pending = this.#pending.splice(0)
        this.#bytes = 0
        this.rates.clear()
        for (const item of pending) item.resume(Effect.fail(new ClientClosedError()))
    }
}
