import type { AuditLogEntry, AuditLogPage, AuditLogQuery, AuditLogIterationQuery } from "#sdk/audit-logs"
import type { PaginationError } from "#sdk/pagination"
import type { ResultAsync, Result } from "neverthrow"
import type { GuildOperationFailure, DefaultGuildOperationOptions } from "#sdk/guilds"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Read a community's audit log with ViewAuditLog permission, without connecting the gateway.
 * The fetchPage method starts immediately.
 * The iterate method reads pages only when the loop requests them.
 * The SDK does not cache audit records or create a permanent archive.
 * Guilds' shared request limits, deadlines and eligible read retries apply.
 * Input, permission and malformed-response failures return GuildOperationError.
 * Abort waits for cleanup and returns CancelledError.
 * Closing clients return ClientClosedError.
 * Unexpected failures reject with SdkDefect.
 * Records can change independently between reads
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
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<AuditLogPage, GuildOperationFailure | CancelledError | ConfigurationError>
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
     * Consume the iterable with a for await loop, which starts the first request.
     * An expected failure yields one Err and ends iteration.
     * Breaking the loop releases the buffered page.
     * Abort interrupts pending request work and waits for cleanup
     */
    iterate(
        guildId: string,
        query: AuditLogIterationQuery,
        options?: DefaultGuildOperationOptions,
    ): AsyncIterable<
        Result<AuditLogEntry, GuildOperationFailure | PaginationError | CancelledError | ConfigurationError>
    >
}
