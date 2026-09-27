import type { PresenceInput, PresenceFailure } from "#sdk/presence"
import type { Result } from "neverthrow"

/**
 * Set the bot's displayed status or request updates for selected community members.
 * Outgoing status is sent to live shards assigned to this client, at least four seconds apart per shard.
 * Member selections use separate bounded gateway requests.
 * Neither operation has a provider acknowledgement or recipient-delivery guarantee.
 * The SDK does not fetch membership or filter out self.
 * Fluxer decides access and which updates are visible
 *
 * @category Client and lifecycle
 */
export interface Presence {
    /**
     * Set the bot's requested status and optional custom status, including before connecting.
     * The input is validated and frozen when the call runs.
     * Omitted customStatus keeps the previous request, and null clears it.
     * Expired custom statuses are not restored after reconnect.
     * Success means the request was accepted locally and scheduled for each shard, not acknowledged by Fluxer.
     * Shutdown releases this intent and its timer
     *
     * @remarks
     * Returns a Result synchronously.
     * A throwing input getter throws SdkDefect with code application.defect and the thrown value as its cause, and other
     * unexpected failures throw SdkDefect with code sdk.defect
     *
     * @example
     * ```ts
     * import { MemberMentionPreferences, type Client } from "@neontechspace/fluxerly"
     * export async function botProfileExample(client: Client, guildId: string) {
     *     const presence = client.presence.set({ status: "online", customStatus: { text: "Ready", emoji: { name: "🌱" } } })
     *     if (presence.isErr()) return presence
     *     return client.members.editSelf(guildId, { nickname: "Support", mentionFlags: MemberMentionPreferences.PreferNoMention })
     * }
     * ```
     */
    set(input: PresenceInput): Result<void, PresenceFailure>
    /**
     * Request presence updates for selected members in one community.
     * Register a presenceUpdate listener, then pass accessible non-self member IDs.
     * Pass [] to clear the selection.
     * Closing the listener does not clear it.
     * No full-member subscription, member lookup or presence cache is created, and Fluxer remains authoritative for access and filtering.
     * The community must belong to a shard assigned to this client, or the call fails with PresenceError reason input
     *
     * Inputs are copied and retained when the call runs.
     * Up to 1,000 distinct decimal IDs are accepted, but the full UTF-8 gateway frame must fit 4,096 bytes.
     * Long IDs therefore reduce the effective per-community maximum.
     * The client retains selections for at most 100 communities and 10,000 IDs.
     * Clearing an unsent selection releases its slot immediately.
     * Clearing a selection already sent keeps one bounded session slot until fresh Identify or confirmed community leave, because a local socket write cannot confirm that Fluxer applied a clear
     *
     * After READY or RESUMED, the latest selection or clear is combined and attempted at most once per 125 ms.
     * Sending the same list again deliberately requests a refresh.
     * A matching guild creation also retries the latest selection or a previously sent clear.
     * None of these attempts guarantees an event or proves provider acceptance.
     * Initial state and transitions can be missed during recovery.
     * Loss of shared channel visibility can remove the provider subscription, so resend the selection after access returns.
     * Clear explicitly or shut down the client to release local intent.
     * Input or limit failures fail with PresenceError, and closing clients fail with ClientClosedError.
     * The member IDs are copied once, and that copy is validated and subscribed
     *
     * @remarks
     * Returns a Result synchronously.
     * A throwing ID getter throws SdkDefect with code application.defect and the thrown value as its cause, and other
     * unexpected failures throw SdkDefect with code sdk.defect
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function watchSelectedMember(client: Client, guildId: string, memberId: string) {
     *     const subscription = client.on("presenceUpdate", (presence) => {
     *         if (presence.guildId === guildId && presence.userId === memberId) void presence.status
     *     })
     *     const selected = client.presence.setMembers(guildId, [memberId])
     *     if (selected.isErr()) subscription.close()
     *     return selected.map(() => subscription)
     * }
     * ```
     */
    setMembers(guildId: string, memberIds: readonly string[]): Result<void, PresenceFailure>
}
