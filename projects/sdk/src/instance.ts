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
 * These helpers make no requests, inspect no credentials and do not refresh discovery or change caches.
 * Built-in badge images and hidden badge kinds from discovery are not kept, because few bots draw community badges.
 * For discovery fields not included here, read `/.well-known/fluxer` from the selected instance's root with fetch and no Authorization header.
 * This address is outside `/v1`, so client.rest.request from the [raw-request guide](https://fluxerly.neontechspace.com/docs/raw-requests-and-events/) cannot read it.
 * Check the response before using it, keep a copy and honor Retry-After
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
    /** Whether this instance has community directory discovery switched on.
     * True when discovery omits the flag, as Fluxer documents. A present value that is not a boolean makes the discovery document invalid.
     * When false, the discovery namespace's search, apply, edit and withdraw operations fail with reason rejected, HTTP 400 and apiError.code discoveryDisabled (Fluxer code DISCOVERY_DISABLED), while fetchStatus and fetchCategories still answer.
     * The value is a snapshot from when the client resolved the instance, so an operator's later change appears only in a new client
     */
    readonly discoveryEnabled: boolean
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
 * A bot client records an enabled migration at Info when it first resolves the instance. Webhook and OAuth clients do not
 * log it. It changes no endpoint itself
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

/** Select community badges for client.instance.fetchBadges: Either up to 100 badge IDs, such as a Guild's badgeIds,
 * or one page of every community badge on the instance. Unknown keys and invalid values fail locally.
 * The query accepts only ids, after and limit. To send the catalog's version field, use client.rest.request with GET /instance/badges and query.version
 *
 * @category Client and lifecycle
 */
export type InstanceBadgeQuery = InstanceBadgeLookup | InstanceBadgePageQuery

/** Look up specific community badges by ID
 *
 * @category Client and lifecycle
 */
export interface InstanceBadgeLookup {
    /** 1 through 100 decimal badge IDs. Fluxer leaves out unknown and deleted IDs */
    readonly ids: readonly string[]
}

/** Read one page of every community badge on the instance, in display order
 *
 * @category Client and lifecycle
 */
export interface InstanceBadgePageQuery {
    /** The nextAfter value of the previous page. Omit it for the first page */
    readonly after?: string
    /** Maximum badges in the page, an integer from 1 through 200, default 100 */
    readonly limit?: number
}

/** One custom badge that communities on the instance can show. The badge is frozen
 *
 * @category Client and lifecycle
 */
export interface InstanceBadge {
    /** Decimal badge ID, as listed in Guild.badgeIds */
    readonly id: string
    /** Badge name */
    readonly name: string
    /** Text shown under the name, null when the badge has none */
    readonly description: string | null
    /** URL of the badge image */
    readonly assetUrl: string
    /** URL the badge links to, null when it links nowhere */
    readonly href: string | null
    /** Display position as a decimal string. Badges are shown in ascending order of this value */
    readonly position: string
}

/** One frozen page of community badges from client.instance.fetchBadges
 *
 * @category Client and lifecycle
 */
export interface InstanceBadgePage {
    /** Version of the instance's badge list. It changes whenever a badge is created, edited, deleted or moved,
     * so badges kept under the same version are still current
     */
    readonly version: string
    /** The badges in display order */
    readonly badges: readonly InstanceBadge[]
    /** Pass as after to read the next page. Null on the last page and for a lookup by ids */
    readonly nextAfter: string | null
}
