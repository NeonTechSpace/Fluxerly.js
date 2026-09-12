import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** One fresh gateway count request. A logical request can fan out to local shard commands but holds one client-wide admission slot and no count cache */
export type CountOperation = "guilds.fetchCounts" | "channels.fetchMemberCounts"

/**
 * One frozen count observed through Fluxer's gateway. `onlineCount` is visibility-filtered by Fluxer and is not a
 * complete presence inventory
 */
export interface GuildCount {
    /** Requested canonical positive uint64 decimal guild ID */
    readonly guildId: string
    /** Nonnegative members Fluxer reported for this guild */
    readonly memberCount: number
    /** Nonnegative visible online members Fluxer reported for this guild */
    readonly onlineCount: number
}

/**
 * One fresh multi-guild gateway result. `omittedGuildIds` preserves requested IDs for which Fluxer sent no count.
 * Omission is not zero, absence, inaccessible membership, or a provider failure. An unowned or unready routed guild fails notConnected instead of appearing here
 */
export interface GuildCountsResult {
    /** Frozen count entries in the caller's requested guild-ID order */
    readonly counts: readonly GuildCount[]
    /** Frozen requested guild IDs without a returned entry, in caller input order */
    readonly omittedGuildIds: readonly string[]
}

/** One frozen channel visibility count returned with the gateway response's guild identity */
export interface ChannelMemberCount extends GuildCount {
    /** Requested canonical positive uint64 decimal channel ID */
    readonly channelId: string
    /** Nonnegative visible members Fluxer reported for this channel, not the guild total */
    readonly memberCount: number
    /** Nonnegative visible online members Fluxer reported for this channel, not the guild total */
    readonly onlineCount: number
}

/**
 * One fresh per-guild channel-member-count gateway result. `omittedChannelIds` preserves requested IDs for which Fluxer sent no count.
 * It never substitutes zero or infers why Fluxer omitted an entry. An unowned or unready routed guild fails notConnected instead
 */
export interface ChannelMemberCountsResult {
    /** Frozen count entries in the caller's requested channel-ID order */
    readonly counts: readonly ChannelMemberCount[]
    /** Frozen requested channel IDs without a returned entry, in caller input order */
    readonly omittedChannelIds: readonly string[]
}

/** Settings shared by fresh gateway-count requests. One deadline covers local registration, every routed shard command and all reply fragments */
export interface CountOperationOptions {
    /** Total reply deadline in milliseconds, including local registration and gateway wait; integer 1–2,147,483,647, default 30,000 */
    readonly timeoutMs?: number
}

/** Default fresh-count settings, with the same deadline plus cancellation of this local wait only */
export interface DefaultCountOperationOptions extends CountOperationOptions, OperationOptions {}

/**
 * Expected fresh-count failure with no credential, request IDs, or provider body. Cancellation is distinct, and a
 * dispatched request cannot cancel the provider's work or establish whether it continued after local release
 */
export class CountOperationError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "CountOperationError"
    /** SDK-owned local input detail, or null for non-input failures */
    readonly inputValidation: InputValidationDetail | null

    constructor(
        /** Requested count operation */
        readonly operation: CountOperation,
        /** Local validation, an absent or unready routed shard, client-wide capacity, deadline, gateway loss, or matched malformed reply */
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

/** Expected fresh-count failure. Native interruption and default cancellation remain separate from this union */
export type CountOperationFailure = CountOperationError | ClientClosedError
