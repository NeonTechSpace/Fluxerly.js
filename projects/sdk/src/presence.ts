import { operationErrorMessage } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** The bot's visible status while connected, with dnd meaning do not disturb.
 * Use invisible to hide online status, not to disconnect the client.
 * offline is excluded because Fluxer normalizes it to invisible on a connected session
 */
export type PresenceStatus = "online" | "idle" | "dnd" | "invisible"

/** One custom-status emoji. The variants cannot be combined */
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
 */
export interface PresenceInput {
    /** Visible status to publish on the bot's live gateway connections */
    readonly status: PresenceStatus
    /** New custom status, null to clear it, or omission to retain the latest custom-status request made by this client */
    readonly customStatus?: CustomStatusInput | null
}

/** The SDK rejected a status update or member-presence selection before changing its saved settings.
 * input includes invalid values or a guild assigned to a shard this client does not own.
 * limit means the member selection exceeds a local count or encoded-byte budget
 */
export class PresenceError extends Error {
    /** Error tag for identifying PresenceError in a Result */
    readonly _tag = "PresenceError"
    /** SDK-owned local input detail, or null for local limits and non-input failures */
    readonly inputValidation: InputValidationDetail | null

    constructor(
        /** Whether local validation failed or the selected members exceeded a local budget */
        readonly reason: "input" | "limit" = "input",
        /** Safe local input detail. It never retains rejected values, caller keys, credentials, or provider data */
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "Presence",
                "configure",
                reason,
                "notDispatched",
                null,
                null,
                inputValidation?.explanation ??
                    (reason === "limit" ? "Presence member selection exceeds a local limit" : null),
            ),
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

/** Expected presence-operation failure. Client closure remains distinct from local input rejection */
export type PresenceFailure = PresenceError | import("./errors.js").ClientClosedError
