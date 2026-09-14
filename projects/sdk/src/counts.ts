import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** The guild or channel count request named in an error.
 * One call can send commands to several local shards but occupies one shared request slot and does not cache counts
 */
export type CountOperation = "guilds.fetchCounts" | "channels.fetchMemberCounts"

/**
 * Member totals returned for one requested guild by Fluxer's gateway.
 * This frozen observation is not cached and can become outdated immediately.
 * Fluxer filters onlineCount by visibility, so it is not a complete account-presence inventory
 */
export interface GuildCount {
    /** Requested guild ID as a positive decimal string with no leading zeroes, within the unsigned 64-bit range */
    readonly guildId: string
    /** Member count Fluxer reported for this guild, never negative */
    readonly memberCount: number
    /** Visible online-member count Fluxer reported for this guild, never negative */
    readonly onlineCount: number
}

/**
 * Results from one explicit request for several guild counts, ordered to match your requested IDs.
 * omittedGuildIds lists requested IDs for which Fluxer returned no count.
 * Do not treat an omission as zero or infer missing membership, denied access or a provider failure.
 * A guild assigned to an unowned or unready shard fails the call with notConnected instead
 */
export interface GuildCountsResult {
    /** Frozen count entries in the caller's requested guild-ID order */
    readonly counts: readonly GuildCount[]
    /** Frozen requested guild IDs without a returned entry, in caller input order */
    readonly omittedGuildIds: readonly string[]
}

/** Visible member totals for one requested channel, with the guild ID supplied by the gateway response.
 * Counts concern this channel's visibility, not the full guild membership
 */
export interface ChannelMemberCount extends GuildCount {
    /** Requested channel ID as a positive decimal string with no leading zeroes, within the unsigned 64-bit range */
    readonly channelId: string
    /** Nonnegative visible members Fluxer reported for this channel, not the guild total */
    readonly memberCount: number
    /** Nonnegative visible online members Fluxer reported for this channel, not the guild total */
    readonly onlineCount: number
}

/**
 * Results from one guild's requested channel counts, ordered to match your requested channel IDs.
 * omittedChannelIds lists requested IDs for which Fluxer returned no count, without substituting zero or inferring why.
 * A guild assigned to an unowned or unready shard fails the call with notConnected instead
 */
export interface ChannelMemberCountsResult {
    /** Frozen count entries in the caller's requested channel-ID order */
    readonly counts: readonly ChannelMemberCount[]
    /** Frozen requested channel IDs without a returned entry, in caller input order */
    readonly omittedChannelIds: readonly string[]
}

/** Set how long one fresh gateway-count call can wait for its complete response.
 * One deadline covers local registration, every routed shard command and all reply fragments.
 * These calls require ready routed shards and do not fetch counts over REST as a fallback
 */
export interface CountOperationOptions {
    /** Total reply deadline in milliseconds, integer 1–2,147,483,647, default 30,000.
     * Includes local registration and gateway waiting
     */
    readonly timeoutMs?: number
}

/** Fresh-count settings for the default API, with the same deadline plus cancellation of this local wait only */
export interface DefaultCountOperationOptions extends CountOperationOptions, OperationOptions {}

/**
 * A fresh gateway-count call could not return its complete result.
 * A failure releases this call's local wait and request slot without retrying or caching partial counts.
 * It does not cancel provider work already dispatched or establish whether that work continued.
 * Error metadata includes no credential, requested IDs, correlation nonce or provider body
 */
export class CountOperationError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "CountOperationError"
    /** SDK-owned local input detail, or null for non-input failures */
    readonly inputValidation: InputValidationDetail | null

    constructor(
        /** Requested count operation */
        readonly operation: CountOperation,
        /** input means local validation failed, and notConnected means a routed shard is absent or not ready.
         * busy means shared request capacity is full, and timeout means the reply deadline expired.
         * connectionLost means a participating shard lost its connection, and response means a matched reply was malformed
         */
        readonly reason: "input" | "notConnected" | "busy" | "timeout" | "connectionLost" | "response",
        /** Safe local input detail. It never retains rejected values, caller keys, credentials, or provider data */
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "Count",
                operation,
                reason,
                "unknown",
                null,
                null,
                inputValidation?.explanation ?? null,
            ),
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

/** Expected fresh-count failure. Native interruption and cancellation in the default API remain separate from this union */
export type CountOperationFailure = CountOperationError | ClientClosedError
