import { FluxerlyError, operationDetails } from "./errors.js"
import { operationErrorMessage, operationFailureHint } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** The bot's visible status while connected, with dnd meaning do not disturb.
 * Use invisible to hide online status, not to disconnect the client.
 * The status offline is excluded because Fluxer normalizes it to invisible on a connected session
 *
 * @category Client and lifecycle
 */
export type PresenceStatus = "online" | "idle" | "dnd" | "invisible"

/**
 * One custom-status emoji. The variants cannot be combined
 *
 * @category Client and lifecycle
 */
export type CustomStatusEmoji =
    | {
          /** Decimal ID of an existing custom emoji. Fluxer checks availability for the bot's account */
          readonly id: string
      }
    | {
          /** One Unicode emoji. Fluxer validates that it is a supported single emoji */
          readonly name: string
      }

/** Text, emoji and optional expiration for the bot's custom status.
 * Fluxer makes the final checks for emoji availability, Unicode emoji semantics and whether expiration is still in the future
 *
 * @category Client and lifecycle
 */
export interface CustomStatusInput {
    /** Status text, from 1 through 128 UTF-16 code units */
    readonly text?: string
    /** An explicit custom-emoji ID or one Unicode emoji */
    readonly emoji?: CustomStatusEmoji
    /** Future ISO-8601 expiration time. Impossible calendar dates are rejected before retaining the update.
     * Fluxer rejects an expiry that passes before it receives the update
     */
    readonly expiresAt?: string
}

/**
 * Set the status this bot should publish on its gateway connections.
 * Use `customStatus: null` to request clearing the custom status.
 * Omission preserves this client's latest custom-status request, or leaves the provider value unchanged if there is no retained request.
 * The client copies the latest accepted settings and replaces earlier updates that have not been sent.
 * It publishes those settings on ready local shards and restores them after READY or RESUMED.
 * A successful call means the client accepted the settings. It does not mean every shard published them at once or that another user can see them.
 * Shutdown clears the saved settings and pending local timers
 *
 * @category Client and lifecycle
 */
export interface PresenceInput {
    /** Visible status to publish on the bot's live gateway connections */
    readonly status: PresenceStatus
    /** New custom status, null to clear it, or omission to retain the latest custom-status request made by this client */
    readonly customStatus?: CustomStatusInput | null
}

/** The SDK rejected a status update or member-presence selection before changing its saved settings.
 * The reason input includes invalid values or a community assigned to a shard this client does not own.
 * The reason limit means the member selection exceeds a local count or encoded-byte budget
 *
 * @category Errors
 */
export class PresenceError extends FluxerlyError {
    /** Error tag for identifying PresenceError in a Result */
    readonly _tag = "PresenceError"
    /** SDK-owned local input detail, or null for local limits and non-input failures */
    readonly inputValidation: InputValidationDetail | null
    /** Whether local validation failed or the selected members exceeded a local budget */
    readonly reason: "input" | "limit"

    /** Describe a rejected presence change. Construction changes no saved presence settings */
    constructor(options: {
        /** Whether local validation failed or the selected members exceeded a local budget */
        readonly reason: PresenceError["reason"]
        /** Safe local input detail. It never retains rejected values, credentials, or Fluxer data, and names an unsupported key only when it looks like a field name. Defaults to null */
        readonly inputValidation?: InputValidationDetail | null | undefined
        /** Underlying failure retained as the error's cause */
        readonly cause?: unknown
    }) {
        const { reason, inputValidation = null } = options
        super(
            operationErrorMessage({
                subject: "Presence",
                operation: "update",
                reason,
                outcome: "notDispatched",
                inputExplanation:
                    inputValidation?.explanation ??
                    (reason === "limit"
                        ? "The member selection is too large. The limits are 1,000 members per community, 10,000 members across at most 100 communities, and 4,096 bytes per gateway request"
                        : null),
            }),
            {
                code: `presence.${reason}`,
                hint:
                    reason === "limit"
                        ? "Select fewer members, or clear the selection of communities that no longer need member presences"
                        : operationFailureHint({
                              reason,
                              outcome: "notDispatched",
                              inputPath: inputValidation?.path ?? null,
                          }),
                cause: options.cause,
                details: operationDetails({ reason }),
            },
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
        this.reason = reason
    }
}

/**
 * Expected presence-operation failure. Client closure remains distinct from local input rejection
 *
 * @category Errors
 */
export type PresenceFailure = PresenceError | import("./errors.js").ClientClosedError
