import type { OperationOptions } from "#sdk/client"
import type { PageTurners } from "#sdk/reaction-pages"
import type { MessageCleanupProgress } from "#sdk/message-cleanup"

/** Settings for one remote operation: Its deadline and an optional AbortSignal.
 * Methods document what their deadline and cancellation cover beyond these rules
 *
 * @category Options
 */
export interface RequestOptions extends OperationOptions {
    /** Total milliseconds for this call, an integer from 1 through 2,147,483,647.
     * For a bot client's REST calls it covers local queueing, rate-limit waits, retries and HTTP, and defaults to the
     * client's rest.defaultTimeoutMs, 30,000 unless configured. Calls outside a bot client's REST settings, such as
     * standalone webhook clients, OAuth, instance discovery and gateway counts, default to 30,000.
     * Owned cleanup is awaited afterward, so the call can finish later than this deadline
     */
    readonly timeoutMs?: number
}

/** Settings for a remote mutation that Fluxer can record in the community audit log: Its deadline, an optional
 * AbortSignal and an optional reason. Aborting cannot roll back a mutation Fluxer already received
 *
 * @category Options
 */
export interface AuditedRequestOptions extends RequestOptions {
    /** Optional audit-log reason, 1–512 printable ASCII characters after trimming.
     * Sent only as the raw X-Audit-Log-Reason header, without URL escaping, because Fluxer does not decode escapes.
     * Non-ASCII and control characters fail before dispatch. Omission sends no header. Never included in SDK errors or diagnostics.
     * Header delivery does not guarantee that Fluxer stores the reason in an audit entry. Methods name the known paths that do not
     */
    readonly auditReason?: string
}

/** Set how long a member stream can run and how many unread bytes it can hold.
 * The SDK checks and copies these settings when consumption starts, not when the iterator or native Stream is created.
 * One client admits one member stream across its local shards, sharing four request slots with count calls.
 * It sends at most 12 member requests in any 11 seconds, keeping under Fluxer's limit of 12 per account in 10 seconds.
 * The children of one supervisor keep that count together.
 * Ending the stream early releases the SDK's local request slot but cannot stop work Fluxer has already started
 *
 * Aborting the signal releases local intake even while consumption is paused, not remote provider work
 *
 * @category Guilds and members
 */
export interface MemberChunkOptions extends OperationOptions {
    /** Total milliseconds from dispatch until the final batch arrives, integer 1–2,147,483,647, default 30,000.
     * Pausing consumption does not pause this deadline or the provider. No timeout applies after the full response arrives
     */
    readonly timeoutMs?: number
    /** Maximum source-JSON bytes counted for unread batches, a positive safe integer, default 4,194,304 (4 MiB).
     * Includes a single batch delivered directly to a waiting reader. Overflow fails rather than dropping batches.
     * This bounds the SDK's batch byte accounting, not total JavaScript heap, decoding overhead or caller-held batches
     */
    readonly maxPendingBytes?: number
}

/**
 * Settings for permissions.fetch: The shared deadline of its reads, and whether enabled caches may replace them
 *
 * Aborting the signal cancels only this call and awaits owned cleanup
 *
 * @category Options
 */
export interface PermissionFetchOptions extends RequestOptions {
    /**
     * Read each observation from an enabled cache before fetching it, such as to decide for every command without a
     * request. Default false, which fetches every observation fresh.
     * The guild, member and channel come from their caches when present, and the roles when the everyone role and every
     * member role are all cached, otherwise one list read replaces all of them. A cached channel without its overwrite
     * list is fetched, and a thread's parent channel is read the same way. Only fetches count toward the deadline.
     * Cached observations reflect the last applied gateway events, so they can differ from Fluxer, and their snapshots can
     * come from different moments.
     * Cached entries stay while a shard can resume and are cleared when a new session starts, after which they are fetched.
     * Use the default right before an action where a stale grant matters. With the caches disabled, the call behaves
     * as it does by default. A value that is not a boolean fails with reason input
     */
    readonly preferCache?: boolean
}

/** Choose whether deleting a community emoji or sticker also requests removal of its image asset.
 * The inherited timeout and auditReason follow AuditedRequestOptions.
 * Removing the image is a separate queued job. Deleting the community entry does not wait for it to finish
 *
 * Deletion starts immediately. Aborting the signal awaits cleanup but cannot undo deletion or queued purging
 *
 * @category Options
 */
export interface ExpressionDeleteOptions extends AuditedRequestOptions {
    /** False/default removes the community entry without asking to purge its image.
     * True additionally requests irreversible queued asset/CDN removal and requires Fluxer's expression-purge feature.
     * HTTP success does not mean the purge job has finished. Failure after dispatch can leave either effect applied
     */
    readonly purge?: boolean
}

/** Limit the bytes and time used by an attachment download.
 * The maxBytes option is required, a positive safe integer no greater than 52,428,800.
 * This limits returned bytes, not the file size on Fluxer, total JavaScript memory or buffering while the SDK assembles the result.
 * The timeoutMs option covers endpoint discovery, URL validation and the full GET, and defaults to the client's rest.defaultTimeoutMs, 30,000 unless configured.
 * The SDK still waits for cleanup after the deadline.
 * Media discovery and GETs use client-local media slots, separate from the REST/upload slots. The media slots default to four (rest.mediaConcurrency), and the REST slots to four per local shard (rest.concurrency).
 * Both pools share the pending-request budget. Media does not wait for bot API rate limits
 *
 * Aborting the signal cancels this download, not the client or other operations
 *
 * @category Messages
 */
