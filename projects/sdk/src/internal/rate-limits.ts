import { createHash } from "node:crypto"
import { rateLimitParameters } from "./rate-limit-templates.js"

const capacity = 2048
const aliasIdleMs = 300_000
type Bucket = {
    remaining: number
    until: number
    limit?: number
    next?: number
    sequence: number
    probeRoute?: string
    probeSequence?: number
    probeRemaining?: number
    probeIncomplete?: true
}
type Alias = { key: string; sequence: number; expires: number; carryUntil: number }
export type RateRoute = { readonly key: string; readonly parameters: Readonly<Record<string, string>> }
export type RateAttempt = { readonly route: RateRoute; readonly sequence: number }

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const provisional = (key: string) => key.split("|")[1] ?? key

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
    const route = `r:${digest(JSON.stringify([method, normalized, major, operation, parameters]))}`
    // Retain explicitly shared SDK operation groups before the provider supplies
    // an identity. Learning is still per endpoint, so distinct server buckets split
    const fallback = operation ? `r:${digest(JSON.stringify([operation, major]))}` : route
    return { key: `${route}|${fallback}`, parameters }
}

/** Per-client bucket learning. Eviction cannot discard an unexpired denial */
export class RateLimits {
    #aliases = new Map<string, Alias>()
    #buckets = new Map<string, Bucket>()
    #sequence = 0
    #overflowUntil = 0

    begin(route: RateRoute): RateAttempt {
        const sequence = ++this.#sequence
        const alias = this.#aliases.get(route.key)
        const bucket = this.#buckets.get(alias?.key ?? provisional(route.key))
        if (bucket?.probeRoute === route.key && bucket.probeSequence === undefined) bucket.probeSequence = sequence
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

    #protected(key: string, now: number) {
        const bucket = this.#buckets.get(key)
        return bucket !== undefined && bucket.until > now && bucket.remaining <= 0
    }

    #wait(key: string, now: number) {
        const bucket = this.#buckets.get(key)
        if (bucket && bucket.until <= now) {
            this.#buckets.delete(key)
            return 0
        }
        if (!bucket || bucket.remaining > 0) return 0
        if (bucket.probeRoute !== undefined) return bucket.until
        return bucket.next !== undefined && bucket.next < bucket.until ? bucket.next : bucket.until
    }

    wait(route: string, now: number): number {
        const alias = this.#alias(route, now)
        const until = Math.max(
            this.#overflowUntil,
            alias?.carryUntil ?? 0,
            this.#wait(alias?.key ?? provisional(route), now),
        )
        return until > now ? until : 0
    }

    reserve(route: string, now: number) {
        const alias = this.#alias(route, now)
        const bucket = this.#buckets.get(alias?.key ?? provisional(route))
        if (!bucket || bucket.until <= now) return
        if (bucket.remaining > 0) {
            bucket.remaining--
            return
        }
        if (bucket.next !== undefined && bucket.next <= now && bucket.probeRoute === undefined) {
            // Once integer remaining reaches zero, only one request may test the
            // next refill. Its response must refresh the schedule before another
            // request can use the same bucket
            bucket.probeRoute = route
        }
    }

    #store(
        key: string,
        remaining: number,
        until: number,
        now: number,
        sequence: number,
        limit?: number,
        next?: number,
    ) {
        const previous = this.#buckets.get(key)
        if (!previous || previous.until <= now) {
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
                return
            }
        }
        const active = previous && previous.until > now ? previous : undefined
        const newest = !active || sequence >= active.sequence
        const changedLimit = active?.limit !== undefined && limit !== undefined && active.limit !== limit
        const refreshedProbe = active?.probeSequence !== undefined && sequence === active.probeSequence
        const observedProbeRemaining =
            active?.probeRoute === undefined ? undefined : Math.min(active.probeRemaining ?? remaining, remaining)
        const conservativeProbe = active?.probeIncomplete === true || (active?.probeRoute !== undefined && changedLimit)
        const refreshesSchedule = newest || refreshedProbe
        const retainedLimit = newest
            ? changedLimit
                ? Math.min(active!.limit!, limit!)
                : (limit ?? active?.limit)
            : active?.limit
        this.#buckets.set(key, {
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
            ...(!refreshedProbe && active?.probeRoute !== undefined
                ? {
                      probeRoute: active.probeRoute,
                      ...(active.probeSequence === undefined ? {} : { probeSequence: active.probeSequence }),
                      ...(observedProbeRemaining === undefined ? {} : { probeRemaining: observedProbeRemaining }),
                      ...(conservativeProbe ? { probeIncomplete: true as const } : {}),
                  }
                : {}),
        })
    }

    observe(attempt: RateAttempt, response: Response, now: number): string {
        const { route, sequence } = attempt
        const previous = this.#alias(route.key, now)
        const header = response.headers.get("x-ratelimit-bucket")
        let key = previous?.key ?? provisional(route.key)
        let missingParameters = false
        if (header !== null && /^[a-zA-Z0-9_-]{1,128}$/.test(header)) {
            const parameters = rateLimitParameters.get(header) ?? []
            missingParameters = parameters.some((name) => route.parameters[name] === undefined)
            key = `b:${header}:${digest(JSON.stringify(parameters.map((name) => route.parameters[name] ?? "")))}`
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
                            this.#wait(provisional(route.key), now),
                        ),
                    })
                } else missingParameters = true
            }
        }
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
            this.#store(key, remaining, until, now, sequence, complete ? limit : undefined, next)
            if (missingParameters) this.#overflowUntil = Math.max(this.#overflowUntil, until)
        } else {
            const bucket = this.#buckets.get(key)
            if (bucket?.probeRoute !== undefined && sequence !== bucket.probeSequence) bucket.probeIncomplete = true
            if (bucket && sequence >= bucket.sequence) {
                // Incomplete or changing metadata cannot keep a speculative refill
                // schedule. Preserve the known full-drain pause instead
                delete bucket.next
                bucket.sequence = sequence
            }
        }
        // Missing resource bindings or pinned-capacity pressure must not let the
        // attempt's later body-only denial bypass the conservative overflow gate
        return missingParameters ? "overflow" : key
    }

    pause(key: string, until: number, now: number, sequence?: number) {
        if (key === "overflow") {
            this.#overflowUntil = Math.max(this.#overflowUntil, until)
            return
        }
        const bucket = this.#buckets.get(key)
        if (sequence !== undefined && bucket?.probeRoute !== undefined && sequence !== bucket.probeSequence)
            bucket.probeRemaining = 0
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
            if (bucket.probeSequence !== undefined && sequence === bucket.probeSequence) {
                delete bucket.probeRoute
                delete bucket.probeSequence
                delete bucket.probeRemaining
                delete bucket.probeIncomplete
            }
            return
        }
        this.#store(key, 0, until, now, sequence ?? ++this.#sequence)
    }

    clear() {
        this.#aliases.clear()
        this.#buckets.clear()
        this.#overflowUntil = 0
    }
}
