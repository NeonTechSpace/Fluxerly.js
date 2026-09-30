import type { PresenceInput, PresenceFailure } from "#sdk/presence"
import type * as Effect from "effect/Effect"

/** Set the bot's status or select community members whose presence updates the bot should receive.
 * The client retains these requests in memory, not across process restarts.
 * Outgoing status updates send to every live locally owned shard and are spaced by at least four seconds per shard. Member selections are separate bounded gateway presence requests.
 * No provider acknowledgement or recipient-delivery guarantee is available. The SDK performs no remote membership lookup or self filtering. Fluxer owns access and filtering
 *
 * @category Client and lifecycle
 */
export interface Presence {
    /**
     * Set the bot's requested status and optional custom status, including before connecting.
     * The input is validated and frozen when the call runs.
     * Omitted customStatus keeps the previous request, and null clears it.
     * Expired custom statuses are not restored after reconnect.
     * Each shard retains at most one unsent status update, replacing it with the latest intent even while gateway pacing waits.
     * The four-second interval starts when an update reaches the socket, not when it is queued.
     * Success means the request was accepted locally and scheduled for each shard, not acknowledged by Fluxer.
     * Shutdown releases this intent and its timer
     *
     * @remarks
     * Unexpected defects remain in the Effect cause
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import { MemberMentionPreferences, type Client } from "@neontechspace/fluxerly/effect"
     * export const botProfileExample = (client: Client, guildId: string) => Effect.gen(function* () {
     *     yield* client.presence.set({ status: "online", customStatus: { text: "Ready", emoji: { name: "🌱" } } })
     *     return yield* client.members.editSelf(guildId, { nickname: "Support", mentionFlags: MemberMentionPreferences.PreferNoMention })
     * })
     * ```
     */
    set(input: PresenceInput): Effect.Effect<void, PresenceFailure>
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
     * Clearing an unsent selection withdraws its queued command and releases its slot immediately.
     * Changes to a selection that has not reached the socket replace that unsent request.
     * Clearing a selection already sent keeps one bounded session slot until fresh Identify or confirmed community leave, because a local socket write cannot confirm that Fluxer applied a clear
     *
     * After READY or RESUMED, the latest selection or clear is combined and sent at most once per 125 ms per shard.
     * This interval starts at actual socket transmission, and at most one member-selection command waits per shard.
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
     * Unexpected defects remain in the Effect cause
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const watchSelectedMember = (client: Client, guildId: string, memberId: string) => Effect.gen(function* () {
     *     const subscription = yield* client.on("presenceUpdate", (presence) =>
     *         Effect.sync(() => { if (presence.guildId === guildId && presence.userId === memberId) void presence.status }),
     *     )
     *     return yield* client.presence.setMembers(guildId, [memberId]).pipe(
     *         Effect.as(subscription),
     *         Effect.onError(() => subscription.close()),
     *     )
     * })
     * ```
     */
    setMembers(guildId: string, memberIds: readonly string[]): Effect.Effect<void, PresenceFailure>
}
