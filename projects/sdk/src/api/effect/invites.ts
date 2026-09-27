import type { Invite, InviteCreate, InviteMetadata } from "#sdk/invites"
import type * as Effect from "effect/Effect"
import type { GuildOperationFailure, GuildOperationOptions, ModerationOptions } from "#sdk/guilds"

/** Inspect, create, list or revoke invite codes without joining their destinations.
 * Methods return Effects and do not connect the gateway or cache invites.
 * Reads retry eligible transient failures at most twice. Writes retry only confirmed 429 rejections.
 * Fluxer checks destination visibility, invite permissions and capacity. Failures use GuildOperationError.
 * Effects start when executed. Interruption waits for owned cleanup and defects remain in Cause.
 * Closing clients fail with ClientClosedError. Lost responses can leave mutations applied. Do not replay them blindly
 *
 * @category Invites and webhooks
 */
export interface Invites {
    /**
     * Look up an invite code without using it or joining its destination.
     * Pass the code, not its full URL.
     * Expired, revoked or inaccessible codes fail remotely.
     * Fluxer may normalize the case of a vanity code
     */
    fetch(code: string, options?: GuildOperationOptions): Effect.Effect<Invite, GuildOperationFailure>
    /**
     * Create an invite for an accessible channel, including an existing group direct message.
     * Defaults are a new code, 86,400 seconds, unlimited uses and non-temporary membership.
     * The result is invite metadata.
     * The SDK does not send the code, create a group or add members.
     * Cancellation cannot revoke an invite that was already created.
     * After an unknown outcome, list the destination's invites before deciding whether to create again
     */
    create(
        channelId: string,
        input?: InviteCreate,
        options?: ModerationOptions,
    ): Effect.Effect<InviteMetadata, GuildOperationFailure>
    /**
     * List a channel's management-visible invites in Fluxer's order.
     * Channel permissions determine access.
     * Concurrent changes can make the list stale, so it is not a stable snapshot
     */
    fetchForChannel(
        channelId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly InviteMetadata[], GuildOperationFailure>
    /**
     * List a community's management-visible invites with ManageGuild permission.
     * The community's vanity invite is excluded
     */
    fetchForGuild(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly InviteMetadata[], GuildOperationFailure>
    /**
     * Revoke an invite code, succeeding with no value after HTTP 204.
     * Fluxer checks creator or management permissions.
     * Existing members remain.
     * A missing code is an error, not proof a previous delete succeeded
     */
    delete(code: string, options?: ModerationOptions): Effect.Effect<void, GuildOperationFailure>
}
