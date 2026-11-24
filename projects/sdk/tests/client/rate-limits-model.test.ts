/*
 * Seeded stateful model tests for RateLimits and RestAdmission.
 * Drives randomized sequences of begin, out-of-order observe, pause, reserve, acquire, cancellation,
 * pauseGlobal, pauseClient, responded, capacity overflow (> 2048), clock jumps and close, checking
 * universal state-machine invariants after every single step
 */
import { createHash } from "node:crypto"
import { Cause, Effect, Exit, Fiber } from "effect"
import { expect, test } from "vitest"
import { ClientClosedError } from "../../src/errors.js"
import type { LogicalScheduler, LogicalTimer } from "../../src/internal/logical-scheduler.js"
import {
    RateLimits,
    rateRoute,
    type RateAttempt,
    type RateRoute,
    type RateTarget,
} from "../../src/internal/rate-limits.js"
import { RestAdmission, type AdmissionRelease } from "../../src/internal/rest/admission.js"
import type { RestConfiguration } from "../../src/internal/rest/options.js"

const baseSeed = Number(process.env.FLUXERLY_MODEL_SEED ?? 1) >>> 0

/** Deterministic Mulberry32 PRNG */
function prng(seed: number) {
    let state = seed >>> 0
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0
        let value = state
        value = Math.imul(value ^ (value >>> 15), value | 1)
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
    }
    const below = (count: number) => Math.floor(next() * count)
    return {
        next,
        below,
        chance: (probability: number) => next() < probability,
        pick: <T>(items: readonly T[]): T => items[below(items.length)]!,
    }
}

function hashTemplate(template: string): string {
    return createHash("sha256").update(template).digest("hex").slice(0, 16)
}

function headerResponse(options: {
    readonly template?: string
    readonly remaining?: number
    readonly resetAfter?: number
    readonly limit?: number
    readonly malformedBucket?: boolean
}): Response {
    const headers: Record<string, string> = {}
    if (options.malformedBucket) headers["x-ratelimit-bucket"] = "bad header value!"
    else if (options.template !== undefined) headers["x-ratelimit-bucket"] = hashTemplate(options.template)
    if (options.remaining !== undefined) headers["x-ratelimit-remaining"] = String(options.remaining)
    if (options.resetAfter !== undefined) headers["x-ratelimit-reset-after"] = String(options.resetAfter)
    if (options.limit !== undefined) headers["x-ratelimit-limit"] = String(options.limit)
    return new Response(null, { status: options.remaining === 0 ? 429 : 204, headers })
}

/** Deterministic synchronous LogicalScheduler stand-in for exhaustive RestAdmission model steps */
class ManualLogicalScheduler {
    #now = 0
    #sequence = 0
    readonly #entries = new Map<
        LogicalTimer,
        { readonly callback: () => void; readonly deadline: number; readonly sequence: number }
    >()

    now(): number {
        return this.#now
    }

