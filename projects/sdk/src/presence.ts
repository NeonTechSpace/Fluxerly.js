/** A bot's visible session status. `offline` is intentionally excluded because Fluxer normalizes it to invisible while connected */
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

/** Optional custom status fields. Text is 1–128 UTF-16 code units, expiry is a future ISO-8601 timestamp, and Fluxer validates emoji availability and Unicode semantics */
export interface CustomStatusInput {
    /** Status text, from 1 through 128 UTF-16 code units */
    readonly text?: string
    /** An explicit custom-emoji ID or one Unicode emoji */
    readonly emoji?: CustomStatusEmoji
    /** Future ISO-8601 expiration time. Fluxer rejects an expiry that passes before it receives the update */
    readonly expiresAt?: string
}

/**
 * The latest desired bot presence. `customStatus: null` requests clearing the custom status, while omission preserves it at Fluxer.
 * Accepted input is retained only in this client process and is sent or restored after the next READY or RESUMED.
 * Local acceptance does not confirm that Fluxer accepted the update or that another user observed it
 */
export interface PresenceInput {
    /** The status to retain and publish */
    readonly status: PresenceStatus
    /** New custom status, null to clear it, or omission to retain the latest custom-status request made by this client */
    readonly customStatus?: CustomStatusInput | null
}

/** Locally invalid or over-budget presence request. It does not indicate whether Fluxer accepted a previously valid update */
export class PresenceError extends Error {
    /** Stable discriminant for default Result failures */
    readonly _tag = "PresenceError"

    constructor(
        /** The rejected operation phase, without retaining the input value */
        readonly reason: "input" | "limit" = "input",
    ) {
        super(reason === "limit" ? "Presence member selection exceeds a local limit" : "Presence input is invalid")
        this.name = this._tag
    }
}

/** Expected presence-operation failure. Client closure remains distinct from local input rejection */
export type PresenceFailure = PresenceError | import("./errors.js").ClientClosedError