export interface AttachmentDownloadOptions extends OperationOptions {
    /** Maximum bytes to accept, required and from 1 through 52,428,800. Exceeding it fails with reason tooLarge rather than truncating */
    readonly maxBytes: number
    /** Total deadline in milliseconds, an integer from 1 through 2,147,483,647, including discovery and the GET.
     * Defaults to the client's rest.defaultTimeoutMs, 30,000 unless configured. Cleanup is still awaited after expiry
     */
    readonly timeoutMs?: number
}

/**
 * Request settings for fetching, editing or deleting a message that a webhook client sent
 *
 * Aborting the signal cancels this request, not the webhook client
 *
 * @category Options
 */
export interface WebhookMessageOperationOptions extends RequestOptions {
    /** Decimal ID of the thread that holds the message, sent as the thread_id query parameter. Set it for a message in
     * a thread, because Fluxer looks in the webhook's channel otherwise and answers that the message is unknown.
     * Fluxer rejects a thread that belongs to another channel
     */
    readonly threadId?: string
}

/**
 * Settings for members.fetchCanManage: Whose rank to check, and the shared deadline of its reads
 *
 * Aborting the signal cancels only this call and awaits owned cleanup
 *
 * @category Options
 */
export interface CanManageOptions extends RequestOptions {
    /** User ID of the member whose rank is checked against the target, such as the moderator who ran a command.
     * Omit to check the bot itself. The actor must be a member of the target's community, or the read fails with notFound
     */
    readonly actorUserId?: string
}

/**
 * Timeout-only request settings. A timeoutReason is provider audit metadata, not a stored GuildMember field
 *
 * Timeout changes begin immediately. Aborting the signal waits for owned cleanup but cannot roll back a dispatched timeout change
 *
 * @category Options
 */
export interface TimeoutOptions extends AuditedRequestOptions {
    /** Optional timeout audit metadata. Null or omission sends no meaningful reason. A string must contain 1–512
     * UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace trimming. The original string is sent unchanged
     */
    readonly timeoutReason?: string | null
}

/** Choose who may turn reaction pages and how long they listen.
 * The bot adds ◀ and ▶ reactions, and each click on one shows the previous or next page, wrapping around at the ends.
 * By default, adding or removing an arrow counts as one click, so the bot needs only Add Reactions and Read Message
 * History. Registration needs a connected gateway, like messages.collectReactions
 *
 * Aborting the signal stops listening, removes the bot's arrows and returns CancelledError, leaving the current page shown
 *
 * @category Messages
 */
export interface PaginateOptions extends OperationOptions {
    /**
     * Who may turn pages.
     * Required by messages.paginate, while a command context defaults to the command's author
     */
    readonly users?: PageTurners
    /** Stop after this many milliseconds without an accepted click. Integer 1 through 2,147,483,647, default 60,000 */
    readonly idleMs?: number
    /** Stop after this many milliseconds from registration, regardless of clicks. Integer 1 through 2,147,483,647, default 300,000 */
    readonly timeoutMs?: number
    /** Count only added arrows, and remove the clicker's arrow after each turn so the next click is another addition.
     * The bot then needs Manage Messages. Default false, where adding and removing an arrow both turn the page
     */
    readonly removeClicks?: boolean
}

/** Reaction page settings for messages.paginate, where no message identifies an asker, so users is required
 *
 * @category Messages
 */
export interface ChannelPaginateOptions extends PaginateOptions {
    /** Who may turn pages, such as `[userId]`, or `() => true` for anyone */
    readonly users: PageTurners
}

/** Settings for cleanup's batch submissions.
 * One timeoutMs deadline covers the entire cleanup execution, including rate-limit waits between batches.
 * Preview has its own separate per-call deadline and does not accept onProgress
 *
 * Aborting the signal returns CancelledError rather than a partial report. Earlier requests may already have been submitted.
 * Use progress observations for application-owned reconciliation
 *
 * @category Messages
 */
export interface MessageCleanupOptions extends RequestOptions {
    /** Observe submitting, submitted and failed batches synchronously.
     * Return values are not awaited, and the callback does not schedule retries or recovery.
     * A throw, a rejected asynchronous return or a returned or resolved Err result goes to the client-level onError as a
     * progress FailureReport with the thrown, rejected or Err error, or is logged at Error, and cleanup continues.
     * The callback runs synchronously in both entry points, so a returned Effect is not run. It is reported as a progress
     * FailureReport with a TypeError instead of being ignored
     */
    readonly onProgress?: (progress: MessageCleanupProgress) => unknown
}

/** Required confirmation and deadline for deleting this bot's entire authored history in a channel or community.
 * The confirm field must be the literal true, so an accidental call without it fails before any request with reason input
 * and inputValidation path options.confirm
 *
 * Aborting the signal cannot undo a dispatched deletion
 *
 * @category Options
 */
export interface OwnMessageDeletionOptions extends RequestOptions {
    /** Must be true to acknowledge that the deletion is irreversible and cannot be rolled back */
    readonly confirm: true
}

/**
 * Add an optional AbortSignal to the stream limits. Aborting stops this stream's consumption, not the client or other operations
 *
 * @category Messages
 */
export interface AttachmentStreamOptions extends OperationOptions {
    /** Maximum bytes to accept, required and from 1 through 52,428,800. Exceeding it fails with reason tooLarge rather than truncating */
    readonly maxBytes: number
    /** Total deadline in milliseconds, an integer from 1 through 2,147,483,647, including discovery and the GET.
     * Defaults to the client's rest.defaultTimeoutMs, 30,000 unless configured. Cleanup is still awaited after expiry
     */
    readonly timeoutMs?: number
}
