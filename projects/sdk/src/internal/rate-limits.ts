/**
 * Learned rate-limit buckets and aliases for one REST owner.
 * Invariant: The owner bounds how many aliases and windows it keeps. Unknown hashes group conservatively within their bucket, and
 * unbound resource parameters or exhausted tracking keep conservative client-wide waits. Known active pauses survive remapping or
 * eviction, an older response never overwrites a newer alias, alias keys never keep credential-bearing URLs or query strings, and
 * no learning crosses REST owners, credentials or instance selections. History and single-message fetches use separate
 * provisional groups while sharing global admission. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { createHash } from "node:crypto"
import { rateLimitParameters } from "./rate-limit-templates.js"

const capacity = 2048
const aliasIdleMs = 300_000

declare const rateRouteKeyBrand: unique symbol
declare const rateBucketKeyBrand: unique symbol
declare const rateOverflowBrand: unique symbol

/** Opaque route key passed through admission queues, pairing an endpoint identity with its provisional bucket */
export type RateRouteKey = string & { readonly [rateRouteKeyBrand]: "RateRouteKey" }

/** Opaque key identifying one learned or provisional rate-limit bucket */
export type RateBucketKey = string & { readonly [rateBucketKeyBrand]: "RateBucketKey" }

/** Branded sentinel indicating conservative client-wide overflow pacing */
export type RateOverflowTarget = "overflow" & { readonly [rateOverflowBrand]: "RateOverflowTarget" }

/** The rate-limit target reported by observe and accepted by pause */
export type RateTarget = RateBucketKey | RateOverflowTarget

/** State of the single refill probe allowed once integer remaining reaches zero */
export type BucketProbe =
    | { readonly kind: "none" }
    | {
          readonly kind: "reserved"
          readonly route: string
          remaining: number | undefined
          incomplete: boolean
      }
    | {
          readonly kind: "inFlight"
          readonly route: string
          readonly sequence: number
          remaining: number | undefined
          incomplete: boolean
      }

const noProbe: BucketProbe = Object.freeze({ kind: "none" })
const overflowTarget = "overflow" as RateOverflowTarget
const provisionalSeparator = "|"

type Bucket = {
    remaining: number
    until: number
    limit?: number
    next?: number
    sequence: number
    probe: BucketProbe
}
type Alias = { key: RateBucketKey; sequence: number; expires: number; carryUntil: number }
export interface RateRoute {
    readonly key: RateRouteKey
    readonly endpoint: RateBucketKey
    readonly provisional: RateBucketKey
    readonly parameters: Readonly<Record<string, string>>
}
export type RateAttempt = { readonly route: RateRoute; readonly sequence: number }

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const bucketKey = (value: string) => value as RateBucketKey
const formatRouteKey = (endpoint: RateBucketKey, fallback: RateBucketKey) =>
    `${endpoint}${provisionalSeparator}${fallback}` as RateRouteKey

function resolveRoute(route: RateRoute | string): { readonly key: string; readonly provisional: RateBucketKey } {
    if (typeof route !== "string") return { key: route.key, provisional: route.provisional }
    const separator = route.indexOf(provisionalSeparator)
    return {
        key: route,
        provisional: bucketKey(separator === -1 ? route : route.slice(separator + 1)),
    }
}

type ParsedTarget = { readonly kind: "overflow" } | { readonly kind: "bucket"; readonly key: RateBucketKey }

function parseTarget(target: RateTarget | RateRouteKey): ParsedTarget {
    return target === overflowTarget ? { kind: "overflow" } : { kind: "bucket", key: target as RateBucketKey }
}