    set(callback: () => void, delayMs: number, _owner: string): LogicalTimer {
        const timer = Object.freeze({})
        this.#entries.set(timer, {
            callback,
            deadline: this.#now + Math.max(0, delayMs),
            sequence: this.#sequence++,
        })
        return timer
    }

    clear(timer: LogicalTimer | undefined): void {
        if (timer !== undefined) this.#entries.delete(timer)
    }

    advance(deltaMs: number): void {
        this.#now += deltaMs
        while (true) {
            const due = [...this.#entries.entries()]
                .filter(([, entry]) => entry.deadline <= this.#now)
                .sort((left, right) =>
                    left[1].deadline === right[1].deadline
                        ? left[1].sequence - right[1].sequence
                        : left[1].deadline - right[1].deadline,
                )
            if (due.length === 0) break
            const [timer, entry] = due[0]!
            if (!this.#entries.delete(timer)) continue
            entry.callback()
        }
    }

    asLogicalScheduler(): LogicalScheduler {
        return this as unknown as LogicalScheduler
    }
}

test("RateLimits preserves capacity, overflow monotonicity, probe exclusivity and wait bounds across random sequences", () => {
    const routePool: readonly RateRoute[] = [
        rateRoute("GET", "/channels/10/messages/1", "10"),
        rateRoute("POST", "/channels/10/messages", "10"),
        rateRoute("POST", "/channels/10/typing", "10", "typing"),
        rateRoute("GET", "/channels/10/messages?limit=50", "10", "history"),
        rateRoute("GET", "/channels/11/messages/2", "11"),
        rateRoute("PATCH", "/guilds/20/members/30", "20"),
        rateRoute("GET", "/users/40/profile", "40"),
        rateRoute("GET", "/invites/secret-code-1", "invites"),
        rateRoute("DELETE", "/channels/10/messages/1/attachments/5", "10"),
        rateRoute("GET", "/unparameterized-route", "misc"),
    ]
    const templates = [
        "channel:message:read::channel_id",
        "channel:typing::channel_id",
        "channel:pins::channel_id",
        "guild:member:update::guild_id",
        "user:profile::target_id",
        "invite:read::invite_code",
        "attachment:delete",
        "unknown:future:template",
    ] as const

    for (let trial = 0; trial < 20; trial++) {
        const seed = (baseSeed + trial * 101) >>> 0
        const rng = prng(seed)
        const limits = new RateLimits()
        let now = 0
        let minOverflowUntil = 0
        const inFlight: RateAttempt[] = []
        const observedTargets: { readonly target: RateTarget; readonly sequence: number }[] = []

        const assertInvariants = (step: number) => {
            const state = limits.inspect()
            const tag = `seed=${seed} trial=${trial} step=${step} now=${now}`
            expect(state.buckets, `${tag}: bucket cap`).toBeLessThanOrEqual(2048)
            expect(state.aliases, `${tag}: alias cap`).toBeLessThanOrEqual(2048)
            expect(state.overflowUntil, `${tag}: overflow monotonicity`).toBeGreaterThanOrEqual(minOverflowUntil)
            minOverflowUntil = state.overflowUntil

            const probeBuckets = new Set<string>()
            for (const { bucket, probe } of state.probes) {
                expect(probeBuckets.has(bucket), `${tag}: unique probe per bucket`).toBe(false)
                probeBuckets.add(bucket)
                if (probe.kind === "reserved") {
                    expect(probe.route.length, `${tag}: reserved probe route`).toBeGreaterThan(0)
                } else if (probe.kind === "inFlight") {
                    expect(probe.route.length, `${tag}: inFlight probe route`).toBeGreaterThan(0)
                    expect(probe.sequence, `${tag}: inFlight probe sequence`).toBeGreaterThan(0)
                } else {
                    expect.unreachable(`${tag}: inspect must omit kind none`)
                }
            }

            for (const route of routePool) {
                const softWait = limits.wait(route.key, now, false)
                const firmWait = limits.wait(route.key, now, true)
                expect(softWait === 0 || softWait > now, `${tag}: soft wait domain`).toBe(true)
                expect(firmWait === 0 || firmWait > now, `${tag}: firm wait domain`).toBe(true)
                expect(firmWait, `${tag}: firm wait <= soft wait`).toBeLessThanOrEqual(softWait)
                if (state.overflowUntil > now) {
                    expect(softWait, `${tag}: soft wait respects overflow`).toBeGreaterThanOrEqual(state.overflowUntil)
                    expect(firmWait, `${tag}: firm wait respects overflow`).toBeGreaterThanOrEqual(state.overflowUntil)
                }
            }
        }

        for (let step = 0; step < 300; step++) {
            const action = rng.below(100)
            if (action < 25) {
                const route = rng.pick(routePool)
                if (limits.wait(route.key, now) === 0) limits.reserve(route.key, now)
                inFlight.push(limits.begin(route))
                if (inFlight.length > 24) inFlight.shift()
            } else if (action < 60 && inFlight.length > 0) {
                // Deliberately pick out-of-order attempts from inFlight
                const index = rng.below(inFlight.length)
                const [attempt] = inFlight.splice(index, 1)
                const mode = rng.below(5)
                const response =
                    mode === 0
                        ? headerResponse({
                              template: rng.pick(templates),
                              remaining: 0,
                              resetAfter: 1 + rng.below(6),
                              limit: rng.pick([1, 2, 4, 8]),
                          })
                        : mode === 1
                          ? headerResponse({
                                template: rng.pick(templates),
                                remaining: rng.below(5),
                                resetAfter: 1 + rng.below(4),
                            })
                          : mode === 2
                            ? headerResponse({ template: rng.pick(templates) })
                            : mode === 3
                              ? headerResponse({ remaining: rng.below(3), resetAfter: 2, limit: 4 })
                              : headerResponse({ malformedBucket: true, remaining: 0, resetAfter: 1 })
                const target = limits.observe(attempt!, response, now)
                observedTargets.push({ target, sequence: attempt!.sequence })
                if (observedTargets.length > 24) observedTargets.shift()
            } else if (action < 75 && observedTargets.length > 0) {
                const entry = rng.pick(observedTargets)
                const until = now + 50 + rng.below(2_000)
                limits.pause(entry.target, until, now, rng.chance(0.7) ? entry.sequence : undefined)
            } else if (action < 85) {
                const route = rng.pick(routePool)
                limits.reserve(route.key, now)
            } else if (action < 98) {
                const jumps = [0, 1, 10, 100, 500, 2_000, 300_005] as const
                now += rng.pick(jumps)
            } else {
                limits.clear()
                minOverflowUntil = 0
                inFlight.length = 0
                observedTargets.length = 0
                const cleared = limits.inspect()
                expect(cleared.buckets).toBe(0)
                expect(cleared.aliases).toBe(0)
                expect(cleared.overflowUntil).toBe(0)
                expect(cleared.probes).toEqual([])
            }
            assertInvariants(step)
        }
    }
})

test("RateLimits bounds storage at 2048 under capacity overflow without dropping active denials", () => {
    const rng = prng((baseSeed + 777) >>> 0)
    const limits = new RateLimits()
    let now = 0
    let maxDeniedUntil = 0

    for (let index = 0; index < 2_300; index++) {
        const route = rateRoute("GET", `/channels/${index + 1}/messages/1`, String(index + 1))
        const depleted = index < 2_100 || rng.chance(0.5)
        const resetAfter = 1 + rng.below(10)
        const target = limits.observe(
            limits.begin(route),
            headerResponse({
                template: "channel:message:read::channel_id",
                remaining: depleted ? 0 : 5,
                resetAfter,
                limit: 5,
            }),
            now,
        )
        if (depleted && index >= 2_048) {
            maxDeniedUntil = Math.max(maxDeniedUntil, now + resetAfter * 1_000)
        }
        if (rng.chance(0.1)) limits.pause(target, now + 500, now)
        const state = limits.inspect()
        expect(state.buckets).toBeLessThanOrEqual(2048)
        expect(state.aliases).toBeLessThanOrEqual(2048)
    }

    const after = limits.inspect()
    expect(after.buckets).toBe(2048)
    expect(after.aliases).toBe(2048)
    expect(after.overflowUntil).toBeGreaterThanOrEqual(maxDeniedUntil)
    // An unrelated route must wait for the overflow horizon rather than bypassing forgotten denials
    const fresh = rateRoute("GET", "/channels/999999/messages/1", "999999")
    expect(limits.wait(fresh.key, now + 1)).toBeGreaterThanOrEqual(after.overflowUntil)

    // Clock jump past expiry frees capacity cleanly
    now += 20_000
    const postExpiry = rateRoute("GET", "/channels/888888/messages/1", "888888")
    expect(limits.wait(postExpiry.key, now)).toBe(0)
    limits.clear()
    expect(limits.inspect()).toEqual({ buckets: 0, aliases: 0, overflowUntil: 0, probes: [] })
})

test("RestAdmission preserves slot, byte, probe-exclusivity and close invariants across random interleavings", async () => {
    const routes: readonly RateRoute[] = [
        rateRoute("GET", "/channels/10/messages/1", "10"),
        rateRoute("POST", "/channels/10/typing", "10", "typing"),
        rateRoute("GET", "/channels/11/messages/2", "11"),
        rateRoute("PATCH", "/guilds/20/members/30", "20"),
    ]
    const settings: RestConfiguration = {
        concurrency: 3,
        concurrencyScales: true,
        mediaConcurrency: 2,
        maxQueued: 12,
        queuedJsonMaxBytes: 512,
        defaultTimeoutMs: 5_000,
    }

    type ActiveHandle = {
        readonly release: AdmissionRelease
        readonly route: RateRoute
        readonly media: boolean
        readonly rateLimited: boolean
        readonly attempt: RateAttempt | undefined
        readonly target: RateTarget | undefined
    }
    type QueuedHandle = {
        readonly id: number
        readonly bytes: number
        readonly fiber: Fiber.Fiber<AdmissionRelease, unknown>
        settled: boolean
        outcome?: Exit.Exit<AdmissionRelease, unknown>
    }

    for (let trial = 0; trial < 15; trial++) {
        const seed = (baseSeed + 5_000 + trial * 313) >>> 0
        const rng = prng(seed)
        const scheduler = new ManualLogicalScheduler()
        const admission = new RestAdmission(scheduler.asLogicalScheduler(), settings)

        let expectedApiCapacity = settings.concurrency
        let previousActiveApi = 0
        let nextId = 1
        let maxGlobalOrClientUntil = 0
        const activeApi = new Map<AdmissionRelease, ActiveHandle>()
        const activeMedia = new Map<AdmissionRelease, ActiveHandle>()
        const queued = new Map<number, QueuedHandle>()

        const yieldMicrotasks = async () => {
            for (let turn = 0; turn < 3; turn++) await Promise.resolve()
        }

        const assertInvariants = (step: number) => {
            const tag = `seed=${seed} trial=${trial} step=${step} now=${scheduler.now()}`
            const diag = admission.diagnostics()
            const expectedQueuedBytes = [...queued.values()].reduce((sum, item) => sum + item.bytes, 0)

            expect(diag.queuedRequests, `${tag}: queuedRequests`).toBe(queued.size)
            expect(diag.queuedJsonBytes, `${tag}: queuedJsonBytes`).toBe(expectedQueuedBytes)
            expect(diag.queuedRequests, `${tag}: queued cap`).toBeLessThanOrEqual(settings.maxQueued)
            expect(diag.queuedJsonBytes, `${tag}: bytes cap`).toBeLessThanOrEqual(settings.queuedJsonMaxBytes)
            expect(diag.activeRequests, `${tag}: activeRequests`).toBe(activeApi.size + activeMedia.size)
            // Scaling concurrency down never aborts already active requests, but no new API request may enter above capacity
            expect(activeApi.size, `${tag}: api slot cap`).toBeLessThanOrEqual(
                Math.max(expectedApiCapacity, previousActiveApi),
            )
            if (activeApi.size > previousActiveApi) {
                expect(activeApi.size, `${tag}: admitted above api slot cap`).toBeLessThanOrEqual(expectedApiCapacity)
            }
            previousActiveApi = activeApi.size
            expect(activeMedia.size, `${tag}: media slot cap`).toBeLessThanOrEqual(settings.mediaConcurrency)

            const probe = admission.probeState
            switch (probe.kind) {
                case "none":
                    break
                case "needed":
                    expect(probe.repeats, `${tag}: needed probe repeats`).toBeGreaterThanOrEqual(1)
                    break
                case "inFlight":
                    expect(probe.repeats, `${tag}: inFlight probe repeats`).toBeGreaterThanOrEqual(1)
                    expect(activeApi.has(probe.attempt), `${tag}: inFlight probe must be active API handle`).toBe(true)
                    break
            }

            const rateState = admission.rates.inspect()
            expect(rateState.buckets, `${tag}: rate buckets cap`).toBeLessThanOrEqual(2048)
            expect(rateState.aliases, `${tag}: rate aliases cap`).toBeLessThanOrEqual(2048)
        }

        for (let step = 0; step < 260; step++) {
            const action = rng.below(100)
            if (action < 34) {
                // Acquire a new API or media request
                const route = rng.pick(routes)
                const media = rng.chance(0.2)
                const rateLimited = !media && rng.chance(0.85)
                const probe = rateLimited && rng.chance(0.85)
                const bytes = media ? 0 : rng.below(180)
                const now = scheduler.now()
                const until = rng.chance(0.25) ? now + 10 + rng.below(200) : 0
                const deadline = rng.chance(0.35) ? now + 50 + rng.below(600) : Infinity
                const id = nextId++
                const probeBefore = admission.probeState

                const fiber = Effect.runFork(
                    admission.acquire({
                        route: route.key,
                        group: `OP ${route.key.slice(0, 8)}`,
                        bytes,
                        until,
                        deadline,
                        rateLimited,
                        media,
                        probe,
                    }),
                )
                const record: QueuedHandle = { id, bytes, fiber, settled: false }
                queued.set(id, record)

                void Effect.runPromiseExit(Fiber.join(fiber)).then((exit) => {
                    record.settled = true
                    record.outcome = exit
                    queued.delete(id)
                    if (Exit.isSuccess(exit)) {
                        const release = exit.value
                        if (
                            rateLimited &&
                            probeBefore.kind === "inFlight" &&
                            admission.probeState.kind === "inFlight" &&
                            admission.probeState.attempt === probeBefore.attempt
                        ) {
                            throw new Error(`Rate-limited request admitted while probe was in flight at step ${step}`)
                        }
                        const attempt = rateLimited ? admission.rates.begin(route) : undefined
                        const handle: ActiveHandle = { release, route, media, rateLimited, attempt, target: undefined }
                        if (media) activeMedia.set(release, handle)
                        else activeApi.set(release, handle)
                    }
                })
                await yieldMicrotasks()
            } else if (action < 48 && queued.size > 0) {
                // Cancel a random queued request via fiber interruption
                const entry = rng.pick([...queued.values()])
                await Effect.runPromise(Fiber.interrupt(entry.fiber))
                await yieldMicrotasks()
                expect(queued.has(entry.id)).toBe(false)
            } else if (action < 66 && activeApi.size + activeMedia.size > 0) {
                // Observe/respond and release an active handle (with occasional redundant double-release)
                const allActive = [...activeApi.values(), ...activeMedia.values()]
                const handle = rng.pick(allActive)
                const now = scheduler.now()
                if (handle.rateLimited && handle.attempt !== undefined) {
                    const outcomeRoll = rng.below(5)
                    if (outcomeRoll === 0) {
                        const target = admission.rates.observe(
                            handle.attempt,
                            headerResponse({
                                template: "channel:message:read::channel_id",
                                remaining: rng.below(3),
                                resetAfter: 1,
                                limit: 3,
                            }),
                            now,
                        )
                        if (rng.chance(0.4)) admission.rates.pause(target, now + 300, now, handle.attempt.sequence)
                        admission.responded(handle.release)
                    } else if (outcomeRoll === 1) {
                        const returned = admission.pauseClient(now + 100 + rng.below(300), rng.next(), handle.release)
                        expect(returned).toBeGreaterThanOrEqual(maxGlobalOrClientUntil)
                        maxGlobalOrClientUntil = Math.max(maxGlobalOrClientUntil, returned)
                    } else if (outcomeRoll === 2) {
                        const targetUntil = now + 100 + rng.below(400)
                        admission.pauseGlobal(targetUntil, rng.chance(0.5))
                        maxGlobalOrClientUntil = Math.max(maxGlobalOrClientUntil, targetUntil)
                        admission.responded(handle.release)
                    } else if (outcomeRoll === 3) {
                        admission.responded(handle.release)
                    }
                    // outcomeRoll === 4 simulates network failure without calling responded (passes probe on release)
                }
                if (handle.media) activeMedia.delete(handle.release)
                else activeApi.delete(handle.release)
                handle.release()
                if (rng.chance(0.3)) handle.release()
                await yieldMicrotasks()
            } else if (action < 74) {
                const targetUntil = scheduler.now() + 50 + rng.below(400)
                admission.pauseGlobal(targetUntil, rng.chance(0.5))
                maxGlobalOrClientUntil = Math.max(maxGlobalOrClientUntil, targetUntil)
                await yieldMicrotasks()
            } else if (action < 82) {
                const now = scheduler.now()
                const activeList = [...activeApi.keys()]
                const attempt = activeList.length > 0 && rng.chance(0.6) ? rng.pick(activeList) : undefined
                const returned = admission.pauseClient(now + 50 + rng.below(300), rng.next(), attempt)
                expect(returned).toBeGreaterThanOrEqual(maxGlobalOrClientUntil)
                maxGlobalOrClientUntil = Math.max(maxGlobalOrClientUntil, returned)
                await yieldMicrotasks()
            } else if (action < 87) {
                const activeList = [...activeApi.keys()]
                const attempt = activeList.length > 0 && rng.chance(0.7) ? rng.pick(activeList) : undefined
                admission.responded(attempt)
                await yieldMicrotasks()
            } else if (action < 91) {
                const shards = 1 + rng.below(4)
                admission.scaleConcurrency(shards)
                expectedApiCapacity = Math.min(64, 4 * shards)
                await yieldMicrotasks()
            } else {
                scheduler.advance(rng.pick([1, 25, 100, 350, 1_200]))
                await yieldMicrotasks()
            }
            assertInvariants(step)
        }

        // Verify clean shutdown: Every waiting acquire fails with ClientClosedError
        const waitingBeforeClose = [...queued.values()]
        admission.close()
        await yieldMicrotasks()

        for (const item of waitingBeforeClose) {
            const exit = await Effect.runPromiseExit(Fiber.join(item.fiber))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                const failure = Cause.squash(exit.cause)
                expect(failure).toBeInstanceOf(ClientClosedError)
            }
        }
        expect(admission.diagnostics().queuedRequests).toBe(0)
        expect(admission.diagnostics().queuedJsonBytes).toBe(0)
        expect(admission.probeState).toEqual({ kind: "none" })

        // Post-close acquires fail immediately with ClientClosedError
        const postClose = await Effect.runPromiseExit(admission.acquire({ route: routes[0]!.key, bytes: 10 }))
        expect(Exit.isFailure(postClose)).toBe(true)
        if (Exit.isFailure(postClose)) expect(Cause.squash(postClose.cause)).toBeInstanceOf(ClientClosedError)

        // Releasing remaining active handles after close keeps counters exact and non-negative
        for (const release of [...activeApi.keys()]) {
            activeApi.delete(release)
            release()
        }
        for (const release of [...activeMedia.keys()]) {
            activeMedia.delete(release)
            release()
        }
        expect(admission.diagnostics().activeRequests).toBe(0)
    }
})
