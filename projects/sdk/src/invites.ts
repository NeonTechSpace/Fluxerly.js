/** Set how long an invite lasts, how many times it can be used and whether Fluxer may reuse an existing code.
 * Creating an invite does not join the recipient or create the destination. Omission requests a new code with
 * unlimited uses that expires after one day. Fluxer enforces destination access, invite permissions and capacity
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export function inviteExample(client: Client, channelId: string) {
 *     return client.invites.create(channelId)
 * }
 * export function shareInviteExample(invite: import("@neontechspace/fluxerly").Invite) {
 *     return { content: invite.url }
 * }
 * ```
 */
export interface InviteCreate {
    /** Lifetime in seconds, integer 0–604800. Default 86400. Zero requests no expiry */
    readonly maxAgeSeconds?: number
    /** Maximum uses, integer 0–100. Default zero means unlimited uses until expiry */
    readonly maxUses?: number
    /** Default true requests a new code. False permits Fluxer to reuse a matching existing invite */
    readonly unique?: boolean
    /** Default false. True requests temporary guild membership, which Fluxer can remove after disconnect */
    readonly temporary?: boolean
}

/** An invite link and the destination details Fluxer returned to this caller.
 * These returned details are frozen (read-only). Fetching them does not accept the invite or change membership, and the SDK does not keep them.
 * Codes can grant access to the destination and should only be shared with intended recipients.
 * The reported counts and expiry do not guarantee that someone can join later
 */
export interface Invite {
    /** Provider code, not a full URL. The SDK never includes it in errors or diagnostics */
    readonly code: string
    /** Hosted Fluxer invite URL with an encoded code, ready to share with intended recipients.
     * Does not check expiry or joinability. Not a credential-safe value for diagnostics or public logs
     */
    readonly url: string
    /** Guild invite or invitation to an existing group DM */
    readonly type: "guild" | "group"
    /** Minimal destination channel identity, not a full channel snapshot */
    readonly channel: {
        /** Decimal destination channel ID, not the invitation code */
        readonly id: string
        /** Destination channel name. Null means no name, omission means Fluxer did not supply it */
        readonly name?: string | null
        /** Numeric Fluxer channel type. This can describe a guild channel or a private group conversation */
        readonly type: number
    }
    /** Present for guild invites only. Not a full guild snapshot */
    readonly guild?: {
        /** Decimal ID of the guild this invitation leads to */
        readonly id: string
        /** Guild name returned with this invitation */
        readonly name: string
    }
    /** Creator ID. Null means no creator, omission means unavailable */
    readonly inviterId?: string | null
    /** Observed destination member count */
    readonly memberCount: number
    /** Observed presence count, available for guild invites */
    readonly presenceCount?: number
    /** ISO 8601 expiry. Null means no expiry, omission means unavailable */
    readonly expiresAt?: string | null
    /** Whether Fluxer treats membership gained through this invite as temporary */
    readonly temporary: boolean
}

/** Invite details returned by creation and management lists, including creation time and use limits.
 * Use these observations to inspect or reconcile created codes, not to predict whether a future join succeeds.
 * The SDK does not cache invite codes or track later uses
 */
export interface InviteMetadata extends Invite {
    /** ISO 8601 creation time */
    readonly createdAt: string
    /** Observed uses, which may change immediately */
    readonly uses: number
    /** Zero means unlimited uses until expiry */
    readonly maxUses: number
    /** Configured lifetime in seconds. Zero means no expiry. Fluxer omits this for group invites */
    readonly maxAgeSeconds?: number
}
