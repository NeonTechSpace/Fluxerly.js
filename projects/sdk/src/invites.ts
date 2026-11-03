import type { User } from "./users.js"

/** Set how long an invite lasts, how many times it can be used and whether Fluxer may reuse an existing code.
 * Creating an invite does not join the recipient or create the destination. Omission requests a new code with
 * unlimited uses that expires after one day. Fluxer enforces destination access, invite permissions and capacity.
 * Two SDK defaults differ from Fluxer's own. When they are omitted, the SDK sends max_age 86400 and unique true, while
 * Fluxer by itself uses max_age 0, meaning no expiry, and unique false, which may return an existing invite. Pass
 * maxAgeSeconds 0 and unique false to get Fluxer's behavior
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
 *
 * @category Invites and webhooks
 */
export interface InviteCreate {
    /** Lifetime in seconds, integer 0–604800. Default 86400, where Fluxer's own default is 0. Zero requests no expiry.
     * Fluxer names it max_age
     */
    readonly maxAgeSeconds?: number
    /** Maximum uses, integer 0–100. Default zero means unlimited uses until expiry */
    readonly maxUses?: number
    /** Default true requests a new code, where Fluxer's own default is false. False permits Fluxer to reuse a matching
     * existing invite
     */
    readonly unique?: boolean
    /** Default false. True requests temporary community membership, which Fluxer can remove after disconnect */
    readonly temporary?: boolean
}

/** An invite link and the destination details Fluxer returned to this caller.
 * These returned details are frozen (read-only). Fetching them does not accept the invite or change membership, and the SDK does not keep them.
 * Codes can grant access to the destination and should only be shared with intended recipients.
 * The reported counts and expiry do not guarantee that someone can join later
 *
 * @category Invites and webhooks
 */
export interface Invite {
    /** Provider code, not a full URL. The SDK never includes it in errors or diagnostics */
    readonly code: string
    /** Invite URL built from the selected instance's discovered invite base and an encoded code, ready to share with
     * intended recipients.
     * Does not check expiry or joinability. Not a credential-safe value for diagnostics or public logs
     */
    readonly url: string
    /** Community invite or invitation to an existing group DM */
    readonly type: "guild" | "group"
    /** Minimal destination channel identity, not a full channel snapshot */
    readonly channel: {
        /** Decimal destination channel ID, not the invitation code */
        readonly id: string
        /** Destination channel name. Null means no name, omission means Fluxer did not supply it */
        readonly name?: string | null
        /** Numeric Fluxer channel type. This can describe a community channel or a private group conversation */
        readonly type: number
    }
    /** Present for community invites only. Not a full guild snapshot. Fluxer's banner, splash, image sizes and splash
     * alignment are not kept, because an invite filter or preview rarely needs them. Fluxer's visits_enabled is not kept
     * either, because it describes an experiment for the account that fetched the invite. The VISITS_ENABLED feature in
     * features shows whether the community allows visits
     */
    readonly guild?: {
        /** Decimal ID of the community this invitation leads to */
        readonly id: string
        /** Community name returned with this invitation */
        readonly name: string
        /** Icon asset hash, not an image URL. Null means no icon, omission means Fluxer did not supply it */
        readonly icon?: string | null
        /** Feature names, such as VERIFIED, including names this SDK version does not know. Omission means Fluxer did not supply them */
        readonly features?: readonly string[]
        /** Decimal IDs of the community's custom badges. Read their names and images with client.instance.fetchBadges */
        readonly badgeIds?: readonly string[]
    }
    /** Creator ID. Null means no creator, omission means unavailable */
    readonly inviterId?: string | null
    /** Public identity of the creator, absent when there is no creator or Fluxer's account data is incomplete */
    readonly inviter?: User
    /** Observed destination member count */
    readonly memberCount: number
    /** Observed presence count, available for community invites */
    readonly presenceCount?: number
    /** ISO 8601 expiry. Null means no expiry, omission means unavailable */
    readonly expiresAt?: string | null
    /** Whether Fluxer treats membership gained through this invite as temporary */
    readonly temporary: boolean
}

/** Invite details returned by creation and management lists, including creation time and use limits.
 * Use these observations to inspect or reconcile created codes, not to predict whether a future join succeeds.
 * The SDK does not cache invite codes or track later uses
 *
 * @category Invites and webhooks
 */
export interface InviteMetadata extends Invite {
    /** ISO 8601 creation time */
    readonly createdAt: string
    /** Observed uses, which may change immediately */
    readonly uses: number
    /** Zero means unlimited uses until expiry */
    readonly maxUses: number
    /** Configured lifetime in seconds. Zero means no expiry. Fluxer omits this for group invites.
     * Fluxer names it max_age
     */
    readonly maxAgeSeconds?: number
}
