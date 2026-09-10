import type { assets } from "./assets.js"
import type { links } from "./helpers.js"

/**
 * Explicit instance selection made when a client is created
 *
 * Omit this option for hosted Fluxer. The SDK reads the selected origin's
 * unauthenticated `/.well-known/fluxer` document only when an operation needs
 * it, and retains that immutable result for the client lifetime. Selecting an
 * instance explicitly trusts its advertised service origins: intended REST and
 * gateway operations can send the client's credential there. Discovery follows
 * at most three validated unauthenticated bootstrap redirects and never follows
 * redirects on credentialed service requests
 */
export interface InstanceOptions {
    /** Absolute root URL that publishes `/.well-known/fluxer`. Defaults to `https://fluxer.app` */
    readonly url: string
    /** Permit HTTP and WS endpoints only for an explicitly selected local or self-hosted instance. Defaults to false */
    readonly allowInsecure?: boolean
}

/** Per-call deadline across bootstrap redirects and document reads. Cleanup is awaited before completion and can outlast the deadline */
export interface InstanceResolveOptions {
    /** Positive timer-safe discovery deadline in milliseconds. Defaults to 30,000 */
    readonly timeoutMs?: number
}

/** Immutable service bases advertised by one selected instance */
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
 * Immutable well-known discovery result retained by one client
 *
 * `assets` and `links` are pure helpers bound to these exact advertised bases.
 * They do not perform a request, inspect client credentials, mutate caches, or
 * refresh discovery
 */
export interface ResolvedInstance {
    /** Provider code-version indicator from discovery. It is not an API path version */
    readonly apiCodeVersion: number
    /** Exact validated service bases from discovery */
    readonly endpoints: InstanceEndpoints
    /** Whether this instance advertises presigned attachment upload plans */
    readonly presignedAttachmentUploads: boolean
    /** Pure asset URL helpers bound to this instance's media and static-CDN bases */
    readonly assets: typeof assets
    /** Pure application-link helpers bound to this instance's web application base */
    readonly links: typeof links
}

/** Expected failure while resolving an instance document */
export type InstanceResolveError =
    | import("./errors.js").ConnectionError
    | import("./errors.js").ConnectionTimeoutError
    | import("./errors.js").RateLimitError
    | import("./errors.js").ClientClosedError
    | import("./errors.js").ConfigurationError
