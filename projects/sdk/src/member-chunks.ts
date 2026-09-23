import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage } from "./api-errors.js"
import type { PresenceUpdate } from "./events.js"
import type { GuildMember } from "./guilds.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** Choose the members to request through one guild's gateway shard.
 * Supply exactly one of all, userIds or query, with an optional presences flag.
 * The SDK requests a response when the stream is consumed. It does not subscribe to future changes, fetch REST pages or keep a guild member list
 */
export type MemberChunkQuery = (
    | {
          /** Request Fluxer's full-list mode, capped by the provider at 100,000 members and subject to gateway rate limits */
          readonly all: true
          readonly userIds?: never
          readonly query?: never
          readonly limit?: never
      }
    | {
          /** Select 1–100 distinct user IDs as positive decimal strings with no leading zeroes, within the unsigned 64-bit range.
           * Missing IDs are omitted without an explanation
           */
          readonly userIds: readonly string[]
          readonly all?: never
          readonly query?: never
          readonly limit?: never
      }
    | {
          /** Case-insensitive display-name prefix, at most 4,096 UTF-16 code units and well-formed Unicode.
           * The complete encoded request must also fit the 4,096-byte gateway payload budget.
           * Empty selects an initial bounded list, not full-list mode
           */
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

/** One batch yielded by members.iterateChunks, with frozen member observations and optional visible presences.
 * Batches arrive in Fluxer's order. The SDK does not combine them into a single snapshot or store them in the member cache.
 * Already yielded batches remain available to your application if a later batch fails
 */
export interface MemberChunk {
    /** Requested guild ID as a positive decimal string with no leading zeroes, within the unsigned 64-bit range */
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

/** Set how long a member stream can run and how many unread bytes it can hold.
 * The SDK checks and copies these settings when consumption starts, not when the iterator or native Stream is created.
 * One client admits one member stream across its local shards, sharing four request slots with count calls.
 * Ending the stream early releases the SDK's local request slot but cannot stop work Fluxer has already started
 */
export interface MemberChunkOptions {
    /** Total milliseconds from dispatch until the final batch arrives, integer 1–2,147,483,647, default 30,000.
     * Pausing consumption does not pause this deadline or the provider. No timeout applies after the full response arrives
     */
    readonly timeoutMs?: number
    /** Maximum source-JSON bytes counted for unread batches, a positive safe integer, default 4,194,304 (4 MiB).
     * Includes a single batch delivered directly to a waiting reader. Overflow fails rather than dropping batches.
     * This bounds the SDK's batch byte accounting, not total JavaScript heap, decoding overhead or caller-held batches
     */
    readonly maxPendingBytes?: number
}

/** Stream options for the default API. Abort releases local intake even while consumption is paused, not remote provider work */
export interface DefaultMemberChunkOptions extends MemberChunkOptions, OperationOptions {}

/** A member stream stopped before it could return every batch.
 * The SDK releases local intake and does not automatically resend the request.
 * Already yielded batches are not undone, but unread batches are discarded when intake fails.
 * Metadata contains no requested IDs, member data, correlation nonce or provider payload
 */
export class MemberChunkError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "MemberChunkError"
    /** Public operation that failed */
    readonly operation = "members.iterateChunks"
    /** SDK-owned local input detail, or null for non-input failures */
    readonly inputValidation: InputValidationDetail | null

    constructor(
        /** input means invalid selection or settings, and notConnected means the guild's shard is absent or not ready.
         * busy means a member stream or shared request slot is already occupied.
         * response means malformed or out-of-order batches, and overflow means the unread byte budget was exceeded.
         * timeout means the complete response missed its deadline, and connectionLost means its shard lost the connection.
         * rateLimit means the provider confirmed a request rate limit
         */
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

/** Expected stream failure. Native interruption and CancelledError in the default API remain separate */
export type MemberChunkFailure = MemberChunkError | ClientClosedError
