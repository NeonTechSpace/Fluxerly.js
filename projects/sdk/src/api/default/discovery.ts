import type {
    DiscoveryApplication,
    DiscoveryApplicationInput,
    DiscoveryApplicationEdit,
    DiscoveryCategory,
    DiscoverySearchPage,
    DiscoverySearchQuery,
    DiscoveryStatus,
} from "#sdk/discovery"
import type { ResultAsync } from "neverthrow"
import type { GuildOperationFailure, DefaultGuildOperationOptions } from "#sdk/guilds"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Search Fluxer's public community directory and manage a community's directory application.
 * This is separate from finding the instance's API and gateway endpoints.
 * Calls start immediately without a gateway connection or directory cache.
 * The default deadline, rest.defaultTimeoutMs (30,000 ms unless configured), includes request-capacity and rate-limit waits.
 * Eligible GET failures retry at most twice
 *
 * Writes retry only confirmed HTTP 429 rejection.
 * Input, HTTP and malformed-response failures return GuildOperationError.
 * Client closure returns ClientClosedError.
 * Abort waits for cleanup and returns CancelledError.
 * Unexpected failures reject with SdkDefect.
 * Application writes may publish or remove a listing and invalidate cached guild data.
 * No eligibility check, approval, resubmission or joining is performed automatically.
 * A failed write does not guarantee rollback
 *
 * @category Guilds and members
 */
export interface Discovery {
    /**
     * Fetch one page from the current public community directory.
     * The limit option defaults to 24, and offset defaults to 0.
     * Pages can change between reads, so offset-based scans are not a stable snapshot.
     * This neither joins a community nor caches its directory entry, and needs no gateway connection.
     * Eligible read failures are retried as described for this namespace
     */
    search(
        query?: DiscoverySearchQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoverySearchPage, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch a community's current directory eligibility and application state.
     * Use a decimal guild ID with ManageGuild permission.
     * An eligible false result can mean discovery is disabled or the member threshold is unmet, without distinguishing them.
     * Eligibility can change before application.
     * Reviewed or removed applications include their available reasons
     */
    fetchStatus(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoveryStatus, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch directory category IDs and Fluxer's category labels in provider order.
     * This requires an authenticated client, not membership of a particular community or ManageGuild.
     * No category copy is kept
     */
    fetchCategories(
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly DiscoveryCategory[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Submit a community's application to the public directory.
     * ManageGuild, enabled discovery and current Fluxer eligibility are required.
     * An existing pending or approved application fails remotely.
     * Eligible verified or partnered communities may be approved immediately.
     * The returned stored application does not guarantee approval or search visibility.
     * An unknown outcome may already have submitted or published the listing.
     * Check fetchStatus before trying again
     */
    apply(
        guildId: string,
        input: DiscoveryApplicationInput,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoveryApplication, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change supplied fields of a pending or approved directory application.
     * ManageGuild and enabled discovery are required.
     * At least one field must be supplied, and omitted fields remain unchanged.
     * Tags use the input type's normalization and replacement rules.
     * No old application is fetched or merged automatically.
     * Updates to an approved listing can become public, while search-index updates can lag or partially fail
     */
    edit(
        guildId: string,
        input: DiscoveryApplicationEdit,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoveryApplication, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Withdraw a pending application or remove an approved directory listing.
     * ManageGuild and enabled discovery are required.
     * HTTP 204 succeeds with no value.
     * A missing application is a remote error, not an assumed successful no-op.
     * Fluxer removes the application record and may separately remove its feature or search entry.
     * The community and its members remain, and the prior application is not restored.
     * An unknown or partial outcome needs remote inspection and may require operator recovery, not blind replay
     */
    withdraw(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}