/** Request paths are SDK-built. Retained keys exclude queries, invite codes and webhook credentials */
export function rateRoute(
    method: string,
    path: string,
    major: string,
    operation?: string,
    webhookId?: string,
): RateRoute {
    const pathname = `${webhookId ? `/webhooks/${webhookId}` : ""}${path.split("?")[0]}`
    const parts = pathname.split("/")
    const parameters: Record<string, string> = {}
    const names: Record<string, string> = {
        channels: "channel_id",
        guilds: "guild_id",
        users: "user_id",
        webhooks: "webhook_id",
        invites: "invite_code",
    }
    for (let index = 1; index < parts.length - 1; index++) {
        const parameter = names[parts[index]!]
        if (!parameter || !parts[index + 1]) continue
        parameters[parameter] = parts[index + 1]!
        if (parameter === "user_id") parameters.target_id = parts[index + 1]!
    }
    // Message, member, role and emoji identifiers do not partition these learned
    // provider templates. Distinct endpoint shapes still get separate provisional keys
    const normalized = parts
        .map((part, index) =>
            /^\d+$/.test(part) || names[parts[index - 1] ?? ""] || parts[index - 1] === "reactions" ? ":id" : part,
        )
        .join("/")
    const endpoint = bucketKey(`r:${digest(JSON.stringify([method, normalized, major, operation, parameters]))}`)
    // Retain explicitly shared SDK operation groups before the provider supplies
    // an identity. Learning is still per endpoint, so distinct server buckets split
    const provisional = operation ? bucketKey(`r:${digest(JSON.stringify([operation, major]))}`) : endpoint
    return { key: formatRouteKey(endpoint, provisional), endpoint, provisional, parameters }
}

/** The values one response reports for a bucket */
type BucketObservation = {
    readonly remaining: number
    readonly until: number
    readonly sequence: number
    readonly limit: number | undefined
    readonly next: number | undefined
}

/** How an observation relates to the live bucket it updates */
function compareObservation(active: Bucket | undefined, observation: BucketObservation) {
    const { remaining, sequence, limit } = observation
    const newest = !active || sequence >= active.sequence
    const changedLimit = active?.limit !== undefined && limit !== undefined && active.limit !== limit
    const probe = active?.probe ?? noProbe
    const refreshedProbe = probe.kind === "inFlight" && sequence === probe.sequence
    const observedProbeRemaining = probe.kind === "none" ? undefined : Math.min(probe.remaining ?? remaining, remaining)
    const conservativeProbe = probe.kind !== "none" && (probe.incomplete || changedLimit)
    const refreshesSchedule = newest || refreshedProbe
    const retainedLimit = newest
        ? changedLimit
            ? Math.min(active!.limit!, limit!)
            : (limit ?? active?.limit)
        : active?.limit
    return {
        changedLimit,
        refreshedProbe,
        observedProbeRemaining,
        conservativeProbe,
        refreshesSchedule,
        retainedLimit,
    }
}

/** Advance a live probe after an observation from another attempt, or clear it once the probe itself answered */
function nextProbe(
    probe: BucketProbe,
    refreshed: boolean,
    remaining: number | undefined,
    incomplete: boolean,
): BucketProbe {
    if (refreshed) return noProbe
    switch (probe.kind) {
        case "none":
            return noProbe
        case "reserved":
            return { kind: "reserved", route: probe.route, remaining, incomplete }
        case "inFlight":
            return { kind: "inFlight", route: probe.route, sequence: probe.sequence, remaining, incomplete }
    }
}

/** The bucket after one observation, which can only tighten a live bucket's remaining requests and pause */
function mergedBucket(active: Bucket | undefined, observation: BucketObservation): Bucket {
    const { remaining, until, sequence, next } = observation
    const {
        changedLimit,
        refreshedProbe,
        observedProbeRemaining,
        conservativeProbe,
        refreshesSchedule,
        retainedLimit,
    } = compareObservation(active, observation)
    return {
        remaining: refreshedProbe
            ? conservativeProbe
                ? 0
                : (observedProbeRemaining ?? remaining)
            : Math.min(active?.remaining ?? remaining, remaining),
        until: Math.max(active?.until ?? 0, until),
        ...(refreshesSchedule && !changedLimit && !conservativeProbe && next !== undefined
            ? { next: Math.max(active?.next ?? 0, next) }
            : !refreshesSchedule && active?.next !== undefined
              ? { next: active.next }
              : {}),
        ...(retainedLimit === undefined ? {} : { limit: retainedLimit }),
        sequence: Math.max(active?.sequence ?? 0, sequence),
        probe: nextProbe(active?.probe ?? noProbe, refreshedProbe, observedProbeRemaining, conservativeProbe),
    }
}

