/**
 * Gateway option validation: Malformed-dispatch policy and the Identify fields ignoredEvents, flags and presence.
 * Invariant: Creation copies every value once, never sends an Identify Fluxer would close with 4002, and rejects an
 * explicit ignored list that would leave an enabled cache stale or stop an SDK-owned request.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import { ConfigurationError } from "#sdk/errors"
import { InputValidationFailure } from "#sdk/input-validation"
import { settingError } from "../client/configuration-fields.js"
import { unsupportedKeyHint } from "../suggest.js"
import { record } from "../decode/primitives.js"
import { presenceInput, type FrozenPresence } from "../presence.js"
import { IdentifyFlag, maxIgnoredEvents } from "../protocol/gateway.js"
import { automaticNeeds, cacheNeeds, protectedDispatchTypes, type FilterCacheKind } from "./event-dispatches.js"

/**
 * Most UTF-8 bytes the encoded ignored_events array may take. Fluxer closes a client message above 4,096 bytes, and
 * the rest of Identify (token, properties, shard and the largest presence) stays within the remaining 1,536 bytes
 */
const maxIgnoredEventsBytes = 2_560

/** Validated gateway settings */
export interface GatewayConfiguration {
    readonly onMalformedDispatch: "skip" | "terminate"
    /** Explicit upper-case deduplicated names, or auto for per-Identify derivation */
    readonly ignoredEvents: readonly string[] | "auto"
    /** Identify flags bitfield, zero when none is set */
    readonly flags: number
    /** Initial presence intent, seeded into the presence owner */
    readonly presence: FrozenPresence | undefined
    /** Dispatch types automatic filtering keeps for the enabled cache categories and SDK owners */
    readonly automaticNeeds: ReadonlySet<string>
}

const dispatchName = /^[A-Za-z0-9_]{1,64}$/

/** Validate and copy the gateway option against the enabled cache categories */
export function gatewayConfiguration(
    value: unknown,
    cacheKinds: readonly FilterCacheKind[],
): GatewayConfiguration | ConfigurationError {
    const allowed = ["onMalformedDispatch", "ignoredEvents", "flags", "presence"]
    if (value !== undefined && !record(value))
        return new ConfigurationError("gateway", "Gateway settings must be an object")
    const unsupported = value === undefined ? undefined : Object.keys(value).find((key) => !allowed.includes(key))
    if (unsupported !== undefined)
        return new ConfigurationError("gateway", `Unsupported gateway setting ${JSON.stringify(unsupported)}`, {
            hint: unsupportedKeyHint(unsupported, allowed, "settings"),
        })
    const settings = value ?? {}
    const onMalformedDispatch = settings.onMalformedDispatch ?? "skip"
    if (onMalformedDispatch !== "skip" && onMalformedDispatch !== "terminate")
        return new ConfigurationError(
            "onMalformedDispatch",
            'The option "gateway.onMalformedDispatch" must be "skip" or "terminate"',
        )
    const ignoredEvents = ignoredList(settings.ignoredEvents, cacheKinds)
    if (ignoredEvents instanceof ConfigurationError) return ignoredEvents
    const flags = flagBits(settings.flags)
    if (flags instanceof ConfigurationError) return flags
    let presence: FrozenPresence | undefined
    const presenceSetting = settings.presence
    if (presenceSetting !== undefined) {
        const checked = presenceInput(presenceSetting)
        if (checked instanceof InputValidationFailure)
            return settingError("presence", `The option "gateway.presence" is invalid: ${checked.detail.explanation}`, {
                hint: 'Pass a PresenceInput such as { status: "online" }',
            })
        presence = checked
    }
    return Object.freeze({
        onMalformedDispatch,
        ignoredEvents,
        flags,
        presence,
        automaticNeeds: automaticNeeds(cacheKinds),
    })
}

function ignoredList(
    value: unknown,
    cacheKinds: readonly FilterCacheKind[],
): readonly string[] | "auto" | ConfigurationError {
    if (value === undefined) return Object.freeze([])
    if (value === "auto") return "auto"
    if (!Array.isArray(value))
        return settingError(
            "ignoredEvents",
            'The option "gateway.ignoredEvents" must be "auto" or an array of dispatch names',
        )
    if (value.length > maxIgnoredEvents)
        return settingError("ignoredEvents", 'The option "gateway.ignoredEvents" can list at most 256 dispatch names')
    const names = new Set<string>()
    for (const name of Array.from(value)) {
        if (typeof name !== "string" || !dispatchName.test(name))
            return settingError(
                "ignoredEvents",
                'The option "gateway.ignoredEvents" must list dispatch names of 1 to 64 letters, digits and underscores, such as TYPING_START',
            )
        names.add(name.toUpperCase())
    }
    const needed = cacheNeeds(cacheKinds)
    for (const name of names) {
        if (protectedDispatchTypes.has(name))
            return settingError(
                "ignoredEvents",
                `The SDK needs ${name} dispatches to run the connection or to answer its own gateway requests, so gateway.ignoredEvents cannot include ${name}`,
                {
                    hint: `Remove ${name} from gateway.ignoredEvents`,
                },
            )
        if (needed.has(name))
            return settingError(
                "ignoredEvents",
                `${name} dispatches keep enabled caches current (${cacheKinds
                    .filter((kind) => cacheNeeds([kind]).has(name))
                    .map((kind) => `cache.${kind}`)
                    .join(", ")}), so gateway.ignoredEvents cannot include ${name}`,
                {
                    hint: `Remove ${name} from gateway.ignoredEvents, or turn off the cache that uses it in the cache option`,
                },
            )
    }
    const list = Object.freeze([...names])
    if (Buffer.byteLength(JSON.stringify(list)) > maxIgnoredEventsBytes)
        return settingError(
            "ignoredEvents",
            `The option "gateway.ignoredEvents" must encode to at most 2,560 bytes of JSON, so the session start message fits Fluxer's 4,096-byte limit`,
        )
    return list
}

function flagBits(value: unknown): number | ConfigurationError {
    if (value === undefined) return 0
    if (!record(value) || Object.keys(value).some((key) => key !== "debounceMessageReactions"))
        return settingError(
            "flags",
            'The option "gateway.flags" must contain only the boolean debounceMessageReactions',
        )
    const debounce = value.debounceMessageReactions
    if (debounce !== undefined && typeof debounce !== "boolean")
        return settingError("flags", 'The option "gateway.flags.debounceMessageReactions" must be true or false')
    return debounce === true ? IdentifyFlag.debounceMessageReactions : 0
}
