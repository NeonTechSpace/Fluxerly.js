/**
 * Cache retention ages: One snapshot's age limit from a fixed maxAgeMs setting or an application duration callback.
 * Invariant: A callback that throws or returns an invalid value never decides retention. Its invalid return is discarded without
 * being awaited, and the failure is returned for the owning cache to remove the older copy and report.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { validAge } from "./configuration.js"
import { discardInvalidCallbackReturn } from "./invalid-callback-return.js"

/** A validated maxAgeMs setting: A fixed age, null for no age limit, or a synchronous callback */
export type AgeSetting<T> = number | null | ((value: T) => number | null)

/** The age to apply, or the failure to report when the callback threw or returned an invalid value */
export type RetentionAge = { readonly age: number | null } | { readonly error: unknown }

/** Resolve one snapshot's age. The subject names the cache and the noun names what was not cached, for the failure text */
export function retentionAge<T>(setting: AgeSetting<T>, value: T, subject: string, noun: string): RetentionAge {
    if (typeof setting !== "function") return { age: setting }
    let age: unknown
    try {
        age = setting(value)
    } catch (error) {
        return { error }
    }
    if (validAge(age)) return { age }
    discardInvalidCallbackReturn(age)
    return {
        error: new TypeError(
            // oxlint-disable-next-line typescript/no-base-to-string -- object and function values take the preceding branch
            `The ${subject} maxAgeMs callback returned ${age === undefined ? "undefined" : typeof age === "object" || typeof age === "function" ? "a non-number value" : String(age)}, but it must return null or a nonnegative safe integer, so the ${noun} was not cached`,
        ),
    }
}
