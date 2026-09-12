import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage } from "./api-errors.js"
import type { PresenceUpdate } from "./events.js"
import type { GuildMember } from "./guilds.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** Select one guild's gateway member response explicitly, without changing REST member pages or subscriptions */
export type MemberChunkQuery = (
    | {
          /** Request Fluxer's full-list mode, capped by the provider at 100,000 members and subject to gateway rate limits */
          readonly all: true
          readonly userIds?: never
          readonly query?: never
          readonly limit?: never
      }
    | {
          /** Select 1–100 distinct canonical positive uint64 user IDs; missing IDs are omitted without an explanation */
          readonly userIds: readonly string[]
          readonly all?: never
          readonly query?: never
          readonly limit?: never
      }
    | {
          /** Case-insensitive display-name prefix. Empty selects an initial bounded list, not full-list mode */
          readonly query: string
          /** Maximum matching members, integer 1–100, default 25 */
          readonly limit?: number
          readonly all?: never
          readonly userIds?: never
      }
) & {
    /** Include available visible presences, default false. Missing presence is not proof of offline status */
    readonly presences?: boolean
}

/** One frozen provider batch, not an atomic guild snapshot or a cache update */
export interface MemberChunk {
    /** Canonical positive uint64 guild ID supplied to the request */
    readonly guildId: string
    /** Zero-based batch index, delivered in provider order without gaps or duplicate indices */
    readonly index: number
    /** Number of batches advertised for this response, from 1 through 100. It does not prove a complete guild roster */
    readonly count: number
    /** Up to 1,000 frozen member observations. An empty response is one batch with an empty array */
    readonly members: readonly GuildMember[]
    /** Present only when requested, including an empty array when Fluxer supplied no visible presences.
     * Contains only members in this batch, with the request's guild context. No live subscription is created
     */
    readonly presences?: readonly PresenceUpdate[]
    /** On the final batch of an explicit user-ID request, requested IDs without a returned member, in input order.
     * Omission does not distinguish missing membership, access restrictions or a provider-side failure
     */
    readonly omittedUserIds?: readonly string[]
}

/** Local gateway stream bounds, copied when consumption starts. A client allows one member stream across all locally owned shards */
export interface MemberChunkOptions {
    /** Total milliseconds from dispatch until the final batch arrives, integer 1–2,147,483,647, default 30,000.
     * Pausing consumption does not pause this deadline or the provider. No timeout applies after the full response arrives
     */
    readonly timeoutMs?: number
    /** Maximum accounted wire bytes of unread batches, a positive safe integer, default 4,194,304 (4 MiB).
     * Includes a single batch delivered directly to a waiting reader. Overflow fails rather than dropping batches.
     * This bounds accounted buffering, not total JavaScript heap, decoding overhead or caller-held batches
     */
    readonly maxPendingBytes?: number
}

/** Default stream options. Abort releases local intake even while consumption is paused, not remote provider work */
export interface DefaultMemberChunkOptions extends MemberChunkOptions, OperationOptions {}

/** Safe member-stream failure without request IDs, member data, nonces or upstream payloads */
export class MemberChunkError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "MemberChunkError"
    /** Public operation that failed */
    readonly operation = "members.iterateChunks"
    /** SDK-owned local input detail, or null for non-input failures */
    readonly inputValidation: InputValidationDetail | null

    constructor(
        /** Input, an absent or unready routed shard, client-wide admission, malformed sequence, buffer overflow, missing response, owning-shard gap or confirmed rate limit */
        readonly reason:
            "input" | "notConnected" | "busy" | "response" | "overflow" | "timeout" | "connectionLost" | "rateLimit",
        /** Confirmed provider retry delay in milliseconds for rateLimit, otherwise null. The SDK never retries automatically */
        readonly retryAfterMs: number | null = null,
        /** Safe local input detail. It never retains rejected values, caller keys, credentials, or provider data */
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "Member chunks",
                "iterate",
                reason,
                "unknown",
                null,
                null,
                inputValidation?.explanation ?? null,
                retryAfterMs,
            ),
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

/** Expected stream failure. Native interruption and default CancelledError remain separate */
export type MemberChunkFailure = MemberChunkError | ClientClosedError