/** Per-client bucket learning. Eviction cannot discard an unexpired denial */
export class RateLimits {
    #aliases = new Map<string, Alias>()
    #buckets = new Map<RateBucketKey, Bucket>()
    #sequence = 0
    #overflowUntil = 0

    begin(route: RateRoute): RateAttempt {
        const sequence = ++this.#sequence
        const alias = this.#aliases.get(route.key)
        const bucket = this.#buckets.get(alias?.key ?? route.provisional)
        if (bucket?.probe.kind === "reserved" && bucket.probe.route === route.key)
            bucket.probe = {
                kind: "inFlight",
                route: bucket.probe.route,
                sequence,
                remaining: bucket.probe.remaining,
                incomplete: bucket.probe.incomplete,
            }
        return { route, sequence }
    }

    #alias(route: string, now: number) {
        const alias = this.#aliases.get(route)
        if (!alias) return undefined
        if (alias.expires <= now && !this.#protected(alias.key, now) && alias.carryUntil <= now) {
            this.#aliases.delete(route)
            return undefined
        }
        alias.expires = now + aliasIdleMs
        return alias
    }

    #protected(key: RateBucketKey, now: number) {
        const bucket = this.#buckets.get(key)
        return bucket !== undefined && bucket.until > now && bucket.remaining <= 0
    }

    #wait(key: RateBucketKey, now: number, firm = false) {
        const bucket = this.#buckets.get(key)
        if (bucket && bucket.until <= now) {
            this.#buckets.delete(key)
            return 0
        }
        if (!bucket || bucket.remaining > 0) return 0
        if (bucket.probe.kind !== "none" && !firm) return bucket.until
        return bucket.next !== undefined && bucket.next < bucket.until ? bucket.next : bucket.until
    }

    /**
     * The logical time before which the route may not send, or 0 when it may send now. A firm wait leaves out the hold
     * of an outstanding refill probe, whose answer can reopen the bucket early, so the route cannot send before it
     */
    wait(route: RateRoute | string, now: number, firm = false): number {
        const resolved = resolveRoute(route)
        const alias = this.#alias(resolved.key, now)
        const until = Math.max(
            this.#overflowUntil,
            alias?.carryUntil ?? 0,
            this.#wait(alias?.key ?? resolved.provisional, now, firm),
        )
        return until > now ? until : 0
    }

    reserve(route: RateRoute | string, now: number) {
        const resolved = resolveRoute(route)
        const alias = this.#alias(resolved.key, now)
        const bucket = this.#buckets.get(alias?.key ?? resolved.provisional)
        if (!bucket || bucket.until <= now) return
        if (bucket.remaining > 0) {
            bucket.remaining--
            return
        }
        if (bucket.next !== undefined && bucket.next <= now && bucket.probe.kind === "none") {
            // Once integer remaining reaches zero, only one request may test the
            // next refill. Its response must refresh the schedule before another
            // request can use the same bucket
            bucket.probe = { kind: "reserved", route: resolved.key, remaining: undefined, incomplete: false }
        }
    }

    #store(key: RateBucketKey, observation: BucketObservation, now: number) {
        const previous = this.#buckets.get(key)
        if ((!previous || previous.until <= now) && !this.#roomFor(key, observation.until, now)) return
        const active = previous && previous.until > now ? previous : undefined
        this.#buckets.set(key, mergedBucket(active, observation))
    }

    /**
     * Make room for a bucket with no live entry, dropping expired buckets and then one bucket with requests left. Without
     * room this returns false and pauses conservatively rather than forgetting a known limit
     */
    #roomFor(key: RateBucketKey, until: number, now: number): boolean {
        for (const [candidate, bucket] of this.#buckets) if (bucket.until <= now) this.#buckets.delete(candidate)
        if (!this.#buckets.has(key) && this.#buckets.size >= capacity) {
            for (const [candidate, bucket] of this.#buckets) {
                if (bucket.remaining > 0) {
                    this.#buckets.delete(candidate)
                    break
                }
            }
        }
        if (!this.#buckets.has(key) && this.#buckets.size >= capacity) {
            // At capacity, pause conservatively rather than forgetting a known limit
            this.#overflowUntil = Math.max(this.#overflowUntil, until)
            return false
        }
        return true
    }

    /** Map a route to the bucket a valid header names, returning the key and whether conservative overflow must apply */
    #learnBucket(attempt: RateAttempt, header: string, previous: Alias | undefined, now: number) {
        const { route, sequence } = attempt
        const parameters = rateLimitParameters.get(header) ?? []
        let missingParameters = parameters.some((name) => route.parameters[name] === undefined)
        const key = bucketKey(
            `b:${header}:${digest(JSON.stringify(parameters.map((name) => route.parameters[name] ?? "")))}`,
        )
        // A response from an older dispatched attempt must not undo a newer mapping
        if (!previous || sequence >= previous.sequence) {
            if (!previous && this.#aliases.size >= capacity) {
                for (const [candidate, alias] of this.#aliases) {
                    if (!this.#protected(alias.key, now) && alias.carryUntil <= now) {
                        this.#aliases.delete(candidate)
                        break
                    }
                }
            }
            if (previous || this.#aliases.size < capacity) {
                this.#aliases.delete(route.key)
                this.#aliases.set(route.key, {
                    key,
                    sequence,
                    expires: now + aliasIdleMs,
                    carryUntil: Math.max(
                        previous?.carryUntil ?? 0,
                        previous && previous.key !== key ? this.#wait(previous.key, now) : 0,
                        this.#wait(route.provisional, now),
                    ),
                })
            } else missingParameters = true
        }
        return { key, missingParameters }
    }

    observe(attempt: RateAttempt, response: Response, now: number): RateTarget {
        const { route, sequence } = attempt
        const previous = this.#alias(route.key, now)
        const header = response.headers.get("x-ratelimit-bucket")
        let key: RateBucketKey = previous?.key ?? route.provisional
        let missingParameters = false
        if (header !== null && /^[a-zA-Z0-9_-]{1,128}$/.test(header))
            ({ key, missingParameters } = this.#learnBucket(attempt, header, previous, now))
        const remainingText = response.headers.get("x-ratelimit-remaining")
        const resetText = response.headers.get("x-ratelimit-reset-after")
        const limitText = response.headers.get("x-ratelimit-limit")
        const remaining = remainingText !== null && /^\d+$/.test(remainingText) ? Number(remainingText) : NaN
        const delay = resetText !== null && /^\d+(?:\.\d+)?$/.test(resetText) ? Number(resetText) * 1000 : NaN
        const limit = limitText !== null && /^\d+$/.test(limitText) ? Number(limitText) : NaN
        if (Number.isSafeInteger(remaining) && remaining >= 0 && Number.isFinite(delay) && delay > 0) {
            const until = now + delay
            const complete = Number.isSafeInteger(limit) && limit > 0 && remaining <= limit
            // With zero integer remaining, the hidden bucket level is in
            // (limit - 1, limit]. A limit-th of the full-drain delay is therefore
            // never earlier than the first instant one whole request fits. One
            // in-flight probe then refreshes the schedule. No leak rate is inferred
            // from (limit - remaining), whose fractional level is not observable
            const next = complete && remaining === 0 ? now + Math.ceil(delay / limit) : undefined
            this.#store(key, { remaining, until, sequence, limit: complete ? limit : undefined, next }, now)
            if (missingParameters) this.#overflowUntil = Math.max(this.#overflowUntil, until)
        } else {
            const bucket = this.#buckets.get(key)
            if (
                bucket !== undefined &&
                bucket.probe.kind !== "none" &&
                (bucket.probe.kind === "reserved" || sequence !== bucket.probe.sequence)
            )
                bucket.probe.incomplete = true
            if (bucket && sequence >= bucket.sequence) {
                // Incomplete or changing metadata cannot keep a speculative refill
                // schedule. Preserve the known full-drain pause instead
                delete bucket.next
                bucket.sequence = sequence
            }
        }
        // Missing resource bindings or pinned-capacity pressure must not let the
        // attempt's later body-only denial bypass the conservative overflow gate
        return missingParameters ? overflowTarget : key
    }

    pause(target: RateTarget | RateRouteKey, until: number, now: number, sequence?: number) {
        const parsed = parseTarget(target)
        if (parsed.kind === "overflow") {
            this.#overflowUntil = Math.max(this.#overflowUntil, until)
            return
        }
        const key = parsed.key
        const bucket = this.#buckets.get(key)
        if (
            sequence !== undefined &&
            bucket !== undefined &&
            bucket.probe.kind !== "none" &&
            (bucket.probe.kind === "reserved" || sequence !== bucket.probe.sequence)
        )
            bucket.probe.remaining = 0
        if (
            sequence !== undefined &&
            bucket !== undefined &&
            bucket.until > now &&
            bucket.limit !== undefined &&
            sequence >= bucket.sequence
        ) {
            // A confirmed 429 body gives the precise first-admission delay. It
            // may shorten only the matching observation's refill probe, never
            // the full-drain horizon or a newer response's schedule
            bucket.remaining = 0
            bucket.until = Math.max(bucket.until, until)
            bucket.next = until
            bucket.sequence = sequence
            if (bucket.probe.kind === "inFlight" && sequence === bucket.probe.sequence) bucket.probe = noProbe
            return
        }
        this.#store(
            key,
            { remaining: 0, until, sequence: sequence ?? ++this.#sequence, limit: undefined, next: undefined },
            now,
        )
    }

    /** Read-only summary of retained buckets, aliases and active probes for model verification */
    inspect(): {
        readonly buckets: number
        readonly aliases: number
        readonly overflowUntil: number
        readonly probes: readonly { readonly bucket: RateBucketKey; readonly probe: Readonly<BucketProbe> }[]
    } {
        const probes: { readonly bucket: RateBucketKey; readonly probe: Readonly<BucketProbe> }[] = []
        for (const [key, bucket] of this.#buckets) {
            if (bucket.probe.kind !== "none") probes.push({ bucket: key, probe: { ...bucket.probe } })
        }
        return {
            buckets: this.#buckets.size,
            aliases: this.#aliases.size,
            overflowUntil: this.#overflowUntil,
            probes,
        }
    }

    clear() {
        this.#aliases.clear()
        this.#buckets.clear()
        this.#overflowUntil = 0
    }
}

