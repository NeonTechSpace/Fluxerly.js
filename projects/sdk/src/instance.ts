import type { assets } from "./assets.js"
import type { links } from "./helpers.js"

/**
 * Connect a client to a selected Fluxer instance instead of the hosted default.
 * Omit the whole option to use hosted Fluxer.
 * The SDK reads the root's unauthenticated `/.well-known/fluxer` document when an operation first needs service endpoints.
 * It retains the resolved endpoints for this client's lifetime without background refresh
 *
 * Select only an instance you trust, since its advertised API and gateway origins can receive this client's credential.
 * Discovery follows at most three validated unauthenticated redirects.
 * Credentialed service requests do not follow redirects
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

/** Set the time budget for an explicit instance.resolve call.
 * The deadline covers discovery work, but the SDK still waits for owned response cleanup before completing
 */
export interface InstanceResolveOptions {
    /** Total discovery deadline in milliseconds, integer 1–2,147,483,647, default 30,000.
     * Includes bootstrap redirects and document reads, but required cleanup can take longer
     */
    readonly timeoutMs?: number
}

/** Where the selected Fluxer instance hosts its services, validated from its discovery document.
 * Services may use different origins, which you trust by selecting that instance
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
 * The selected instance's resolved service endpoints and matching URL helpers.
 * This frozen result is retained for one client, not refreshed each time you resolve it.
 * Use assets and links to build URLs for this instance rather than the hosted default.
 * These helpers make no requests, inspect no credentials and do not refresh discovery or change caches
 */
export interface ResolvedInstance {
    /** Provider code-version indicator from discovery. It is not an API path version */
    readonly apiCodeVersion: number
    /** Exact validated service bases from discovery */
    readonly endpoints: InstanceEndpoints
    /** Whether this instance advertises temporary upload URLs for attachment transfers */
    readonly presignedAttachmentUploads: boolean
    /** Pure asset URL helpers bound to this instance's media and static-CDN bases */
    readonly assets: typeof assets
    /** Pure application-link helpers bound to this instance's web application base */
    readonly links: typeof links
}

/** Expected instance-resolution failures, including invalid options, connection trouble, deadline expiry, rate limits and client closure.
 * Default API calls add CancelledError, while native interruption remains in the Effect cause
 */
export type InstanceResolveError =
    | import("./errors.js").ConnectionError
    | import("./errors.js").ConnectionTimeoutError
    | import("./errors.js").RateLimitError
    | import("./errors.js").ClientClosedError
    | import("./errors.js").ConfigurationError
