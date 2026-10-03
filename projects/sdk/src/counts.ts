import { FluxerlyError, operationDetails } from "./errors.js"
import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage, operationFailureHint } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** The guild or channel count request named in an error.
 * One call can send commands to several local shards but occupies one shared request slot and does not cache counts
 *
 * @category Errors
 */
export type CountOperation = "guilds.fetchCounts" | "channels.fetchMemberCounts"

/**
 * Member totals returned for one requested community by Fluxer's gateway.
 * This frozen result is not cached and can become outdated immediately.
 * Fluxer includes only visible members in onlineCount, so it does not count every online account
 *
 * @category Guilds and members
 */
export interface GuildCount {
    /** Requested guild ID as a positive decimal string with no leading zeroes, no greater than 9223372036854775807 */
    readonly guildId: string
    /** Member count Fluxer reported for this community, never negative */
    readonly memberCount: number
    /** Visible online-member count Fluxer reported for this community, never negative */
    readonly onlineCount: number
}

/**
 * Results from one explicit request for several community counts, ordered to match the requested IDs.
 * The `omittedGuildIds` field lists requested IDs for which Fluxer returned no count.
 * Do not treat an omission as zero or infer missing membership, denied access or a provider failure.
 * A community assigned to an unowned or unready shard fails the call with notConnected instead
 *
 * @category Guilds and members
 */
export interface GuildCountsResult {
    /** Frozen count entries in the caller's requested guild-ID order */
    readonly counts: readonly GuildCount[]
    /** Frozen requested guild IDs without a returned entry, in caller input order */
    readonly omittedGuildIds: readonly string[]
}

/** Visible member totals for one requested channel, with the guild ID supplied by the gateway response.
 * Counts concern this channel's visibility, not the full community membership
 *
 * @category Channels
 */
export interface ChannelMemberCount extends GuildCount {
    /** Requested channel ID as a positive decimal string with no leading zeroes, no greater than 9223372036854775807 */
    readonly channelId: string
    /** Nonnegative visible members Fluxer reported for this channel, not the community total */
    readonly memberCount: number
    /** Nonnegative visible online members Fluxer reported for this channel, not the community total */
    readonly onlineCount: number
}

/**
 * Results from one community's requested channel counts, ordered to match the requested channel IDs.
 * The `omittedChannelIds` field lists requested IDs for which Fluxer returned no count. The SDK does not substitute zero or infer why.
 * A community assigned to an unowned or unready shard fails the call with notConnected instead
 *
 * @category Channels
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
 *
 * @category Options
 */
export interface CountOperationOptions {
    /** Total reply deadline in milliseconds, integer 1–2,147,483,647, default 30,000.
     * Includes local registration and gateway waiting
     */
    readonly timeoutMs?: number
}

/**
 * Fresh-count settings for the default API, with the same deadline plus cancellation of this local wait only
 *
 * @category Options
 */
export interface DefaultCountOperationOptions extends CountOperationOptions, OperationOptions {}

/**
 * A fresh gateway-count call could not return its complete result.
 * A failure releases this call's local wait and request slot and withdraws its unsent commands without retrying or caching partial counts.
 * It does not cancel provider work already dispatched or establish whether that work continued.
 * Error metadata includes no credential, requested IDs, correlation nonce or provider body
 *
 * @category Errors
 */
export class CountOperationError extends FluxerlyError {
    /** Fixed name that identifies this error type */
    readonly _tag = "CountOperationError"
    /** SDK-owned local input detail, or null for non-input failures */
    readonly inputValidation: InputValidationDetail | null
    /** Requested count operation */
    readonly operation: CountOperation
    /** Failure category.
     * The reason input means local validation failed, and notConnected means a routed shard is absent or not ready.
     * The reason busy means shared request capacity or a shard's internal command queue is full, and timeout means the reply deadline expired.
     * The reason connectionLost means a participating shard lost its connection, and response means a matched reply was malformed
     */
    readonly reason: "input" | "notConnected" | "busy" | "timeout" | "connectionLost" | "response"

    /** Describe a count failure. Construction sends no request and releases no request slot */
    constructor(options: {
        /** Requested count operation */
        readonly operation: CountOperation
        /** Failure category, as described on the reason field */
        readonly reason: CountOperationError["reason"]
        /** Safe local input detail. It never retains rejected values, credentials, or Fluxer data, and names an unsupported key only when it looks like a field name. Defaults to null */
        readonly inputValidation?: InputValidationDetail | null | undefined
        /** Underlying failure retained as the error's cause */
        readonly cause?: unknown
    }) {
        const { operation, reason, inputValidation = null } = options
        super(
            operationErrorMessage({
                subject: "Count",
                operation,
                reason,
                outcome: reason === "input" ? "notDispatched" : "unknown",
                inputExplanation: inputValidation?.explanation ?? null,
                facts: { read: true },
            }),
            {
                code: `count.${reason}`,
                hint: operationFailureHint({
                    reason,
                    outcome: reason === "input" ? "notDispatched" : "unknown",
                    read: true,
                    inputPath: inputValidation?.path ?? null,
                }),
                cause: options.cause,
                details: operationDetails({ operation, reason }),
            },
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
        this.operation = operation
        this.reason = reason
    }
}

/**
 * Expected fresh-count failure. Native interruption and cancellation in the default API remain separate from this union
 *
 * @category Errors
 */
export type CountOperationFailure = CountOperationError | ClientClosedError