/**
 * A log-safe template for a caller-supplied path, whose segments the SDK did not build: The routeTemplate placeholders,
 * then every remaining segment that is not a short lower-case word, such as a code or credential, becomes :value
 */
export function callerRouteTemplate(path: string): string {
    return routeTemplate(path)
        .split("/")
        .map((part) =>
            part === "" ||
            part.startsWith(":") ||
            (part.length <= 32 && /^(?:@me|[a-z]+(?:[-_][a-z]+)*\d?)$/.test(part))
                ? part
                : ":value",
        )
        .join("/")
}

/** A log-safe route template: IDs, invite codes, emoji and webhook tokens become placeholders and the query is removed */
export function routeTemplate(path: string, webhookId?: string): string {
    const pathname = `${webhookId === undefined ? "" : "/webhooks/:id/:token"}${path.split("?")[0]}`
    const parts = pathname.split("/")
    return parts
        .map((part, index) => {
            const previous = parts[index - 1]
            if (part === "" || part.startsWith(":")) return part
            if (/^\d+$/.test(part)) return ":id"
            if (previous === "invites" || previous === "vanity-url") return ":code"
            if (previous === "reactions") return ":emoji"
            if (index > 1 && parts[index - 2] === "webhooks" && previous !== undefined && /^\d+$/.test(previous))
                return ":token"
            return /^[a-z@][a-z0-9@._-]*$/i.test(part) ? part : ":value"
        })
        .join("/")
}
