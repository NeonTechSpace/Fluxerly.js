import type { AssetHelpers } from "./assets.js"
import type { LinkHelpers } from "./helpers.js"

/**
 * Connect a client to a selected Fluxer server instead of the hosted default.
 * Omit the whole option to use hosted Fluxer.
 * When an operation first needs service addresses, the SDK reads `/.well-known/fluxer` from that server without credentials.
 * It retains the resolved endpoints for this client's lifetime without background refresh
 *
 * Select only a trusted instance, since its advertised API and gateway origins can receive this client's credential.
 * Discovery follows at most three validated unauthenticated redirects.
 * Requests that send credentials do not follow redirects
 *
 * @category Options
 */
export interface InstanceOptions {
    /** Absolute HTTPS root URL that publishes `/.well-known/fluxer`, such as https://fluxer.example.
     * A path beyond /, query, fragment or embedded credentials is invalid.
     * HTTP requires allowInsecure, and omitting the whole instance option selects hosted Fluxer
     */
    readonly url: string
    /** Permit HTTP and WS endpoints only for an explicitly selected local or self-hosted instance. Defaults to false */
    readonly allowInsecure?: boolean
}

/** Set how long an explicit instance.resolve call may spend finding the server's addresses.
 * The deadline covers discovery work, but the SDK still waits for owned response cleanup before completing
 *
 * @category Options
 */
export interface InstanceResolveOptions {
    /** Time allowed to find service addresses, in milliseconds. Use an integer from 1–2,147,483,647. Default 30,000.
     * Includes bootstrap redirects and document reads, but required cleanup can take longer
     */
    readonly timeoutMs?: number
}

/** Where the selected Fluxer instance hosts its services, validated from its discovery document.
 * Services may use different origins, which selecting that instance trusts
 *
 * @category Client and lifecycle
 */
export interface InstanceEndpoints {
    /** Public HTTP API base. The SDK appends its documented `/v1` route once, preserving any advertised prefix */
    readonly apiPublic: string
    /** Gateway WebSocket base. The SDK adds its required protocol query without deriving another host */
    readonly gateway: string
    /** Public media base for instance-specific generated asset URLs */
    readonly media: string
    /** Static CDN base for instance-specific generated default-asset URLs */
    readonly staticCdn: string
    /** Web application base for instance-specific generated navigation and installation links */
    readonly webapp: string
    /** Invite base for instance-specific invite and vanity URLs */
    readonly invite: string
}

/**
 * The selected server's service addresses and matching URL helpers.
 * This frozen result is retained for one client, not refreshed on each later resolve.
 * Use assets and links to build URLs for this instance rather than the hosted default.
 * These helpers make no requests, inspect no credentials and do not refresh discovery or change caches
 *
 * @category Client and lifecycle
 */
export interface ResolvedInstance {
    /** Provider code-version indicator from discovery. It is not an API path version */
    readonly apiCodeVersion: number
    /** Exact validated service bases from discovery */
    readonly endpoints: InstanceEndpoints
    /** Whether this instance advertises temporary upload URLs for attachment transfers */
    readonly presignedAttachmentUploads: boolean
    /** Pure asset URL helpers bound to this instance's media and static-CDN bases.
     * They follow the assets namespace's input-field and fallback rules, return URLs directly and throw AssetUrlError for invalid input
     */
    readonly assets: AssetHelpers
    /** Pure application-link helpers bound to this instance's web application base.
     * They return URLs directly, throw HelperError for invalid input and perform no navigation or access check
     */
    readonly links: LinkHelpers
    /** The web domain migration that discovery announced, or null when the instance announced none.
     * Links and OAuth URLs always use the discovered web application base in endpoints, so they follow a migrated domain
     */
    readonly domainMigration: InstanceDomainMigration | null
}

/** A web domain migration announced by instance discovery, such as hosted Fluxer moving its web app to a new domain.
 * The SDK records an enabled migration at Info when a client first resolves the instance. It changes no endpoint itself
 *
 * @category Client and lifecycle
 */
export interface InstanceDomainMigration {
    /** Whether the instance switched the migration on */
    readonly enabled: boolean
    /** Share of signed-out web visitors moved to the new domain, in basis points from 0 through 10,000, or null when not supplied */
    readonly anonymousRolloutBasisPoints: number | null
    /** Whether standalone app installs are forwarded to the new domain, or null when not supplied */
    readonly standaloneForwarding: boolean | null
}

/** Expected instance-resolution failures, including invalid options, connection trouble, deadline expiry, rate limits and client closure.
 * Default API calls add CancelledError, while native interruption remains in the Effect cause
 *
 * @category Errors
 */
export type InstanceResolveError =
    | import("./errors.js").ConnectionError
    | import("./errors.js").ConnectionTimeoutError
    | import("./errors.js").RateLimitError
    | import("./errors.js").ClientClosedError
    | import("./errors.js").ConfigurationError
