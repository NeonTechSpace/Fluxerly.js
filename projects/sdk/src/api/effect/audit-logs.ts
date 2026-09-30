import type { AuditLogEntry, AuditLogPage, AuditLogQuery, AuditLogIterationQuery } from "#sdk/audit-logs"
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type { PaginationError } from "#sdk/pagination"
import type { GuildOperationFailure, GuildOperationOptions } from "#sdk/guilds"

/** Read a community's audit log as a page or a bounded sequence of entries.
 * Fluxer requires ViewAuditLog. The SDK does not cache audit entries or connect the gateway.
 * Eligible reads retry transient failures at most twice under the shared guild REST policy.
 * Permission, malformed-response and input failures are typed GuildOperationError values.
 * Effects start when executed and preserve the caller's services, unexpected faults and interruption cleanup.
 * Closing clients fail with ClientClosedError. Audit records can change independently. This is not an archival snapshot
 *
 * @category Guilds and members
 */
export interface AuditLogs {
    /**
     * Fetch one filtered audit page with referenced users and webhook metadata that excludes tokens.
     * Supply cursors and filters in AuditLogQuery.
     * A deletion duration that cannot be represented as safe integer milliseconds fails with reason response, without returning a partial page.
     * The returned page is frozen and remains in memory while the caller retains it
     */
    fetchPage(
        guildId: string,
        query: AuditLogQuery,
        options?: GuildOperationOptions,
    ): Effect.Effect<AuditLogPage, GuildOperationFailure>
    /**
     * Read filtered audit entries newest first, buffering one page and never prefetching.
     * The maxItems option is required.
     * The pageSize option defaults to 50 and accepts 1–100, maxPages defaults to 100, and timeoutMs applies to each page.
     * An empty page or maxItems ends the scan, not a short page.
     * Invalid traversal input, a stalled cursor or reaching the page budget fails with PaginationError.
     * Remote failures keep auditLogs.fetchPage's errors.
     * Deletion durations are rounded to whole milliseconds, and one whose milliseconds are not a safe integer fails its page before that page's entries are delivered.
     * Each consumption is independent, and client closure releases the page and fails the next pull.
     * Already delivered entries remain with the caller, and concurrent changes can prevent a complete scan.
     * Use fetchPage instead to also receive referenced users or webhooks
     *
     * @remarks
     * The returned Stream reads pages only while it is consumed.
     * Failures end the Stream in its error channel.
     * Interruption waits for request cleanup, and ending consumption releases the buffered page
     */
    iterate(
        guildId: string,
        query: AuditLogIterationQuery,
        options?: GuildOperationOptions,
    ): Stream.Stream<AuditLogEntry, GuildOperationFailure | PaginationError>
}
