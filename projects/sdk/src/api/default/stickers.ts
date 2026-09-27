import type {
    GuildSticker,
    ExpressionReference,
    ExpressionMetadata,
    ExpressionSourceGuild,
    StickerCreate,
    StickerEdit,
    ExpressionBatch,
    DefaultExpressionDeleteOptions,
} from "#sdk/expressions"
import type { ResultAsync } from "neverthrow"
import type { GuildOperationFailure, DefaultGuildOperationOptions, DefaultModerationOptions } from "#sdk/guilds"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Create, list, copy, edit and delete community stickers.
 * Use get for an optional local cache lookup, or fetchAll, fetchMetadata and fetchSource for remote reads.
 * Shared guild request limits, deadlines and read retries apply.
 * Writes retry only confirmed HTTP 429 rejections.
 * Input, permission, not-found and malformed-response errors are not retried.
 * A lost response can leave a write applied.
 * Results are frozen snapshots, not gateway acknowledgement
 *
 * Expected failures return GuildOperationError or ClientClosedError.
 * Abort returns CancelledError after cleanup.
 * Unexpected failures reject with SdkDefect
 *
 * @category Emoji and stickers
 */
export interface Stickers {
    /**
     * Replace a sticker's name, description and tags without changing its image or fetching it first.
     * A fetched sticker can be spread into input if its identity matches the target.
     * Unknown fields fail locally.
     * An empty or null description clears it, and [] clears tags.
     * The namespace's write, failure and cancellation rules apply
     */
    edit(
        target: ExpressionReference,
        input: StickerEdit,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildSticker, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Look up cached sticker metadata using decimal guildId and id, without an HTTP request.
     * The result is undefined when caching is disabled or the entry is absent, expired or invalidated by a conflicting change.
     * A hit becomes more recently used without extending expiry.
     * An invalid ID is misuse: The default API throws GuildOperationError with reason input and the native API dies with it.
     * A closing or closed client has no cache, so the result is undefined
     *
     * @remarks
     * Returns the value synchronously.
     * Unexpected failures throw SdkDefect
     */
    get(target: ExpressionReference): GuildSticker | undefined
    /**
     * Fetch a community's sticker list in Fluxer's order, without pagination.
     * The list can change after the response and is not an ongoing completeness guarantee.
     * An enabled metadata cache can retain results, but not image bytes or creator accounts
     */
    fetchAll(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildSticker[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch minimal sticker metadata by decimal ID, without requiring source-community membership.
     * This read does not populate the cache
     */
    fetchMetadata(
        id: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<ExpressionMetadata, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch the public presentation of the community that owns a custom sticker with this decimal ID: Its ID, name, icon hash and badges.
     * Fluxer answers when the source community is discoverable or the bot is a member of it.
     * A private source community the bot is not in, an unavailable community or an unknown sticker fails with GuildOperationError
     * whose apiError.code is unknownResource, without revealing which case applies.
     * This read does not populate the cache, and the result does not update when the community changes
     */
    fetchSource(
        id: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<ExpressionSourceGuild, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Upload one community sticker and return its metadata.
     * Inputs are copied when execution starts.
     * No image URL is fetched automatically.
     * Fluxer checks image format, dimensions, permissions and capacity.
     * A write with an unknown outcome is not replayed
     */
    create(
        guildId: string,
        input: StickerCreate,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildSticker, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Upload 1–50 community stickers in one batch and return separate successes and failures.
     * The input array is copied by index, then its entries are copied when execution starts.
     * Some uploads can succeed while others fail.
     * No rollback or automatic chunking is performed.
     * Failures named by duplicate sticker names cannot be matched reliably to input positions.
     * After an unknown outcome, fetch fresh remote data rather than blindly replaying the batch
     */
    createMany(
        guildId: string,
        input: readonly StickerCreate[],
        options?: DefaultModerationOptions,
    ): ResultAsync<ExpressionBatch<GuildSticker>, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Copy a sticker into a community by its source ID, using Fluxer's server-side copy.
     * Source metadata is preserved.
     * Fluxer enforces source copying restrictions
     */
    clone(
        guildId: string,
        sourceId: string,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildSticker, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove a sticker, succeeding with no value after HTTP 204.
     * Retained metadata is invalidated.
     * A missing target is an error, not proof of an earlier deletion.
     * The purge option defaults to false.
     * Setting it to true also queues irreversible media removal, subject to Fluxer's restrictions
     */
    delete(
        target: ExpressionReference,
        options?: DefaultExpressionDeleteOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}
