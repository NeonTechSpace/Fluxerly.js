import type { Invite, InviteCreate, InviteMetadata } from "#sdk/invites"
import type { ResultAsync } from "neverthrow"
import type { GuildOperationFailure, DefaultGuildOperationOptions, DefaultModerationOptions } from "#sdk/guilds"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Inspect, create, list and revoke invite codes with the bot's credentials.
 * No gateway connection or invite cache is needed.
 * Fluxer checks destination visibility, invite permissions and capacity.
 * Shared guild request limits and deadlines apply.
 * Eligible reads retry at most twice.
 * Writes retry only confirmed HTTP 429 rejections
 *
 * Expected failures return GuildOperationError or ClientClosedError.
 * Abort returns CancelledError after cleanup.
 * Unexpected failures reject with SdkDefect.
 * A lost write response can leave the invite change applied.
 * Check remote state before retrying
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
    fetch(
        code: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<Invite, GuildOperationFailure | CancelledError | ConfigurationError>
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
        options?: DefaultModerationOptions,
    ): ResultAsync<InviteMetadata, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * List a channel's management-visible invites in Fluxer's order.
     * Channel permissions determine access.
     * Concurrent changes can make the list stale, so it is not a stable snapshot
     */
    fetchForChannel(
        channelId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly InviteMetadata[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * List a community's management-visible invites with ManageGuild permission.
     * The community's vanity invite is excluded
     */
    fetchForGuild(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly InviteMetadata[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Revoke an invite code, succeeding with no value after HTTP 204.
     * Fluxer checks creator or management permissions.
     * Existing members remain.
     * A missing code is an error, not proof a previous delete succeeded
     */
    delete(
        code: string,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}
