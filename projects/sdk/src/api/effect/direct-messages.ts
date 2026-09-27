import type {
    DirectMessageChannel,
    DirectMessageGroupEdit,
    DirectMessageLatestMessages,
    UserOperationFailure,
    UserOperationOptions,
} from "#sdk/users"
import type * as Effect from "effect/Effect"
import type { SendError } from "#sdk/message-errors"
import type { Message, MessageCore, ReplyInput, SendOptions } from "#sdk/messages"

/** Open private conversations, send messages or manage existing groups.
 * Methods return Effects with shared 30-second default deadlines and at most two eligible transient read retries.
 * Writes retry only confirmed rate-limit rejection, never an unknown outcome. No gateway connection is required.
 * Cancellation and unexpected faults remain in Cause rather than becoming UserOperationError
 *
 * @category Users and DMs
 */
export interface DirectMessages<M extends MessageCore = Message> {
    /**
     * Open or reopen a one-to-one conversation with a user, then send a message.
     * A plain string sends only that text, as shorthand for `{ content }`.
     * The whole operation uses one deadline, and mentions are disabled by default.
     * Message metadata and data bytes are prepared before opening the conversation.
     * File and stream sources are captured, not copied, and read later when uploads start, using messages.send's size, upload-budget and cleanup rules.
     * An inline multipart 429 does not replay file or stream sources.
     * MessageError with outcome notDispatched does not mean opening the conversation was undone.
     * A send with an unknown outcome is never repeated automatically.
     * Opening by user ID uses collection-wide direct-message cache conflict handling because the channel ID is not known yet.
     * Reply references are not accepted here.
     * Use messages.reply with an existing channel and message reference
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const notifyUserExample = (client: Client, userId: string) => Effect.gen(function* () {
     *     const user = yield* client.users.fetch(userId)
     *     return yield* client.directMessages.send(user.id, { content: `Hello ${user.displayName ?? user.username}` })
     * })
     * ```
     */
    send(userId: string, input: ReplyInput | string, options?: SendOptions): Effect.Effect<M, SendError>
    /**
     * Look up a private channel in the optional cache using its decimal ID, without a request.
     * A hit may be stale and becomes more recently used without extending its age.
     * A miss produces undefined.
     * An invalid ID is misuse: The default API throws UserOperationError with reason input and the native API dies with it.
     * A closing or closed client has no cache, so the result is undefined
     */
    get(id: string): Effect.Effect<DirectMessageChannel | undefined>
    /**
     * Open or reopen a one-to-one conversation with the selected user.
     * The result is a private channel, not proof a message can be delivered.
     * Privacy checks can still prevent sending after opening succeeds.
     * Because the channel ID is not known before the response, enabled direct-message cache conflict handling is collection-wide, so a later cache change can prevent the result from being stored
     */
    open(userId: string, options?: UserOperationOptions): Effect.Effect<DirectMessageChannel, UserOperationFailure>
    /**
     * Fetch a private channel by decimal ID.
     * A community-channel response is rejected as invalid.
     * An enabled cache admits this ID independently of unrelated targeted private-channel reads
     */
    fetch(id: string, options?: UserOperationOptions): Effect.Effect<DirectMessageChannel, UserOperationFailure>
    /**
     * Fetch this bot's currently open one-to-one and group conversations.
     * Personal notes are excluded.
     * The list is neither an atomic snapshot nor complete message history.
     * Enabled cache replacement is skipped when a later targeted request or channel observation conflicts
     */
    fetchAll(options?: UserOperationOptions): Effect.Effect<readonly DirectMessageChannel[], UserOperationFailure>
    /**
     * Fetch the latest messages for 1–100 selected, distinct private channel IDs through Fluxer's batch endpoint.
     * IDs are copied by index when execution starts.
     * This does not enumerate conversations or fill a cache.
     * A null message is ambiguous.
     * The omittedChannelIds field separately lists requested IDs that Fluxer did not return.
     * Do not treat omission as null, an empty channel or denied access.
     * The batch uses POST and is not retried after a dispatched failure with an unknown outcome, even though it reads data
     */
    fetchLatestMessages(
        channelIds: readonly string[],
        options?: UserOperationOptions,
    ): Effect.Effect<DirectMessageLatestMessages<M>, UserOperationFailure>
    /**
     * Change supplied settings of an existing group conversation.
     * A null name clears it, and omitted fields remain unchanged.
     * Fluxer enforces member and owner permissions.
     * A failed response does not guarantee rollback.
     * Enabled cache invalidation normally stays scoped to this conversation.
     * A cache-wide conflict check can also prevent older in-flight results from being stored
     */
    editGroup(
        id: string,
        input: DirectMessageGroupEdit,
        options?: UserOperationOptions,
    ): Effect.Effect<DirectMessageChannel, UserOperationFailure>
    /**
     * Close a one-to-one conversation for this bot, or leave a group conversation.
     * Another recipient's conversation is not erased.
     * If the group owner leaves, ownership may transfer.
     * Enabled cache invalidation normally stays scoped to this conversation.
     * A cache-wide conflict check can also prevent older in-flight results from being stored
     */
    close(id: string, options?: UserOperationOptions): Effect.Effect<void, UserOperationFailure>
    /**
     * Remove a group recipient as owner, or remove the bot itself.
     * This does not request deletion of that user's messages.
     * If the last recipient leaves, Fluxer deletes the group.
     * Enabled cache invalidation normally stays scoped to this conversation.
     * A cache-wide conflict check can also prevent older in-flight results from being stored
     */
    removeRecipient(
        id: string,
        userId: string,
        options?: UserOperationOptions,
    ): Effect.Effect<void, UserOperationFailure>
}
