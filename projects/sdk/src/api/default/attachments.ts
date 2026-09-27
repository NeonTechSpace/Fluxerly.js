import type {
    Attachment,
    AttachmentDownloadFailure,
    AttachmentRefreshFailure,
    DefaultAttachmentRefreshOptions,
    DefaultAttachmentDownloadOptions,
    DefaultAttachmentStreamOptions,
    RefreshedAttachmentUrl,
} from "#sdk/attachments"
import type { ResultAsync, Result } from "neverthrow"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Refresh signed attachment URL strings explicitly, or download received Attachment data all at once or as chunks.
 * Refresh uses the selected instance's authenticated API. Downloads use its media path, with no gateway connection or cache required.
 * The SDK never sends bot credentials to a download URL or substitutes attachment.proxyUrl
 *
 * @category Messages
 */
export interface Attachments {
    /**
     * Ask Fluxer's bot-authenticated API to reissue signatures for 1 through 50 URL strings.
     * Each string may contain at most 2,048 UTF-16 code units.
     * Strings, duplicate entries and query parameters are sent unchanged
     *
     * The frozen result has one original and refreshed pair per input in the same order.
     * A string outside this instance's attachment URL space is returned unchanged by Fluxer.
     * Refreshing does not check attachment existence, community or channel membership, permission to download, or media availability
     *
     * This method never downloads media and sends the bot credential only to the selected instance's API, never to a requested or refreshed URL.
     * The credentialed POST follows no redirect.
     * Use download explicitly afterward for a returned URL that belongs to this instance
     *
     * The timeoutMs option defaults to the client's rest.defaultTimeoutMs, 30,000 unless configured, for endpoint discovery, waiting for a REST request slot, rate-limit waits and the limited response read.
     * A confirmed 429 can retry after its required wait.
     * A POST with an unknown outcome or a malformed success is not retried automatically.
     * Cancellation affects only this refresh and waits for request cleanup.
     * HTTP 404 cannot distinguish an older unsupported deployment from an unavailable route or denied access.
     * No refresh happens automatically when reading messages or downloading attachments
     */
    refreshUrls(
        urls: readonly string[],
        options?: DefaultAttachmentRefreshOptions,
    ): ResultAsync<readonly RefreshedAttachmentUrl[], AttachmentRefreshFailure | CancelledError | ConfigurationError>
    /**
     * Download attachment.url into one Uint8Array.
     * Pass maxBytes explicitly, from 1 through 52,428,800 bytes (50 MiB).
     * The limit caps the returned bytes, not total memory, because response chunks can coexist with the packed result
     *
     * The URL must match this instance's discovered media /attachments/ path.
     * The GET sends no Authorization header, follows no redirects, stores no cached copy and never falls back to proxyUrl.
     * The timeoutMs option defaults to the client's rest.defaultTimeoutMs, 30,000 unless configured, for endpoint discovery, waiting for a media slot and downloading.
     * Four media downloads can run at once, separately from REST and uploads, without waiting for bot API rate limits.
     * Cancellation waits for response-reader cleanup, but cannot undo bytes already received
     *
     * Size and expiry metadata do not prove that the URL is available or the bytes are safe.
     * Expected failures contain a safe reason and status, including busy, without the URL or response body
     */
    download(
        attachment: Attachment,
        options: DefaultAttachmentDownloadOptions,
    ): ResultAsync<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
    /**
     * Read attachment.url as chunks without combining the file into one array.
     * Pass maxBytes explicitly, from 1 through 52,428,800 bytes (50 MiB), for the total bytes delivered
     *
     * The first pull reads the inputs, resolves endpoints, waits for a media slot (four by default, rest.mediaConcurrency) and starts the GET.
     * Media slots are separate from the REST and upload slots.
     * Later pulls read at most one response chunk.
     * No byte packing, spooling, automatic retry or durable storage is added
     *
     * The URL must match this instance's media /attachments/ path.
     * The GET sends no Authorization header, follows no redirects, caches nothing and never uses proxyUrl.
     * A Content-Length above maxBytes fails before any chunk, but actual byte counting is still enforced
     *
     * The result can be consumed only once.
     * The timeoutMs option defaults to the client's rest.defaultTimeoutMs, 30,000 unless configured, for the whole download, including pauses between chunks.
     * Ending consumption early, cancellation, failure and client shutdown cancel the body, wait for reader cleanup and release the media slot.
     * Expected failures include safe local busy, network, response, limit and deadline reasons and client closure.
     * Size and expiry metadata do not establish availability or byte safety
     *
     * @remarks
     * Consume the iterable with a for await loop.
     * Each item is a Result containing one Uint8Array, and an expected failure yields one Err and ends the loop.
     * Overlapping next calls return busy without cancelling the pending read.
     * Breaking the loop, return, throw and signal cancellation all end the download.
     * Listener or cleanup failures reject with SdkDefect after independent cleanup is attempted
     *
     * @example
     * ```ts
     * import type { Attachment, Client } from "@neontechspace/fluxerly"
     * export async function downloadChunks(client: Client, attachment: Attachment) {
     *     for await (const chunk of client.attachments.stream(attachment, { maxBytes: 1_024 })) {
     *         if (chunk.isErr()) return chunk
     *         void chunk.value
     *     }
     * }
     * ```
     */
    stream(
        attachment: Attachment,
        options: DefaultAttachmentStreamOptions,
    ): AsyncIterable<Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>>
}
