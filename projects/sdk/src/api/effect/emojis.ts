import type {
    GuildEmoji,
    ExpressionReference,
    ExpressionMetadata,
    ExpressionSourceGuild,
    EmojiCreate,
    EmojiEdit,
    ExpressionBatch,
    ExpressionDeleteOptions,
} from "#sdk/expressions"
import type * as Effect from "effect/Effect"
import type { GuildOperationFailure, GuildOperationOptions, ModerationOptions } from "#sdk/guilds"

/** Read, upload, rename, clone or delete custom emoji.
 * Methods return Effects and share guild HTTP concurrency limits, deadlines and GuildOperationError failures.
 * Reads retry eligible transient failures at most twice. Writes retry only confirmed 429 rejections.
 * Input, permission, 404 and malformed responses do not retry. Unknown outcomes may leave writes applied.
 * Effects start when executed, use the caller's services and await cleanup on interruption. Defects remain in Cause.
 * Closing clients fail with ClientClosedError. Snapshots are frozen and HTTP success is not gateway acknowledgement
 *
 * @category Emoji and stickers
 */
export interface Emojis {
    /**
     * Look up cached emoji metadata using decimal guildId and id, without an HTTP request.
     * The result is undefined when caching is disabled or the entry is absent, expired or invalidated by a conflicting change.
     * A hit becomes more recently used without extending expiry.
     * An invalid ID is misuse: The default API throws GuildOperationError with reason input and the native API dies with it.
     * A closing or closed client has no cache, so the result is undefined
     */
    get(target: ExpressionReference): Effect.Effect<GuildEmoji | undefined>
    /**
     * Fetch a community's emoji list in Fluxer's order, without pagination.
     * The list can change after the response and is not an ongoing completeness guarantee.
     * An enabled metadata cache can retain results, but not image bytes or creator accounts
     */
    fetchAll(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildEmoji[], GuildOperationFailure>
    /**
     * Fetch minimal emoji metadata by decimal ID, without requiring source-community membership.
     * This read does not populate the cache
     */
    fetchMetadata(id: string, options?: GuildOperationOptions): Effect.Effect<ExpressionMetadata, GuildOperationFailure>
    /**
     * Fetch the public presentation of the community that owns a custom emoji with this decimal ID: Its ID, name, icon hash and badges.
     * Fluxer answers when the source community is discoverable or the bot is a member of it.
     * A private source community the bot is not in, an unavailable community or an unknown emoji fails with GuildOperationError
     * whose apiError.code is unknownResource, without revealing which case applies.
     * This read does not populate the cache, and the result does not update when the community changes
     */
    fetchSource(
        id: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<ExpressionSourceGuild, GuildOperationFailure>
    /**
     * Upload one community emoji and return its metadata.
     * Inputs are copied when execution starts.
     * No image URL is fetched automatically.
     * Fluxer checks image format, dimensions, permissions and capacity.
     * A write with an unknown outcome is not replayed
     */
    create(
        guildId: string,
        input: EmojiCreate,
        options?: ModerationOptions,
    ): Effect.Effect<GuildEmoji, GuildOperationFailure>
    /**
     * Upload 1–50 community emojis in one batch and return separate successes and failures.
     * The input array is copied by index, then its entries are copied when execution starts.
     * Some uploads can succeed while others fail.
     * No rollback or automatic chunking is performed.
     * Failures named by duplicate emoji names cannot be matched reliably to input positions.
     * After an unknown outcome, fetch fresh remote data rather than blindly replaying the batch
     */
    createMany(
        guildId: string,
        input: readonly EmojiCreate[],
        options?: ModerationOptions,
    ): Effect.Effect<ExpressionBatch<GuildEmoji>, GuildOperationFailure>
    /**
     * Copy an emoji into a community by its source ID, using Fluxer's server-side copy.
     * Source metadata is preserved.
     * Fluxer enforces source copying restrictions
     */
    clone(
        guildId: string,
        sourceId: string,
        options?: ModerationOptions,
    ): Effect.Effect<GuildEmoji, GuildOperationFailure>
    /**
     * Rename a community emoji without changing its image or fetching its old metadata first
     */
    edit(
        target: ExpressionReference,
        input: EmojiEdit,
        options?: ModerationOptions,
    ): Effect.Effect<GuildEmoji, GuildOperationFailure>
    /**
     * Remove an emoji, succeeding with no value after HTTP 204.
     * Retained metadata is invalidated.
     * A missing target is an error, not proof of an earlier deletion.
     * The purge option defaults to false.
     * Setting it to true also queues irreversible media removal, subject to Fluxer's restrictions
     */
    delete(target: ExpressionReference, options?: ExpressionDeleteOptions): Effect.Effect<void, GuildOperationFailure>
}
