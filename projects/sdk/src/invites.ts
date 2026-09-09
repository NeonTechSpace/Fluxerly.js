/** Invite creation settings. Omission creates a separate code that expires after one day
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
    /** Lifetime in seconds, integer 0–604800; default 86400. Zero requests no expiry */
    readonly maxAgeSeconds?: number
    /** Maximum uses, integer 0–100; default zero means unlimited uses until expiry */
    readonly maxUses?: number
    /** Default true requests a new code. False permits Fluxer to reuse a matching existing invite */
    readonly unique?: boolean
    /** Default false. True requests temporary guild membership, which Fluxer can remove after disconnect */
    readonly temporary?: boolean
}

/** Frozen invite observation, without acceptance, membership changes or SDK retention.
 * Codes grant access to the destination and should only be shared with intended recipients.
 * Counts and expiry are observations, not a guarantee that a later join will succeed
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
        readonly id: string
        readonly name?: string | null
        readonly type: number
    }
    /** Present for guild invites only; not a full guild snapshot */
    readonly guild?: { readonly id: string; readonly name: string }
    /** Creator ID; null means no creator, omission means unavailable */
    readonly inviterId?: string | null
    /** Observed destination member count */
    readonly memberCount: number
    /** Observed presence count, available for guild invites */
    readonly presenceCount?: number
    /** ISO 8601 expiry; null means no expiry, omission means unavailable */
    readonly expiresAt?: string | null
    /** Whether Fluxer applies temporary membership semantics */
    readonly temporary: boolean
}

/** Management observation returned by create/list, without a client-owned cache */
export interface InviteMetadata extends Invite {
    /** ISO 8601 creation time */
    readonly createdAt: string
    /** Observed uses, which may change immediately */
    readonly uses: number
    /** Zero means unlimited uses until expiry */
    readonly maxUses: number
    /** Configured lifetime in seconds; zero means no expiry. Fluxer omits this for group invites */
    readonly maxAgeSeconds?: number
}
